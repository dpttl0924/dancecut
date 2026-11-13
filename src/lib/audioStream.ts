import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny'
import type { InputAudioTrack } from 'mediabunny'
import { EnvelopeAccumulator } from './audio'
import type { AudioAnalysis } from './audio'

/**
 * 用 mediabunny 串流解碼音軌,邊解邊算包絡。
 *
 * 獨立成一個模組並由 audio.ts 動態載入:mediabunny 很大,
 * 只有 decodeAudioData 失敗或檔案太大時才值得下載。
 *
 * 為什麼需要這條路:
 *   - 大檔案:BlobSource 只讀需要的區塊,不會整檔進記憶體。
 *   - 多音軌:iPhone 開了空間音訊錄的 .mov 除了 AAC 還帶一條 APAC 軌,
 *     decodeAudioData 不讓你選軌。這裡逐條問 canDecode(),挑第一條解得開的。
 */
export async function analyzeAudioStreaming(file: Blob): Promise<AudioAnalysis> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const tracks = await input.getAudioTracks()
    if (tracks.length === 0) throw new Error('檔案裡沒有音軌')

    const track = await pickDecodableTrack(tracks)
    if (!track) {
      const codecs = tracks.map((t) => t.codec ?? '未知').join('、')
      throw new Error(`這個瀏覽器解不開音軌編碼(${codecs})`)
    }

    const sr = track.sampleRate
    const acc = new EnvelopeAccumulator(sr)
    let planes: Float32Array[] = []

    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        const frames = sample.numberOfFrames
        const channels = sample.numberOfChannels
        if (planes.length !== channels || planes[0].length < frames) {
          planes = Array.from({ length: channels }, () => new Float32Array(frames))
        }
        for (let c = 0; c < channels; c++) {
          sample.copyTo(planes[c], { planeIndex: c, format: 'f32-planar' })
        }

        // 用時間戳對位:中間有空洞就補靜音,重疊(或開頭的負時間戳 / priming)就跳過,
        // 讓包絡的第 0 格永遠對應影片的第 0 秒
        const start = Math.round(sample.timestamp * sr)
        if (start > acc.position) acc.pushSilence(start - acc.position)
        const skip = Math.min(frames, Math.max(0, acc.position - start))
        acc.push(planes, frames, skip)
      } finally {
        sample.close()
      }
    }

    return acc.finish()
  } finally {
    input.dispose()
  }
}

async function pickDecodableTrack(tracks: InputAudioTrack[]): Promise<InputAudioTrack | null> {
  for (const t of tracks) {
    try {
      if (await t.canDecode()) return t
    } catch {
      // 問不出來就當作不行,換下一條
    }
  }
  return null
}
