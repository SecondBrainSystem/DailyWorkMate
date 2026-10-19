import { CircleHelp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { OpenCodeFreeCatalogue } from '@shared/companion'
import { Button } from '@/components/ui/button'
import { HeaderPopover } from './HeaderPopover'

/** Tips & help as a button in the control row; a dot marks a catalogue problem or a free-model limitation. */
export function CompanionHints({ catalogue, loading = false, onRefresh, freeModelHint, folderDrop = false }: {
  catalogue?: OpenCodeFreeCatalogue
  loading?: boolean
  onRefresh: () => void
  freeModelHint?: string
  folderDrop?: boolean
}) {
  const { t } = useTranslation()
  const catalogueNotice = catalogue && (loading || catalogue.error || catalogue.stale || !catalogue.models.length)
  if (!folderDrop && !catalogueNotice && !freeModelHint) return null
  const status = !catalogueNotice ? freeModelHint ? t('companion.hints.freeModelGuidance') : ''
    : loading ? t('companion.hints.loadingFree')
      : catalogue?.error ? t('companion.hints.freeUnavailable')
        : catalogue?.stale ? t('companion.hints.freeStale')
          : t('companion.hints.noFree')
  const title = t('companion.hints.title') + (status ? ' · ' + status : '')
  return <HeaderPopover rootProps={{ 'data-companion-hints': status }} icon={<CircleHelp size={16} aria-hidden="true" />} label={t('companion.hints.title')} title={title}
    badge={!!catalogueNotice || !!freeModelHint} panelClassName="companion-hints-body">
    {status && <p className="companion-hints-status" role="status">{status}</p>}
    {catalogueNotice && <div data-free-models-status className="companion-hints-catalogue" aria-busy={loading}>
      <div className="min-w-0 flex-1 break-words">
        <p>{t('companion.hints.freeModels')}{loading ? t('companion.hints.loadingList') : catalogue?.error || (catalogue?.stale
          ? t('companion.hints.listExpired')
          : t('companion.hints.listEmpty'))}</p>
        {catalogue?.error && <p className="mt-1">{t('companion.hints.listError')}</p>}
      </div>
      <Button size="sm" variant="outline" disabled={loading} aria-label={t('companion.hints.refreshLabel')} onClick={onRefresh}>{t('companion.hints.refresh')}</Button>
    </div>}
    {freeModelHint && <p data-free-model-limit>{freeModelHint}</p>}
    {folderDrop && <p className="folder-drop-hint">{t('companion.hints.folderDrop')}</p>}
  </HeaderPopover>
}
