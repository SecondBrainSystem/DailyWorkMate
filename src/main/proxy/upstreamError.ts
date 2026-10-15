import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

/** Read a bounded response body, never serialize the stream's request/socket internals. */
export async function readUpstreamErrorBody(data: unknown): Promise<unknown> {
  if (!(data instanceof Readable)) return data
  let body = ''
  const decoder = new StringDecoder('utf8')
  for await (const chunk of data) {
    body += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (body.length > 65536) { data.destroy(); break }
  }
  body += decoder.end()
  try { return JSON.parse(body) } catch { return { message: body.slice(0, 1000) } }
}
