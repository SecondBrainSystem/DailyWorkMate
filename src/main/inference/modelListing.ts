import { freeModelSource, isOpenCodeFreeModel, type FreeRoutingModels } from '../../shared/freeModels'
import { listAvailableModels } from '../proxy/modelCatalog'
import { kiloFreeModels, waitForKiloOperation } from './kiloModels'
import { getOpenCodeFreeModels } from '../companion/opencodeModels'
import { resolveOpenCodeProxyModel, supportsOpenCodeProxy } from './opencodeTransport'

export function resolveProxyFreeModel(id: string, signal?: AbortSignal) {
  return isOpenCodeFreeModel(id) ? waitForKiloOperation(resolveOpenCodeProxyModel(id), signal) : kiloFreeModels.resolve(id, signal)
}

export async function listFreeRoutingModels(refresh = false): Promise<FreeRoutingModels> {
  const catalogue = await listInferenceModels(refresh, undefined, true)
  return {
    models: catalogue.data.filter(model => freeModelSource(model.id)).map(model => ({ id: model.id, name: 'name' in model ? model.name : model.id })),
    sources: [
      { id: 'opencode-free', name: 'OpenCode Free', stale: true, ...catalogue.opencode },
      { id: 'kilo-free', name: 'Kilo Free', ...catalogue.kilo },
    ],
  }
}

/** Desktop and public clients share the same model IDs and free eligibility. */
export async function listInferenceModels(refresh = false, signal?: AbortSignal, includeOpenCode = false) {
  const [kilo, opencode] = await waitForKiloOperation(Promise.all([
    kiloFreeModels.get(refresh), includeOpenCode ? getOpenCodeFreeModels(refresh) : undefined,
  ]), signal)
  return {
    object: 'list' as const,
    data: [
      ...listAvailableModels().filter(model => !freeModelSource(model.id)),
      ...(!kilo.stale ? kilo.models.map(model => ({
        id: model.id, name: model.name, object: 'model' as const,
        created: Math.floor((kilo.updatedAt || 0) / 1000), owned_by: 'Kilo Free',
      })) : []),
      ...(opencode && !opencode.stale ? opencode.models.filter(supportsOpenCodeProxy).map(model => ({
        id: model.id, name: model.name, object: 'model' as const,
        created: Math.floor((opencode.updatedAt || 0) / 1000), owned_by: 'OpenCode Free',
      })) : []),
    ],
    kilo: { updatedAt: kilo.updatedAt, stale: kilo.stale, ...(kilo.error ? { error: kilo.error } : {}) },
    ...(opencode ? { opencode: { updatedAt: opencode.updatedAt, stale: opencode.stale, ...(opencode.error ? { error: opencode.error } : {}) } } : {}),
  }
}
