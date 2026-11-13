import { crossCorrelate } from './fft'
import { ENVELOPE_HZ } from './types'

/**
 * 音訊自動對齊。
 *
 * 前提:兩段影片跳的是同一首歌,所以音訊內容幾乎相同、只差一個時間偏移。
 * 那就不必讓使用者手動拉時間軸 —— 直接算出偏移量。
 *
 * 流程:
 *   解碼 → 混單聲道 → 100Hz 音量包絡 → 依自身音量正規化 → 對數壓縮
 *   → 正向差分(起音強度) → 正規化 → FFT 互相關 → 重疊區 Pearson 相關係數 → 找峰值
 *
 * 為什麼比對「起音強度」而不是「音量包絡」:
 *   音量包絡會被兩支影片的錄音音量、EQ、環境噪音整體平移,相關性容易被低頻成分主導。
 *   正向差分只留下「音量突然變大」的瞬間 —— 也就是鼓點和重拍 —— 峰值也尖銳得多。
 *   對數壓縮前先除以這支自己的音量水準(見 onsetFromEnvelope),小聲錄的那支才不會吃虧。
 *   解析度上限由 ENVELOPE_HZ 決定,100Hz 即 10ms。
 */

export interface AudioAnalysis {
  /** 音量包絡(ENVELOPE_HZ),畫波形用 */
  envelope: Float32Array
  /** 起音強度包絡(ENVELOPE_HZ),對齊用 */
  onset: Float32Array
}

export interface AlignResult {
  /** offsetB - offsetA,單位 ms。正值代表 B 要往後推。 */
  lagMs: number
  /** 重疊區上的 Pearson 相關係數(-1..1)。同一首歌通常 > 0.6。 */
  score: number
  /** 距離主峰 1 秒以上的次高峰分數 */
  runnerUpScore: number
  /** 次高峰的位置,也就是「另一個候選答案」 */
  runnerUpLagMs: number
  /** 主峰領先次高峰的幅度 (0..1) */
  margin: number
  /**
   * 是否存在另一個分數接近的候選位置。
   *
   * 這是「還有別的可能」的提示,不是「對錯」的判決 —— 這點是實測之後才改的。
   *
   * 原本想在這裡給一個可信度分數,試過的都失敗:
   *   1. 峰值對全體分數的 z-score:不管兩段音訊有沒有關係都落在 7.0~7.4,毫無鑑別力。
   *   2. 相關係數本身:兩首無關但同 BPM 的歌照樣拿 0.93,因為拍點位置本來就對得上。
   *
   * margin 也不能單獨當判準,因為它嚴重取決於素材:
   *   振幅變化豐富的訊號    對齊成功 0.061~0.076 / 失敗 0.000~0.030
   *   純打擊樂(嗶聲+靜音)  對齊成功 0.006      / 失敗 0.000
   * 後者正確答案的 margin 幾乎和退化情況重疊,任何門檻都會誤報。
   *
   * 結論:只要兩段真的是同一首歌,偏移量本身一律算得準(合成與真實音訊都驗過),
   * 但沒有便宜的純量能判斷成敗。所以這裡只把次高峰當成「另一個候選」交出去,
   * 由 UI 讓使用者一鍵切換,最終以時間軸上兩條波形是否對齊為準。
   */
  hasAlternative: boolean
}

/** 次高峰分數在主峰的這個比例之內,就當成值得一提的另一個候選 */
const ALTERNATIVE_THRESHOLD = 0.05

/**
 * 分析用的解碼取樣率。
 *
 * decodeAudioData 會把音訊重新取樣到 context 的取樣率,所以這個值直接決定
 * 解碼後佔多少記憶體 —— 3 分鐘的影片在 48kHz 立體聲是約 69MB,兩支就 138MB,
 * 在 iPhone 上很容易讓 Safari 直接把分頁回收掉(選完影片回不了網頁就是這個症狀)。
 *
 * 16kHz 單聲道是 6 分之一(約 11.5MB)。選 16k 而不是更低,是因為包絡是靠
 * 每 10ms 的 RMS 能量算的,取樣率太低會把小鼓與 hi-hat 的高頻瞬態濾掉,
 * 起音會變鈍。16kHz 保留到 8kHz,鼓組的資訊幾乎都還在。
 *
 * 包絡本身只有 100Hz,所以這個取樣率遠遠夠用。
 */
const ANALYSIS_SAMPLE_RATE = 16000

let sharedCtx: OfflineAudioContext | null = null
function getDecodeContext(): OfflineAudioContext {
  if (!sharedCtx) sharedCtx = new OfflineAudioContext(1, 1, ANALYSIS_SAMPLE_RATE)
  return sharedCtx
}

/**
 * 超過這個大小就不走 decodeAudioData,直接串流解碼。
 *
 * decodeAudioData 只吃完整的 ArrayBuffer —— 整支檔案得先整個讀進記憶體。
 * iPhone 錄的 3 分鐘影片動輒 300MB~1GB(4K 更大),在 iPad / iPhone 上
 * `file.arrayBuffer()` 本身就可能失敗,或把分頁擠到被回收。
 * 串流路徑(mediabunny)只讀音軌的那幾塊,記憶體跟檔案大小無關。
 *
 * 小檔案還是先走 decodeAudioData:不必為了它下載 mediabunny。
 */
const DIRECT_DECODE_LIMIT = 150 * 1024 * 1024

/**
 * 從影片/音訊檔抽出包絡。所有路徑都失敗才 throw,錯誤訊息會列出每條路徑失敗的原因。
 *
 * 兩條路徑:
 *   1. decodeAudioData:快、不用額外載入東西,但要整檔進記憶體,
 *      而且遇到「多條音軌」的檔案(iPhone 開空間音訊錄的 .mov 會帶 APAC 軌)可能直接拒絕。
 *   2. mediabunny 串流:逐塊解封裝 + WebCodecs AudioDecoder,自己挑第一條解得開的音軌。
 */
export async function analyzeAudio(file: Blob): Promise<AudioAnalysis> {
  const failures: string[] = []

  if (file.size <= DIRECT_DECODE_LIMIT) {
    try {
      return await analyzeWithDecodeAudioData(file)
    } catch (err) {
      failures.push(`decodeAudioData:${describeError(err)}`)
    }
  }

  try {
    const { analyzeAudioStreaming } = await import('./audioStream')
    return await analyzeAudioStreaming(file)
  } catch (err) {
    failures.push(`串流解碼:${describeError(err)}`)
  }

  throw new Error(failures.join(';'))
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

async function analyzeWithDecodeAudioData(file: Blob): Promise<AudioAnalysis> {
  const bytes = await file.arrayBuffer()
  const audio = await getDecodeContext().decodeAudioData(bytes)

  const acc = new EnvelopeAccumulator(audio.sampleRate)
  const planes: Float32Array[] = []
  for (let c = 0; c < audio.numberOfChannels; c++) planes.push(audio.getChannelData(c))
  acc.push(planes, audio.length)
  return acc.finish()
}

/**
 * 邊收 PCM 邊算包絡。兩條解碼路徑共用 —— 一次拿到整段(decodeAudioData)
 * 或一塊一塊來(串流)都走這裡,包絡才不會因為解碼方式不同而有差異。
 *
 * 每個 hop(1/ENVELOPE_HZ 秒)取混成單聲道後的 RMS。
 * 不足一個 hop 的尾巴丟掉,與舊版行為一致。
 */
export class EnvelopeAccumulator {
  private readonly hop: number
  private buf = new Float32Array(1024)
  private count = 0
  private sum = 0
  private filled = 0
  /** 目前已收到的總 frame 數(含補的靜音),串流路徑靠它處理時間戳的空洞與重疊 */
  position = 0

  constructor(sampleRate: number) {
    this.hop = Math.max(1, Math.round(sampleRate / ENVELOPE_HZ))
  }

  /** planes:每個聲道一條,長度至少 frames */
  push(planes: Float32Array[], frames: number, from = 0): void {
    const channels = planes.length
    if (channels === 0) return
    for (let j = from; j < frames; j++) {
      let s = 0
      for (let c = 0; c < channels; c++) s += planes[c][j]
      s /= channels
      this.addSquare(s * s)
    }
    this.position += frames - from
  }

  pushSilence(frames: number): void {
    for (let j = 0; j < frames; j++) this.addSquare(0)
    this.position += frames
  }

  private addSquare(v: number): void {
    this.sum += v
    if (++this.filled < this.hop) return
    if (this.count === this.buf.length) {
      const next = new Float32Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    this.buf[this.count++] = Math.sqrt(this.sum / this.hop)
    this.sum = 0
    this.filled = 0
  }

  finish(): AudioAnalysis {
    if (this.count < 2) throw new Error('音訊太短,無法分析')
    const envelope = this.buf.slice(0, this.count)
    return { envelope, onset: onsetFromEnvelope(envelope) }
  }
}

/**
 * 對數壓縮的參考點:包絡第 90 百分位的 1/50。
 *
 * 舊版直接用 log1p(x·50),參考點是寫死的。log1p 對小訊號近似線性、對大訊號才是對數,
 * 所以同一首歌,小聲錄的那支(例如教室裡手機離喇叭很遠)整條都落在線性區 ——
 * 起音被壓扁,跺腳、拍手這些近距離的聲響反而主導。
 * 合成測試裡音樂只剩 3% 音量時,相關係數從 0.30 掉到 0.16,
 * 0.3% 時剩 0.13 —— 偏移其實算對了,但分數低到被判成「可能不是同一首歌」。
 *
 * 改成除以自己的音量水準之後,整體音量乘上 k 倍,參考點也乘 k 倍,結果完全不變。
 * 用第 90 百分位而不是最大值,是為了不被一聲特別大的跺腳帶走;
 * 1/50 讓大聲素材的行為跟舊版幾乎一樣(舊版的 50 是對滿音量素材調過的)。
 */
const ONSET_REF_PERCENTILE = 0.9
const ONSET_REF_DIVISOR = 50

export function onsetFromEnvelope(envelope: Float32Array): Float32Array {
  const n = envelope.length
  const onset = new Float32Array(n)
  if (n < 2) return onset

  const sorted = Float32Array.from(envelope).sort()
  const level = sorted[Math.min(n - 1, Math.floor(n * ONSET_REF_PERCENTILE))]
  // 全靜音就沒有起音可言,回傳全 0(對齊時 standardize 會處理)
  if (!(level > 0)) return onset
  const ref = level / ONSET_REF_DIVISOR

  let prev = Math.log1p(envelope[0] / ref)
  for (let i = 1; i < n; i++) {
    const cur = Math.log1p(envelope[i] / ref)
    onset[i] = Math.max(0, cur - prev)
    prev = cur
  }
  return onset
}

/** 減平均、除標準差。互相關前一定要做,否則直流成分會蓋掉真正的峰值。 */
export function standardize(src: Float32Array): Float32Array {
  const n = src.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += src[i]
  mean /= n
  let variance = 0
  for (let i = 0; i < n; i++) {
    const d = src[i] - mean
    variance += d * d
  }
  const sd = Math.sqrt(variance / n) || 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = (src[i] - mean) / sd
  return out
}

function prefixSums(src: Float32Array) {
  const n = src.length
  const sum = new Float64Array(n + 1)
  const sumSq = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    sum[i + 1] = sum[i] + src[i]
    sumSq[i + 1] = sumSq[i] + src[i] * src[i]
  }
  return { sum, sumSq }
}

/** 兩個峰值要相隔多遠才算是「不同的答案」。1 秒內的相鄰高點只是同一個峰的肩膀。 */
const PEAK_SEPARATION = ENVELOPE_HZ

/**
 * 每個候選位移在重疊區上的 Pearson 相關係數(起音序列)。
 * 回傳的 lags 單位是包絡格數(1/ENVELOPE_HZ 秒)。
 */
function scoreAllLags(onsetA: Float32Array, onsetB: Float32Array, maxLagMs: number) {
  const a = standardize(onsetA)
  const b = standardize(onsetB)
  const corr = crossCorrelate(a, b)
  const n = corr.length
  const la = a.length
  const lb = b.length

  const pa = prefixSums(a)
  const pb = prefixSums(b)

  const maxLag = Math.min(Math.round((maxLagMs / 1000) * ENVELOPE_HZ), Math.max(la, lb))
  // 重疊太少的 lag 不可信:至少要 5 秒、且不少於較短那段的四分之一
  const minOverlap = Math.max(ENVELOPE_HZ * 5, Math.floor(Math.min(la, lb) * 0.25))

  const lags: number[] = []
  const scores: number[] = []

  for (let k = -maxLag; k <= maxLag; k++) {
    // 這個 lag 下,b[lo..hi) 對上 a[lo+k..hi+k)
    const lo = Math.max(0, -k)
    const hi = Math.min(lb, la - k)
    const overlap = hi - lo
    if (overlap < minOverlap) continue

    const idx = k >= 0 ? k : n + k
    const sumAB = corr[idx] // 補零讓循環相關等於線性相關,所以這就是重疊區的 Σab

    // 在重疊區上算 Pearson 相關係數。
    // 早期版本是 corr/overlap,結果偏袒重疊少的 lag —— 視窗越小,平均乘積的變異數越大,
    // 極端值就越容易冒出來當冠軍。Pearson 把值限制在 [-1,1],小視窗就不再有這種紅利。
    const sumB = pb.sum[hi] - pb.sum[lo]
    const sumB2 = pb.sumSq[hi] - pb.sumSq[lo]
    const sumA = pa.sum[hi + k] - pa.sum[lo + k]
    const sumA2 = pa.sumSq[hi + k] - pa.sumSq[lo + k]

    const varA = overlap * sumA2 - sumA * sumA
    const varB = overlap * sumB2 - sumB * sumB
    const den = Math.sqrt(Math.max(0, varA) * Math.max(0, varB))
    const r = den > 0 ? (overlap * sumAB - sumA * sumB) / den : 0

    lags.push(k)
    scores.push(r)
  }

  if (lags.length === 0) throw new Error('兩段影片重疊太少,無法對齊')
  return { lags, scores }
}

/** 由高到低挑出彼此相隔超過 PEAK_SEPARATION 的峰值(回傳索引) */
function topPeaks(lags: number[], scores: number[], count: number): number[] {
  const order = scores.map((_, i) => i).sort((x, y) => scores[y] - scores[x])
  const picked: number[] = []
  for (const i of order) {
    if (picked.every((j) => Math.abs(lags[i] - lags[j]) > PEAK_SEPARATION)) {
      picked.push(i)
      if (picked.length === count) break
    }
  }
  return picked
}

function buildResult(
  bestLag: number,
  bestScore: number,
  runnerUpLag: number | null,
  runnerUpScore: number,
  margin: number,
): AlignResult {
  return {
    lagMs: (bestLag * 1000) / ENVELOPE_HZ,
    score: bestScore,
    runnerUpScore,
    runnerUpLagMs: ((runnerUpLag ?? 0) * 1000) / ENVELOPE_HZ,
    margin,
    hasAlternative: margin < ALTERNATIVE_THRESHOLD,
  }
}

/**
 * 只看起音序列,算出 B 相對於 A 的時間偏移。
 * @param maxLagMs 只在這個範圍內找,預設 ±60 秒。範圍越小越不容易被雜訊騙。
 */
export function alignOnsets(
  onsetA: Float32Array,
  onsetB: Float32Array,
  maxLagMs = 60_000,
): AlignResult {
  const { lags, scores } = scoreAllLags(onsetA, onsetB, maxLagMs)
  const [best, second] = topPeaks(lags, scores, 2)
  const bestScore = scores[best]
  // 搜尋範圍太窄、只有一個峰時無從比較
  const runnerUp = second === undefined ? 0 : scores[second]
  const margin = bestScore > 0 ? (bestScore - runnerUp) / bestScore : 0
  return buildResult(lags[best], bestScore, second === undefined ? null : lags[second], runnerUp, margin)
}

/**
 * 起音互相關挑出幾個候選位置,再用「段落音量輪廓」決定是哪一個。
 *
 * 為什麼只看起音不夠:舞曲是一小節一小節循環做出來的,同一個段落裡每一小節的
 * 鼓組幾乎一模一樣,主歌和副歌還會整段重複。起音序列在「差了幾小節」的位置上
 * 一樣吻合,只有段落交界那幾拍能分辨對錯 —— 再加上教室錄音的跺腳和講話,
 * 正確答案與「對到隔壁 5 小節」的分數差距常常小於雜訊。
 * 實際回報:正確是 3.69 秒,工具給了 13.69 秒,剛好差 5 小節(120 BPM)。
 *
 * 段落音量輪廓(音量包絡取對數、平滑到 1 秒)看的是另一個尺度:
 * 前奏小聲、主歌中等、副歌最大聲。差幾小節的話,段落的高低起伏就對不上。
 * 而且它對跺腳不敏感 —— 跺腳是零星的瞬間,平滑之後幾乎不見。
 *
 * 最終分數 = 起音分數(以最高者為 1 正規化) + 輪廓分數。
 * 起音能明確分出勝負時(例如正確答案 1.0、次高 0.6),輪廓不會翻盤;
 * 起音分不出來時(全部 0.95~1.0),由輪廓決定。
 */
export function alignAnalyses(
  a: Pick<AudioAnalysis, 'envelope' | 'onset'>,
  b: Pick<AudioAnalysis, 'envelope' | 'onset'>,
  maxLagMs = 60_000,
): AlignResult & { contourScore: number } {
  const { lags, scores } = scoreAllLags(a.onset, b.onset, maxLagMs)
  const peaks = topPeaks(lags, scores, CANDIDATE_COUNT)
  const top = scores[peaks[0]]

  const ca = contour(a.envelope)
  const cb = contour(b.envelope)

  const ranked = peaks
    .map((i) => {
      const contourScore = pearsonAtLag(ca, cb, lags[i])
      const onsetNorm = top > 0 ? scores[i] / top : 0
      return { lag: lags[i], onset: scores[i], contourScore, total: onsetNorm + contourScore }
    })
    .sort((x, y) => y.total - x.total)

  const best = ranked[0]
  const second = ranked[1]
  const margin =
    second && best.total > 0 ? (best.total - second.total) / best.total : second ? 0 : 1
  return {
    ...buildResult(best.lag, best.onset, second?.lag ?? null, second?.onset ?? 0, margin),
    contourScore: best.contourScore,
  }
}

/** 起音挑出幾個候選位置交給輪廓複審 */
/**
 * 起音挑出幾個候選位置交給輪廓複審。
 * 合成測試裡 12 個不夠:跺腳很多的時候,正確答案在起音排名可能掉到二十幾名
 * (段落內每一小節都長一樣,前面全是「差幾小節」的假峰)。30 個就 8/8 全對。
 */
const CANDIDATE_COUNT = 30

/**
 * 輪廓的視窗與百分位數。
 *
 * 用**低百分位數**而不是平均:跺腳、拍手、講話都只會把音量往上加,
 * 取視窗內偏低的那一端,看到的就是「底下那層音樂」的音量。
 * 合成教室錄音(8 種噪音)的結果:
 *   1 秒平均 / 中位數   2/8 對
 *   2 秒第 15 百分位     7/8 對
 *   3 秒第 10 百分位     8/8 對,正確位置的輪廓相關 0.88~0.92
 * 視窗要比一小節(2 秒)長才吃得掉零星的跺腳,又要比一個段落(16 秒)短很多才分得出段落。
 */
const CONTOUR_WINDOW = ENVELOPE_HZ * 3
const CONTOUR_PERCENTILE = 0.1
/** 每隔幾格才重算一次百分位數。輪廓本來就是慢變化,0.1 秒一點足夠,計算量少 10 倍 */
const CONTOUR_STEP = ENVELOPE_HZ / 10

/** 段落音量輪廓:對數音量(與起音同一個參考點,對整體音量免疫),再取滑動視窗的低百分位數 */
function contour(envelope: Float32Array): Float32Array {
  const n = envelope.length
  const sorted = Float32Array.from(envelope).sort()
  const level = sorted[Math.min(n - 1, Math.floor(n * ONSET_REF_PERCENTILE))]
  const ref = level > 0 ? level / ONSET_REF_DIVISOR : 1
  const log = new Float32Array(n)
  for (let i = 0; i < n; i++) log[i] = Math.log1p(envelope[i] / ref)

  const out = new Float32Array(n)
  const half = CONTOUR_WINDOW >> 1
  const buf = new Float32Array(CONTOUR_WINDOW + 1)
  for (let i = 0; i < n; i += CONTOUR_STEP) {
    const lo = Math.max(0, i - half)
    const hi = Math.min(n, i + half + 1)
    const m = hi - lo
    for (let j = 0; j < m; j++) buf[j] = log[lo + j]
    const view = buf.subarray(0, m).sort()
    out.fill(view[Math.floor((m - 1) * CONTOUR_PERCENTILE)], i, Math.min(n, i + CONTOUR_STEP))
  }
  return out
}

/** b[t] 對上 a[t + lag] 時,重疊區上的 Pearson 相關係數 */
function pearsonAtLag(a: Float32Array, b: Float32Array, lag: number): number {
  const lo = Math.max(0, -lag)
  const hi = Math.min(b.length, a.length - lag)
  const n = hi - lo
  if (n < 2) return 0
  let sa = 0
  let sb = 0
  let saa = 0
  let sbb = 0
  let sab = 0
  for (let t = lo; t < hi; t++) {
    const x = a[t + lag]
    const y = b[t]
    sa += x
    sb += y
    saa += x * x
    sbb += y * y
    sab += x * y
  }
  const den = Math.sqrt(Math.max(0, n * saa - sa * sa) * Math.max(0, n * sbb - sb * sb))
  return den > 0 ? (n * sab - sa * sb) / den : 0
}
