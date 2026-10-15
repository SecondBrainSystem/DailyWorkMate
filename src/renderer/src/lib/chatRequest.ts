import type { ChatMessage } from './chatWorkspace'
import type { ChatApiMessage } from './chatClient'

function toApiMessage(message: ChatMessage, visionEnabled: boolean): ChatApiMessage {
  if (message.role === 'assistant') return { role: 'assistant', content: message.content }

  const textFiles = (message.attachments || []).filter(item => item.kind === 'text')
  const images = visionEnabled ? (message.attachments || []).filter(item => item.kind === 'image') : []
  const fileContent = textFiles.map(file => (
    `\n\n<attachment name="${file.name}">\n${file.content}\n</attachment>`
  )).join('')
  const text = `${message.content}${fileContent}`

  if (images.length === 0) return { role: 'user', content: text }
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map(image => ({
        type: 'image_url' as const,
        image_url: { url: image.content, detail: 'auto' as const },
      })),
    ],
  }
}

/** Status messages belong to the UI; only actual assistant output enters the next request. */
export function toChatApiMessages(messages: ChatMessage[], visionEnabled: boolean, latestImagesOnly = false): ChatApiMessage[] {
  const latestUser = [...messages].reverse().find(item => item.role === 'user')
  return messages
    .filter(message => message.role !== 'assistant' || message.content.trim().length > 0)
    .map(message => toApiMessage(message, visionEnabled && (!latestImagesOnly || message === latestUser)))
}
