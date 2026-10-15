import { useEffect, useRef } from 'react'
import { useProvidersStore } from '@/stores/providersStore'

/** Read local state only; never turn a refresh into a remote account check. */
export function useProviderRefresh(onError: (error: unknown) => void) {
  const reportError = useRef(onError)
  reportError.current = onError
  useEffect(() => {
    let active = true
    let pending = false
    let lastError = ''
    const refresh = async () => {
      if (document.hidden || pending) return
      pending = true
      try {
        const [providers, accounts] = await Promise.all([
          window.electronAPI.providers.getAll(), window.electronAPI.accounts.getAll(),
        ])
        if (!active) return
        lastError = ''
        useProvidersStore.setState({
          providers, accounts,
          providerStatuses: Object.fromEntries(providers.map(provider => [provider.id, provider.status || 'unknown'])),
          accountCounts: Object.fromEntries(providers.map(provider => [provider.id, {
            total: accounts.filter(account => account.providerId === provider.id).length,
            active: accounts.filter(account => account.providerId === provider.id && account.status === 'active').length,
          }])),
        })
      } catch (error) {
        const message = String(error)
        if (active && message !== lastError) reportError.current(error)
        lastError = message
      }
      finally { pending = false }
    }
    const timer = setInterval(() => void refresh(), 5000)
    window.addEventListener('focus', refresh)
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [])
}
