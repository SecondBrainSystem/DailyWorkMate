import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorText } from '@/lib/errors'
import type { AvatarState } from '@shared/companion'
import pinkOctopus from '@/assets/companion/pink-ai-octopus.png'
import { Avatar3D } from './Avatar3D'

export function Avatar({ state, image, name, level, avatarMode = '2d', modelUrl }: { state: AvatarState; image: string; name: string; level: number; avatarMode?: '2d' | '3d'; modelUrl?: string }) {
  const { i18n } = useTranslation()
  const chinese = i18n.language.startsWith('zh')
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setError(''); setDismissed(false) }, [avatarMode, modelUrl])
  const show3D = avatarMode === '3d' && !error
  return <div className={'companion-avatar is-' + state} style={{ '--voice-level': level } as React.CSSProperties}>
    <div className="companion-orbit orbit-one" /><div className="companion-orbit orbit-two" />
    <div className="companion-avatar-shadow" />
    {show3D ? <Avatar3D state={state} level={level} name={name} modelUrl={modelUrl} onError={setError} /> : <img className={'companion-custom-avatar' + (image ? '' : ' companion-character companion-octopus')} src={image || pinkOctopus} alt={name} />}
    {error && !dismissed && <span role="status" data-avatar-fallback style={{ position: 'absolute', bottom: -16, fontSize: 11, textAlign: 'center', zIndex: 3 }}>{errorText(error, chinese)} · {chinese ? '已显示 2D 形象' : 'Showing the 2D avatar'}<button aria-label={chinese ? '关闭提示' : 'Dismiss notice'} onClick={() => setDismissed(true)}> × </button></span>}
    <div className="companion-spark spark-one">✦</div><div className="companion-spark spark-two">✧</div>
  </div>
}
