import { countInDurationMs, countInPlan, playRange, useProject } from '../store/useProject'
import { createClick } from './metronome'
import { encodeWav } from './wav'
import type { Clip, ClipId } from './types'

/**
 * 純音訊匯出。
 *
 * 走 OfflineAudioContext 離線算完,不是即時錄製 ——
 * 3 分鐘的專案幾秒就好,而且不需要一直開著畫面。
 * 影像的匯出還在 MediaRecorder 上受這個限制,音訊這條先跳過去了。
 *
 * 這也等於先鋪好 WebCodecs 的一半:換過去之後音訊本來就要離線混音,
 * 這套混音邏輯可以原封不動沿用,只是最後改接 AudioEncoder 而不是寫 WAV。
 */

const OUTPUT_SAMPLE_RATE = 44100
const OUTPUT_CHANNELS = 2

export type AudioFormat = 'wav' | 'mp3'

/** 匯出音量的選項。0.25 一階,是使用者要求的四段。 */
export const AUDIO_GAINS = [0.25, 0.5, 0.75, 1] as const

/**
 * MP3 的位元率。192kbps 是音樂的常見甜蜜點 —— 128 對鼓組的瞬態已經聽得出來,
 * 320 對「練舞時放來聽」這個用途沒有意義,只是檔案大 1.7 倍。
 */
export const MP3_BITRATE = 192_000

export interface AudioExportOptions {
  format?: AudioFormat
  /** 整體音量,0..1。套在混音之後、編碼之前,所以素材音量與節拍器都一起縮。 */
  gain?: number
  onProgress?: (ratio: number) => void
}

export interface AudioExportResult {
  blob: Blob
  durationMs: number
  extension: string
}

/**
 * 估算輸出檔案大小,給介面顯示用。
 *
 * WAV 是未壓縮的 16-bit 立體聲,大小完全由長度決定;
 * MP3 是固定位元率,所以也算得準。
 */
export function estimateAudioBytes(durationMs: number, format: AudioFormat): number {
  const seconds = durationMs / 1000
  return format === 'wav'
    ? seconds * OUTPUT_SAMPLE_RATE * OUTPUT_CHANNELS * 2
    : (seconds * MP3_BITRATE) / 8
}

/** 進度到這裡之後就是編碼階段。介面靠這個把「混音中」換成「編碼中」。 */
export const ENCODE_STARTS_AT = 0.6

export interface RenderOptions {
  onProgress?: (ratio: number) => void
  /** 整體音量,預設 1(不動)。影片匯出走預設值,音訊匯出才會給。 */
  gain?: number
}

/** blob: URL 讀得回原始資料,所以不必為了匯出額外保留 File 物件 */
async function decodeClip(ctx: BaseAudioContext, clip: Clip): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(clip.url)
    return await ctx.decodeAudioData(await res.arrayBuffer())
  } catch {
    return null
  }
}

/**
 * 把整個專案的聲音離線混成一段 AudioBuffer:兩支素材的音訊 + 預備拍的節拍器。
 *
 * 抽出來是因為有兩個消費端 —— 純音訊匯出(寫成 WAV)與 WebCodecs 影片匯出
 * (餵給 AudioEncoder)。混音邏輯只寫一份,兩邊的聲音才不會有一天開始不一樣。
 *
 * 沒有任何有聲來源時回傳 null,呼叫端自己決定要不要輸出無聲軌。
 */
export async function renderMixedAudio(
  opts: RenderOptions = {},
): Promise<AudioBuffer | null> {
  const { onProgress, gain = 1 } = opts
  const state = useProject.getState()
  const range = playRange(state)
  if (range.durationMs <= 0) return null

  const frames = Math.ceil((range.durationMs / 1000) * OUTPUT_SAMPLE_RATE)
  const ctx = new OfflineAudioContext(OUTPUT_CHANNELS, frames, OUTPUT_SAMPLE_RATE)
  const countInMs = countInDurationMs(state)

  // 整體音量:所有來源(素材 + 節拍器)都經過這一個節點再出去。
  // 用 GainNode 而不是事後把 buffer 乘一遍 —— 免掉整段 PCM 的第二次走訪,
  // 而且 gain = 1 時是零成本的直通。
  const master = ctx.createGain()
  master.gain.value = gain
  master.connect(ctx.destination)
  // 輸出的時間軸:[0, countInMs) 是預備拍,之後接保留的內容
  const keepFromMs = state.rangeInMs

  onProgress?.(0.05)

  const ids: ClipId[] = ['a', 'b']
  let mixed = 0
  for (const id of ids) {
    const clip = state.clips[id]
    if (!clip || clip.volume <= 0) continue

    const buffer = await decodeClip(ctx, clip)
    if (!buffer) continue

    // 這支素材從內容時間 offsetMs 開始;保留的段落從 keepFromMs 開始。
    // 兩者取晚的那個當作實際要放的起點。
    const startContentMs = Math.max(keepFromMs, clip.offsetMs)
    const whenSec = (countInMs + startContentMs - keepFromMs) / 1000
    // 起點落在素材中間的話,從 buffer 的對應位置切進去
    const seekSec = (startContentMs - clip.offsetMs) / 1000
    if (seekSec >= buffer.duration) continue

    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.value = clip.volume
    source.connect(gain).connect(master)
    source.start(whenSec, seekSec)
    mixed++
    // 兩支素材各佔解碼階段的一半 —— 之前是 0.05 + 0.35 × mixed,
    // 第二支就會跳到 0.75,接著又被後面的 0.5 拉回去,進度條會倒退
    onProgress?.(0.05 + 0.45 * (mixed / ids.length))
  }

  // 節拍器:輸出的 0 秒就是預備拍的開頭,click 的時間可以直接用
  const plan = countInPlan(state.countIn, state.tempo?.phaseMs ?? 0)
  let clicks = 0
  plan.clickTimesMs.forEach((tMs, index) => {
    const whenSec = tMs / 1000
    if (whenSec >= range.durationMs / 1000) return
    // 與預覽共用同一份,音色與重音規則不會分岔
    createClick(ctx, index, whenSec, state.countIn.volume, [master])
    clicks++
  })

  if (mixed === 0 && clicks === 0) return null

  onProgress?.(0.5)
  return ctx.startRendering()
}

export async function exportAudio(
  opts: AudioExportOptions = {},
): Promise<AudioExportResult> {
  const { format = 'wav', gain = 1, onProgress } = opts
  const state = useProject.getState()
  const range = playRange(state)
  if (range.durationMs <= 0) throw new Error('輸出範圍是空的')

  /*
    MP3 編碼器(LAME 的 WASM 版)304KB,加上它依賴的 mediabunny ——
    WAV 那條路完全不需要這些,所以只在真的選了 MP3 時才載。
    跟影片匯出的編碼器是同一種處理方式。

    放在混音**之前**載:載不到的話要在花時間混音前就失敗,
    而且介面上「準備編碼器」那段才對得上實際在等的東西。
  */
  const mp3 = format === 'mp3' ? await import('./mp3Export') : null

  const rendered = await renderMixedAudio({ onProgress, gain })
  if (!rendered) throw new Error('沒有可匯出的聲音')
  onProgress?.(ENCODE_STARTS_AT)

  const blob = mp3 ? await mp3.encodeMp3(rendered, MP3_BITRATE) : encodeWav(rendered)
  onProgress?.(1)

  return { blob, durationMs: range.durationMs, extension: format }
}
