import { create } from 'zustand'
import type { UsageSnapshot } from '@/lib/usageMetrics'
import type { ActivityItem } from '@/components/dashboard/RecentActivity'

interface DashboardState {
  snapshot: UsageSnapshot | null
  activities: ActivityItem[]
  isLoading: boolean
  error: string | null
  activityError: string | null
  lastUpdated: number | null
  refreshData: () => Promise<void>
}

let inFlight: Promise<void> | null = null

/** One snapshot feeds every period and model filter. Failed polls retain the last good data. */
export const useDashboardStore = create<DashboardState>((set) => ({
  snapshot: null,
  activities: [],
  isLoading: false,
  error: null,
  activityError: null,
  lastUpdated: null,
  refreshData: () => {
    if (inFlight) return inFlight
    if (!window.electronAPI?.statistics?.get) return Promise.resolve()
    set({ isLoading: true })
    inFlight = (async () => {
      const [statistics, requests] = await Promise.allSettled([
        window.electronAPI.statistics.get(),
        window.electronAPI.requestLogs?.get({ limit: 7, summaryOnly: true }) ?? Promise.resolve([]),
      ])
      if (statistics.status === 'fulfilled') {
        set({ snapshot: statistics.value, lastUpdated: Date.now(), error: null })
      } else {
        set({ error: statistics.reason instanceof Error ? statistics.reason.message : String(statistics.reason) })
      }
      if (requests.status === 'fulfilled') {
        set({
          activityError: null,
          activities: requests.value.map(log => ({
            id: log.id,
            type: log.status === 'success' ? 'success' : 'error',
            title: log.model,
            timestamp: log.timestamp,
            providerName: log.providerName,
            modelName: log.model,
            latency: log.latency,
            statusCode: log.statusCode,
          })),
        })
      } else {
        set({ activityError: requests.reason instanceof Error ? requests.reason.message : String(requests.reason) })
      }
    })().catch(error => {
      set({ error: error instanceof Error ? error.message : String(error) })
    }).finally(() => {
      inFlight = null
      set({ isLoading: false })
    })
    return inFlight
  },
}))
