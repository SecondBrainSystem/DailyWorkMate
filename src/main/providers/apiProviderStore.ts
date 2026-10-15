import { storeManager } from '../store/store'
import { AccountManager } from '../store/accounts'
import { ProviderManager } from '../store/providers'
import type { ApiProviderStore } from './apiProviders'

/** The app's provider and account store, as used by the official API add/refresh flows. */
export const apiProviderStore: ApiProviderStore = {
  getProvider: id => ProviderManager.getById(id) ?? undefined,
  addProvider: provider => storeManager.addProvider(provider),
  updateProvider: (id, updates) => { ProviderManager.update(id, updates) },
  // Working keys first, so refreshes use one that is known to be valid.
  keys: providerId => AccountManager.getByProviderId(providerId, true)
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'))
    .map(account => account.credentials.apiKey).filter((key): key is string => typeof key === 'string' && !!key),
  addKey: (providerId, name, apiKey) => AccountManager.create({ providerId, name, credentials: { apiKey } }).id,
  otherModels: providerId => new Set(ProviderManager.getAll().filter(provider => provider.enabled && provider.id !== providerId)
    .flatMap(provider => storeManager.getEffectiveModels(provider.id).map(model => model.displayName))),
}
