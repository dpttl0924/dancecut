import { useState } from 'react'
import { downloadBlob, exportComposite } from '../lib/export'
import {
  AUDIO_GAINS,
  ENCODE_STARTS_AT,
  estimateAudioBytes,
  exportAudio,
  type AudioFormat,
} from '../lib/audioExport'
import { playRange, useProject } from '../store/useProject'
import { formatSeconds, formatTime } from '../lib/format'
import { ASPECT_SIZES } from '../lib/types'
import type { VideoRefs } from '../hooks/usePlaybackEngine'
import { Button, Field, Panel, inputClass } from './ui'

/** 編碼器普遍要求偶數尺寸,這裡的顯示要跟 export.ts 算出來的一致 */
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

const SCALES = [1, 2 / 3, 0.5]

export function ExportPanel({ refs }: { refs: VideoRefs }) {
  const durationMs = useProject((s) => s.durationMs)
  const rangeInMs = useProject((s) => s.rangeInMs)
  const rangeOutMs = useProject((s) => s.rangeOutMs)
  const countIn = useProject((s) => s.countIn)
  const tempo = useProject((s) => s.tempo)
  const range = playRange({ rangeInMs, rangeOutMs, durationMs, countIn, tempo })
  const aspect = useProject((s) => s.aspect)
  const size = ASPECT_SIZES[aspect]
  const [scale, setScale] = useState(2 / 3)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [audioBusy, setAudioBusy] = useState(false)
  const [audioProgress, setAudioProgress] = useState(0)
  const [audioFormat, setAudioFormat] = useState<AudioFormat>('wav')
  const [audioGain, setAudioGain] = useState<number>(1)
  /** MP3 編碼器要另外下載,那段沒有進度可報 */
  const [audioStage, setAudioStage] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  /** 退回即時錄製的原因 —— 匯出還是成功了,所以不是 error */
  const [warn, setWarn] = useState('')
  /** 下載編碼器那段沒有進度可回報,但也不能讓按鈕看起來卡住 */
  const [stage, setStage] = useState('')

  const runAudio = async () => {
    setAudioBusy(true)
    setError('')
    setAudioProgress(0)
    setAudioStage(audioFormat === 'mp3' ? '準備 MP3 編碼器…' : '')
    try {
      const { blob, extension } = await exportAudio({
        format: audioFormat,
        gain: audioGain,
        onProgress: (r) => {
          // 混音一開始回報進度,就代表編碼器已經載好了
          setAudioStage('')
          setAudioProgress(r)
        },
      })
      downloadBlob(blob, `dance-compare-${Date.now()}.${extension}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '音訊匯出失敗')
    } finally {
      setAudioBusy(false)
      setAudioProgress(0)
      setAudioStage('')
    }
  }

  /**
   * 先試 WebCodecs 的離線編碼,不行才退回 MediaRecorder 即時錄製。
   *
   * 退路一定要留:WebCodecs 的編碼器支援度因瀏覽器而異,
   * 而且失敗的話使用者只會看到「匯出壞了」,不會知道是編碼器的問題。
   */
  const run = async () => {
    setBusy(true)
    setError('')
    setProgress(0)
    setNote('')
    setWarn('')
    setStage('準備編碼器…')
    try {
      /*
        WebCodecs 這條路連著 mediabunny(解封裝 + 封裝),minify 後 648KB、
        佔整包的八成以上,但只有真的按下匯出才用得到。靜態 import 的話
        每個開啟網頁的人都要先下載完才能操作 —— 手機優先的專案不該這樣。
        改成動態載入,首屏就只剩 UI 與播放引擎。

        載不到的時候會掉進下面的 catch,自動退回即時錄製 —— 跟編碼器不支援
        是同一種處理,使用者仍然拿得到檔案。
      */
      const { exportWithWebCodecs } = await import('../lib/webcodecs/videoExport')
      setStage('')
      const result = await exportWithWebCodecs({ scale, onProgress: setProgress })
      downloadBlob(result.blob, `dance-compare-${Date.now()}.${result.extension}`)
      const speedup = range.durationMs / result.elapsedMs
      setNote(
        `離線編碼完成:${result.frames} 格(平均 ${result.avgFps}fps)、耗時 ${(result.elapsedMs / 1000).toFixed(1)}s,` +
          `約為即時錄製的 ${speedup.toFixed(1)} 倍速(${result.choice.container.toUpperCase()} / ${result.choice.video.toUpperCase()})` +
          (result.note ? `。${result.note}` : ''),
      )
    } catch (err) {
      setStage('')
      const reason = err instanceof Error ? err.message : '未知原因'
      setWarn(`${reason}。改用即時錄製,需要一直開著這個畫面到跑完。`)
      try {
        // 即時錄製錄的是畫面上的 <video>,預覽若在用代理檔就會錄出 540p —— 先換回原檔
        await switchToOriginal(refs)
        const { blob, extension } = await exportComposite({
          videos: { a: refs.a.current, b: refs.b.current },
          scale,
          fps: 30,
          onProgress: setProgress,
        })
        downloadBlob(blob, `dance-compare-${Date.now()}.${extension}`)
      } catch (fallbackErr) {
        setError(fallbackErr instanceof Error ? fallbackErr.message : '匯出失敗')
      } finally {
        useProject.getState().setPreviewOriginal(false)
      }
    } finally {
      setBusy(false)
      setProgress(0)
      setStage('')
    }
  }

  return (
    <Panel title="匯出影片">
      <Field label="輸出解析度">
        <select
          className={inputClass}
          value={scale}
          disabled={busy}
          onChange={(e) => setScale(Number(e.target.value))}
        >
          {SCALES.map((s) => (
            <option key={s} value={s}>
              {even(size.w * s)}×{even(size.h * s)}
            </option>
          ))}
        </select>
      </Field>

      <Button
        variant="primary"
        className="w-full py-2"
        disabled={durationMs <= 0 || busy}
        onClick={() => void run()}
      >
        {busy ? stage || `編碼中 ${(progress * 100).toFixed(0)}%` : '匯出影片'}
      </Button>

      {busy && (
        <div className="h-1 overflow-hidden rounded bg-white/10">
          <div
            className="h-full bg-indigo-400 transition-[width]"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      )}

      {note && <p className="text-[11px] leading-relaxed text-emerald-300">{note}</p>}
      {warn && <p className="text-[11px] leading-relaxed text-amber-300">{warn}</p>}
      {error && <p className="text-[11px] text-red-400">{error}</p>}

      <div className="space-y-2 border-t border-white/10 pt-2">
        {/*
          音量與格式都用按鈕組而不是 select:四個和兩個選項一眼就看完,
          點一下就切,不用先打開再挑。active 樣式跟播放列的速度按鈕一致。
        */}
        <Field label="音訊音量">
          <div className="grid grid-cols-4 gap-1">
            {AUDIO_GAINS.map((g) => (
              <Button
                key={g}
                active={audioGain === g}
                disabled={audioBusy}
                onClick={() => setAudioGain(g)}
              >
                {Math.round(g * 100)}%
              </Button>
            ))}
          </div>
        </Field>

        <Field label="音訊格式">
          <div className="grid grid-cols-2 gap-1">
            {(['wav', 'mp3'] as const).map((f) => (
              <Button
                key={f}
                active={audioFormat === f}
                disabled={audioBusy}
                onClick={() => setAudioFormat(f)}
              >
                {f.toUpperCase()}
              </Button>
            ))}
          </div>
        </Field>

        <Button
          className="w-full"
          disabled={durationMs <= 0 || busy || audioBusy}
          onClick={() => void runAudio()}
        >
          {audioBusy
            ? audioStage ||
              (audioProgress >= ENCODE_STARTS_AT
                ? `編碼 ${audioFormat.toUpperCase()} 中…`
                : `混音中 ${(audioProgress * 100).toFixed(0)}%`)
            : `只匯出音訊(${audioFormat.toUpperCase()})`}
        </Button>
        <p className="text-[11px] leading-relaxed text-white/35">
          預備拍 + 歌曲,不含畫面。走離線混音,幾秒就好,而且不需要一直開著畫面。
          {audioFormat === 'wav' ? '未壓縮' : 'MP3 192kbps'},
          {formatSeconds(range.durationMs)} 約{' '}
          {(estimateAudioBytes(range.durationMs, audioFormat) / 1048576).toFixed(
            audioFormat === 'wav' ? 0 : 1,
          )}{' '}
          MB。音量 {Math.round(audioGain * 100)}% 會套在整段混音上,素材與預備拍一起縮。
        </p>
      </div>

      <p className="text-[11px] leading-relaxed text-white/35">
        優先走 WebCodecs 離線編碼:影格直接從檔案解碼,不必即時播放,
        所以不受「切到其他 App 就錄到空白」的限制。
        編不出來時會自動退回即時錄製,那條路才需要一直開著畫面
        (輸出長度 {formatTime(range.durationMs)})。
      </p>
    </Panel>
  )
}

/**
 * 讓預覽換回原檔,並等兩支 <video> 都載入到有畫面為止。
 * 沒有任何代理檔時直接返回,不必重新載入。
 */
async function switchToOriginal(refs: VideoRefs) {
  const { clips, setPreviewOriginal } = useProject.getState()
  if (!clips.a?.previewUrl && !clips.b?.previewUrl) return
  setPreviewOriginal(true)
  // 等 React 把 src 換掉
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  await Promise.all(
    (['a', 'b'] as const).map((id) => {
      const el = refs[id].current
      const clip = clips[id]
      if (!el || !clip) return
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          el.removeEventListener('loadeddata', done)
          resolve()
        }
        // 拿不到事件也不要卡死,匯出本身會再處理還沒就緒的畫面
        const timer = setTimeout(done, 10_000)
        if (el.src === clip.url && el.readyState >= 2) done()
        else el.addEventListener('loadeddata', done)
      })
    }),
  )
}
