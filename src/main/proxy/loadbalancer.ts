/**
 * Proxy Service Module - Load Balancer
 * Implements Round Robin and Fill First strategies
 */

import { Account, Provider, LoadBalanceStrategy, UpstreamKind } from '../store/types'
import { AccountSelection } from './types'
import { storeManager } from '../store/store'
import { findModelMapping } from '../../shared/modelMapping'

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
    const available = this.getAvailableAccounts(model, preferredProviderId, strategy === 'failover', upstreamKind)
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
    model: string,
    preferredProviderId?: string,
    excludeFailed: boolean = false,
    upstreamKind?: UpstreamKind,
  ): AccountSelection[] {
    const providers = storeManager.getProviders().filter(p =>
      p.enabled && (!upstreamKind || p.upstreamKind === upstreamKind)
    )
    const candidates: AccountSelection[] = []

    for (const provider of providers) {
      if (preferredProviderId && provider.id !== preferredProviderId) {
        continue
      }

      if (!this.providerSupportsModel(provider, model)) {
        continue
      }

      const accounts = storeManager.getAccountsByProviderId(provider.id, true)
        .filter(account => this.isAccountAvailable(account) || (provider.upstreamKind === 'ollama' && account.status === 'error' && Boolean(provider.supportedModels?.length) && Date.now() - (provider.lastStatusCheck || 0) >= 60000))
        .filter(account => !excludeFailed || !this.isAccountInFailure(account.id))


      for (const account of accounts) {
        candidates.push({
          account,
          provider,
          actualModel: this.mapModel(model, provider),
        })
      }
    }

    return candidates
  }

  /**
   * Check if provider supports model
   */
  private providerSupportsModel(provider: Provider, model: string): boolean {
    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    if (effectiveModels.length === 0) {
      // An empty Ollama catalog also represents unscanned or fully disabled nodes.
      return provider.upstreamKind !== 'ollama' && !provider.supportedModels?.length
    }

    if (provider.upstreamKind === 'ollama') {
      const mapping = findModelMapping(model, storeManager.getConfig().modelMappings)
      if (mapping?.preferredProviderId && mapping.preferredProviderId !== provider.id) return false
      const requested = model.toLowerCase()
      const actual = (mapping?.actualModel || model).toLowerCase()
      return effectiveModels.some(candidate =>
        (candidate.displayName.toLowerCase() === requested || candidate.displayName.toLowerCase() === actual
          || candidate.actualModelId.toLowerCase() === actual)
        && Boolean(provider.ollamaModels?.[candidate.actualModelId]?.endpoint))
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

    const config = storeManager.getConfig()
    const globalMapping = findModelMapping(model, config.modelMappings)
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
  private mapModel(model: string, provider: Provider): string {
    
    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    const effectiveModel = effectiveModels.find(m => 
      m.displayName.toLowerCase() === model.toLowerCase()
    )
    
    if (effectiveModel) {
      return effectiveModel.actualModelId
    }

    const config = storeManager.getConfig()
    const mapping = findModelMapping(model, config.modelMappings)

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
  getAvailableAccountCount(model: string, providerId?: string, excludeFailed = false): number {
    return this.getAvailableAccounts(model, providerId, excludeFailed).length
  }

  /**
   * Get all available models
   */
  getAvailableModels(): string[] {
    const providers = storeManager.getProviders().filter(p => p.enabled)
    const models = new Set<string>()

    for (const provider of providers) {
      const accounts = storeManager.getAccountsByProviderId(provider.id)
        .filter(account => this.isAccountAvailable(account))

      if (accounts.length > 0) {
        const effectiveModels = storeManager.getEffectiveModels(provider.id)
        effectiveModels.forEach(m => models.add(m.displayName))
      }
    }

    return [...models]
  }
}

export const loadBalancer = new LoadBalancer()
export default loadBalancer
