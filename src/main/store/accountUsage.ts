import type { Account } from './types'

/** Daily quotas follow the desktop's local calendar, including DST boundaries. */
export function accountUsageDate(now = Date.now()): string {
  const date = new Date(now)
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}

/** Normalize on read so restarts and sleep across midnight need no timer or disk write. */
export function normalizeAccountDailyUsage(account: Account, now = Date.now()): Account {
  const today = accountUsageDate(now)
  const previousDay = account.dailyUsageDate || accountUsageDate(account.lastUsed ?? account.createdAt ?? now)
  return {
    ...account,
    todayUsed: previousDay === today ? account.todayUsed || 0 : 0,
    dailyUsageDate: today,
  }
}
