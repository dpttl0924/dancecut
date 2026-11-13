import { describe, expect, it } from 'vitest'
import { needsProxy, proxySize } from './proxyPolicy'

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
