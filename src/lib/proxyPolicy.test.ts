import { describe, expect, it } from 'vitest'
import { needsProxy, proxyFrameRate, proxySize, worthProxying } from './proxyPolicy'

describe('needsProxy', () => {
  it('720p 以下不做,轉一次的代價划不來', () => {
    expect(needsProxy(1280, 720)).toBe(false)
    expect(needsProxy(720, 1280)).toBe(false)
  })
  it('1080p、4K、直拍都要做', () => {
    expect(needsProxy(1920, 1080)).toBe(true)
    expect(needsProxy(3840, 2160)).toBe(true)
    expect(needsProxy(1080, 1920)).toBe(true)
  })
  it('純音檔(尺寸 0)不做', () => {
    expect(needsProxy(0, 0)).toBe(false)
  })
})

describe('proxySize', () => {
  it('橫拍 4K → 960×540', () => {
    expect(proxySize(3840, 2160)).toEqual({ width: 960, height: 540 })
  })
  it('直拍保持方向', () => {
    expect(proxySize(1080, 1920)).toEqual({ width: 540, height: 960 })
  })
  it('兩邊都是偶數,長寬比不變', () => {
    const s = proxySize(1440, 1080)
    expect(s.width % 2).toBe(0)
    expect(s.height % 2).toBe(0)
    expect(s.width / s.height).toBeCloseTo(1440 / 1080, 2)
  })
  it('不會放大', () => {
    expect(proxySize(640, 360)).toEqual({ width: 640, height: 360 })
  })
})

describe('worthProxying', () => {
  it('1080p30 的 H.264(YouTube 下載的官方影片)不轉,讓位給真正吃重的那支', () => {
    expect(worthProxying({ codec: 'avc', width: 1920, height: 1080, fps: 30 })).toBe(false)
    expect(worthProxying({ codec: 'avc', width: 1920, height: 1080, fps: 29.97 })).toBe(false)
  })
  it('iPhone 的 HEVC 一律轉', () => {
    expect(worthProxying({ codec: 'hevc', width: 1920, height: 1080, fps: 30 })).toBe(true)
  })
  it('4K 或 1080p60 即使是 H.264 也轉', () => {
    expect(worthProxying({ codec: 'avc', width: 3840, height: 2160, fps: 30 })).toBe(true)
    expect(worthProxying({ codec: 'avc', width: 1920, height: 1080, fps: 60 })).toBe(true)
  })
})

describe('proxyFrameRate', () => {
  it('60fps 降成 30,30fps 以下沿用原檔', () => {
    expect(proxyFrameRate(59.94)).toBe(30)
    expect(proxyFrameRate(30)).toBeUndefined()
    expect(proxyFrameRate(24)).toBeUndefined()
  })
})
