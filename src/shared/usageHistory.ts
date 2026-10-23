import { localDateKey } from './localDate'

/** Two complete 90-day reporting periods, independently of detailed log retention. */
export const MIN_USAGE_HISTORY_DAYS = 180

export function usageHistoryStart(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  return localDateKey(new Date(value + 'T12:00:00')) === value ? value : undefined
}
