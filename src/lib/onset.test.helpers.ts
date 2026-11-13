/** 測試用的合成音訊。給 onset.test.ts 用 */
export const SR = 16000

function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** 合成一首「歌」:大鼓、小鼓、hi-hat、每小節換和弦、隨機旋律音 */
export function makeSong(seconds: number, seed = 7): Float32Array {
  const n = Math.floor(seconds * SR)
  const out = new Float32Array(n)
  const rnd = lcg(seed)
  const beat = SR / 2 // 120 BPM
  const add = (start: number, len: number, f: (i: number) => number) => {
    for (let i = 0; i < len && start + i < n; i++) out[start + i] += f(i)
  }
  for (let b = 0; b * beat < n; b++) {
    const t = Math.floor(b * beat)
    if (b % 4 === 0 || rnd() < 0.5) {
      const amp = 0.5 + rnd() * 0.5
      add(t, 3000, (i) => amp * Math.sin(2 * Math.PI * 55 * (i / SR) * (1 + 2 * Math.exp(-i / 300))) * Math.exp(-i / 1200))
    }
    if (b % 2 === 1) {
      const amp = 0.3 + rnd() * 0.3
      add(t, 2000, () => amp * (rnd() * 2 - 1))
    }
    for (const h of [0, 0.5]) {
      if (rnd() < 0.8) {
        const amp = 0.05 + rnd() * 0.15
        let last = 0
        add(Math.floor(t + h * beat), 400, (i) => {
          const w = rnd() * 2 - 1
          const v = w - last // 一階差分 ≈ 高通
          last = w
          return amp * v * Math.exp(-i / 80)
        })
      }
    }
    if (b % 4 === 0) {
      const root = 110 * Math.pow(2, Math.floor(rnd() * 12) / 12)
      const len = Math.floor(beat * 4)
      add(t, len, (i) =>
        0.08 * Math.min(1, i / 200) *
        (Math.sin(2 * Math.PI * root * i / SR) +
          Math.sin(2 * Math.PI * root * 1.26 * i / SR) +
          Math.sin(2 * Math.PI * root * 1.5 * i / SR)),
      )
    }
    for (const h of [0, 0.5]) {
      if (rnd() < 0.6) {
        const f = 440 * Math.pow(2, Math.floor(rnd() * 24 - 6) / 12)
        const amp = 0.05 + rnd() * 0.1
        add(Math.floor(t + h * beat), Math.floor(beat / 2), (i) => amp * Math.sin(2 * Math.PI * f * i / SR) * Math.exp(-i / 3000))
      }
    }
  }
  return out
}

/**
 * 教室裡用手機錄的版本:從 shift 秒開始錄,音樂只剩 gain 倍,
 * 低頻被削弱,再加上噪音、跺腳(很大聲的低頻悶響)與講話(中頻雜訊團)。
 */
export function recordInRoom(song: Float32Array, shiftSec: number, gain: number, seed = 3, stomps = true): Float32Array {
  const rnd = lcg(seed)
  const start = Math.floor(shiftSec * SR)
  const n = song.length - start
  const out = new Float32Array(n)
  // 手機收音:一階高通削掉低頻
  let prevIn = 0
  let prevOut = 0
  for (let i = 0; i < n; i++) {
    const x = song[start + i] * gain
    const y = 0.97 * (prevOut + x - prevIn)
    prevIn = x
    prevOut = y
    out[i] = y + (rnd() * 2 - 1) * gain * 0.15
  }
  // 跺腳:比音樂大聲好幾倍、時間完全隨機
  for (let k = 0; stomps && k < (n / SR) * 2.5; k++) {
    const t = Math.floor(rnd() * n)
    const amp = gain * (2 + rnd() * 3)
    for (let i = 0; i < 2500 && t + i < n; i++) {
      out[t + i] += amp * Math.sin(2 * Math.PI * 80 * i / SR) * Math.exp(-i / 500)
    }
  }
  // 講話:一段段中頻雜訊團
  for (let k = 0; k < (n / SR) * 0.4; k++) {
    const t = Math.floor(rnd() * n)
    const len = Math.floor(SR * (0.3 + rnd() * 1.2))
    const amp = gain * (0.5 + rnd())
    const f = 200 + rnd() * 200
    for (let i = 0; i < len && t + i < n; i++) {
      const syll = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * i / SR)
      out[t + i] += amp * syll * Math.sin(2 * Math.PI * f * i / SR + rnd() * 0.5)
    }
  }
  return out
}


/**
 * 有段落結構的歌:每個段落裡每一小節**完全一樣**(循環製作的舞曲就是這樣),
 * 段落之間的配器與音量不同。主歌、副歌還會重複出現。
 *
 * 這是「對到隔壁幾小節」的最壞情況:只看起音,段落內部每隔一小節都完全吻合,
 * 只有段落交界的地方能分辨對錯。
 */
export function makeStructuredSong(seed = 21): Float32Array {
  const bar = SR * 2 // 120 BPM,一小節 2 秒
  const rndPattern = lcg(seed)
  type Section = { pattern: Float32Array; gain: number }
  const makeBar = (density: number, pad: boolean): Float32Array => {
    const out = new Float32Array(bar)
    const step = bar / 16
    for (let s = 0; s < 16; s++) {
      const t = Math.floor(s * step)
      if (s % 4 === 0 || rndPattern() < density * 0.4) {
        const amp = 0.4 + rndPattern() * 0.6
        for (let i = 0; i < 2400 && t + i < bar; i++) out[t + i] += amp * Math.sin(2 * Math.PI * 60 * i / SR) * Math.exp(-i / 900)
      }
      if (rndPattern() < density) {
        const amp = 0.05 + rndPattern() * 0.25
        const r2 = lcg(seed * 31 + s)
        for (let i = 0; i < 800 && t + i < bar; i++) out[t + i] += amp * (r2() * 2 - 1) * Math.exp(-i / 200)
      }
      if (rndPattern() < density * 0.7) {
        const f = 220 * Math.pow(2, Math.floor(rndPattern() * 24) / 12)
        const amp = 0.05 + rndPattern() * 0.15
        for (let i = 0; i < step && t + i < bar; i++) out[t + i] += amp * Math.sin(2 * Math.PI * f * i / SR) * Math.exp(-i / 2500)
      }
    }
    if (pad) for (let i = 0; i < bar; i++) out[i] += 0.12 * Math.sin(2 * Math.PI * 330 * i / SR)
    return out
  }
  const intro: Section = { pattern: makeBar(0.2, false), gain: 0.4 }
  const verse: Section = { pattern: makeBar(0.4, false), gain: 0.7 }
  const pre: Section = { pattern: makeBar(0.6, true), gain: 0.8 }
  const chorus: Section = { pattern: makeBar(0.9, true), gain: 1 }
  const bridge: Section = { pattern: makeBar(0.3, true), gain: 0.5 }
  const form: [Section, number][] = [
    [intro, 4], [verse, 8], [pre, 4], [chorus, 8], [verse, 8], [pre, 4], [chorus, 8], [bridge, 4], [chorus, 8],
  ]
  const total = form.reduce((n, [, bars]) => n + bars, 0)
  const out = new Float32Array(total * bar)
  let pos = 0
  for (const [sec, bars] of form) {
    for (let k = 0; k < bars; k++) {
      for (let i = 0; i < bar; i++) out[pos + i] = sec.pattern[i] * sec.gain
      pos += bar
    }
  }
  return out
}
