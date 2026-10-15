import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { createOllamaAgents } from '../proxy/connectionAgents.ts'

/** A failed TCP handshake has not delivered the prompt. Retry it once within the same budget. */
export async function requestOllama(config: AxiosRequestConfig, timeout: number): Promise<AxiosResponse> {
  const started = Date.now()
  try {
    return await axios.request(config)
  } catch (error) {
    const remaining = timeout - (Date.now() - started)
    const cause = axios.isAxiosError(error) ? error.cause as (Error & { syscall?: string }) | undefined : undefined
    // Never replay an HTTP error, response timeout, reset during generation, or cancellation.
    if (!axios.isAxiosError(error) || error.response || error.code !== 'ETIMEDOUT'
      || cause?.syscall !== 'connect' || config.signal?.aborted || remaining <= 0) throw error
    return axios.request({ ...config, timeout: remaining, ...createOllamaAgents(remaining) })
  }
}
