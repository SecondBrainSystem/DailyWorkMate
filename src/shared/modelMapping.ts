/** Exact names win; otherwise use the most specific wildcard, with stable tie breaking. */
export function findModelMapping<T>(model: string, mappings: Record<string, T>): T | undefined {
  if (Object.prototype.hasOwnProperty.call(mappings, model)) return mappings[model]
  const entries = Object.entries(mappings).sort(([a], [b]) => b.replace(/\*/g, '').length - a.replace(/\*/g, '').length || a.localeCompare(b))
  return entries.find(([pattern]) => {
    const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    return new RegExp('^' + expression + '$', 'i').test(model)
  })?.[1]
}
