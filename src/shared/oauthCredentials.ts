/** Normalize once for both login dialogs, preserving the full cookie header. */
export function mapOAuthCredentials(providerId: string | undefined, credentials: Record<string, string>): Record<string, string> {
  const result = { ...credentials }
  const mappings: Record<string, [string, string]> = {
    glm: ['chatglm_refresh_token', 'refresh_token'], deepseek: ['userToken', 'token'],
    qwen: ['tongyi_sso_ticket', 'ticket'], 'qwen-ai': ['token', 'token'], zai: ['token', 'token'],
    perplexity: ['__Secure-next-auth.session-token', 'sessionToken'], mimo: ['serviceToken', 'service_token'],
  }
  const pair = providerId && mappings[providerId]
  if (pair && credentials[pair[0]]) {
    let token = credentials[pair[0]]
    if (providerId === 'deepseek' && token.startsWith('{')) {
      try { const value = JSON.parse(token).value; if (typeof value === 'string') token = value } catch { /* Plain tokens remain unchanged. */ }
    }
    result[pair[1]] = token
  }
  if (providerId === 'perplexity') {
    result.sessionToken ||= credentials['next-auth.session-token'] || ''
    result.cookie ||= credentials.cookies || ''
  }
  if (providerId === 'mimo') {
    result.user_id ||= credentials.userId || ''
    result.ph_token ||= credentials.xiaomichatbot_ph || ''
  }
  return result
}
