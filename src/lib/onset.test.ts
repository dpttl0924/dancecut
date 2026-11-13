import { describe, expect, it } from 'vitest'
import { alignOnsets, EnvelopeAccumulator, onsetFromEnvelope } from './audio'
import { makeSong, recordInRoom, SR } from './onset.test.helpers'

/**
 * 真實情境:A 是官方練習室影片(乾淨、大聲),B 是自己在教室用手機錄的 cover ——
 * 音樂從喇叭出來、離手機遠,所以很小聲,還混著跺腳、講話、環境噪音,
 * 手機收音的低頻也比較弱。
 *
 * 舊版(寫死的 log1p(x·50))在這裡偏移其實算對了,但小聲那支的相關係數
 * 從 0.30 掉到 0.13,被判成「可能不是同一首歌」。這裡把它釘成迴歸測試。
 */

function analyze(pcm: Float32Array) {
  const acc = new EnvelopeAccumulator(SR)
  acc.push([pcm], pcm.length)
  return acc.finish()
}

describe('onsetFromEnvelope', () => {
  it('整體音量差 100 倍,起音一樣(對音量免疫)', () => {
    const song = makeSong(10)
    const a = analyze(song).onset
    const b = analyze(song.map((v) => v * 0.01)).onset
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 2)
  })

  it('全靜音不會產生 NaN', () => {
    const onset = onsetFromEnvelope(new Float32Array(100))
    expect(onset.every((v) => v === 0)).toBe(true)
  })

  const song = makeSong(90)
  const songOnset = analyze(song).onset

  it.each([
    ['正常音量', 1],
    ['3% 音量', 0.03],
    ['0.3% 音量', 0.003],
  ])('教室錄音(%s、低頻被削、跺腳講話):偏移正確,相關係數不因小聲而下降', (_, gain) => {
    const room = recordInRoom(song, 7.3, gain)
    const r = alignOnsets(songOnset, analyze(room).onset)
    expect(r.lagMs).toBe(7300)
    // 跺腳是隨機的,相關係數本來就會被拉低;重點是它跟音量無關
    expect(r.score).toBeGreaterThan(0.25)
  })

  it('沒有跺腳時相關係數要夠高,不會跳出警告', () => {
    const room = recordInRoom(song, 7.3, 0.03, 3, false)
    const r = alignOnsets(songOnset, analyze(room).onset)
    expect(r.lagMs).toBe(7300)
    expect(r.score).toBeGreaterThan(0.6)
  })
})
