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
import {
  PROXY_BITRATE,
  PROXY_KEYFRAME_INTERVAL,
  proxySize,
} from './proxyPolicy'

/**
 * 轉出預覽用的代理檔(規則與理由見 proxyPolicy.ts)。
 *
 * 由 store 動態載入:mediabunny 很大,只有真的要轉檔才下載。
 *
 * 音軌只留一條:預覽的聲音也是從這支代理檔播的,所以一定要有聲音,
 * 但 iPhone 開空間音訊錄的 .mov 會多帶一條 APAC 軌,MP4 裝不下也解不開。
 * 挑第一條瀏覽器解得開的(通常就是 AAC),原封不動複製過去。
 * 原檔有聲音、代理檔卻沒有的話就當作失敗 —— 寧可繼續用原檔預覽,
 * 也不要讓使用者聽不到聲音。
 */
export async function buildProxy(
  file: Blob,
  opts: { onProgress?: (ratio: number) => void; signal?: AbortSignal } = {},
): Promise<Blob> {
  const { onProgress, signal } = opts
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new Error('沒有視訊軌')
    if (!(await video.canDecode())) throw new Error(`這個瀏覽器解不開視訊編碼(${video.codec ?? '未知'})`)

    const size = proxySize(video.displayWidth, video.displayHeight)
    if (!(await canEncodeVideo('avc', { ...size, bitrate: PROXY_BITRATE }))) {
      throw new Error('這個瀏覽器不能編 H.264')
    }

    const audioTracks = await input.getAudioTracks()
    const keepAudio = await pickAudioTrack(audioTracks)
    if (audioTracks.length > 0 && !keepAudio) throw new Error('音軌解不開,代理檔會沒有聲音')

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
              ...size,
              fit: 'fill',
              codec: 'avc',
              bitrate: PROXY_BITRATE,
              keyFrameInterval: PROXY_KEYFRAME_INTERVAL,
              forceTranscode: true,
              // 刻意不給 frameRate:代理檔要跟原檔一格對一格,逐幀才會落在同一張畫面上
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
      throw new Error('音軌無法放進代理檔,代理檔會沒有聲音')
    }

    const abort = () => void conversion.cancel()
    signal?.addEventListener('abort', abort)
    try {
      if (signal?.aborted) throw new DOMException('canceled', 'AbortError')
      conversion.onProgress = (p) => onProgress?.(p)
      await conversion.execute()
    } finally {
      signal?.removeEventListener('abort', abort)
    }

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
