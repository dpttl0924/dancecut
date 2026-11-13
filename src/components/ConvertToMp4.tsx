import { useRef, useState } from 'react'
import { downloadBlob } from '../lib/export'
import { proxySize } from '../lib/proxyPolicy'
import type { Clip } from '../lib/types'
import { Button } from './ui'

/** 下載版的短邊。1080p 在手機、電腦、剪輯軟體都通用,檔案也不會太大 */
const MP4_SHORT_SIDE = 1080
/** 1080p H.264 用 8Mbps,3 分鐘約 180MB */
const MP4_BITRATE = 8_000_000
/** 即時錄製時的格率上限。60fps 邊播邊編在手機上容易掉格 */
const MP4_CAPTURE_FPS = 30

/**
 * 把這支素材轉成 1080p H.264 的 MP4 下載。
 *
 * 用途:iPhone 錄的 .mov(4K HDR HEVC)在很多地方打不開或很難處理 ——
 * 轉成 MP4 之後,電腦、Android、剪輯軟體都能直接用,
 * 下次拿來比對時網站也會判定為「解碼很輕」,不必再做預覽版。
 *
 * 走的是跟預覽版同一套轉檔(transcode.ts):桌機用 WebCodecs 很快,
 * iPhone 上太慢時自動改成「播一遍錄下來」,大約等於影片長度。
 */
export function ConvertToMp4({ clip }: { clip: Clip }) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  const run = async () => {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setBusy(true)
    setError('')
    setProgress(0)
    setNote('準備轉檔…')
    const t0 = performance.now()
    let phaseStart = t0
    let capturing = false
    try {
      const [{ transcodeToMp4 }, file] = await Promise.all([
        import('../lib/transcode'),
        // blob: URL 讀得回原檔,不必另外保留 File 物件
        fetch(clip.url).then((r) => r.blob()),
      ])
      const blob = await transcodeToMp4(file, {
        ...proxySize(clip.width, clip.height, MP4_SHORT_SIDE),
        captureFps: Math.min(MP4_CAPTURE_FPS, clip.fps || MP4_CAPTURE_FPS),
        bitrate: MP4_BITRATE,
        keyFrameInterval: 2,
        signal: ctrl.signal,
        onMethod: (m) => {
          capturing = m === 'capture'
          phaseStart = performance.now()
          setNote(capturing ? '改用即時錄製,請留在這個畫面' : '轉檔中…')
        },
        onProgress: (p) => {
          setProgress(p)
          const elapsed = (performance.now() - phaseStart) / 1000
          if (p > 0.02) {
            const left = Math.round((elapsed / p) * (1 - p))
            const eta = left >= 60 ? `${Math.floor(left / 60)} 分 ${left % 60} 秒` : `${left} 秒`
            setNote(`${capturing ? '即時錄製中,請留在這個畫面 · ' : ''}約剩 ${eta}`)
          }
        },
      })
      const base = clip.name.replace(/\.[^.]+$/, '')
      downloadBlob(blob, `${base}.mp4`)
      const sec = Math.round((performance.now() - t0) / 1000)
      setNote(`完成(${(blob.size / 1048576).toFixed(0)} MB,耗時 ${sec} 秒)`)
    } catch (err) {
      if (ctrl.signal.aborted) {
        setNote('已取消')
      } else {
        setNote('')
        setError(err instanceof Error ? err.message : '轉檔失敗')
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  return (
    <div className="space-y-1 text-[11px]">
      <div className="flex items-center gap-2">
        {busy ? (
          <Button variant="ghost" onClick={() => abortRef.current?.abort()}>
            取消轉檔
          </Button>
        ) : (
          <Button onClick={() => void run()}>轉成 MP4 下載</Button>
        )}
        {busy && <span className="text-white/60">{Math.round(progress * 100)}%</span>}
      </div>
      {note && <p className="text-white/50">{note}</p>}
      {error && <p className="text-red-400">{error}</p>}
      {!busy && !note && (
        <p className="text-white/40">1080p H.264,電腦、手機、剪輯軟體都能直接開</p>
      )}
    </div>
  )
}
