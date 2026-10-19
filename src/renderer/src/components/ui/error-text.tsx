import { useTranslation } from 'react-i18next'
import { useErrorText } from '@/lib/errors'
import { redactSecrets } from '../../../../shared/redaction'

/** A localized action message, with protocol details available without dominating the page. */
export function ErrorText({ error }: { error: unknown }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const detail = String(redactSecrets(errorText(error)))
  const rules: Array<[RegExp, string]> = [
    [/required|please enter|fill.*field|必填|请输入|填写/i, 'errorText.required'],
    [/disk|write failed|storage|IndexedDB|存储|写入|磁盘/i, 'errorText.storage'],
    [/timeout|timed out|超时/i, 'errorText.timeout'],
    [/401|403|authentication|unauthorized|invalid.*token|认证|令牌.*失效/i, 'errorText.auth'],
    [/429|rate.limit|quota|额度|频率/i, 'errorText.rateLimit'],
    [/fetch|network|ECONN|ENOTFOUND|连接|网络|DNS/i, 'errorText.network'],
    [/503|no available|unavailable|没有.*可用|不可用/i, 'errorText.unavailable'],
    [/stream|connection closed|断开|流.*结束/i, 'errorText.interrupted'],
  ]
  const match = rules.find(([pattern]) => pattern.test(detail))
  const summary = t(match ? match[1] : 'errorText.failed')
  return <span className="break-words">{summary}{summary !== detail && <details className="mt-1 text-xs font-normal opacity-80"><summary className="cursor-pointer">{t('errorText.details')}</summary><span className="whitespace-pre-wrap">{detail}</span></details>}</span>
}
