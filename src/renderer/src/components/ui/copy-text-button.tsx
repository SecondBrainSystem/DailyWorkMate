import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy } from 'lucide-react'

export function CopyTextButton({ text, className = 'companion-icon-button' }: { text: string; className?: string }) {
  const { t } = useTranslation()
  const [result, setResult] = useState<'copied' | 'error' | ''>('')
  useEffect(() => { setResult('') }, [text])
  useEffect(() => {
    if (!result) return
    const timer = setTimeout(() => setResult(''), 2500)
    return () => clearTimeout(timer)
  }, [result])
  const label = result === 'error' ? t('chat.errors.copy') : result === 'copied' ? t('common.copied') : t('common.copy')
  return <span className="copy-text-control">
    <button type="button" className={className} disabled={!text} aria-label={label} title={label} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setResult('copied') }
      catch (error) { console.warn('[Clipboard] Copy failed:', error); setResult('error') }
    }}>{result === 'copied' ? <Check size={14} /> : <Copy size={14} />}</button>
    {result && <span role="status" className={result === 'error' ? 'copy-text-error' : 'sr-only'}>{label}</span>}
  </span>
}
