/**
 * Signs that an "Ollama" node only imitates the API (honeypots, canned-reply servers). Such nodes
 * answer with templates such as a fixed tool refusal, so no client or request format can make them work.
 */

/** Real models are pulled at irregular times; a generated catalog spaces every model identically. */
export function syntheticCatalogReason(data: unknown): string | undefined {
  const models = Array.isArray((data as { models?: unknown })?.models) ? (data as { models: Array<{ modified_at?: unknown }> }).models : []
  const times = models.map(model => typeof model?.modified_at === 'string' ? Date.parse(model.modified_at) : NaN)
    .filter(Number.isFinite).sort((a, b) => a - b)
  if (times.length < 5) return undefined
  const gaps = times.slice(1).map((time, index) => time - times[index])
  if (gaps[0] <= 0 || gaps.some(gap => gap !== gaps[0])) return undefined
  return `All ${times.length} models report modification times exactly ${(gaps[0] / 1000).toFixed(3)} s apart, which a real Ollama server does not produce. This node is likely imitating Ollama and returning canned replies.`
}

/** Ollama measures `total_duration` (ns) inside the request, so it can never exceed the client's round trip. */
export function impossibleTimingReason(data: unknown, elapsedMs: number): string | undefined {
  const reported = Number((data as { total_duration?: unknown })?.total_duration)
  if (!Number.isFinite(reported) || reported <= 0 || !Number.isFinite(elapsedMs)) return undefined
  const reportedMs = reported / 1e6
  if (reportedMs <= elapsedMs + 500) return undefined
  return `The node reported ${(reportedMs / 1000).toFixed(2)} s of processing for a reply that arrived in ${(elapsedMs / 1000).toFixed(2)} s. The timing is fabricated, so this node is not running the model it lists and its answers (including tool refusals) are canned.`
}
