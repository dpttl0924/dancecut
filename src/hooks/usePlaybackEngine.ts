import { useEffect } from 'react'
import type { RefObject } from 'react'
import { playRange, timelineMap, useProject } from '../store/useProject'
import { contentToProject, isInCountIn, projectToContent } from '../lib/timeline'
import { resolveClipTime } from '../lib/layout'
import { playbackClock } from '../lib/playbackClock'
import {
  AUDIBLE_MAX_TRIM,
  MUTED_MAX_TRIM,
  SeekStrainMonitor,
  correctDrift,
} from '../lib/sync'
import type { Clip, ClipId } from '../lib/types'

export type VideoRefs = Record<ClipId, RefObject<HTMLVideoElement | null>>

/** 同步回 store 的頻率。播放頭與時間顯示走 DOM 直寫,不受這個限制。 */
const STORE_SYNC_INTERVAL_MS = 100

/**
 * 播放同步引擎。
 *
 * 專案時間以「其中一支正在播的影片」為準,而不是牆鐘。
 *
 * 早期版本是牆鐘推進、誤差超過 60ms 就 seek 校正,結果反而是卡頓的來源:
 * video.currentTime 只在影格邊界更新,30fps 的影片會以 ~33ms 為階梯跳動,
 * 所以即使完全同步,量到的誤差也會自然震盪 ±33ms。加上 rAF 抖動就會越過門檻,
 * 一 seek 就停頓、停頓後誤差更大、於是再 seek —— 自我強化的迴圈。
 *
 * 現在的做法:
 *   主控影片   直接拿它的 currentTime 當專案時間,它自己播自己的,永遠不用校正
 *   另一支     算出誤差後微調 playbackRate 慢慢追回來,不 seek
 *   都不在範圍 才退回牆鐘推進(例如 A 播完了、B 還沒開始的空檔)
 *
 * 這是串流播放器對付時鐘漂移的標準做法,收斂過程完全看不出來。
 */
export function usePlaybackEngine(refs: VideoRefs) {
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let lastStoreSync = 0
    const strain = new SeekStrainMonitor()

    const tick = () => {
      const now = performance.now()
      const delta = now - last
      last = now

      const state = useProject.getState()
      const { playing, durationMs, rate, clips } = state
      const map = timelineMap(state)
      // 預備拍那段沒有影片內容,不能拿影片當時鐘主控 —— 它會把播放頭
      // 直接拉出預備拍區間,節拍器等於沒響
      const inCountIn = isInCountIn(playbackClock.currentMs, map)
      const contentMs = projectToContent(playbackClock.currentMs, map)
      const master = playing && !inCountIn ? pickMaster(refs, clips, contentMs) : null

      if (playing && durationMs > 0) {
        if (master) {
          // 跟著主控影片自己的解碼時鐘走,它想播多快就多快
          const el = refs[master].current!
          playbackClock.currentMs = contentToProject(
            el.currentTime * 1000 + clips[master]!.offsetMs,
            map,
          )
        } else {
          playbackClock.currentMs += delta * rate
        }

        // 播到輸出範圍的終點就停,這樣預覽看到的就是匯出會得到的東西
        const endMs = playRange(state).endMs
        if (playbackClock.currentMs >= endMs) {
          playbackClock.currentMs = endMs
          useProject.getState().setPlaying(false)
          useProject.getState().seek(endMs)
          lastStoreSync = now
        }
      }

      const contentNow = projectToContent(playbackClock.currentMs, map)
      // 預備拍期間影片要停住,只有節拍器在響
      const clipsRunning = playing && !isInCountIn(playbackClock.currentMs, map)

      for (const id of ['a', 'b'] as ClipId[]) {
        const el = refs[id].current
        const clip = clips[id]
        if (!el || !clip) continue

        const { targetSec, inRange } = resolveClipTime(clip, contentNow)
        setVolume(el, clip.volume)

        if (!clipsRunning || !inRange) {
          if (!el.paused) el.pause()
          setRate(el, rate)
          // 暫停時要跟上播放頭,否則拖時間軸畫面不會動
          if (Math.abs(el.currentTime - targetSec) > 0.004) el.currentTime = targetSec
          continue
        }

        if (el.paused) void el.play().catch(() => {})

        if (id === master) {
          setRate(el, rate)
          continue
        }

        // 還在載入(例如剛從原檔換成代理檔)或上一個 seek 還沒完成時,量到的誤差不可信。
        // 這時候再 seek 只會讓解碼器一直重來,還會被誤判成「裝置追不上」。
        if (el.readyState < 2 || el.seeking) continue

        // 靜音的那支可以用大一點的修正幅度,反正沒有聲音會被聽出來
        const maxTrim = clip.volume > 0.01 ? AUDIBLE_MAX_TRIM : MUTED_MAX_TRIM
        const correction = correctDrift(targetSec - el.currentTime, rate, maxTrim)
        // 已經判定裝置追不上時就不再硬 seek —— 反覆 seek 的停頓比稍微不同步難用得多
        if (correction.seek && !strain.strained(now)) {
          el.currentTime = targetSec
          if (strain.record(now)) useProject.getState().setSyncStrained(true)
        }
        setRate(el, correction.rate)
      }

      // React 端節流。標註的出現/消失差 100ms 看不出來,
      // 但每幀 set 一次 store 會讓整棵樹一秒重繪 60 次。
      const store = useProject.getState()
      const drifted = Math.abs(store.currentMs - playbackClock.currentMs) > 1
      if (drifted && (!playing || now - lastStoreSync >= STORE_SYNC_INTERVAL_MS)) {
        lastStoreSync = now
        store.seek(playbackClock.currentMs)
      }

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [refs])
}

/**
 * 選一支影片當時鐘主控:**解碼最吃力的那一支**。兩支都不在範圍內回傳 null
 * (例如 A 播完、B 還沒開始的空檔)。
 *
 * 主控那支自己播自己的,永遠不會被 seek 也不會被改速度;從屬那支負責追。
 * 所以「誰當主控」等於在決定「把校正的代價丟給誰」——
 * 一定要丟給撐得住的那一支。
 *
 * 舊版無條件優先 A,結果剛好相反:1280×720 配 1920×1080 時,
 * 不管誰重誰輕,被 seek 的永遠是 B。而手機同時解兩支影片本來就吃緊,
 * 對著已經解不動的 1080p 反覆 seek(每次都是清空解碼器重來)只會更慢,
 * 慢了誤差更大、於是再 seek —— 那支就一直在頓。
 * 反過來讓 1080p 當主控,它就再也不會被打斷,由便宜的 720p 去追。
 *
 * 代價:預設 B 是靜音的,所以這樣通常會讓有聲音的 A 變成從屬,
 * 修正幅度受 AUDIBLE_MAX_TRIM 限制(±3%),追得比較慢。
 * 用畫面的頓換聲音的微幅速度變化是划算的 —— 頓看得出來,3% 聽不出來。
 *
 * 像素數一樣時維持原本的順序(優先 A),常見情況的行為完全不變。
 */
export function pickMaster(
  refs: VideoRefs,
  clips: Record<ClipId, Clip | null>,
  projectMs: number,
): ClipId | null {
  const eligible = (['a', 'b'] as ClipId[]).filter((id) => {
    const el = refs[id].current
    const clip = clips[id]
    return !!el && !!clip && el.readyState >= 2 && resolveClipTime(clip, projectMs).inRange
  })
  if (eligible.length === 0) return null

  // 兩支都解得很輕鬆時(轉成代理檔之後通常如此),解碼負擔不再是考量,
  // 改讓**唯一有聲音的那支**當主控、永遠不去動它。理由見 LIGHT_PIXELS。
  const audible = eligible.filter((id) => clips[id]!.volume > 0.01)
  const allLight = eligible.every((id) => decodeCost(refs[id].current, clips[id]) <= LIGHT_PIXELS)
  if (allLight && audible.length === 1) return audible[0]

  return eligible.reduce((best, id) =>
    decodeCost(refs[id].current, clips[id]) > decodeCost(refs[best].current, clips[best])
      ? id
      : best,
  )
}

/**
 * 不超過 1080p 就算「輕」。
 *
 * 輕的時候,誰當從屬不再取決於解碼:從屬被校正的代價變成「改播放速度」本身。
 * iOS 上改一支**有聲音**影片的 playbackRate 要重新對時音訊管線,畫面會頓一下 ——
 * 實測是「轉好預覽版後偶爾停頓一下」。靜音的影片改速度沒有這個成本,
 * 所以讓有聲音的那支當主控,校正全部交給靜音的那支。
 *
 * 有一支超過 1080p(例如沒轉代理檔的 4K)時維持原規則:重的當主控,
 * 對著解不動的 4K 反覆 seek 比聲音被微調速度糟得多。
 */
const LIGHT_PIXELS = 1920 * 1080

/**
 * 解碼負擔的代理指標:**目前實際在播的**那個來源的像素數。
 *
 * 不能用 clip.width/height —— 那是原檔尺寸。預覽換成 540p 代理檔之後,
 * 4K 原檔的那支其實變成最輕的,用原檔尺寸會把它選成主控,
 * 結果讓另一支(還在播原檔的)被反覆校正而一直頓。
 * 元素還沒載入、量不到時才退回原檔尺寸;都量不到當成 0,寧可不要搶主控。
 */
function decodeCost(el: HTMLVideoElement | null, clip: Clip | null): number {
  if (el && el.videoWidth > 0) return el.videoWidth * el.videoHeight
  return clip ? (clip.width ?? 0) * (clip.height ?? 0) : 0
}

/** 只在真的變了才寫。每幀重設 playbackRate 會打擾媒體管線。 */
function setRate(el: HTMLVideoElement, value: number) {
  if (Math.abs(el.playbackRate - value) > 0.002) el.playbackRate = value
}

/**
 * 音量 0 的那支一定要設 `muted`,不能只把 volume 調成 0。
 *
 * iPhone / iPad 的 Safari 會忽略 `el.volume`(唯讀,永遠是 1),
 * 所以「B 預設靜音」在 iOS 上其實是兩支都有聲音在播。
 * 而 iOS 的 WebKit 不允許兩支有聲音的影片同時播放 —— 一支開始播就把另一支暫停,
 * 播放引擎下一幀又把被暫停的叫回來,兩支互相搶,畫面就一直頓。
 * 實際症狀:mp4 單獨播很順,跟 mov 一起放就卡。
 * `muted` 在 iOS 上是有效的,靜音的影片不受這個限制。
 *
 * 只記上次寫入的值:iOS 上 el.volume 讀回來永遠是 1,用它比對的話會每幀都寫一次。
 */
const lastVolume = new WeakMap<HTMLVideoElement, number>()

export function setVolume(el: HTMLVideoElement, value: number) {
  const mute = value < 0.01
  if (el.muted !== mute) el.muted = mute
  if (mute) return
  const last = lastVolume.get(el)
  if (last !== undefined && Math.abs(last - value) <= 0.01) return
  el.volume = value
  lastVolume.set(el, value)
}
