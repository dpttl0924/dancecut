import { describe, expect, it } from 'vitest'
import { EnvelopeAccumulator } from './audio'
import { ENVELOPE_HZ } from './types'

/**
 * 串流解碼是一塊一塊餵 PCM 進來的,塊的邊界不會剛好落在 hop 上。
 * 這裡釘死:不管怎麼切塊,算出來的包絡都要跟一次餵完一模一樣 ——
 * 否則同一支影片走不同解碼路徑會對出不同的偏移。
 */
function signal(frames: number, channels: number): Float32Array[] {
  return Array.from({ length: channels }, (_, c) => {
    const out = new Float32Array(frames)
    for (let i = 0; i < frames; i++) out[i] = Math.sin(i * 0.01 * (c + 1)) * ((i >> 9) % 3) * 0.3
    return out
  })
}

describe('EnvelopeAccumulator', () => {
  const sr = 48000
  const frames = sr * 3 + 123

  it('任意切塊的結果與一次餵完相同', () => {
    const planes = signal(frames, 2)
    const whole = new EnvelopeAccumulator(sr)
    whole.push(planes, frames)
    const a = whole.finish()

    const chunked = new EnvelopeAccumulator(sr)
    for (let start = 0, size = 1000; start < frames; start += size, size = 700 + (size * 7) % 1500) {
      const n = Math.min(size, frames - start)
      chunked.push(planes.map((p) => p.subarray(start, start + n)), n)
    }
    const b = chunked.finish()

    expect(b.envelope.length).toBe(Math.floor(frames / (sr / ENVELOPE_HZ)))
    expect(Array.from(b.envelope)).toEqual(Array.from(a.envelope))
    expect(Array.from(b.onset)).toEqual(Array.from(a.onset))
  })

  it('pushSilence 與 from 跳過都會正確推進 position', () => {
    const acc = new EnvelopeAccumulator(sr)
    acc.pushSilence(480)
    const planes = signal(1000, 1)
    acc.push(planes, 1000, 200)
    expect(acc.position).toBe(480 + 800)
  })

  it('太短時 throw', () => {
    const acc = new EnvelopeAccumulator(sr)
    acc.pushSilence(480)
    expect(() => acc.finish()).toThrow()
  })
})
