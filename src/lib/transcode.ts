import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  canEncodeVideo,
} from 'mediabunny'
import type { InputAudioTrack } from 'mediabunny'
import { captureToMp4 } from './capture'
import { tooSlowForWebCodecs } from './proxyPolicy'

export type TranscodeMethod = 'webcodecs' | 'capture'

export interface TranscodeOptions {
  /** 輸出尺寸(顯示方向),偶數 */
  width: number
  height: number
  /** WebCodecs 路徑的輸出格率。undefined = 沿用原檔 */
  frameRate?: number
  /** 即時錄製路徑的最高格率 */
  captureFps: number
  bitrate: number
  keyFrameInterval: number
  onProgress?: (ratio: number) => void
  /** 換方法時通知,介面要告訴使用者「即時錄製要一直開著這個畫面」 */
  onMethod?: (method: TranscodeMethod) => void
  signal?: AbortSignal
}

/**
 * 把任何瀏覽器播得動的影片轉成 H.264 MP4。兩條路:
 *
 *   1. WebCodecs(mediabunny Conversion):離線解碼 → 縮圖 → 編碼。桌機上比即時快 10 倍。
 *   2. 即時錄製(capture.ts):讓播放器播一遍、邊播邊錄。耗時約等於影片長度。
 *
 * 先跑 1,跑了幾秒發現比 2 還慢(iPhone 錄的 4K HDR HEVC 實測要 20 分鐘)就取消改走 2。
 * 1 直接失敗(解不開、編不了)也改走 2。
 */
export async function transcodeToMp4(file: Blob, opts: TranscodeOptions): Promise<Blob> {
  const { signal } = opts
  try {
    const blob = await tryWebCodecs(file, opts)
    if (blob) return blob
  } catch (err) {
    if (signal?.aborted) throw err
    console.warn('[transcode] WebCodecs 轉檔失敗,改用即時錄製', err)
  }
  if (signal?.aborted) throw new DOMException('canceled', 'AbortError')

  opts.onMethod?.('capture')
  opts.onProgress?.(0)
  return captureToMp4(file, {
    width: opts.width,
    height: opts.height,
    maxFps: opts.captureFps,
    bitrate: opts.bitrate,
    keyFrameInterval: opts.keyFrameInterval,
    onProgress: opts.onProgress,
    signal,
  })
}

/** 回傳 null = 太慢,已經取消,請改走即時錄製 */
async function tryWebCodecs(file: Blob, opts: TranscodeOptions): Promise<Blob | null> {
  const { width, height, frameRate, bitrate, keyFrameInterval, onProgress, signal } = opts
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new Error('沒有視訊軌')
    if (!(await video.canDecode())) {
      throw new Error(`WebCodecs 解不開視訊編碼(${video.codec ?? '未知'})`)
    }
    if (!(await canEncodeVideo('avc', { width, height, bitrate }))) {
      throw new Error('這個瀏覽器不能編 H.264')
    }

    const audioTracks = await input.getAudioTracks()
    const keepAudio = await pickAudioTrack(audioTracks)
    if (audioTracks.length > 0 && !keepAudio) throw new Error('音軌解不開')

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    })
    const conversion = await Conversion.init({
      input,
      output,
      video: (track) =>
        track.id === video.id
          ? {
              width,
              height,
              fit: 'fill',
              codec: 'avc',
              bitrate,
              keyFrameInterval,
              forceTranscode: true,
              ...(frameRate ? { frameRate } : {}),
            }
          : { discard: true },
      audio: (track) => (track.id === keepAudio?.id ? {} : { discard: true }),
      showWarnings: false,
    })
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((d) => d.reason).join('、')
      throw new Error(`無法轉檔(${reasons || '原因不明'})`)
    }
    if (keepAudio && !conversion.utilizedTracks.some((t) => t.id === keepAudio.id)) {
      throw new Error('音軌無法放進 MP4')
    }

    const duration = await input.computeDuration()
    const t0 = performance.now()
    let progress = 0
    let tooSlow = false
    const check = () => {
      if (tooSlow) return
      if (tooSlowForWebCodecs((performance.now() - t0) / 1000, progress, duration)) {
        tooSlow = true
        void conversion.cancel()
      }
    }
    // 進度回呼可能很久才來一次(或根本不來),另外用計時器定期檢查
    const timer = setInterval(check, 1000)
    const abort = () => void conversion.cancel()
    signal?.addEventListener('abort', abort)

    opts.onMethod?.('webcodecs')
    try {
      if (signal?.aborted) throw new DOMException('canceled', 'AbortError')
      conversion.onProgress = (p) => {
        progress = p
        onProgress?.(p)
        check()
      }
      await conversion.execute()
    } catch (err) {
      if (tooSlow && !signal?.aborted) return null
      throw err
    } finally {
      clearInterval(timer)
      signal?.removeEventListener('abort', abort)
    }
    if (tooSlow) return null

    const buffer = output.target.buffer
    if (!buffer) throw new Error('轉檔沒有產生資料')
    return new Blob([buffer], { type: 'video/mp4' })
  } finally {
    input.dispose()
  }
}

async function pickAudioTrack(tracks: InputAudioTrack[]): Promise<InputAudioTrack | null> {
  for (const t of tracks) {
    try {
      if (await t.canDecode()) return t
    } catch {
      // 換下一條
    }
  }
  return null
}
