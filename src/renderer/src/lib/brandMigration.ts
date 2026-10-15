/** Keep the previous names only here, to import existing settings and conversations once. */
export function migrateLocalStorage(storage: Storage): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key)
  for (const key of keys) {
    if (!key.startsWith('chat2api')) continue
    const next = key.replace(/^chat2api/, 'dailyworkmate')
    if (storage.getItem(next) === null) storage.setItem(next, storage.getItem(key)!)
  }
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

async function migrateHistory(factory: IDBFactory, source: string, target: string): Promise<void> {
  const old = await requestResult(factory.open(source))
  try {
    const names = Array.from(old.objectStoreNames)
    const transaction = old.transaction(names, 'readonly')
    const rows = await Promise.all(names.map(async name => {
      const store = transaction.objectStore(name)
      const keys = requestResult(store.getAllKeys())
      const values = requestResult(store.getAll())
      return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, keys: await keys, values: await values }
    }))
    const opening = factory.open(target, old.version)
    opening.onupgradeneeded = () => {
      for (const row of rows) opening.result.createObjectStore(row.name, { keyPath: row.keyPath, autoIncrement: row.autoIncrement })
    }
    const next = await requestResult(opening)
    try {
      await new Promise<void>((resolve, reject) => {
        const write = next.transaction(names, 'readwrite')
        write.oncomplete = () => resolve()
        write.onabort = () => reject(write.error || new Error('History migration was interrupted'))
        write.onerror = () => reject(write.error)
        for (const row of rows) {
          const store = write.objectStore(row.name)
          row.values.forEach((value, index) => row.keyPath === null ? store.put(value, row.keys[index]) : store.put(value))
        }
      })
    } catch (error) {
      next.close()
      await requestResult(factory.deleteDatabase(target))
      throw error
    } finally { next.close() }
  } finally { old.close() }
}

export async function migrateRendererData(storage: Storage, factory: IDBFactory): Promise<void> {
  migrateLocalStorage(storage)
  const databases = await factory.databases()
  for (const name of ['chat.history.v1', 'companion.history.v1']) {
    const source = 'chat2api.' + name, target = 'dailyworkmate.' + name
    if (databases.some(db => db.name === source) && !databases.some(db => db.name === target)) await migrateHistory(factory, source, target)
  }
}
