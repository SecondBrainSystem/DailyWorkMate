import { useTranslation } from 'react-i18next'
import { errorText } from '@/lib/errors'
import { redactSecrets } from '../../../../shared/redaction'

/** A localized action message, with protocol details available without dominating the page. */
export function ErrorText({ error }: { error: unknown }) {
  const { i18n } = useTranslation()
  const chinese = i18n.language.startsWith('zh')
  const detail = String(redactSecrets(errorText(error, chinese)))
  const rules: Array<[RegExp, string, string]> = [
    [/required|please enter|fill.*field|必填|请输入|填写/i, '请补全必填字段后重试。', 'Complete the required fields and retry.'],
    [/disk|write failed|storage|IndexedDB|存储|写入|磁盘/i, '无法保存本地数据，当前内容已保留。请检查磁盘空间后重试。', 'Cannot save local data. Your current content is preserved. Check available disk space and retry.'],
    [/timeout|timed out|超时/i, '等待响应超时，请检查连接或增加请求超时后重试。', 'The response timed out. Check the connection or increase the request timeout and retry.'],
    [/401|403|authentication|unauthorized|invalid.*token|认证|令牌.*失效/i, '认证失败，请重新登录或检查账号凭证。', 'Authentication failed. Sign in again or check the account credentials.'],
    [/429|rate.limit|quota|额度|频率/i, '已达到额度或请求频率限制，请稍后重试或切换账号。', 'The account reached a quota or rate limit. Retry later or choose another account.'],
    [/fetch|network|ECONN|ENOTFOUND|连接|网络|DNS/i, '无法连接服务，请检查代理和网络后重试。', 'Cannot connect to the service. Check the proxy and network, then retry.'],
    [/503|no available|unavailable|没有.*可用|不可用/i, '当前没有可用服务，请检查模型、节点和账号状态。', 'No service is available. Check the model, node and account status.'],
    [/stream|connection closed|断开|流.*结束/i, '回复中途断开，已收到的内容已保留，可以重试。', 'The reply was interrupted. Received content is preserved; you can retry.'],
  ]
  const match = rules.find(([pattern]) => pattern.test(detail))
  const summary = match ? match[chinese ? 1 : 2] : chinese ? '操作未完成，请查看详细信息并重试。' : 'The operation failed. Check the details and retry.'
  return <span className="break-words">{summary}{summary !== detail && <details className="mt-1 text-xs font-normal opacity-80"><summary className="cursor-pointer">{chinese ? '详细信息' : 'Details'}</summary><span className="whitespace-pre-wrap">{detail}</span></details>}</span>
}
