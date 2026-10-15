/** The parts of electron-store (conf) that the app uses. */
export interface PersistentStore {
  store: Record<string, unknown>
  set(key: string, value: unknown): void
  delete(key: string): void
  clear(): void
}

const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value))

/**
 * electron-store re-reads the file and re-derives its PBKDF2 key on every `get`, so listing models
 * (hundreds of settings reads) blocked the main process for over a second at startup. Keep one
 * decrypted copy in memory; every write still goes to disk immediately and only then updates the copy.
 * Reads return JSON copies, exactly what would be read back from disk, so callers cannot change the cache.
 */
export function cachedStore<T extends PersistentStore>(store: T) {
  let data: Record<string, unknown> = copy(store.store)
  const persist = (next: Record<string, unknown>) => {
    store.store = next
    data = copy(next)
  }
  return {
    get(key: string, defaultValue?: unknown): any {
      let value: unknown = data
      for (const part of key.split('.')) {
        if (!value || typeof value !== 'object' || !(part in value)) return defaultValue
        value = (value as Record<string, unknown>)[part]
      }
      return copy(value)
    },
    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'object') { persist({ ...data, ...copy(key) }); return }
      if (value === undefined) throw new TypeError('Use `delete()` to clear values')
      if (!key.includes('.')) { persist({ ...data, [key]: copy(value) }); return }
      store.set(key, value)
      data = copy(store.store)
    },
    delete(key: string): void {
      store.delete(key)
      data = copy(store.store)
    },
    clear(): void {
      store.clear()
      data = copy(store.store)
    },
    has(key: string): boolean { return this.get(key) !== undefined },
    get store(): Record<string, unknown> { return copy(data) },
  }
}
