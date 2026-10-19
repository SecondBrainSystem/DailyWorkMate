import { isOllamaModelUsable } from '../../shared/ollamaAvailability'

/**
 * Proxy Service Module - Load Balancer
 * Implements Round Robin and Fill First strategies
 */

import { Account, AppConfig, EffectiveModel, Provider, LoadBalanceStrategy, UpstreamKind } from '../store/types'
import { AccountSelection } from './types'
import { storeManager } from '../store/store'
import { findModelMapping } from '../../shared/modelMapping'

/**
 * One consistent read of routing state. Selecting an account touches every provider, its models
 * and its accounts; reading each from the store per candidate cost O(models x providers^2) copies
 * and decrypted credentials repeatedly. A snapshot reads each piece at most once.
 */
export interface RoutingSnapshot {
  readonly providers: readonly Provider[]
  readonly config: AppConfig
  models(providerId: string): readonly EffectiveModel[]
  accounts(providerId: string, includeCredentials: boolean): readonly Account[]
}

export function createRoutingSnapshot(): RoutingSnapshot {
  const models = new Map<string, readonly EffectiveModel[]>()
  const accounts = new Map<string, readonly Account[]>()
  const memo = <T>(cache: Map<string, T>, key: string, read: () => T): T => {
    if (!cache.has(key)) cache.set(key, read())
    return cache.get(key) as T
  }
  return {
    providers: storeManager.getProviders(),
    config: storeManager.getConfig(),
    models: providerId => memo(models, providerId, () => storeManager.getEffectiveModels(providerId)),
    accounts: (providerId, includeCredentials) => memo(accounts, `${includeCredentials}:${providerId}`,
      () => storeManager.getAccountsByProviderId(providerId, includeCredentials)),
  }
}

/**
 * Load Balancer
 */
export class LoadBalancer {
  private roundRobinIndex: Map<string, number> = new Map()
  private failedAccounts: Map<string, { count: number; lastFailTime: number }> = new Map()
  private static readonly FAIL_THRESHOLD = 3
  private static readonly RECOVERY_TIME = 60000 // 1 minute

  /**
   * Mark account as failed
   */
  markAccountFailed(accountId: string, quarantine = false): void {
    const current = this.failedAccounts.get(accountId) || { count: 0, lastFailTime: 0 }
    this.failedAccounts.set(accountId, {
      count: quarantine ? LoadBalancer.FAIL_THRESHOLD : current.count + 1,
      lastFailTime: Date.now(),
    })
  }

  /**
   * Clear account failure status
   */
  clearAccountFailure(accountId: string): void {
    this.failedAccounts.delete(accountId)
  }

  /**
   * Check if account is in failure state
   */
  private isAccountInFailure(accountId: string): boolean {
    const failure = this.failedAccounts.get(accountId)
    if (!failure) return false

    if (Date.now() - failure.lastFailTime > LoadBalancer.RECOVERY_TIME) {
      this.failedAccounts.delete(accountId)
      return false
    }

    return failure.count >= LoadBalancer.FAIL_THRESHOLD
  }

  /**
   * Select account
   * @param model Requested model
   * @param strategy Load balance strategy
   * @param preferredProviderId Preferred provider ID
   * @param preferredAccountId Preferred account ID
   */
  selectAccount(
    model: string,
    strategy: LoadBalanceStrategy = 'round-robin',
    preferredProviderId?: string,
    preferredAccountId?: string,
    upstreamKind?: UpstreamKind,
    excludedAccountIds: readonly string[] = [],
    advance = true,
  ): AccountSelection | null {
    // Quarantined accounts are not pre-excluded: when every account is quarantined, the
    // least-failed one is still tried instead of failing the request outright.
    const available = this.getAvailableAccounts(createRoutingSnapshot(), model, preferredProviderId, false, upstreamKind, true)
      .filter(candidate => !excludedAccountIds.includes(candidate.account.id))
    const healthy = available.filter(candidate => !this.isAccountInFailure(candidate.account.id))
    // Prefer healthy nodes in every strategy. If there is only one node, allow an
    // explicit retry instead of making a recovered node inaccessible for a minute.
    const candidates = healthy.length ? healthy : available

    if (candidates.length === 0) {
      return null
    }

    if (preferredAccountId) {
      const preferred = candidates.find(c => c.account.id === preferredAccountId)
      if (preferred && !this.isAccountInFailure(preferredAccountId)) {
        return preferred
      }
    }

    if (strategy === 'fill-first') {
      return this.selectFillFirst(candidates)
    }

    if (strategy === 'failover') {
      return this.selectFailover(candidates, advance)
    }

    return this.selectRoundRobin(candidates, advance)
  }

  /**
   * Get available accounts list
   */
  private getAvailableAccounts(
    snapshot: RoutingSnapshot,
    model: string,
    preferredProviderId?: string,
    excludeFailed: boolean = false,
    upstreamKind?: UpstreamKind,
    includeCredentials = false,
  ): AccountSelection[] {
    return snapshot.providers
      .filter(provider => provider.enabled && (!upstreamKind || provider.upstreamKind === upstreamKind)
        && (!preferredProviderId || provider.id === preferredProviderId)
        && this.providerSupportsModel(snapshot, provider, model))
      .flatMap(provider => {
        const accounts = snapshot.accounts(provider.id, includeCredentials)
          .filter(account => this.isAccountAvailable(account) || (provider.upstreamKind === 'ollama' && account.status === 'error' && Boolean(provider.supportedModels?.length) && Date.now() - (provider.lastStatusCheck || 0) >= 60000))
          .filter(account => !excludeFailed || !this.isAccountInFailure(account.id))
        if (!accounts.length) return []
        // The mapping depends only on the provider, not on the account.
        const actualModel = this.mapModel(snapshot, model, provider)
        return accounts.map(account => ({ account, provider, actualModel }))
      })
  }

  /**
   * Check if provider supports model
   */
  private providerSupportsModel(snapshot: RoutingSnapshot, provider: Provider, model: string): boolean {
    const effectiveModels = snapshot.models(provider.id)
    if (effectiveModels.length === 0) {
      // An empty Ollama catalog also represents unscanned or fully disabled nodes.
      return provider.upstreamKind !== 'ollama' && !provider.supportedModels?.length
    }

    if (provider.upstreamKind === 'ollama') {
      const mapping = findModelMapping(model, snapshot.config.modelMappings)
      if (mapping?.preferredProviderId && mapping.preferredProviderId !== provider.id) return false
      const requested = model.toLowerCase()
      const actual = (mapping?.actualModel || model).toLowerCase()
      return effectiveModels.some(candidate =>
        (candidate.displayName.toLowerCase() === requested || candidate.displayName.toLowerCase() === actual
          || candidate.actualModelId.toLowerCase() === actual)
        && isOllamaModelUsable(provider, provider.ollamaModels?.[candidate.actualModelId]))
    }

    const normalizedModel = model.toLowerCase()
    const supported = effectiveModels.some(m => {
      const normalizedSupported = m.displayName.toLowerCase()
      if (normalizedSupported.endsWith('*')) {
        return normalizedModel.startsWith(normalizedSupported.slice(0, -1))
      }
      return normalizedSupported === normalizedModel
    })
    
    if (supported) {
      return true
    }

    const globalMapping = findModelMapping(model, snapshot.config.modelMappings)
    if (globalMapping) {
      if (globalMapping.preferredProviderId) {
        if (globalMapping.preferredProviderId === provider.id) {
          return true
        }
        return false
      }
      
      const actualModel = globalMapping.actualModel
      const normalizedActualModel = actualModel.toLowerCase()
      const actualSupported = effectiveModels.some(m => {
        const normalizedSupported = m.displayName.toLowerCase()
        if (normalizedSupported.endsWith('*')) {
          return normalizedActualModel.startsWith(normalizedSupported.slice(0, -1))
        }
        return normalizedSupported === normalizedActualModel
      })
      
      if (actualSupported) {
        return true
      }
    }
    
    return false
  }

  /**
   * Check if account is available
   */
  private isAccountAvailable(account: Account): boolean {
    if (account.status !== 'active') {
      return false
    }

    if (account.dailyLimit && account.todayUsed && account.todayUsed >= account.dailyLimit) {
      return false
    }

    return true
  }

  /**
   * Map model name
   */
  private mapModel(snapshot: RoutingSnapshot, model: string, provider: Provider): string {
    const effectiveModels = snapshot.models(provider.id)
    const effectiveModel = effectiveModels.find(m => 
      m.displayName.toLowerCase() === model.toLowerCase()
    )
    
    if (effectiveModel) {
      return effectiveModel.actualModelId
    }

    const mapping = findModelMapping(model, snapshot.config.modelMappings)

    if (mapping && (!mapping.preferredProviderId || mapping.preferredProviderId === provider.id)) {
      const actualModel = mapping.actualModel
      
      const actualEffectiveModel = effectiveModels.find(m => 
        m.displayName.toLowerCase() === actualModel.toLowerCase()
      )
      if (actualEffectiveModel) {
        return actualEffectiveModel.actualModelId
      }
      
      return actualModel
    }

    return model
  }

  /**
   * Round Robin strategy
   */
  private selectRoundRobin(candidates: AccountSelection[], advance = true): AccountSelection {
    const providerIds = [...new Set(candidates.map(c => c.provider.id))]
    const key = providerIds.join(',')

    const currentIndex = this.roundRobinIndex.get(key) || 0
    const selected = candidates[currentIndex % candidates.length]

    if (advance) this.roundRobinIndex.set(key, (currentIndex + 1) % candidates.length)

    return selected
  }

  /**
   * Fill First strategy
   * Use current account preferentially until limit is reached
   */
  private selectFillFirst(candidates: AccountSelection[]): AccountSelection {
    return candidates[0]
  }

  /**
   * Failover strategy
   * Select account with least failures, preferring healthy accounts
   */
  private selectFailover(candidates: AccountSelection[], advance = true): AccountSelection {
    const healthyCandidates = candidates.filter(c => !this.isAccountInFailure(c.account.id))
    
    if (healthyCandidates.length > 0) {
      return this.selectRoundRobin(healthyCandidates, advance)
    }

    const sortedCandidates = [...candidates].sort((a, b) => {
      const failureA = this.failedAccounts.get(a.account.id)
      const failureB = this.failedAccounts.get(b.account.id)

      const countA = failureA ? failureA.count : 0
      const countB = failureB ? failureB.count : 0

      if (countA !== countB) {
        return countA - countB
      }

      const timeA = failureA ? failureA.lastFailTime : 0
      const timeB = failureB ? failureB.lastFailTime : 0

      return timeA - timeB
    })

    return sortedCandidates[0]
  }

  /**
   * Reset Round Robin index
   */
  resetRoundRobinIndex(): void {
    this.roundRobinIndex.clear()
  }

  /**
   * Get available account count
   */
  getAvailableAccountCount(model: string, providerId?: string, excludeFailed = false, snapshot = createRoutingSnapshot()): number {
    return this.getAvailableAccounts(snapshot, model, providerId, excludeFailed).length
  }

  /**
   * Get all available models
   */
  getAvailableModels(): string[] {
    const snapshot = createRoutingSnapshot()
    return [...new Set(snapshot.providers
      .filter(provider => provider.enabled && snapshot.accounts(provider.id, false).some(account => this.isAccountAvailable(account)))
      .flatMap(provider => snapshot.models(provider.id).map(model => model.displayName)))]
  }
}

export const loadBalancer = new LoadBalancer()
export default loadBalancer
