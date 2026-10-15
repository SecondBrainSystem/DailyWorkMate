import { thinkingForModel, type ModelFeatureInput } from '../../../shared/modelFeatures.ts'

export interface DeepSeekChatOptionInput extends ModelFeatureInput {
  model: string
  web_search?: boolean
}

export interface DeepSeekChatOptions {
  modelType: 'default' | 'expert'
  searchEnabled: boolean
  thinkingEnabled: boolean
}

export function resolveDeepSeekChatOptions(
  request: DeepSeekChatOptionInput,
  _prompt: string = ''
): DeepSeekChatOptions {
  const modelLower = request.model.toLowerCase()
  const isProModel = modelLower.includes('deepseek-v4-pro') || modelLower.includes('expert')
  const isSearchAlias = modelLower.includes('search')
  return {
    modelType: isProModel ? 'expert' : 'default',
    searchEnabled: request.web_search ?? isSearchAlias,
    thinkingEnabled: thinkingForModel(request),
  }
}

export type KimiScenario = 'SCENARIO_K2D5' | 'SCENARIO_K2D6'

export function resolveKimiScenario(model: string): KimiScenario {
  return model.toLowerCase().includes('k2.6') ? 'SCENARIO_K2D6' : 'SCENARIO_K2D5'
}

export function buildQwenAiConversation(messages: Array<{ role: string; content: unknown }>): string {
  const text = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : ''
  const system = messages.filter(message => message.role === 'system').map(message => text(message.content)).join('\n\n')
  const dialogue = messages.filter(message => message.role !== 'system')
  const conversation = dialogue.length === 1 ? text(dialogue[0].content)
    : dialogue.map(message => `${message.role.toUpperCase()}: ${text(message.content)}`).join('\n\n')
  return system ? `${system}\n\nUser: ${conversation}` : conversation
}

export function createKimiChatPayload(options: {
  model: string
  content: string
  enableWebSearch: boolean
  enableThinking: boolean
}) {
  const scenario = resolveKimiScenario(options.model)

  return {
    scenario,
    chat_id: '',
    tools: options.enableWebSearch ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
    message: {
      parent_id: '',
      role: 'user',
      blocks: [{
        message_id: '',
        text: { content: options.content }
      }],
      scenario,
    },
    options: {
      thinking: options.enableThinking
    }
  }
}

export function encodeKimiGrpcFrame(payload: unknown): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const frameBuffer = Buffer.alloc(5 + jsonBuffer.length)
  frameBuffer.writeUInt8(0, 0)
  frameBuffer.writeUInt32BE(jsonBuffer.length, 1)
  jsonBuffer.copy(frameBuffer, 5)
  return frameBuffer
}
