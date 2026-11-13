import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'
import {
  PROXY_BITRATE,
  PROXY_KEYFRAME_INTERVAL,
  PROXY_MAX_FPS,
  proxyFrameRate,
  proxySize,
  worthProxying,
} from './proxyPolicy'
import { transcodeToMp4, type TranscodeMethod } from './transcode'

/**
 * 轉出預覽用的代理檔(規則與理由見 proxyPolicy.ts,轉檔本身見 transcode.ts)。
 *
 * 由 store 動態載入:mediabunny 很大,只有真的要轉檔才下載。
 * 回傳 null = 這支解碼很輕,不需要代理檔。
 */
export async function buildProxy(
  file: Blob,
  opts: {
    onProgress?: (ratio: number) => void
    onMethod?: (method: TranscodeMethod) => void
    signal?: AbortSignal
  } = {},
): Promise<Blob | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  let info: { width: number; height: number; fps: number }
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new Error('沒有視訊軌')
    const fps = (await video.computePacketStats(120)).averagePacketRate
    info = { width: video.displayWidth, height: video.displayHeight, fps }
    // 看過編碼與格率才知道值不值得轉
    if (!worthProxying({ codec: video.codec, ...info })) return null
  } finally {
    input.dispose()
  }

  return transcodeToMp4(file, {
    ...proxySize(info.width, info.height),
    // 30fps 以下不給 frameRate,代理檔跟原檔一格對一格。
    // 60fps 的來源降成 30:編碼工作量減半。代價是預覽逐幀時每兩步才換一張畫面,
    // 匯出仍是原檔的 60fps。
    frameRate: proxyFrameRate(info.fps),
    captureFps: Math.min(PROXY_MAX_FPS, Math.round(info.fps) || PROXY_MAX_FPS),
    bitrate: PROXY_BITRATE,
    keyFrameInterval: PROXY_KEYFRAME_INTERVAL,
    ...opts,
  })
}
