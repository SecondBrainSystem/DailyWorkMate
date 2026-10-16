import { useCallback, useEffect, useRef, useState } from 'react'
import { internalInferenceFetch } from './internalInferenceClient.ts'

/**
 * Checks routing eligibility without running inference. Actual response tests
 * are manual per-model operations on the Ollama Nodes page.
 */
export type PreverifyStatus = 'idle' | 'checking' | 'ready' | 'failed' | 'skipped'

export interface PreverifyState {
  status: PreverifyStatus
  /** Model the status refers to; compare before trusting it. */
  model: string
  error?: string
  skipped?: boolean
}

const READY_TTL = 25 * 60_000 // a little under the proxy's 30-minute success cache
const FAILED_TTL = 2 * 60_000 // matches the proxy's failure cache
const cache = new Map<string, { ok: boolean; skipped?: boolean; error?: string; expiresAt: number }>()
const inFlight = new Map<string, Promise<{ ok: boolean; skipped?: boolean; error?: string }>>()

/** Native OpenCode models are verified by their runtime rather than our provider router. */
export function isVerifiableModel(model: string): boolean {
  return Boolean(model) && !model.startsWith('opencode-free/')
}

/** Forget cached results, e.g. after the model list or provider accounts change. */
export function clearPreverifyCache(model?: string) {
  if (model) cache.delete(model)
  else cache.clear()
}

/** Last known result for a model, if still fresh. */
export function peekPreverify(model: string): { ok: boolean; skipped?: boolean; error?: string } | undefined {
  const entry = cache.get(model)
  if (!entry) return undefined
  if (entry.expiresAt < Date.now()) {
    cache.delete(model)
    return undefined
  }
  return { ok: entry.ok, error: entry.error, skipped: entry.skipped }
}

/** Verifies one model without recovery; concurrent callers share the same request. */
export function preverifyModel(model: string): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const cached = peekPreverify(model)
  if (cached) return Promise.resolve(cached)
  const pending = inFlight.get(model)
  if (pending) return pending

  const request = (async () => {
    try {
      const config = await window.electronAPI.config.get()
      const response = await internalInferenceFetch('/v1/models/verify', {
        method: 'POST',
        body: JSON.stringify({ model, recover: false }),
        signal: AbortSignal.timeout((config.requestTimeout || 120000) * 2 + 10000),
      })
      const body = await response.json().catch(() => ({})) as { model?: string; skipped?: boolean; error?: { message?: string } }
      const ok = response.ok && body.model === model
      const result = ok ? { ok: true, skipped: body.skipped } : { ok: false, error: body.error?.message || (response.ok ? 'The selected model could not be verified' : `HTTP ${response.status}`) }
      cache.set(model, { ...result, expiresAt: Date.now() + (ok ? READY_TTL : FAILED_TTL) })
      return result
    } catch (error) {
      // Transient bridge or provider errors are not cached, so the next selection retries.
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      inFlight.delete(model)
    }
  })()
  inFlight.set(model, request)
  return request
}

/**
 * Selecting a model only displays its cached status. `recheck` is explicit;
 * callers can also check the route just before sending or connecting a session.
 */
export function useModelPreverification(model: string, enabled: boolean) {
  const [state, setState] = useState<PreverifyState>({ status: 'idle', model: '' })
  const generation = useRef(0)

  const run = useCallback((target: string, force: boolean) => {
    const id = ++generation.current
    if (!enabled || !isVerifiableModel(target)) {
      setState({ status: 'idle', model: target })
      return
    }
    if (force) clearPreverifyCache(target)
    const cached = peekPreverify(target)
    if (cached) {
      setState({ status: cached.ok ? cached.skipped ? 'skipped' : 'ready' : 'failed', model: target, error: cached.error })
      return
    }
    setState({ status: 'checking', model: target })
    void preverifyModel(target).then(result => {
      if (generation.current !== id) return
      setState({ status: result.ok ? result.skipped ? 'skipped' : 'ready' : 'failed', model: target, error: result.error })
    })
  }, [enabled])

  useEffect(() => {
    generation.current++
    const cached = enabled && isVerifiableModel(model) ? peekPreverify(model) : undefined
    setState({ status: cached ? cached.ok ? cached.skipped ? 'skipped' : 'ready' : 'failed' : 'idle', model, error: cached?.error })
    return () => { generation.current++ }
  }, [model, enabled])

  const recheck = useCallback(() => run(model, true), [model, run])
  const report = (ok: boolean, error?: string, skipped?: boolean) => {
    generation.current++
    cache.set(model, { ok, error, skipped, expiresAt: Date.now() + (ok ? READY_TTL : FAILED_TTL) })
    setState({ model, status: ok ? skipped ? 'skipped' : 'ready' : 'failed', error })
  }
  return { ...(state.model === model ? state : { model, status: 'idle' as const }), recheck, report }
}
