import { describe, expect, it } from 'vitest'
import { pickMaster, setVolume, type VideoRefs } from './usePlaybackEngine'
import type { Clip, ClipId } from '../lib/types'

/**
 * 時鐘主控的選擇。
 *
 * 這件事決定「校正的代價丟給誰」:主控永遠不會被 seek 也不會被改速度,
 * 從屬才會。丟錯邊的話,解不動的那一支會被反覆 seek —— 那就是手機上
 * 「其中一支影片一直頓」的樣子。
 */

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'a',
  url: 'blob:test',
  name: 'test.mp4',
  durationMs: 60_000,
  width: 1280,
  height: 720,
  fps: 30,
  offsetMs: 0,
  transform: { scale: 1, offsetX: 0, offsetY: 0, mirrored: false },
  crop: null,
  volume: 1,
  envelope: null,
  onset: null,
  ...over,
})

const refs = (ready: Partial<Record<ClipId, number | null>> = {}): VideoRefs => {
  const make = (readyState: number | null) => ({
    current: readyState === null ? null : ({ readyState } as HTMLVideoElement),
  })
  return {
    a: make(ready.a === undefined ? 4 : ready.a),
    b: make(ready.b === undefined ? 4 : ready.b),
  }
}

describe('時鐘主控', () => {
  it('選解碼最吃力的那一支 —— 它撐不住被 seek', () => {
    const clips = {
      a: clip({ id: 'a', width: 1280, height: 720 }),
      b: clip({ id: 'b', width: 1920, height: 1080 }),
    }
    expect(pickMaster(refs(), clips, 0)).toBe('b')
  })

  it('反過來也一樣,跟 A/B 的順序無關', () => {
    const clips = {
      a: clip({ id: 'a', width: 1920, height: 1080 }),
      b: clip({ id: 'b', width: 1280, height: 720 }),
    }
    expect(pickMaster(refs(), clips, 0)).toBe('a')
  })

  it('解析度一樣時維持原本的順序,常見情況行為不變', () => {
    const clips = { a: clip({ id: 'a' }), b: clip({ id: 'b' }) }
    expect(pickMaster(refs(), clips, 0)).toBe('a')
  })

  it('還沒解得出畫面的不能當主控', () => {
    const clips = {
      a: clip({ id: 'a', width: 1280, height: 720 }),
      b: clip({ id: 'b', width: 1920, height: 1080 }),
    }
    // B 比較重,但它還沒 ready
    expect(pickMaster(refs({ b: 1 }), clips, 0)).toBe('a')
  })

  it('不在自己時間範圍內的不能當主控', () => {
    const clips = {
      a: clip({ id: 'a', width: 1280, height: 720 }),
      // B 更重,但第 5 秒才進場
      b: clip({ id: 'b', width: 1920, height: 1080, offsetMs: 5000 }),
    }
    expect(pickMaster(refs(), clips, 0)).toBe('a')
    expect(pickMaster(refs(), clips, 6000)).toBe('b')
  })

  it('兩支都不在範圍內時沒有主控 —— 退回牆鐘推進', () => {
    const clips = {
      a: clip({ id: 'a', durationMs: 1000 }),
      b: clip({ id: 'b', offsetMs: 5000 }),
    }
    expect(pickMaster(refs(), clips, 3000)).toBeNull()
  })

  it('量不到尺寸的素材不搶主控', () => {
    const clips = {
      a: clip({ id: 'a', width: 1280, height: 720 }),
      b: clip({ id: 'b', width: 0, height: 0 }),
    }
    expect(pickMaster(refs(), clips, 0)).toBe('a')
  })

  it('看的是實際在播的來源:4K 原檔換成 540p 代理檔後就不該再當主控', () => {
    const clips = {
      a: clip({ id: 'a', width: 1920, height: 1080 }),
      b: clip({ id: 'b', width: 3840, height: 2160 }),
    }
    const r = refs()
    r.a.current = { readyState: 4, videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement
    r.b.current = { readyState: 4, videoWidth: 960, videoHeight: 540 } as HTMLVideoElement
    expect(pickMaster(r, clips, 0)).toBe('a')
  })

  it('兩支都輕(≤1080p)時,唯一有聲音的那支當主控 —— iOS 改有聲影片的速度會頓', () => {
    const clips = {
      a: clip({ id: 'a', width: 1920, height: 1080, volume: 0 }),
      b: clip({ id: 'b', width: 960, height: 540, volume: 1 }),
    }
    expect(pickMaster(refs(), clips, 0)).toBe('b')
  })

  it('有一支是 4K 時,仍然讓重的當主控(對 4K 反覆 seek 更糟)', () => {
    const clips = {
      a: clip({ id: 'a', width: 3840, height: 2160, volume: 0 }),
      b: clip({ id: 'b', width: 960, height: 540, volume: 1 }),
    }
    expect(pickMaster(refs(), clips, 0)).toBe('a')
  })

  it('只有一支素材時就是它', () => {
    expect(pickMaster(refs({ b: null }), { a: clip(), b: null }, 0)).toBe('a')
  })
})

describe('音量', () => {
  /** 模擬 iOS:volume 是唯讀的,寫了也永遠讀回 1 */
  const iosVideo = () => {
    let writes = 0
    const el = { muted: false } as HTMLVideoElement & { writes: () => number }
    Object.defineProperty(el, 'volume', {
      get: () => 1,
      set: () => {
        writes++
      },
    })
    el.writes = () => writes
    return el
  }

  it('音量 0 一定要設 muted —— iOS 不理 volume,兩支有聲影片會互相暫停', () => {
    const el = iosVideo()
    setVolume(el, 0)
    expect(el.muted).toBe(true)
    setVolume(el, 0.8)
    expect(el.muted).toBe(false)
  })

  it('iOS 上 volume 讀回來永遠是 1,不能因此每幀都寫一次', () => {
    const el = iosVideo()
    for (let i = 0; i < 60; i++) setVolume(el, 0.5)
    expect(el.writes()).toBe(1)
  })
})
