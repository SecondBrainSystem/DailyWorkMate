import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { validateSettings } from '../../../../shared/companion'
import { errorText } from '@/lib/errors'
import type { CompanionSettings as Settings } from '@shared/companion'
import type { CompanionCopy } from './copy'
import { LOCAL_SPEECH_VOICES, type LocalSpeechStatus } from '../../../../shared/localSpeech'

export function CompanionSettings({ settings, home, copy, onClose, onSave }: {
  settings: Settings; home: string; copy: CompanionCopy; onClose: () => void; onSave: (settings: Settings) => Promise<void>
}) {
  const [draft, setDraft] = useState(settings)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [previewing, setPreviewing] = useState(false)
  const audio = useRef<HTMLAudioElement>()
  const previewUrl = useRef('')
  const chinese = settings.language.startsWith('zh')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [localStatus, setLocalStatus] = useState<LocalSpeechStatus>()
  const fastMode = (draft.localEngine || 'fast') === 'fast'
  useEffect(() => {
    const update = () => setVoices(window.speechSynthesis?.getVoices() || [])
    update()
    void window.electronAPI.companion.localSpeechStatus().then(setLocalStatus).catch(error => setError(error instanceof Error ? error.message : String(error)))
    window.speechSynthesis?.addEventListener('voiceschanged', update)
    const refresh = setInterval(() => { void window.electronAPI.companion.localSpeechStatus().then(setLocalStatus).catch(error => setError(errorText(error, chinese))) }, 5000)
    return () => { clearInterval(refresh); audio.current?.pause(); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); window.speechSynthesis?.removeEventListener('voiceschanged', update) }
  }, [])
  const field = (key: 'name' | 'language' | 'voice', label: string) => <label className="companion-field">{label}<input value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })} /></label>
  const endpoint = (key: 'stt' | 'tts') => (
    <fieldset className="companion-endpoint"><legend>{copy[key]}</legend>
      <label className="companion-field">{copy.baseUrl}<input placeholder="http://127.0.0.1:8080/v1" value={draft[key].baseUrl} onChange={event => setDraft({ ...draft, [key]: { ...draft[key], baseUrl: event.target.value } })} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="companion-field">{copy.speechModel}<input value={draft[key].model} onChange={event => setDraft({ ...draft, [key]: { ...draft[key], model: event.target.value } })} /></label>
        <label className="companion-field">{copy.key}<input type="password" autoComplete="off" value={draft[key].apiKey} onChange={event => setDraft({ ...draft, [key]: { ...draft[key], apiKey: event.target.value } })} /></label>
      </div>
    </fieldset>
  )
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose() }}><DialogContent className="companion-settings max-h-[88vh] max-w-2xl overflow-y-auto">
    <DialogHeader><DialogTitle>{copy.settings}</DialogTitle><DialogDescription>{copy.speechHint}</DialogDescription></DialogHeader>
    <div className="grid gap-4">
      {field('name', copy.name)}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.avatarVisible ?? true} onChange={event => setDraft({ ...draft, avatarVisible: event.target.checked })} />{copy.showAvatar}</label>
      <label className="companion-field">{copy.avatarDisplay}<select value={draft.avatarMode || '2d'} onChange={event => setDraft({ ...draft, avatarMode: event.target.value as Settings['avatarMode'] })}><option value="2d">{copy.avatar2d}</option><option value="3d">{copy.avatar3d}</option></select></label>
      <label className="companion-field">{copy.persona}<textarea rows={3} value={draft.persona} onChange={event => setDraft({ ...draft, persona: event.target.value })} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="companion-field">{copy.language}<select value={draft.language} onChange={event => setDraft({ ...draft, language: event.target.value })}>{!['zh-CN', 'en-US'].includes(draft.language) && <option value={draft.language}>{draft.language}</option>}<option value="zh-CN">中文</option><option value="en-US">English</option></select></label>
        <label className="companion-field">{copy.rate}<input type="number" step="0.1" min="0.5" max="2" value={draft.speechRate} onChange={event => setDraft({ ...draft, speechRate: event.target.value ? Number(event.target.value) : 1 })} /></label>
      </div>
      <label className="companion-field">{copy.readingMode}<select value={draft.readingMode} onChange={event => setDraft({ ...draft, readingMode: event.target.value as Settings['readingMode'] })}><option value="summary">{copy.summary}</option><option value="full">{copy.full}</option></select><span>{copy.readingHint}</span></label>
      <label className="companion-field">{copy.volume} · {Math.round(draft.speechVolume * 100)}%<input type="range" min="0" max="1" step="0.05" value={draft.speechVolume} onChange={event => setDraft({ ...draft, speechVolume: Number(event.target.value) })} /></label>
      <label className="companion-field">{copy.stt}<select value={draft.sttMode || 'local'} onChange={event => setDraft({ ...draft, sttMode: event.target.value as 'local' | 'api' })}><option value="local">{copy.localRecognition}</option><option value="api">{copy.api}</option></select></label>
      {draft.sttMode === 'api' ? endpoint('stt') : <p role="status" className="text-xs text-[var(--text-muted)]">{localStatus ? localStatus.recognitionAvailable ? copy.localReady + ' · SenseVoiceSmall' : localStatus.recognitionError || localStatus.error || copy.localMissing : '…'}</p>}
      <label className="companion-field">{copy.voice}<select value={draft.ttsMode === 'api' ? 'api' : 'local'} onChange={event => setDraft({ ...draft, ttsMode: event.target.value as 'local' | 'api' })}><option value="local">{copy.local}</option><option value="api">{copy.api}</option></select></label>
      {draft.ttsMode === 'api' ? <>{endpoint('tts')}{field('voice', copy.voiceId)}</> : <>
        <label className="companion-field">{copy.speechEngine}<select value={draft.localEngine || 'fast'} onChange={event => setDraft({ ...draft, localEngine: event.target.value as Settings['localEngine'] })}><option value="fast">{copy.fastVoice}</option><option value="kokoro">{copy.multiVoice}</option></select><span>{copy.fastVoiceHint}</span></label>
        <p role="status" className="text-xs text-[var(--text-muted)]">{localStatus ? (fastMode ? localStatus.fastAvailable : localStatus.available) ? copy.localReady + ' · ' + (fastMode ? localStatus.fastModel || 'Matcha Chinese / English' : localStatus.model) : (fastMode ? localStatus.fastError : localStatus.error) || copy.localMissing : '…'}</p>
        {!fastMode && <label className="companion-field">{copy.localVoice}<select value={draft.localVoice || 'auto'} onChange={event => setDraft({ ...draft, localVoice: event.target.value })}><option value="auto">{copy.autoVoice}</option>{LOCAL_SPEECH_VOICES.map(voice => <option key={voice.id} value={voice.id}>{voice.id} · {voice.language === 'zh' ? '中文' : 'English'} · {voice.gender === 'female' ? '♀' : '♂'}</option>)}</select></label>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.systemFallback ?? true} onChange={event => setDraft({ ...draft, systemFallback: event.target.checked })} />{copy.systemFallback}</label>
        {(draft.systemFallback ?? true) && <>
          <label className="companion-field">{copy.systemVoice}<select value={draft.systemVoice} onChange={event => setDraft({ ...draft, systemVoice: event.target.value })}><option value="">{copy.defaultVoice}</option>{voices.map(voice => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>)}</select></label>
          <label className="companion-field">{copy.pitch}<input type="number" min="0.5" max="2" step="0.1" value={draft.speechPitch} onChange={event => setDraft({ ...draft, speechPitch: Number(event.target.value) })} /></label>
        </>}
      </>}
      <p className="text-xs text-[var(--text-muted)] break-all">{copy.storage}: {home}</p>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={previewing || saving} onClick={async () => { setPreviewing(true); setError(''); try { audio.current?.pause(); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); const result = await window.electronAPI.companion.synthesize(chinese ? '你好，这是当前语音的试听。' : 'Hello, this is a preview of the selected voice.', validateSettings(draft)); previewUrl.current = URL.createObjectURL(new Blob([new Uint8Array(result.audio)], { type: result.mime })); audio.current = new Audio(previewUrl.current); audio.current.volume = draft.speechVolume; await audio.current.play() } catch (error) { setError(errorText(error, chinese)) } finally { setPreviewing(false) } }}>{previewing ? '…' : chinese ? '试听' : 'Preview voice'}</Button><Button variant="outline" onClick={onClose} disabled={saving}>{copy.cancel}</Button><Button disabled={saving} onClick={async () => {
        setSaving(true); setError('')
        try { await onSave(validateSettings(draft)); onClose() } catch (error) { setError(errorText(error, chinese)) } finally { setSaving(false) }
      }}>{saving ? '…' : copy.save}</Button></div>
    </div>
  </DialogContent></Dialog>
}
