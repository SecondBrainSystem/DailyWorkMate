import { Fragment, createElement, memo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|~~[^~\n]+~~|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index} className="rounded bg-foreground/10 px-1 font-mono">{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>
    if (part.startsWith('~~') && part.endsWith('~~')) return <del key={index}>{part.slice(2, -2)}</del>
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/)
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer" className="underline">{link[1]}</a>
    return <Fragment key={index}>{part}</Fragment>
  })
}

function CopyCode({ code }: { code: string }) {
  const { t } = useTranslation()
  const [result, setResult] = useState<'copied' | 'error' | null>(null)
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setResult('copied') }
    catch { setResult('error') }
  }
  return <button aria-label={t('common.copy')} title={result ? t(`common.${result}`) : t('common.copy')} onClick={() => void copy()}>{result === 'copied' ? '✓' : result === 'error' ? '!' : '⧉'}</button>
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
function prose(part: string): ReactNode[] {
  const lines = part.split('\n'), result: ReactNode[] = []
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]
    const header = cells(line), separator = cells(lines[row + 1] || '')
    if (line.includes('|') && header.length > 1 && header.length === separator.length && separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
      const body: string[][] = []
      let next = row + 2
      while (next < lines.length && lines[next].includes('|')) { body.push(cells(lines[next])); next++ }
      result.push(<div key={row} className="max-w-full overflow-x-auto rounded border"><table className="w-full border-collapse text-sm"><thead><tr>{header.map((cell, column) => <th key={column} scope="col" className="border-b bg-muted px-3 py-2 text-left">{inline(cell)}</th>)}</tr></thead><tbody>{body.map((values, index) => <tr key={index}>{header.map((_, column) => <td key={column} className="border-b px-3 py-2">{inline(values[column] || '')}</td>)}</tr>)}</tbody></table></div>)
      row = next - 1
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+)/), list = line.match(/^\s*([-*]|\d+\.)\s+(.+)/), quote = line.match(/^>\s?(.*)/)
    if (heading) result.push(createElement(`h${heading[1].length}`, { key: row, className: 'mt-3 font-semibold' }, inline(heading[2])))
    else if (list) result.push(<div key={row} className="pl-3">{list[1].match(/\d/) ? list[1] : '•'} {inline(list[2])}</div>)
    else if (quote) result.push(<blockquote key={row} className="border-l-2 pl-3 text-muted-foreground">{inline(quote[1])}</blockquote>)
    else result.push(<Fragment key={row}>{inline(line)}{row < lines.length - 1 ? '\n' : ''}</Fragment>)
  }
  return result
}

/** Text-only Markdown rendering: raw HTML is always escaped by React. Memoized: streaming re-renders only the changed message. */
export const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }) {
  const parts = text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g)
  return <div className="space-y-3 break-words text-base leading-relaxed">{parts.map((part, index) => {
    if (part.startsWith('```')) {
      const first = part.indexOf('\n'), language = part.slice(3, first).trim()
      const code = part.slice(first + 1).replace(/```$/, '')
      return <div key={index} className="overflow-hidden rounded-lg border"><div className="flex items-center justify-between bg-muted px-3 py-1 text-xs"><span>{language}</span><CopyCode code={code} /></div><pre className="overflow-x-auto p-3 text-sm"><code>{code}</code></pre></div>
    }
    return <div key={index} className="whitespace-pre-wrap">{prose(part)}</div>
  })}</div>
})
