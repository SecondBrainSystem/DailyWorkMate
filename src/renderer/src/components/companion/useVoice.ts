import { useEffect, useRef, useState } from 'react'
import i18n from 'i18next'
import type { CompanionSettings, SpeechAudio } from '@shared/companion'
import type { CompanionCopy } from './copy'
import { playbackSpeechChunks, speechText, speechExcerpt, summarizeForSpeech } from '@/lib/companionSpeech'
import { recordingWave } from '@/lib/localSpeechAudio'
import { createVoiceLevel } from '@/lib/voiceLevel'

// IPC cancellation is global to the speech worker. A replacement request must wait for it,
// including cancellation from a previous Hook instance or StrictMode cleanup.
let speechCancellationBarrier: Promise<void> = Promise.resolve()
function queueSpeechCancellation(): Promise<void> {
  speechCancellationBarrier = speechCancellationBarrier.then(() => window.electronAPI?.companion?.cancelSpeech())
    .catch(error => console.error('[Voice] Cancel failed:', error))
  return speechCancellationBarrier
}

export function useVoice(settings: CompanionSettings, copy: CompanionCopy, onTranscript: (text: string) => void, onError: (message: string) => void) {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  // A meter, not state: see lib/voiceLevel.
  const [level] = useState(createVoiceLevel)
  const setLevel = level.set
  const [notice, setNotice] = useState('')
  const recorder = useRef<MediaRecorder | null>(null)
  const media = useRef<MediaStream | null>(null)
  const audioContext = useRef<AudioContext | null>(null)
  const meter = useRef<ReturnType<typeof setInterval>>()
  const playback = useRef<HTMLAudioElement | null>(null)
  const playbackUrl = useRef('')
  const generation = useRef(0)
  const speechGeneration = useRef(0)
  const mounted = useRef(true)
  const callbacks = useRef({ onTranscript, onError })
  const speechEnabled = useRef(settings.speechEnabled !== false)
  speechEnabled.current = settings.speechEnabled !== false
  callbacks.current = { onTranscript, onError }
  const speakingDone = useRef<(() => void) | null>(null)
  const starting = useRef(false)
  const summaryRequest = useRef<AbortController | null>(null)
  const recognitionRequest = useRef<AbortController | null>(null)
  const playbackContext = useRef<AudioContext | null>(null)
  const playbackMeter = useRef<ReturnType<typeof setInterval>>()

  const releaseMic = () => {
    clearInterval(meter.current)
    media.current?.getTracks().forEach(track => track.stop())
    media.current = null
    void audioContext.current?.close().catch(error => console.error('[Voice] Audio context cleanup:', error))
    audioContext.current = null
    if (mounted.current) { setRecording(false); setLevel(0) }
  }
  const stopPlayback = () => {
    clearInterval(playbackMeter.current)
    void playbackContext.current?.close().catch(error => console.error('[Voice] Playback cleanup:', error))
    playbackContext.current = null
    window.speechSynthesis?.cancel()
    playback.current?.pause()
    playback.current = null
    if (playbackUrl.current) URL.revokeObjectURL(playbackUrl.current)
    playbackUrl.current = ''
    speakingDone.current?.()
    speakingDone.current = null
    if (mounted.current) { setSpeaking(false); setLevel(0) }
  }
  const stop = () => {
    generation.current++
    speechGeneration.current++
    const pending = summaryRequest.current || recognitionRequest.current
    summaryRequest.current?.abort()
    summaryRequest.current = null
    pending?.abort()
    recognitionRequest.current?.abort(); recognitionRequest.current = null
    if (recorder.current?.state === 'recording') recorder.current.stop()
    recorder.current = null
    releaseMic()
    stopPlayback()
    if (mounted.current) setTranscribing(false)
    if (pending) void queueSpeechCancellation()
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; stop() }
  }, [])

  useEffect(() => {
    if (settings.speechEnabled === false) {
      speechGeneration.current++
      const pending = summaryRequest.current
      pending?.abort()
      summaryRequest.current = null
      stopPlayback()
      setNotice('')
      if (pending) void queueSpeechCancellation()
    }
  }, [settings.speechEnabled])

  const speak = async (raw: string, readingMode = settings.readingMode, model = settings.model) => {
    if (!speechEnabled.current || recording || transcribing || starting.current) return
    const previous = summaryRequest.current
    stopPlayback()
    summaryRequest.current?.abort()
    const request = new AbortController()
    summaryRequest.current = request
    const token = ++speechGeneration.current
    let text = speechText(raw)
    const active = () => token === speechGeneration.current && mounted.current && !request.signal.aborted
    const addNotice = (value: string) => setNotice(current => current.includes(value) ? current : [current, value].filter(Boolean).join(' '))
    const prepare = async (chunk: string): Promise<{ result?: SpeechAudio; error?: unknown }> => {
      try {
        await speechCancellationBarrier
        if (!active()) throw new DOMException('Speech cancelled', 'AbortError')
        const result = await window.electronAPI.companion.synthesize(chunk)
        return { result }
      } catch (error) { return { error } }
    }
    let firstPrepared: { text: string; pending: ReturnType<typeof prepare> } | undefined
    try {
      setSpeaking(true)
      setNotice('')
      if (previous) await queueSpeechCancellation()
      else await speechCancellationBarrier
      if (!text) return
      if (token !== speechGeneration.current || !mounted.current) return
      if (readingMode === 'summary' && text.length > 350) {
        if (!model) throw new Error(copy.noModels)
        if (model.startsWith('opencode-free/')) {
          text = speechExcerpt(text)
          // Follows the speech language, not the UI language.
          addNotice(i18n.getFixedT(settings.language.startsWith('zh') ? 'zh-CN' : 'en-US')('companion.speech.excerptNotice'))

        } else {
          text = await summarizeForSpeech(text, model, await window.electronAPI.config.get(), request.signal, {
            chunkMode: settings.ttsMode,
            onFirstChunk: chunk => { if (active() && !firstPrepared) firstPrepared = { text: chunk, pending: prepare(chunk) } },
          })
        }
      }
      if (token !== speechGeneration.current || !mounted.current) return
      const systemRead = async (source: string) => {
        const voices = window.speechSynthesis?.getVoices() || []
        if (!voices.length) throw new Error(copy.noVoice)
        const voice = voices.find(item => item.voiceURI === settings.systemVoice) || voices.find(item => item.lang.startsWith(settings.language.split('-')[0]))
        for (const chunk of playbackSpeechChunks(source, 'system')) {
          if (token !== speechGeneration.current || !mounted.current) break
          await new Promise<void>((resolve, reject) => {
            speakingDone.current = resolve
            const utterance = new SpeechSynthesisUtterance(chunk)
            utterance.lang = settings.language; utterance.rate = settings.speechRate
            utterance.volume = settings.speechVolume ?? 1; utterance.pitch = settings.speechPitch ?? 1
            if (voice) utterance.voice = voice
            utterance.onstart = () => { if (active()) setSpeaking(true) }
            utterance.onend = () => resolve()
            utterance.onerror = event => event.error === 'canceled' || event.error === 'interrupted' ? resolve() : reject(new Error('System speech: ' + event.error))
            window.speechSynthesis.speak(utterance)
          })
        }
      }
      {
        const chunks = playbackSpeechChunks(text, settings.ttsMode)
        // Only reuse a streamed prefix if its final text and boundary match exactly.
        const prefetched = firstPrepared as { text: string; pending: ReturnType<typeof prepare> } | undefined
        if (prefetched && prefetched.text !== chunks[0]) await queueSpeechCancellation()
        if (!active()) return
        let next: ReturnType<typeof prepare> | undefined = prefetched?.text === chunks[0] ? prefetched.pending : undefined
        for (let index = 0; index < chunks.length; index++) {
          if (token !== speechGeneration.current || !mounted.current) break
          let result: SpeechAudio
          try {
            const prepared = await (next || prepare(chunks[index]))
            next = undefined
            if (!prepared.result) throw prepared.error
            result = prepared.result
          }
          catch (error) {
            if (token !== speechGeneration.current || !mounted.current) return
            if (settings.ttsMode === 'api' || settings.systemFallback === false) throw error
            addNotice(copy.localFallback)
            await systemRead(chunks.slice(index).join(''))
            break
          }
          if (token !== speechGeneration.current || !mounted.current) return
          if (result.notice) addNotice(result.notice)
          // Prepare one following phrase while the current phrase plays, without losing cancellation.
          if (index + 1 < chunks.length) next = prepare(chunks[index + 1])
          const url = URL.createObjectURL(new Blob([new Uint8Array(result.audio)], { type: result.mime }))
          playbackUrl.current = url
          const audio = new Audio(url)
          audio.volume = settings.speechVolume ?? 1
          playback.current = audio
          let context: AudioContext | undefined
          let interval: ReturnType<typeof setInterval> | undefined
          let playbackError: unknown
          try {
            context = new AudioContext()
            playbackContext.current = context
            const analyser = context.createAnalyser()
            analyser.fftSize = 256
            context.createMediaElementSource(audio).connect(analyser)
            analyser.connect(context.destination)
            await context.resume()
            if (token !== speechGeneration.current || !mounted.current) return
            const samples = new Float32Array(analyser.fftSize)
            interval = setInterval(() => {
              analyser.getFloatTimeDomainData(samples)
              if (mounted.current && token === speechGeneration.current) setLevel(Math.min(1, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) * 7))
            }, 70)
            playbackMeter.current = interval
            await new Promise<void>((resolve, reject) => {
              speakingDone.current = resolve
              audio.onended = resolve as () => void
              audio.onerror = () => reject(new Error('Unable to play synthesized audio'))
              void audio.play().then(() => { if (token === speechGeneration.current && mounted.current) setSpeaking(true) }).catch(reject)
            })
          } catch (error) { playbackError = error }
          finally {
            audio.pause()
            clearInterval(interval)
            if (context && context.state !== 'closed') await context.close().catch(error => console.error('[Voice] Playback cleanup:', error))
            if (playbackContext.current === context) playbackContext.current = null
            if (playbackMeter.current === interval) playbackMeter.current = undefined
            URL.revokeObjectURL(url)
            if (playback.current === audio) { playback.current = null; playbackUrl.current = ''; speakingDone.current = null }
          }
          if (token !== speechGeneration.current || !mounted.current) return
          if (playbackError) {
            await queueSpeechCancellation()
            if (token !== speechGeneration.current || !mounted.current) return
            if (settings.ttsMode === 'api' || settings.systemFallback === false) throw playbackError
            setNotice(copy.localFallback)
            await systemRead(chunks.slice(index).join(''))
            break
          }
        }
      }
    } catch (error) {
      if (token === speechGeneration.current && mounted.current) {
        void queueSpeechCancellation()
        callbacks.current.onError(error instanceof Error ? error.message : String(error))
      }
    } finally { if (token === speechGeneration.current) { summaryRequest.current = null; stopPlayback() } }
  }

  const startRecording = async () => {
    if (recording || transcribing || starting.current) return
    if (settings.sttMode === 'api' && !settings.stt.baseUrl) { callbacks.current.onError(copy.noStt); return }
    starting.current = true
    stop()
    const token = generation.current
    const request = new AbortController()
    recognitionRequest.current = request
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      if (!mounted.current || token !== generation.current) { stream.getTracks().forEach(track => track.stop()); return }
      media.current = stream
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type))
      const next = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorder.current = next
      let chunks: Blob[] = []
      next.ondataavailable = event => { if (event.data.size) chunks = [...chunks, event.data] }
      next.onerror = () => { if (token === generation.current && mounted.current) { stop(); callbacks.current.onError(copy.micError) } }
      next.onstop = async () => {
        if (recorder.current === next) { recorder.current = null; releaseMic() }
        if (token !== generation.current || !mounted.current) return
        setTranscribing(true)
        try {
          const blob = new Blob(chunks, { type: next.mimeType })
          const bytes = await blob.arrayBuffer()
          const audio = settings.sttMode === 'api' ? new Uint8Array(bytes) : await recordingWave(bytes, request.signal)
          if (token !== generation.current || !mounted.current) return
          await speechCancellationBarrier
          if (token !== generation.current || !mounted.current) return
          const text = await window.electronAPI.companion.transcribe(audio, settings.sttMode === 'api' ? next.mimeType : 'audio/wav')
          if (token === generation.current && mounted.current) {
            if (text) callbacks.current.onTranscript(text)
            else callbacks.current.onError(copy.noSpeech)
          }
        } catch (error) {
          if (token === generation.current && mounted.current) callbacks.current.onError(error instanceof Error ? error.message : String(error))
        } finally { if (token === generation.current && mounted.current) { recognitionRequest.current = null; setTranscribing(false) } }
      }
      const context = new AudioContext()
      audioContext.current = context
      await context.resume()
      if (token !== generation.current) { releaseMic(); return }
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      const began = Date.now()
      let lastSound = began
      let speechFrames = 0
      next.start(250)
      setRecording(true)
      meter.current = setInterval(() => {
        analyser.getFloatTimeDomainData(samples)
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
        setLevel(Math.min(1, rms * 10))
        if (rms > 0.018) { lastSound = Date.now(); speechFrames++ }
        const elapsed = Date.now() - began
        if ((speechFrames >= 3 && Date.now() - lastSound > 1300) || elapsed > 30000) {
          if (next.state === 'recording') next.stop()
        } else if (speechFrames === 0 && elapsed > 12000) { stop(); callbacks.current.onError(copy.noSpeech) }
      }, 100)
    } catch (error) {
      releaseMic()
      if (token === generation.current && mounted.current) callbacks.current.onError(copy.micError + ' ' + (error instanceof Error ? error.message : String(error)))
    } finally { starting.current = false }
  }
  const finishRecording = () => { if (recorder.current?.state === 'recording') recorder.current.stop() }
  return { recording, transcribing, speaking, level, notice, clearNotice: () => setNotice(''), startRecording, finishRecording, speak, stop }
}
