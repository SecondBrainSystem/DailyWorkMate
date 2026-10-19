/** The parts of electron-store (conf) that the app uses. */
export interface PersistentStore {
  store: Record<string, unknown>
  set(key: string, value: unknown): void
  delete(key: string): void
  clear(): void
}

const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value))

/** Freeze a JSON tree in place. Only used on trees this module just created. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

/**
 * electron-store re-reads the file and re-derives its PBKDF2 key on every `get`, so listing models
 * (hundreds of settings reads) blocked the main process for over a second at startup. Keep one
 * decrypted copy in memory; every write still goes to disk immediately and only then updates the copy.
 * Reads return JSON copies, exactly what would be read back from disk, so callers cannot change the cache.
 * Hot paths that only read may use `peek`, which returns the frozen cached tree without copying, and
 * `version`, which changes on every write so derived indexes know when to rebuild.
 */
export function cachedStore<T extends PersistentStore>(store: T) {
  let data: Record<string, unknown> = deepFreeze(copy(store.store))
  let version = 0
  const replace = (next: Record<string, unknown>) => { data = deepFreeze(next); version += 1 }
  const persist = (next: Record<string, unknown>) => {
    store.store = next
    // `next` shares frozen subtrees with the previous cache plus one fresh JSON copy, so freezing it is safe.
    replace(next)
  }
  const lookup = (key: string): unknown => {
    let value: unknown = data
    for (const part of key.split('.')) {
      if (!value || typeof value !== 'object' || !(part in value)) return undefined
      value = (value as Record<string, unknown>)[part]
    }
    return value
  }
  return {
    get(key: string, defaultValue?: unknown): any {
      const value = lookup(key)
      return value === undefined ? defaultValue : copy(value)
    },
    /** Read-only view of the cached value. Never mutate it; it is frozen and shared. */
    peek(key: string): unknown { return lookup(key) },
    get version(): number { return version },
    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'object') { persist({ ...data, ...copy(key) }); return }
      if (value === undefined) throw new TypeError('Use `delete()` to clear values')
      if (!key.includes('.')) { persist({ ...data, [key]: copy(value) }); return }
      store.set(key, value)
      replace(copy(store.store))
    },
    delete(key: string): void {
      store.delete(key)
      replace(copy(store.store))
    },
    clear(): void {
      store.clear()
      replace(copy(store.store))
    },
    has(key: string): boolean { return lookup(key) !== undefined },
    get store(): Record<string, unknown> { return copy(data) },
  }
}

export type CachedStore = ReturnType<typeof cachedStore>
