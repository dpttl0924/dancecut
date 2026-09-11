import {
  AudioBufferSource,
  BufferTarget,
  Mp3OutputFormat,
  Output,
  canEncodeAudio,
} from 'mediabunny'
import { registerMp3Encoder } from '@mediabunny/mp3-encoder'

/**
 * AudioBuffer → MP3。
 *
 * 瀏覽器的 WebCodecs 幾乎都沒有 MP3 **編碼**器(解碼有,編碼沒有),
 * 所以掛上 mediabunny 官方的 LAME 擴充。它走 mediabunny 的 custom coder API,
 * 註冊之後 `AudioBufferSource({ codec: 'mp3' })` 就會自動用它。
 *
 * 這個模組刻意獨立出來:它拉進 mediabunny + 304KB 的 WASM 編碼器,
 * 而 WAV 那條路一個位元組都不需要。呼叫端用 `import()` 動態載入。
 */

let registered = false

/** 只在瀏覽器真的沒有原生 MP3 編碼器時才註冊,有的話讓原生的優先 */
async function ensureEncoder() {
  if (registered) return
  if (!(await canEncodeAudio('mp3'))) registerMp3Encoder()
  registered = true
}

export async function encodeMp3(buffer: AudioBuffer, bitrate: number): Promise<Blob> {
  await ensureEncoder()

  const output = new Output({
    format: new Mp3OutputFormat(),
    target: new BufferTarget(),
  })
  const source = new AudioBufferSource({ codec: 'mp3', bitrate })
  output.addAudioTrack(source)

  await output.start()
  await source.add(buffer)
  source.close()
  await output.finalize()

  const bytes = output.target.buffer
  if (!bytes) throw new Error('MP3 編碼沒有產生資料')
  return new Blob([bytes], { type: 'audio/mpeg' })
}
