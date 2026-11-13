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
export function proxySize(width: number, height: number): { width: number; height: number } {
  const short = Math.min(width, height)
  const scale = Math.min(1, PROXY_SHORT_SIDE / short)
  return {
    width: toEven(width * scale),
    height: toEven(height * scale),
  }
}

function toEven(v: number): number {
  return Math.max(2, Math.round(v / 2) * 2)
}
