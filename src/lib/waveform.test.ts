import { describe, expect, it } from 'vitest'
import { waveformHeight, waveformOf } from './waveform'

/** 每 0.5 秒一下鼓,中間幾乎靜音。verse 秒數之前是主歌(鼓聲一半大),之後是副歌 */
function drums(seconds: number, verseSec: number): Float32Array {
  return Float32Array.from({ length: seconds * 100 }, (_, i) => {
    const hit = i % 50 < 5 ? 1 : 0.02
    return (i < verseSec * 100 ? 0.5 : 1) * hit
  })
}

/** 一段時間內畫出來的平均高度 */
function avgHeight(env: Float32Array, fromSec: number, toSec: number): number {
  const w = waveformOf(env)!
  let sum = 0
  for (let i = fromSec * 100; i < toSec * 100; i++) sum += waveformHeight(w.levels[i], w)
  return sum / ((toSec - fromSec) * 100)
}

describe('波形顯示', () => {
  it('混音壓得很平的歌,段落高低仍要明顯分開(不能全部滿格)', () => {
    const env = drums(120, 60)
    expect(avgHeight(env, 70, 110) - avgHeight(env, 10, 50)).toBeGreaterThan(0.4)
  })

  it('一聲很大的跺腳不會把整條音樂壓扁', () => {
    const env = drums(120, 60)
    env[9000] = 50
    expect(avgHeight(env, 70, 85)).toBeGreaterThan(0.6)
  })

  it('整體音量不影響形狀', () => {
    const env = drums(60, 30)
    const quiet = env.map((v) => v * 0.01)
    expect(avgHeight(quiet, 5, 25)).toBeCloseTo(avgHeight(env, 5, 25), 4)
  })

  it('全靜音回傳 null,不會除以零', () => {
    expect(waveformOf(new Float32Array(100))).toBeNull()
  })
})
