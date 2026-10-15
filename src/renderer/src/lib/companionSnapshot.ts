import type { CompanionSnapshot } from '../../../shared/companion'

/** Settings-only IPC replies omit heavy avatar assets; only a full reply replaces them. */
export function mergeCompanionSnapshot(current: CompanionSnapshot | null, result: CompanionSnapshot): CompanionSnapshot {
  if (result.assetsIncluded !== false) return result
  return {
    ...result,
    avatarUrl: current?.avatarUrl || '',
    avatarModelUrl: current?.avatarModelUrl || '',
    avatarModelError: current?.avatarModelError,
  }
}
