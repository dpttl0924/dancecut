import { describe, expect, it } from 'vitest'
import { proxyCacheKey } from './proxyCache'

describe('proxyCacheKey', () => {
  it('同檔名同大小就是同一支,不看修改時間(iOS 每次選檔修改時間都可能不同)', () => {
    expect(proxyCacheKey({ name: 'IMG_6878.mov', size: 123 })).toBe(
      proxyCacheKey({ name: 'IMG_6878.mov', size: 123 }),
    )
  })
  it('大小不同就不是同一支', () => {
    expect(proxyCacheKey({ name: 'a.mp4', size: 1 })).not.toBe(proxyCacheKey({ name: 'a.mp4', size: 2 }))
  })
})
