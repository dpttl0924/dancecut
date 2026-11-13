import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSample,
  VideoSampleSource,
} from 'mediabunny'
import type { InputAudioTrack } from 'mediabunny'

/**
 * 用瀏覽器自己的播放器把影片「播一遍、邊播邊錄」,轉成 H.264 MP4。
 *
 * 為什麼需要這條路:WebCodecs 轉檔(proxy.ts 的 Conversion)在 iPhone 錄的
 * 4K HDR HEVC 上非常慢 —— 實測 3 分鐘的 .mov 要 20 分鐘,1080p60 的 mp4 也要 144 秒。
 * 但同一支影片,Safari 的 `<video>` 播起來很順:播放器走的是硬體解碼與系統的色彩管線,
 * WebCodecs 那邊則要把每一格 10-bit HDR 畫面在 canvas 裡轉一次。
 * 所以乾脆讓播放器解碼,我們只負責把播出來的每一格畫到小 canvas 上再編碼。
 * 所需時間約等於影片長度,而且跟原檔是什麼格式無關 —— 播得動就轉得動。
 *
 * 聲音不從播放器錄(會被重新取樣、還可能跟畫面差幾十毫秒),
 * 而是直接把原檔的 AAC 封包原封不動搬過去;不是 AAC 才解碼後重新編碼。
 *
 * 代價:
 *   - 播放器忙不過來時會掉格,輸出就少那幾格(時間戳仍正確,不會不同步)。
 *   - 切到別的 App 時 iOS 會暫停播放,回來才會繼續。
 */

export interface CaptureOptions {
  /** 輸出尺寸(顯示方向)。兩邊都要是偶數 */
  width: number
  height: number
  /** 最高格率。來源比較高時會跳著取 */
  maxFps: number
  bitrate: number
  /** 關鍵影格間隔(秒) */
  keyFrameInterval: number
  onProgress?: (ratio: number) => void
  signal?: AbortSignal
}

/** 編碼器排隊超過這麼多格就先暫停播放,等它消化 —— 寧可慢一點也不要掉格 */
const MAX_QUEUED_FRAMES = 6

export async function captureToMp4(file: Blob, opts: CaptureOptions): Promise<Blob> {
  const { width, height, maxFps, bitrate, keyFrameInterval, onProgress, signal } = opts
  if (typeof HTMLVideoElement === 'undefined' || !('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
    throw new Error('這個瀏覽器不支援逐格擷取(requestVideoFrameCallback)')
  }

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  })
  const videoSource = new VideoSampleSource({
    codec: 'avc',
    bitrate,
    keyFrameInterval,
    latencyMode: 'quality',
  })
  output.addVideoTrack(videoSource, { frameRate: maxFps })

  // ── 聲音:先決定怎麼搬,軌道一定要在 start() 之前加好 ──
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  let audioJob: (() => Promise<void>) | null = null
  try {
    const track = await pickAudioTrack(await input.getAudioTracks())
    if (track) audioJob = await prepareAudio(output, track)
  } catch {
    // 聲音搬不過來就輸出無聲的,畫面還是能用
  }

  await output.start()

  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('無法建立 canvas')

  // iOS 不會替不在畫面上的 <video> 解碼出畫面,所以要放進 DOM;
  // 但不能 display:none(一樣不解碼),改成縮到角落、幾乎透明
  Object.assign(video.style, {
    position: 'fixed',
    left: '0',
    bottom: '0',
    width: '2px',
    height: '2px',
    opacity: '0.01',
    pointerEvents: 'none',
  })
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = url
  document.body.appendChild(video)

  const cleanup = () => {
    video.pause()
    video.removeAttribute('src')
    video.load()
    video.remove()
    URL.revokeObjectURL(url)
    input.dispose()
  }

  try {
    if (audioJob) await audioJob()

    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () => reject(new Error('播放器打不開這支影片'))
    })
    const duration = video.duration
    let detach = () => {}

    // 第 0 格:play() 之前播放器已經停在第一格,但 requestVideoFrameCallback 只回報
    // 「新呈現的」影格,不先抓的話輸出會從第二格(0.033 秒)才開始
    ctx.drawImage(video, 0, 0, width, height)
    const firstSample = new VideoSample(canvas, { timestamp: 0, duration: 1 / maxFps })
    try {
      await videoSource.add(firstSample)
    } finally {
      firstSample.close()
    }

    await new Promise<void>((resolve, reject) => {
      let queued = 0
      let chain: Promise<void> = Promise.resolve()
      let lastTime = 0
      let finished = false
      const minGap = 1 / maxFps - 0.002

      const fail = (err: unknown) => {
        if (finished) return
        finished = true
        reject(err)
      }

      const resumeWhenVisible = () => {
        if (document.visibilityState === 'visible' && !finished && queued < MAX_QUEUED_FRAMES) {
          void video.play().catch(() => {})
        }
      }
      document.addEventListener('visibilitychange', resumeWhenVisible)
      const onAbort = () => fail(new DOMException('canceled', 'AbortError'))
      signal?.addEventListener('abort', onAbort)
      if (signal?.aborted) onAbort()
      detach = () => {
        document.removeEventListener('visibilitychange', resumeWhenVisible)
        signal?.removeEventListener('abort', onAbort)
      }

      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (finished) return
        const t = meta.mediaTime
        if (t - lastTime >= minGap) {
          lastTime = t
          // 畫面在這一刻就要擷取下來 —— 等排到編碼器時,播放器早就換到下一格了
          ctx.drawImage(video, 0, 0, width, height)
          const sample = new VideoSample(canvas, { timestamp: t, duration: 1 / maxFps })
          queued++
          if (queued >= MAX_QUEUED_FRAMES) video.pause()
          chain = chain
            .then(() => videoSource.add(sample))
            .then(() => {
              sample.close()
              queued--
              if (queued <= 1 && video.paused && !video.ended) resumeWhenVisible()
            })
            .catch(fail)
          if (duration > 0) onProgress?.(Math.min(0.99, t / duration))
        }
        video.requestVideoFrameCallback(onFrame)
      }

      video.onended = () => {
        if (finished) return
        void chain.then(() => {
          if (finished) return
          finished = true
          resolve()
        })
      }
      video.onerror = () => fail(new Error('播放途中出錯'))

      video.requestVideoFrameCallback(onFrame)
      void video.play().catch(fail)
    }).finally(() => detach())

    videoSource.close()
    await output.finalize()
    const buffer = output.target.buffer
    if (!buffer) throw new Error('轉檔沒有產生資料')
    onProgress?.(1)
    return new Blob([buffer], { type: 'video/mp4' })
  } catch (err) {
    void output.cancel()
    throw err
  } finally {
    cleanup()
  }
}

async function pickAudioTrack(tracks: InputAudioTrack[]): Promise<InputAudioTrack | null> {
  // 優先 AAC:可以原封不動搬,不必解碼
  for (const t of tracks) if (t.codec === 'aac') return t
  for (const t of tracks) {
    try {
      if (await t.canDecode()) return t
    } catch {
      // 換下一條
    }
  }
  return null
}

/**
 * 加好音軌,回傳「把聲音灌進去」的工作。
 * AAC 直接搬封包;其他編碼(很少見)解碼後重新編成 AAC。
 */
async function prepareAudio(
  output: Output,
  track: InputAudioTrack,
): Promise<() => Promise<void>> {
  if (track.codec === 'aac') {
    const source = new EncodedAudioPacketSource('aac')
    output.addAudioTrack(source)
    const decoderConfig = (await track.getDecoderConfig()) ?? undefined
    return async () => {
      let first = true
      for await (const packet of new EncodedPacketSink(track).packets()) {
        await source.add(packet, first && decoderConfig ? { decoderConfig } : undefined)
        first = false
      }
      source.close()
    }
  }
  const source = new AudioSampleSource({ codec: 'aac', bitrate: 128_000 })
  output.addAudioTrack(source)
  return async () => {
    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        await source.add(sample)
      } finally {
        sample.close()
      }
    }
    source.close()
  }
}
