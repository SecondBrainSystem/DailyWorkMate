import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrorText } from '@/lib/errors'
import type { VoiceLevel } from '@/lib/voiceLevel'
import type { AvatarState } from '@shared/companion'
import pinkOctopus from '@/assets/companion/pink-ai-octopus.png'
import { Avatar3D } from './Avatar3D'

export const Avatar = memo(function Avatar({ state, image, name, level, avatarMode = '2d', modelUrl }: { state: AvatarState; image: string; name: string; level: VoiceLevel; avatarMode?: '2d' | '3d'; modelUrl?: string }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const root = useRef<HTMLDivElement>(null)
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setError(''); setDismissed(false) }, [avatarMode, modelUrl])
  // Draw the meter straight into a CSS variable, at most once per frame, without re-rendering.
  useEffect(() => {
    let frame = 0
    const draw = () => { frame = 0; root.current?.style.setProperty('--voice-level', String(level.get())) }
    draw()
    const unsubscribe = level.subscribe(() => { if (!frame) frame = requestAnimationFrame(draw) })
    return () => { unsubscribe(); cancelAnimationFrame(frame) }
  }, [level])
  const show3D = avatarMode === '3d' && !error
  return <div ref={root} className={'companion-avatar is-' + state}>
    <div className="companion-orbit orbit-one" /><div className="companion-orbit orbit-two" />
    <div className="companion-avatar-shadow" />
    {show3D ? <Avatar3D state={state} level={level} name={name} modelUrl={modelUrl} onError={setError} /> : <img className={'companion-custom-avatar' + (image ? '' : ' companion-character companion-octopus')} src={image || pinkOctopus} alt={name} />}
    {error && !dismissed && <span role="status" data-avatar-fallback style={{ position: 'absolute', bottom: -16, fontSize: 11, textAlign: 'center', zIndex: 3 }}>{errorText(error)} · {t('companion.avatarView.fallback')}<button aria-label={t('companion.avatarView.dismiss')}
 onClick={() => setDismissed(true)}> × </button></span>}
    <div className="companion-spark spark-one">✦</div><div className="companion-spark spark-two">✧</div>
  </div>
})
