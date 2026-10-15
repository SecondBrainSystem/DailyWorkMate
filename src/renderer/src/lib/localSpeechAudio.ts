/** Decode the browser recorder locally and send canonical mono PCM to the offline recognizer. */
export async function recordingWave(bytes: ArrayBuffer, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) throw new Error('Speech request cancelled')
  const context = new AudioContext()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    const decoded = await Promise.race([
      context.decodeAudioData(bytes),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Recording decode timed out')), 15000)
        abort = () => reject(new Error('Speech request cancelled'))
        signal?.addEventListener('abort', abort, { once: true })
      }),
    ])
    if (signal?.aborted) throw new Error('Speech request cancelled')
    if (!decoded.length || decoded.duration > 35) throw new Error('Recordings must be at most 35 seconds')
    const mono = new Float32Array(decoded.length)
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const samples = decoded.getChannelData(channel)
      for (let index = 0; index < samples.length; index++) mono[index] += samples[index] / decoded.numberOfChannels
    }
    return pcmWave(mono, decoded.sampleRate)
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
    await context.close()
  }
}

export function pcmWave(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000 || samples.length === 0 || samples.length > sampleRate * 35) throw new Error('Invalid PCM recording')
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => [...value].forEach((char, index) => { bytes[offset + index] = char.charCodeAt(0) })
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, Number.isFinite(samples[index]) ? samples[index] : 0)) * 32767), true)
  return bytes
}
