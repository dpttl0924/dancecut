import { describe, expect, it } from 'vitest'
import { waveformHeight, waveformRef } from './waveform'

describe('波形顯示', () => {
  it('一聲很大的跺腳不會把整條音樂壓扁', () => {
    const env = new Float32Array(1000).fill(0.01)
    env[500] = 1 // 跺腳,比音樂大 100 倍
    const ref = waveformRef(env)
    expect(waveformHeight(0.01, ref)).toBe(1)
    expect(waveformHeight(1, ref)).toBe(1)
  })

  it('整體音量不影響形狀', () => {
    const env = Float32Array.from({ length: 1000 }, (_, i) => 0.1 + 0.1 * Math.sin(i / 50) ** 2)
    const quiet = env.map((v) => v * 0.01)
    const a = waveformHeight(env[123], waveformRef(env))
    const b = waveformHeight(quiet[123], waveformRef(quiet))
    expect(b).toBeCloseTo(a, 5)
  })

  it('小聲的段落還看得到,不會變成一條線', () => {
    expect(waveformHeight(0.1, 1)).toBeGreaterThan(0.3) // -20dB
    expect(waveformHeight(0, 1)).toBe(0)
  })
})
