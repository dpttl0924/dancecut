/**
 * 轉好的預覽代理檔存在 IndexedDB,同一支影片第二次載入就不用再轉。
 *
 * 為什麼值得:iPhone 上 3 分鐘 1080p60 轉一次要 2~3 分鐘、4K 更久,
 * 時間幾乎全花在硬解原檔(桌機實測縮圖與格率對耗時影響都不到一成),參數再調也省不了多少。
 * 但官方練習影片會被反覆拿來對照,只要轉過一次,之後就是零等待。
 *
 * 用 IndexedDB 存 Blob 而不是 OPFS:iOS Safari 對 IndexedDB 的 Blob 支援久且穩定,
 * OPFS 的可寫串流到很新的版本才有。
 *
 * 全部都是盡力而為:存不進去、讀不出來(私密瀏覽、空間不足、被系統清掉)都只是退回重新轉檔,
 * 不能讓快取的問題擋住預覽。
 */

const DB_NAME = 'dance-compare'
const STORE = 'proxies'
/** 代理檔的規格(解析度、格率、關鍵影格)改了就要換版本,舊的自然失效 */
const FORMAT_VERSION = 2
/** 最多留幾支。每支 3 分鐘約 45MB */
const MAX_ENTRIES = 6

interface Entry {
  key: string
  blob: Blob
  savedAt: number
}

/**
 * 以檔名 + 大小識別同一支影片。
 *
 * 不用 lastModified:iOS 從相簿選檔時,每次交給網頁的檔案修改時間可能都不一樣,
 * 用它當 key 會永遠對不中。檔名 + 位元組數相同卻是不同影片的機率可以忽略。
 */
export function proxyCacheKey(file: { name: string; size: number }): string {
  return `v${FORMAT_VERSION}|${file.name}|${file.size}`
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('沒有 IndexedDB'))
      return
    }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function loadCachedProxy(key: string): Promise<Blob | null> {
  try {
    const db = await openDb()
    try {
      const entry = (await done(db.transaction(STORE).objectStore(STORE).get(key))) as
        | Entry
        | undefined
      return entry?.blob ?? null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

export async function saveCachedProxy(key: string, blob: Blob): Promise<void> {
  try {
    const db = await openDb()
    try {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
      await done(store.put({ key, blob, savedAt: Date.now() } satisfies Entry))

      // 超過上限就丟掉最舊的。另開一個交易:上面那個在 await 之後可能已經自動結束
      const all = (await done(
        db.transaction(STORE).objectStore(STORE).getAll(),
      )) as Entry[]
      if (all.length > MAX_ENTRIES) {
        const stale = all.sort((x, y) => y.savedAt - x.savedAt).slice(MAX_ENTRIES)
        const cleanup = db.transaction(STORE, 'readwrite').objectStore(STORE)
        await Promise.all(stale.map((e) => done(cleanup.delete(e.key))))
      }
    } finally {
      db.close()
    }
  } catch {
    // 存不進去就算了,下次重新轉
  }
}
