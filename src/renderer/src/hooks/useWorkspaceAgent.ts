import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentInput, AgentSnapshot } from '@shared/companion'
import { WorkspaceAgentRunner, type WorkspaceAgentOptions } from '@/lib/workspaceAgent'

export function useWorkspaceAgent() {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const runner = useRef<WorkspaceAgentRunner | null>(null)
  if (!runner.current) runner.current = new WorkspaceAgentRunner(window.electronAPI.companion)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; void runner.current!.cancel().catch(error => console.error('[Workspace] Could not stop task on page change:', error)) }
  }, [])
  const execute = useCallback(async (input: AgentInput, options: WorkspaceAgentOptions = {}) => {
    if (mounted.current) { setRunning(true); setError(''); setSnapshot(null) }
    try {
      return await runner.current!.execute(input, { ...options, onUpdate: next => {
        if (mounted.current) setSnapshot(next)
        options.onUpdate?.(next)
      } })
    } catch (failure) {
      if (mounted.current && !(failure instanceof DOMException && failure.name === 'AbortError')) setError(failure instanceof Error ? failure.message : String(failure))
      throw failure
    } finally { if (mounted.current) { setRunning(false); setSnapshot(current => current ? { ...current, running: false, permissions: [] } : null) } }
  }, [])
  const cancel = useCallback(async () => {
    await runner.current!.cancel()
    if (mounted.current) setSnapshot(current => current ? { ...current, running: false, permissions: [] } : null)
  }, [])
  const reply = useCallback(async (id: string, allow: boolean) => {
    if (mounted.current) setError('')
    try { await runner.current!.reply(id, allow) }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)); throw failure }
  }, [])
  const reset = useCallback(() => { setSnapshot(null); setError('') }, [])
  return { snapshot, running, error, execute, cancel, reply, reset }
}
