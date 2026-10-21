import { memo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Volume2 } from 'lucide-react'
import type { CompanionMessage } from '@shared/companion'
import { MessageMarkdown } from '@/components/chat/MessageMarkdown'
import { WorkspaceAgentStatus } from '@/components/chat/ChatWorkspaceAccess'
import { ErrorText } from '@/components/ui/error-text'
import { CopyTextButton } from '@/components/ui/copy-text-button'
import type { CompanionCopy } from './copy'

const ATTACHED_FILE = /\n\n<attached-file name=([\s\S]*?)>[\s\S]*?<\/attached-file>/g

export interface CompanionMessageItemProps {
  message: CompanionMessage
  name: string
  copy: CompanionCopy
  locale: string
  /** Model of the answer this one retried, already resolved by the list. */
  retrySource?: string
  /** Shown instead of an empty body, e.g. the waiting text of the streaming answer. */
  placeholder?: string
  speakDisabled: boolean
  onSpeak(message: CompanionMessage, reading: 'summary' | 'full'): void
  onReply(id: string, allow: boolean): Promise<void>
  /** Only the message that offers a tool-model retry passes this. */
  footer?: ReactNode
}

/**
 * Memoized so a streamed token re-renders and re-parses only the answer being written,
 * not every earlier message. All callbacks passed in must be stable.
 */
export const CompanionMessageItem = memo(function CompanionMessageItem({ message, name, copy, locale, retrySource, placeholder, speakDisabled, onSpeak, onReply, footer }: CompanionMessageItemProps) {
  const { t } = useTranslation()
  return <article data-message-id={message.id} className={'companion-message ' + (message.role === 'user' ? 'is-user' : '')}>
    <div className="companion-message-label">{message.role === 'user' ? t('companion.message.you') : name}{message.role === 'assistant' && message.model && <span data-message-model className="break-all"> · {message.model}</span>}{message.retryOf && <span data-retry-source>{t('companion.message.retryFrom')}{retrySource}</span>}{message.role === 'assistant' && message.content && (['summary', 'full'] as const).map(reading => <button key={reading} className="companion-read-button" aria-label={copy[reading] + ' · ' + name + ' · ' + new Date(message.createdAt).toLocaleString(locale)} disabled={speakDisabled} onClick={() => onSpeak(message, reading)}><Volume2 size={12} />{copy[reading]}</button>)}</div>
    <div className="companion-message-body">{message.content ? <MessageMarkdown text={message.content.replace(ATTACHED_FILE, (_match, file) => '\n📎 ' + file)} /> : placeholder && <span className="text-[var(--text-muted)]">{placeholder}</span>}</div>
    {!!message.content && <div className="companion-message-copy"><CopyTextButton text={message.content} /></div>}
    {message.error && <p role="alert" className="mt-2 whitespace-pre-wrap break-words text-sm text-danger"><ErrorText error={message.error} /></p>}
    {footer}
    {!!message.tools?.length && <WorkspaceAgentStatus snapshot
={{ sessionId: '', running: false, text: '', error: '', tools: message.tools, permissions: [] }} onReply={onReply} />}
  </article>
})
