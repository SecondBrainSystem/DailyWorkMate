import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AvatarState } from '@shared/companion'
import { AVATAR_MODEL_MAX_BYTES } from '../../../../shared/avatarModel'
import builtInModel from '@/assets/companion/pink-ai-octopus.glb?url'
import type { AvatarSceneHandle } from './avatarScene'

export interface Avatar3DProps { state: AvatarState; level: number; name: string; modelUrl?: string; onError(message: string): void }

export function Avatar3D({ state, level, name, modelUrl = '', onError }: Avatar3DProps) {
  const { i18n } = useTranslation(); const chinese = i18n.language.startsWith('zh')
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
      if (modelUrl && !/^data:model\/gltf-binary;base64,[A-Za-z0-9+/=\r\n]+$/.test(modelUrl) && !modelUrl.startsWith('blob:')) throw new Error((chinese ? '请选择本地 GLB 模型文件' : 'Choose a local GLB model file'))
      if (modelUrl.length > AVATAR_MODEL_MAX_BYTES * 1.4) throw new Error((chinese ? '3D 模型文件过大' : 'The 3D model is too large'))
      const response = await fetch(modelUrl || builtInModel, { signal: controller.signal })
      if (!response.ok) throw new Error((chinese ? '无法读取 3D 模型' : 'Unable to read the 3D model'))
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > AVATAR_MODEL_MAX_BYTES) throw new Error(chinese ? '3D 模型文件过大' : 'The 3D model is too large')
      if (!active || !host.current) return
      const { mountAvatarScene } = await import('./avatarScene')
      if (!active || !host.current) return
      const handle = await mountAvatarScene(host.current, bytes, { state: () => live.current.state, level: () => live.current.level, onError: message => live.current.onError(message) })
      if (!active) { handle.dispose(); return }
      scene.current = handle; setReady(true)
    })().catch(error => { if (active && !controller.signal.aborted) live.current.onError(error instanceof Error ? error.message : (chinese ? '3D 模型加载失败' : 'Unable to load the 3D model')) })
    return () => { active = false; controller.abort(); scene.current?.dispose(); scene.current = undefined }
  }, [modelUrl])
  return <div role="group" aria-label={name + (chinese ? '，可旋转的 3D 形象' : ', rotatable 3D avatar')} data-avatar-3d={ready ? 'ready' : 'loading'} style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
    <div ref={host} tabIndex={0} title={chinese ? '拖动旋转 · 方向键调整 · 双击或 Home 复位' : 'Drag to rotate · Arrow keys to adjust · Double click or Home to reset'} aria-label={chinese ? '旋转 3D 形象' : 'Rotate the 3D avatar'} style={{ width: '100%', height: '100%', cursor: 'grab', touchAction: 'none', borderRadius: 24 }}
      onPointerDown={event => { drag.current = { x: event.clientX, y: event.clientY, id: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId) }}
      onPointerMove={event => { const previous = drag.current; if (previous?.id !== event.pointerId) return; scene.current?.rotate((event.clientX - previous.x) * .012, (event.clientY - previous.y) * .009); drag.current = { x: event.clientX, y: event.clientY, id: event.pointerId } }}
      onPointerUp={() => { drag.current = undefined }} onPointerCancel={() => { drag.current = undefined }}
      onDoubleClick={() => scene.current?.reset()}
      onKeyDown={event => { const angles: Record<string, [number, number]> = { ArrowLeft: [-.15, 0], ArrowRight: [.15, 0], ArrowUp: [0, -.12], ArrowDown: [0, .12] }; if (angles[event.key]) { event.preventDefault(); scene.current?.rotate(...angles[event.key]) } else if (event.key === 'Home') { event.preventDefault(); scene.current?.reset() } }} />
    {!ready && <span role="status" style={{ position: 'absolute', bottom: 8, left: 0, right: 0, textAlign: 'center', fontSize: '.75rem', opacity: .7 }}>{chinese ? '正在加载 3D 形象…' : 'Loading the 3D avatar…'}</span>}
    {ready && <span style={{ position: 'absolute', bottom: 1, left: 0, right: 0, textAlign: 'center', fontSize: '.75rem', opacity: .55, pointerEvents: 'none' }}>{chinese ? '拖动旋转 · 双击复位' : 'Drag to rotate · Double click to reset'}</span>}
  </div>
}
