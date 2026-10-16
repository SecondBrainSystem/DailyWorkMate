import { ChevronRight } from 'lucide-react'
import type { OpenCodeFreeCatalogue } from '@shared/companion'
import { Button } from '@/components/ui/button'

export function CompanionHints({ chinese, catalogue, loading = false, onRefresh, freeModelHint, folderDrop = false }: {
  chinese: boolean
  catalogue?: OpenCodeFreeCatalogue
  loading?: boolean
  onRefresh: () => void
  freeModelHint?: string
  folderDrop?: boolean
}) {
  const catalogueNotice = catalogue && (loading || catalogue.error || catalogue.stale || !catalogue.models.length)
  if (!folderDrop && !catalogueNotice && !freeModelHint) return null
  const status = !catalogueNotice ? freeModelHint ? (chinese ? '免费模型使用提示' : 'Free model guidance') : ''
    : loading ? (chinese ? '免费模型目录加载中…' : 'Loading free models…')
      : catalogue?.error ? (chinese ? '免费模型目录暂不可用' : 'Free model list unavailable')
        : catalogue?.stale ? (chinese ? '免费模型目录待刷新' : 'Free model list needs refresh')
          : (chinese ? '暂无官方免费模型' : 'No official free models')
  return <details className="companion-hints" data-companion-hints>
    <summary><ChevronRight size={14} aria-hidden="true" /><span>{chinese ? '提示与帮助' : 'Tips & help'}</span><span role="status" className="companion-hints-status">{status}</span></summary>
    <div className="companion-hints-body">
      {catalogueNotice && <div data-free-models-status className="companion-hints-catalogue" aria-busy={loading}>
        <div className="min-w-0 flex-1 break-words">
          <p>{chinese ? 'OpenCode 免费模型：' : 'OpenCode free models: '}{loading ? (chinese ? '正在加载目录…' : 'Loading the model list…') : catalogue?.error || (catalogue?.stale
            ? (chinese ? '目录已过期，请刷新后使用。' : 'The model list has expired. Refresh it before use.')
            : (chinese ? '当前没有可用的官方免费模型。' : 'No official free models are available in the current list.'))}</p>
          {catalogue?.error && <p className="mt-1">{chinese ? '目录异常不代表额度已用完。其他模型仍可使用。' : 'A model list error does not indicate exhausted quota. Other models remain available.'}</p>}
        </div>
        <Button size="sm" variant="outline" disabled={loading} aria-label={chinese ? '刷新免费模型' : 'Refresh free models'} onClick={onRefresh}>{chinese ? '刷新目录' : 'Refresh list'}</Button>
      </div>}
      {freeModelHint && <p data-free-model-limit>{freeModelHint}</p>}
      {folderDrop && <p className="folder-drop-hint">{chinese ? '可从文件管理器拖入文件夹，设置用途、权限和分组。' : 'Drag folders from your file manager to choose access and groups.'}</p>}
    </div>
  </details>
}
