/**
 * 預覽代理檔的規則。獨立出來是因為它不能依賴 mediabunny ——
 * 載入素材時就要判斷「要不要做代理檔」,而 mediabunny 只在真的要轉檔時才下載。
 *
 * 為什麼要代理檔:
 *   預覽是兩個 `<video>` 同時硬解。iPhone 錄的素材是 4K 或 1080p 的 HEVC,
 *   關鍵影格間隔又長 —— 兩支一起播 iPad 就追不上,逐幀 ←→ 與同步校正的 seek
 *   每次都得從上一個關鍵影格重解一大段。
 *   代理檔是短邊 540、H.264、每 0.5 秒一個關鍵影格:解碼量是 4K 的 1/16,
 *   seek 最多只要往回解半秒。匯出仍然讀原檔,畫質不受影響。
 */

/** 代理檔的短邊 */
export const PROXY_SHORT_SIDE = 540

/**
 * 短邊超過這個值才值得做。720p 以下解碼本來就輕,轉一次的代價划不來。
 */
export const PROXY_THRESHOLD = 720

/** 關鍵影格間隔(秒)。seek 與逐幀最壞要從這麼遠之前開始解。 */
export const PROXY_KEYFRAME_INTERVAL = 0.5

/** 540p 的 H.264 用 2Mbps 足夠看清楚動作,3 分鐘約 45MB */
export const PROXY_BITRATE = 2_000_000

export function needsProxy(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false // 純音檔
  return Math.min(width, height) > PROXY_THRESHOLD
}

/**
 * 代理檔的尺寸(顯示方向,已考慮旋轉)。兩邊都取偶數 —— 編碼器普遍要求。
 * 只會縮小,不會放大。
 */
export function proxySize(
  width: number,
  height: number,
  shortSide = PROXY_SHORT_SIDE,
): { width: number; height: number } {
  const short = Math.min(width, height)
  const scale = Math.min(1, shortSide / short)
  return {
    width: toEven(width * scale),
    height: toEven(height * scale),
  }
}

function toEven(v: number): number {
  return Math.max(2, Math.round(v / 2) * 2)
}

/** 代理檔最高格率。60fps 的來源只留一半的格,編碼與縮圖的工作量直接減半 */
export const PROXY_MAX_FPS = 30

/**
 * 真的打開檔案、看到編碼與格率之後的第二道判斷。
 *
 * needsProxy 只看尺寸(載入時就要決定,還沒有 mediabunny)。但 1080p30 的 H.264 ——
 * 例如從 YouTube 下載的官方練習影片 —— iPad 解起來很輕鬆,幫它轉代理檔只是白白
 * 排在 iPhone 的 4K HEVC 前面,讓真正需要的那支等更久。
 *
 * 需要轉的:任何 HEVC(iPhone 預設)、超過 1080p30 像素量的任何東西(4K、1080p60)。
 */
export function worthProxying(info: {
  codec: string | null
  width: number
  height: number
  fps: number
}): boolean {
  const pixelRate = info.width * info.height * Math.max(1, info.fps)
  const light = info.codec === 'avc' && pixelRate <= 1920 * 1080 * 31
  return !light
}

/** 代理檔的格率:不超過 PROXY_MAX_FPS。undefined = 沿用原檔 */
export function proxyFrameRate(sourceFps: number): number | undefined {
  return sourceFps > PROXY_MAX_FPS + 1 ? PROXY_MAX_FPS : undefined
}

/** WebCodecs 轉檔至少跑這麼久才判斷快慢,太早判斷會被開頭的初始化時間誤導 */
export const PROBE_SECONDS = 8
/** 預估總耗時超過影片長度的這個倍數,就改用即時錄製(它大約等於影片長度) */
export const SLOW_FACTOR = 1.2

/**
 * WebCodecs 轉檔是不是比「播一遍錄下來」還慢。
 *
 * 不事先猜哪種檔案會慢 —— 實測 iPhone 4K HDR 的 .mov 走 WebCodecs 要 20 分鐘,
 * 桌機上同一條路卻比即時快 10 倍。直接跑幾秒看實際速度最準。
 */
export function tooSlowForWebCodecs(
  elapsedSec: number,
  progress: number,
  durationSec: number,
): boolean {
  if (elapsedSec < PROBE_SECONDS || durationSec <= 0) return false
  if (progress <= 0) return true
  return elapsedSec / progress > durationSec * SLOW_FACTOR
}
