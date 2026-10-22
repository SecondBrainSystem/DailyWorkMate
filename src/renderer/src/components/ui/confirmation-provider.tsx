import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { ConfirmDialog } from './confirm-dialog'

interface Confirmation {
  owner: symbol
  message: string
  resolve: (confirmed: boolean) => void
  returnFocus: HTMLElement | null
}
interface ConfirmationContextValue {
  request: (owner: symbol, message: string) => Promise<boolean>
  cancel: (owner: symbol) => void
}
const ConfirmationContext = createContext<ConfirmationContextValue | null>(null)

/** Keep confirmations inside Chromium: native synchronous dialogs can strand keyboard focus. */
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const pending = useRef<Confirmation | null>(null)
  const [dialog, setDialog] = useState<Confirmation | null>(null)
  const [open, setOpen] = useState(false)
  const finish = useCallback((confirmed: boolean) => {
    const current = pending.current
    pending.current = null
    setOpen(false)
    current?.resolve(confirmed)
  }, [])
  const request = useCallback((owner: symbol, message: string) => {
    // A modal already owns input; never replace its unresolved action.
    if (pending.current) return Promise.resolve(false)
    return new Promise<boolean>(resolve => {
      const next = { owner, message, resolve, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null }
      pending.current = next
      setDialog(next)
      setOpen(true)
    })
  }, [])
  const cancel = useCallback((owner: symbol) => {
    if (pending.current?.owner === owner) finish(false)
  }, [finish])
  // Also cancel for kept-alive pages when navigating away, not just on unmount.
  useEffect(() => () => finish(false), [location.key, finish])
  const context = useMemo(() => ({ request, cancel }), [request, cancel])

  return <ConfirmationContext.Provider value={context}>
    {children}
    <ConfirmDialog open={open} title={dialog?.message} destructive
      onOpenChange={next => { if (!next) finish(false) }} onConfirm={() => finish(true)}
      onCloseAutoFocus={event => {
        event.preventDefault()
        const target = dialog?.returnFocus
        if (target?.isConnected && target.getClientRects().length && !target.matches(':disabled')) target.focus({ preventScroll: true })
      }} />
  </ConfirmationContext.Provider>
}

/** A cancelled/unmounted owner must never execute the action that was awaiting confirmation. */
export function useConfirm(active = true): (message: string) => Promise<boolean> {
  const context = useContext(ConfirmationContext)
  if (!context) throw new Error('useConfirm requires ConfirmationProvider')
  const { request, cancel } = context
  const owner = useRef(Symbol('confirmation'))
  useEffect(() => {
    const id = owner.current
    if (!active) cancel(id)
    return () => cancel(id)
  }, [active, cancel])
  return useCallback((message: string) => active ? request(owner.current, message) : Promise.resolve(false), [active, request])
}
