import type { OllamaModelMetadata, Provider } from './types'

/** An endpoint is a protocol hint; a failed test or offline node cannot serve requests. */
export function isOllamaModelUsable(
  provider: Pick<Provider, 'status'>,
  model: OllamaModelMetadata | undefined,
): boolean {
  return provider.status !== 'offline' && Boolean(model?.endpoint) && model?.testStatus !== 'failed'
}
