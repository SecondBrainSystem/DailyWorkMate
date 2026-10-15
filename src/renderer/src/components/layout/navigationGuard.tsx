import { useCallback, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useNavigationStore } from '@/stores/navigationStore'

/**
 * Navigates unless a page has registered unsaved changes, in which case the
 * shared confirm dialog asks first. Use for every in-app menu or switcher.
 */
export function useGuardedNavigate() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const setPendingNavigation = useNavigationStore(state => state.setPendingNavigation)
  return useCallback((href: string) => {
    if (pathname === href) return
    setPendingNavigation(() => navigate(href))
  }, [navigate, pathname, setPendingNavigation])
}

/** Single "discard unsaved changes?" dialog, mounted once in the layout so it works with the sidebar hidden. */
export function NavigationGuardDialog() {
  const { t } = useTranslation()
  const { blockers, isDialogOpen, confirmNavigation, cancelNavigation } = useNavigationStore()
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (useNavigationStore.getState().blockers.length) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])
  return (
    <ConfirmDialog
      open={isDialogOpen}
      onOpenChange={(open) => { if (!open) cancelNavigation() }}
      destructive
      title={t('proxy.unsavedChangesTitle')}
      description={blockers[0]?.message || t('proxy.unsavedChangesDescription')}
      confirmLabel={t('proxy.discardAndLeave')}
      onConfirm={confirmNavigation}
    />
  )
}
