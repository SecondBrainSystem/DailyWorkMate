import { localDateKey } from '../../../shared/localDate'
import { usageHistoryStart } from '../../../shared/usageHistory'

export interface UsageRecord {
  totalRequests?: number
  successRequests?: number
  failedRequests?: number
  totalLatency?: number
  totalTokens?: number
  modelUsage?: Record<string, number>
  modelTokenUsage?: Record<string, number>
}

export interface UsageSnapshot extends UsageRecord {
  dailyStatsAvailableFrom?: string
  dailyStats?: Record<string, UsageRecord>
}

export interface UsageDay {
  date: string
  available: boolean
  tokens: number
  requests: number
  success: number
  failed: number
  latency: number
  modelTokens: Record<string, number>
  modelRequests: Record<string, number>
}

export interface ModelUsage {
  model: string
  tokens: number
  requests: number
}

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
const counts = (values?: Record<string, number>) => Object.fromEntries(Object.entries(values || {}).map(([key, value]) => [key, count(value)]))

/** Calendar arithmetic keeps dates contiguous over DST and uses the store's local-day boundaries. */
export function usageDays(snapshot: UsageSnapshot | null, days: number, now = new Date()): UsageDay[] {
  const length = Number.isFinite(days) ? Math.min(366, Math.max(1, Math.floor(days))) : 30
  const availableFrom = usageHistoryStart(snapshot?.dailyStatsAvailableFrom)
  return Array.from({ length }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - length + 1 + index, 12)
    const key = localDateKey(date)
    const stored = snapshot?.dailyStats?.[key]
    const requests = count(stored?.totalRequests)
    return {
      available: !!stored || !!(availableFrom && key >= availableFrom),
      date: key, tokens: count(stored?.totalTokens), requests,
      success: Math.min(requests, count(stored?.successRequests)),
      failed: Math.min(requests, count(stored?.failedRequests)),
      latency: count(stored?.totalLatency),
      modelTokens: counts(stored?.modelTokenUsage), modelRequests: counts(stored?.modelUsage),
    }
  })
}

export function summarizeUsage(snapshot: UsageSnapshot | null, days: number, now = new Date()) {
  const current = usageDays(snapshot, days, now)
  const previousEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - current.length, 12)
  const previous = usageDays(snapshot, current.length, previousEnd)
  const totalTokens = current.reduce((sum, day) => sum + day.tokens, 0)
  const previousTokens = previous.reduce((sum, day) => sum + day.tokens, 0)
  const totalRequests = current.reduce((sum, day) => sum + day.requests, 0)
  const successes = current.reduce((sum, day) => sum + day.success, 0)
  const availableDays = current.filter(day => day.available).length
  const complete = availableDays === current.length
  const canCompare = complete && previous.every(day => day.available)
  const models = [...new Set(current.flatMap(day => [...Object.keys(day.modelTokens), ...Object.keys(day.modelRequests)]))]
    .map(model => ({
      model, tokens: current.reduce((sum, day) => sum + count(day.modelTokens[model]), 0),
      requests: current.reduce((sum, day) => sum + count(day.modelRequests[model]), 0),
    }))
    .filter(model => model.tokens > 0 || model.requests > 0)
    .sort((left, right) => right.tokens - left.tokens || right.requests - left.requests || left.model.localeCompare(right.model))
  return {
    days: current, totalTokens, totalRequests, models,
    availableDays, complete, canCompare,
    previousTokens,
    tokenChange: canCompare && previousTokens > 0 ? (totalTokens - previousTokens) / previousTokens * 100 : null,
    dailyAverage: availableDays > 0 ? totalTokens / availableDays : null,
    activeDays: current.filter(day => day.requests > 0 || day.tokens > 0).length,
    peak: current.reduce<UsageDay | null>((best, day) => day.tokens > (best?.tokens || 0) ? day : best, null),
    successRate: totalRequests > 0 ? successes / totalRequests * 100 : null,
    avgLatency: successes > 0 ? current.reduce((sum, day) => sum + day.latency, 0) / successes : null,
    failedRequests: current.reduce((sum, day) => sum + day.failed, 0),
    unattributedTokens: Math.max(0, totalTokens - models.reduce((sum, model) => sum + model.tokens, 0)),
  }
}

export function compactUsage(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function modelDayUsage(day: UsageDay, model: string, metric: 'tokens' | 'requests') {
  return count((metric === 'tokens' ? day.modelTokens : day.modelRequests)[model])
}

export function usageDate(date: string, locale: string, short = false) {
  return new Date(date + 'T12:00:00').toLocaleDateString(locale, { month: short ? 'numeric' : 'short', day: 'numeric' })
}
