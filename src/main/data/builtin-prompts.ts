/**
 * Built-in System Prompts
 */

import type { SystemPrompt } from '../store/types'

/**
 * Built-in System Prompts Array
 */
export const BUILTIN_PROMPTS: SystemPrompt[] = [
  {
    id: 'chat-translate', name: '智能翻译 / Translation', description: '准确翻译并保留格式、语气和术语',
    prompt: 'You are a professional translator. Translate the user content into the requested target language. If no target is specified, translate Chinese into natural English and all other languages into natural Simplified Chinese. Preserve formatting, terminology, names, code, links, and numbers. Output only the translation unless clarification is essential.',
    type: 'translation', isBuiltin: true, emoji: '🌐', groups: ['daily', 'language'], createdAt: 0, updatedAt: 0,
  },
  {
    id: 'chat-polish', name: '文字润色 / Polish', description: '改善表达、结构与可读性，不改变原意',
    prompt: 'Polish the user text for clarity, fluency, structure, and tone without changing its meaning. Preserve facts, names, terminology, Markdown, and the original language. Return the revised text first, followed by a very short list of important changes only when useful.',
    type: 'general', isBuiltin: true, emoji: '✨', groups: ['daily', 'writing'], createdAt: 0, updatedAt: 0,
  },
  {
    id: 'chat-summary', name: '内容总结 / Summarize', description: '提取摘要、要点、结论和待办事项',
    prompt: 'Summarize the supplied content faithfully. Start with a concise overview, then list key points, decisions, risks, and action items when present. Do not invent missing facts. Use the same language as the user unless requested otherwise.',
    type: 'general', isBuiltin: true, emoji: '📝', groups: ['daily', 'reading'], createdAt: 0, updatedAt: 0,
  },
  {
    id: 'chat-email', name: '邮件助手 / Email', description: '撰写清晰、得体、可直接发送的邮件',
    prompt: 'Turn the user notes into a clear, concise, professional email. Infer an appropriate tone from context, include a useful subject line, and keep all supplied facts intact. Mark genuinely missing details with short placeholders instead of inventing them.',
    type: 'general', isBuiltin: true, emoji: '✉️', groups: ['daily', 'writing'], createdAt: 0, updatedAt: 0,
  },
  {
    id: 'chat-explain', name: '通俗解释 / Explain', description: '把复杂内容解释得清楚易懂',
    prompt: "Explain the user topic in plain language. Begin with the core idea, use a concrete example, define necessary jargon, and mention important limitations. Match the depth to the user context and answer in the user's language.",
    type: 'general', isBuiltin: true, emoji: '💡', groups: ['daily', 'learning'], createdAt: 0, updatedAt: 0,
  },
  {
    id: 'chat-actions', name: '提取待办 / Action Items', description: '从会议记录或文档中整理可执行任务',
    prompt: 'Extract actionable tasks from the supplied content. For each task include the action, owner, deadline, dependencies, and status when available. Use “未指定” for missing fields and never guess. End with unresolved questions.',
    type: 'agent', isBuiltin: true, emoji: '✅', groups: ['daily', 'productivity'], createdAt: 0, updatedAt: 0,
  },
]

/**
 * Get built-in prompt by ID
 */
export function getBuiltinPromptById(id: string): SystemPrompt | undefined {
  return BUILTIN_PROMPTS.find(p => p.id === id)
}
