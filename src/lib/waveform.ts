/**
 * 時間軸波形的刻度。
 *
 * 目的是讓人用眼睛確認「兩支有沒有對到同一段」,所以要看得出**段落的高低起伏**
 * (前奏小聲、副歌大聲),而不是絕對音量。
 *
 * 走過的版本:
 *   1. 以最大值為滿格、線性刻度:教室錄音裡一聲靠近手機的跺腳就是最大值,
 *      整首音樂被壓到幾乎看不見。
 *   2. 以第 95 百分位為滿格、固定 36dB 範圍:流行歌混音後音量本來就很平,
 *      整首都落在滿格以下 10dB 內,畫出來全部接近滿格,看不出差別。
 *   3. 用原始包絡(10ms 一格)的第 10 ~ 98 百分位當上下限:第 10 百分位抓到的是
 *      「鼓點之間的空隙」而不是「安靜的段落」,範圍又被撐太寬,還是全部接近滿格。
 *
 * 現在:先把包絡平滑到 0.5 秒(畫的也是平滑後的值,刻度與畫面才一致),
 * 再用第 10 百分位(安靜段落)到第 98 百分位(最大聲)當上下限,對數刻度。
 * 每支影片都把自己的起伏拉滿整個高度,錄得多大聲、混音壓得多平都不影響。
 */

export interface Waveform {
  /** 平滑後的包絡,與原包絡等長。時間軸畫的是這個 */
  levels: Float32Array
  /** 對數刻度的下限(自然對數) */
  lo: number
  /** 對數刻度的上限(自然對數) */
  hi: number
}

/**
 * 平滑視窗(包絡格數,100Hz)。0.5 秒 = 120 BPM 的一拍。
 * 試過 0.25 秒:拍子還看得出來,但每一拍裡的空隙仍把下限拉得太低,段落差異又被壓掉。
 * 這條波形的用途是比對段落,不是比對拍點(拍點交給自動對齊),所以取段落。
 */
const SMOOTH_FRAMES = 50
const LOW_PERCENTILE = 0.1
const HIGH_PERCENTILE = 0.98
/** 範圍至少這麼寬(約 6dB),否則幾乎沒有起伏的素材會把雜訊放大成劇烈跳動 */
const MIN_RANGE = Math.log(2)
/** 下限以下的部分(真正的靜音)仍畫一點點,看得出那裡有素材 */
const FLOOR = 0.06

/** 置中的移動平均,不會讓波形往後偏 */
function smooth(env: Float32Array, width: number): Float32Array {
  const n = env.length
  const out = new Float32Array(n)
  const half = width >> 1
  let sum = 0
  let lo = 0
  let hi = 0 // 視窗 env[lo..hi)
  for (let i = 0; i < n; i++) {
    const wantHi = Math.min(n, i + half + 1)
    const wantLo = Math.max(0, i - half)
    while (hi < wantHi) sum += env[hi++]
    while (lo < wantLo) sum -= env[lo++]
    out[i] = sum / (hi - lo)
  }
  return out
}

const cache = new WeakMap<Float32Array, Waveform | null>()

/** 全靜音回傳 null。快取起來,畫面每次重繪都要用 */
export function waveformOf(env: Float32Array): Waveform | null {
  if (cache.has(env)) return cache.get(env)!
  const levels = smooth(env, SMOOTH_FRAMES)
  const sorted = Float32Array.from(levels).sort()
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  const high = at(HIGH_PERCENTILE)
  let result: Waveform | null = null
  if (high > 0) {
    const hi = Math.log(high)
    const low = at(LOW_PERCENTILE)
    // 第 10 百分位是 0(開頭結尾有靜音)時,往下留 30dB
    const lo = low > 0 ? Math.min(Math.log(low), hi - MIN_RANGE) : hi - Math.log(32)
    result = { levels, lo, hi }
  }
  cache.set(env, result)
  return result
}

/** 0..1 */
export function waveformHeight(level: number, w: Pick<Waveform, 'lo' | 'hi'>): number {
  if (level <= 0) return 0
  const t = (Math.log(level) - w.lo) / (w.hi - w.lo)
  return FLOOR + (1 - FLOOR) * Math.min(1, Math.max(0, t))
}
