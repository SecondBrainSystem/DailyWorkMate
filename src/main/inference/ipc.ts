import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'
import type { InternalInferenceEvent } from '../../shared/inference'
import { IpcChannels } from '../ipc/channels'
import { storeManager } from '../store/store'
import { executeInternalInference, validateInferenceId, validateInferenceRequest } from './service'

const MAX_ACTIVE_REQUESTS = 16
const MAX_STREAM_BYTES = 64 * 1024 * 1024
interface PendingInference { controller: AbortController; output?: Readable }
let stopPreviousOwner: (() => void) | undefined

/** The owning desktop main frame is the sole client; no network listener or public API key is involved. */
export function registerInternalInferenceHandlers(window: BrowserWindow): () => void {
  // Storage recovery may register handlers again for the same window.
  stopPreviousOwner?.()
  const owner = window.webContents
  let pending = new Map<string, PendingInference>()
  let disposed = false
  const assertOwner = (event: IpcMainInvokeEvent) => {
    if (disposed || owner.isDestroyed() || event.sender !== owner || event.senderFrame !== owner.mainFrame) throw new Error('Untrusted inference request')
  }
  const send = (event: InternalInferenceEvent) => {
    if (!disposed && !owner.isDestroyed()) owner.send(IpcChannels.INFERENCE.data, event)
  }
  const remove = (id: string, entry: PendingInference) => {
    if (pending.get(id) === entry) pending = new Map([...pending].filter(([key]) => key !== id))
  }
  const cancel = (entry: PendingInference) => { entry.controller.abort(); entry.output?.destroy() }
  const cancelAll = () => {
    const active = pending
    pending = new Map()
    for (const entry of active.values()) cancel(entry)
  }
  const pump = async (id: string, entry: PendingInference, output: Readable) => {
    const decoder = new StringDecoder('utf8')
    let bytes = 0
    try {
      for await (const chunk of output) {
        if (entry.controller.signal.aborted || pending.get(id) !== entry) break
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > MAX_STREAM_BYTES) throw new Error('Inference response exceeds the 64 MB streaming limit')
        for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
          const data = decoder.write(buffer.subarray(offset, offset + 64 * 1024))
          if (data) send({ id, data })
        }
      }
      if (pending.get(id) === entry) {
        const tail = decoder.end()
        if (tail) send({ id, data: tail })
        send({ id, done: true, ...(entry.controller.signal.aborted ? { error: 'Inference request cancelled' } : {}) })
      }
    } catch (error) {
      const message = entry.controller.signal.aborted ? 'Inference request cancelled' : error instanceof Error ? error.message : 'Inference stream failed'
      if (pending.get(id) === entry) send({ id, done: true, error: message })
      if (!entry.controller.signal.aborted) storeManager.addLog('error', `Internal inference stream failed: ${message}`, { requestId: id })
      cancel(entry)
    } finally { remove(id, entry) }
  }
  ipcMain.removeHandler(IpcChannels.INFERENCE.request)
  ipcMain.handle(IpcChannels.INFERENCE.request, async (event, input: unknown) => {
    assertOwner(event)
    const checked = validateInferenceRequest(input)
    if (pending.has(checked.id)) throw new Error('Inference request ID is already active')
    if (pending.size >= MAX_ACTIVE_REQUESTS) throw new Error('Too many concurrent inference requests')
    const entry: PendingInference = { controller: new AbortController() }
    pending = new Map([...pending, [checked.id, entry]])
    try {
      const result = await executeInternalInference(checked, entry.controller.signal)
      if (result.output) {
        const streaming = { ...entry, output: result.output }
        if (disposed || pending.get(checked.id) !== entry || entry.controller.signal.aborted) {
          cancel(streaming)
          remove(checked.id, entry)
          return { status: 499, headers: { 'content-type': 'application/json' }, body: { error: { message: 'Inference request cancelled' } } }
        }
        pending = new Map([...pending, [checked.id, streaming]])
        void pump(checked.id, streaming, result.output)
      } else remove(checked.id, entry)
      return result.response
    } catch (error) {
      remove(checked.id, entry)
      cancel(entry)
      const message = error instanceof Error ? error.message : 'Internal inference failed'
      storeManager.addLog('error', `Internal inference failed: ${message}`, { requestId: checked.id })
      throw new Error(message)
    }
  })
  ipcMain.removeHandler(IpcChannels.INFERENCE.cancel)
  ipcMain.handle(IpcChannels.INFERENCE.cancel, (event, id: unknown) => {
    assertOwner(event)
    validateInferenceId(id)
    const entry = pending.get(id)
    if (entry) cancel(entry)
  })
  const navigate = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => { if (isMainFrame && !isInPlace) cancelAll() }
  const dispose = () => {
    if (disposed) return
    disposed = true
    cancelAll()
    owner.off('did-start-navigation', navigate)
    owner.off('render-process-gone', cancelAll)
    owner.off('destroyed', dispose)
    ipcMain.removeHandler(IpcChannels.INFERENCE.request)
    ipcMain.removeHandler(IpcChannels.INFERENCE.cancel)
    if (stopPreviousOwner === dispose) stopPreviousOwner = undefined
  }
  owner.on('did-start-navigation', navigate)
  owner.on('render-process-gone', cancelAll)
  owner.once('destroyed', dispose)
  stopPreviousOwner = dispose
  return dispose
}
