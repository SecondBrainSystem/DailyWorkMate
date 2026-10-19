import { useEffect, useRef, useState } from 'react'
import type { AvatarState } from '@shared/companion'
import { useTranslation } from 'react-i18next'
import type { VoiceLevel } from '@/lib/voiceLevel'
import { AVATAR_MODEL_MAX_BYTES } from '../../../../shared/avatarModel'
import builtInModel from '@/assets/companion/pink-ai-octopus.glb?url'
import type { AvatarSceneHandle } from './avatarScene'

export interface Avatar3DProps { state: AvatarState; level: VoiceLevel; name: string; modelUrl?: string; onError(message: string): void }

export function Avatar3D({ state, level, name, modelUrl = '', onError }: Avatar3DProps) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<AvatarSceneHandle>()
  const live = useRef({ state, level, onError }); live.current = { state, level, onError }
  const drag = useRef<{ x: number; y: number; id: number }>()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setReady(false)
    ;(async () => {
      if (modelUrl && !/^data:model\/gltf-binary;base64,[A-Za-z0-9+/=\r\n]+$/.test(modelUrl) && !modelUrl.startsWith('blob:')) throw new Error(t('companion.avatarView.chooseGlb'))
      if (modelUrl.length > AVATAR_MODEL_MAX_BYTES * 1.4) throw new Error(t('companion.avatarView.tooLarge'))
      const response = await fetch(modelUrl || builtInModel, { signal: controller.signal })
      if (!response.ok) throw new Error(t('companion.avatarView.unreadable'))
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > AVATAR_MODEL_MAX_BYTES) throw new Error(t('companion.avatarView.tooLarge'))
      if (!active || !host.current) return
      const { mountAvatarScene } = await import('./avatarScene')
      if (!active || !host.current) return
      const handle = await mountAvatarScene(host.current, bytes, { state: () => live.current.state, level: () => live.current.level.get(), onError: message => live.current.onError(message) })
      if (!active) { handle.dispose(); return }
      scene.current = handle; setReady(true)
    })().catch(error => { if (active && !controller.signal.aborted) live.current.onError(error instanceof Error ? error.message : t('companion.avatarView.loadFailed')) })
    return () => { active = false; controller.abort(); scene.current?.dispose(); scene.current = undefined }
  }, [modelUrl])
  return <div role="group" aria-label={t('companion.avatarView.label', { name })} data-avatar-3d={ready ? 'ready' : 'loading'} style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
    <div ref={host} tabIndex={0} title={t('companion.avatarView.controls')} aria-label={t('companion.avatarView.rotate')} style={{ width: '100%', height: '100%', cursor: 'grab', touchAction: 'none', borderRadius: 24 }}
      onPointerDown={event => { drag.current = { x: event.clientX, y: event.clientY, id: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId) }}
      onPointerMove={event => { const previous = drag.current; if (previous?.id !== event.pointerId) return; scene.current?.rotate((event.clientX - previous.x) * .012, (event.clientY - previous.y) * .009); drag.current = { x: event.clientX, y: event.clientY, id: event.pointerId } }}
      onPointerUp={() => { drag.current = undefined }} onPointerCancel={() => { drag.current = undefined }}
      onDoubleClick={() => scene.current?.reset()}
      onKeyDown={event => { const angles: Record<string, [number, number]> = { ArrowLeft: [-.15, 0], ArrowRight: [.15, 0], ArrowUp: [0, -.12], ArrowDown: [0, .12] }; if (angles[event.key]) { event.preventDefault(); scene.current?.rotate(...angles[event.key]) } else if (event.key === 'Home') { event.preventDefault(); scene.current?.reset() } }} />
    {!ready && <span role="status" style={{ position: 'absolute', bottom: 8, left: 0, right: 0, textAlign: 'center', fontSize: '.75rem', opacity: .7 }}>{t('companion.avatarView.loading')}</span>}
    {ready && <span style={{ position: 'absolute', bottom: 1, left: 0, right: 0, textAlign: 'center', fontSize: '.75rem', opacity: .55, pointerEvents: 'none' }}>{t('companion.avatarView.hint')}
</span>}
  </div>
}
