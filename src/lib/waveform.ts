/**
 * 波形的滿格參考點:包絡的第 95 百分位。
 *
 * 舊版用最大值。教室錄音裡一聲靠近手機的跺腳就是最大值,整條音樂被壓到幾乎看不見,
 * 兩條波形看起來「差很多」,沒辦法拿來確認對齊。用第 95 百分位,零星的大聲響只會頂到滿格,
 * 不會把其他部分壓扁。快取起來,畫面每次重繪都要用。
 */
const refCache = new WeakMap<Float32Array, number>()
export function waveformRef(env: Float32Array): number {
  const cached = refCache.get(env)
  if (cached !== undefined) return cached
  const sorted = Float32Array.from(env).sort()
  const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  refCache.set(env, ref)
  return ref
}

/** 波形顯示的動態範圍(dB)。低於滿格這麼多就畫成一條線 */
const WAVEFORM_RANGE_DB = 36

/**
 * 以分貝顯示,0..1。線性刻度下小聲的段落(前奏、主歌)幾乎看不見,
 * 而段落的高低起伏正是用眼睛確認「有沒有對到同一段」的線索。
 */
export function waveformHeight(level: number, ref: number): number {
  if (level <= 0 || ref <= 0) return 0
  const db = 20 * Math.log10(level / ref)
  return Math.min(1, Math.max(0, 1 + db / WAVEFORM_RANGE_DB))
}
