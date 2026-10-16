import { storeManager } from '../store/store'
import { loadBalancer } from '../proxy/loadbalancer'
import { modelMapper } from '../proxy/modelMapper'
import { directModelConnection } from './directConnection'
import { internalInferenceBridge } from './bridge'
import type { ModelConnection, ModelConsumer } from '../../shared/modelConnection'

let nativeAccounts = new Map<string, string>()

export async function resolveModelConnection(model: string, consumer: ModelConsumer): Promise<ModelConnection> {
  if (typeof model !== 'string' || !model.trim() || model.length > 512) throw new Error('Select a valid model')
  if (consumer !== 'opencode' && consumer !== 'claude') throw new Error('Unknown model client')
  const config = storeManager.getConfig()
  // Workspaces explicitly choose a model, just like internal chat. Public API routing
  // defaults must not replace it. Repeated prepares must not rotate a live runtime.
  const requested = model.trim()
  const cacheKey = `${consumer}:${requested}`
  const selection = loadBalancer.selectAccount(requested, config.loadBalanceStrategy,
    modelMapper.getPreferredProvider(requested), modelMapper.getPreferredAccount(requested) || nativeAccounts.get(cacheKey), undefined, [], false)
  if (!selection) throw new Error(`模型没有可用账号，请检查节点和凭据。 / No available account for model: ${requested}`)
  const direct = directModelConnection(selection, consumer)
  if (direct) {
    // Other chats may advance round-robin. Keep a native client's account stable
    // while still re-reading its URL, credentials, mapping and current eligibility.
    nativeAccounts = new Map([...nativeAccounts].filter(([key]) => key !== cacheKey).slice(-255).concat([[cacheKey, selection.account.id]]))
    return direct
  }
  const bridge = await internalInferenceBridge.connection()
  return { ...bridge, model: requested, protocol: consumer === 'claude' ? 'anthropic' : 'openai', direct: false }
}
