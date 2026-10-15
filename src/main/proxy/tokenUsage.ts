import { Transform } from 'stream'

type UnknownRecord = Record<string, unknown>

const MAX_TRACKED_RESPONSE_CHARS = 1024 * 1024

function finiteTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

function tokenCountFromObject(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  const record = value as UnknownRecord
  const directTotal = Math.max(
    finiteTokenCount(record.total_tokens),
    finiteTokenCount(record.totalTokens),
  )
  const openAiParts = finiteTokenCount(record.prompt_tokens) + finiteTokenCount(record.completion_tokens)
  const anthropicParts = finiteTokenCount(record.input_tokens) + finiteTokenCount(record.output_tokens)
  const ollamaParts = finiteTokenCount(record.prompt_eval_count) + finiteTokenCount(record.eval_count)
  let best = Math.max(directTotal, openAiParts, anthropicParts, ollamaParts)

  for (const nested of Object.values(record)) {
    best = Math.max(best, tokenCountFromObject(nested))
  }
  return best
}

function maxRegexValue(text: string, field: string): number {
  const expression = new RegExp(`"${field}"\\s*:\\s*(\\d+)`, 'g')
  let best = 0
  for (const match of text.matchAll(expression)) {
    best = Math.max(best, Number(match[1]) || 0)
  }
  return best
}

export function extractTokenCount(payload: unknown): number {
  if (typeof payload !== 'string') return tokenCountFromObject(payload)

  let best = 0
  const trimmed = payload.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      best = tokenCountFromObject(JSON.parse(trimmed))
    } catch {
      // Streaming responses contain multiple JSON documents.
    }
  }

  for (const line of payload.split(/\r?\n/)) {
    const data = line.trim().startsWith('data:') ? line.trim().slice(5).trim() : line.trim()
    if (!data || data === '[DONE]' || (!data.startsWith('{') && !data.startsWith('['))) continue
    try {
      best = Math.max(best, tokenCountFromObject(JSON.parse(data)))
    } catch {
      // Some upstream streams are not line-delimited JSON; regex fallback below handles them.
    }
  }

  const explicitTotal = Math.max(maxRegexValue(payload, 'total_tokens'), maxRegexValue(payload, 'totalTokens'))
  const openAiParts = maxRegexValue(payload, 'prompt_tokens') + maxRegexValue(payload, 'completion_tokens')
  const anthropicParts = maxRegexValue(payload, 'input_tokens') + maxRegexValue(payload, 'output_tokens')
  const ollamaParts = maxRegexValue(payload, 'prompt_eval_count') + maxRegexValue(payload, 'eval_count')
  return Math.max(best, explicitTotal, openAiParts, anthropicParts, ollamaParts)
}

export function createTokenUsageTrackingStream(onUsage: (tokens: number) => void): Transform {
  let tail = ''
  return new Transform({
    transform(chunk, _encoding, callback) {
      tail = `${tail}${chunk.toString()}`.slice(-MAX_TRACKED_RESPONSE_CHARS)
      this.push(chunk)
      callback()
    },
    flush(callback) {
      onUsage(extractTokenCount(tail))
      callback()
    },
  })
}
