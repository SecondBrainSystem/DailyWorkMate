import axios from 'axios'
import { boundedText, speechUrl } from '../../shared/companion.ts'
import type { CompanionSettings, SpeechAudio } from '../../shared/companion'
import type { LocalSpeechStatus } from '../../shared/localSpeech'
import { LocalSpeechService, type LocalSpeechOptions } from './localSpeech'

const interrupted = (message: string) => /cancelled|closed|resources changed/.test(message)

export class SpeechService {
  private controllers = new Set<AbortController>()
  private local: LocalSpeechService
  private fastFailure: { until: number; message: string } | undefined
  constructor(options?: LocalSpeechOptions) { this.local = new LocalSpeechService(options) }
  localStatus() { return this.local.status() }
  cancel() { for (const controller of this.controllers) controller.abort(); this.controllers.clear(); this.local.cancel() }
  dispose() { this.cancel(); this.local.dispose() }
  async warmup(settings: CompanionSettings): Promise<LocalSpeechStatus> {
    if (settings.ttsMode === 'api') return this.local.status()
    const engine = settings.localEngine || 'kokoro'
    if (engine === 'fast' && this.fastFailure && this.fastFailure.until > Date.now()) {
      return { ...(await this.local.warmup(settings.localVoice || 'auto', settings.language, settings.speechRate, 'kokoro')), fastError: this.fastFailure.message }
    }
    const warmed = await this.local.warmup(settings.localVoice || 'auto', settings.language, settings.speechRate, engine)
    if (engine !== 'fast' || interrupted(warmed.error || '')) return warmed
    if (warmed.ready && warmed.readyEngine === 'fast' && !warmed.error) { this.fastFailure = undefined; return warmed }
    const reason = warmed.error || warmed.fastError || 'Fast local speech warmup failed'
    this.fastFailure = { until: Date.now() + 60_000, message: reason }
    const fallback = await this.local.warmup(settings.localVoice || 'auto', settings.language, settings.speechRate, 'kokoro')
    return { ...fallback, fastError: reason }
  }

  private async request<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    this.controllers.add(controller)
    try { return await run(controller.signal) }
    catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(controller.signal.aborted ? 'Speech request cancelled' : 'Speech service failed' + (error.response ? ' (HTTP ' + error.response.status + ')' : ': ' + error.code))
      }
      throw error
    } finally { this.controllers.delete(controller) }
  }
  async transcribe(settings: CompanionSettings, bytes: Uint8Array, mime: string): Promise<string> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 15 * 1024 * 1024) throw new Error('Audio must be between 1 byte and 15 MiB')
    const types: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav' }
    const type = boundedText(mime, 'audio type', 80).split(';')[0]
    if (!types[type]) throw new Error('Unsupported recording format')
    if (settings.sttMode !== 'api') {
      if (type !== 'audio/wav') throw new Error('Local speech recognition requires WAV audio')
      return this.request(signal => this.local.transcribe(bytes, signal))
    }
    const url = speechUrl(settings.stt.baseUrl, 'transcriptions')
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(bytes)], { type }), 'recording.' + types[type])
    form.append('model', settings.stt.model)
    form.append('language', settings.language.split('-')[0])
    return this.request(async signal => {
      const response = await axios.post(url, form, { signal, timeout: 90000, maxRedirects: 0, maxContentLength: 1024 * 1024, headers: settings.stt.apiKey ? { Authorization: 'Bearer ' + settings.stt.apiKey } : {} })
      return boundedText(response.data?.text, 'transcription response', 32000).trim()
    })
  }
  async synthesize(settings: CompanionSettings, text: string): Promise<SpeechAudio> {
    boundedText(text, 'speech text', 12000, true)
    if (settings.ttsMode !== 'api') {
      return this.request(async signal => {
        const engine = settings.localEngine || 'kokoro'
        const synthesize = (selected: 'fast' | 'kokoro') => this.local.synthesize(text, settings.localVoice || 'auto', settings.language, settings.speechRate, signal, selected)
        if (engine !== 'fast') return synthesize(engine)
        let reason = this.fastFailure && this.fastFailure.until > Date.now() ? this.fastFailure.message : undefined
        if (!reason) {
          try { const result = await synthesize('fast'); this.fastFailure = undefined; return result }
          catch (error) {
            reason = error instanceof Error ? error.message : 'Fast local speech failed'
            if (signal.aborted || interrupted(reason) || /text must|Speech rate|Unknown local/.test(reason)) throw error
            this.fastFailure = { until: Date.now() + 60_000, message: reason }
          }
        }
        const result = await synthesize('kokoro')
        const chinese = settings.language.startsWith('zh')
        return { ...result, notice: chinese
          ? '快速语音暂不可用，已使用本地多音色语音，生成可能稍慢。原因：' + reason
          : 'Fast voice is unavailable; using the local multi-voice engine, which may take longer. Reason: ' + reason }
      })
    }
    const url = speechUrl(settings.tts.baseUrl, 'speech')
    return this.request(async signal => {
      const response = await axios.post(url, { model: settings.tts.model, input: text, voice: settings.voice, speed: settings.speechRate, response_format: 'mp3' }, {
        signal, timeout: 90000, maxRedirects: 0, responseType: 'arraybuffer', maxContentLength: 25 * 1024 * 1024,
        headers: settings.tts.apiKey ? { Authorization: 'Bearer ' + settings.tts.apiKey } : {},
      })
      const mime = String(response.headers['content-type'] || 'audio/mpeg').split(';')[0]
      if (!mime.startsWith('audio/') && mime !== 'application/octet-stream') throw new Error('Speech service returned non-audio data')
      return { audio: new Uint8Array(response.data), mime: mime === 'application/octet-stream' ? 'audio/mpeg' : mime }
    })
  }
}
