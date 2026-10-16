import { execFile } from 'node:child_process'
import { isIP } from 'node:net'

interface PortRange {
  readonly start: number
  readonly end: number
}

interface ListenErrorOptions {
  platform?: NodeJS.Platform
  language?: string
  readExcludedRanges?: (family: 4 | 6) => Promise<string>
  onDiagnosticFailure?: (error: unknown) => void
}

// netsh headers are localized; the numeric rows (and optional managed-range
// marker) have the same shape in each locale.
export function findExcludedPortRange(output: string, port: number): PortRange | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*\*?\s*$/.exec(line)
    if (!match) continue
    const start = Number(match[1])
    const end = Number(match[2])
    if (start >= 1 && end <= 65535 && start <= end && port >= start && port <= end) {
      return { start, end }
    }
  }
  return undefined
}

function readWindowsExcludedRanges(family: 4 | 6): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('netsh.exe', ['interface', `ipv${family}`, 'show', 'excludedportrange', 'protocol=tcp'], {
      windowsHide: true,
      timeout: 2000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    }, (error, stdout) => error ? reject(error) : resolve(stdout))
  })
}

/** Diagnose a failed bind without probing or changing any listening endpoint. */
export async function describeProxyListenError(
  error: unknown,
  endpoint: { host: string; port: number },
  options: ListenErrorOptions = {},
): Promise<string> {
  const zh = options.language?.startsWith('zh') === true
  const detail = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const address = `${isIP(endpoint.host) === 6 ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`
  const nativeDetail = zh ? `原始错误：${detail}` : `Original error: ${detail}`
  if (code === 'EADDRINUSE') {
    return zh
      ? `代理地址 ${address} 已被占用，请选择其他端口或停止占用该端口的服务。${nativeDetail}`
      : `Proxy address ${address} is already in use; choose another port or stop the service using it. ${nativeDetail}`
  }
  if (code !== 'EACCES') return `Failed to listen on ${address}: ${detail}`

  if ((options.platform ?? process.platform) === 'win32') {
    const nativeAddress = error && typeof error === 'object' && 'address' in error && typeof error.address === 'string'
      ? error.address : endpoint.host
    const family = isIP(nativeAddress)
    const families: readonly (4 | 6)[] = family === 4 || family === 6 ? [family] : [4, 6]
    const readRanges = options.readExcludedRanges ?? readWindowsExcludedRanges
    const results = await Promise.allSettled(families.map(value => readRanges(value)))
    for (const result of results) {
      if (result.status === 'rejected') {
        if (options.onDiagnosticFailure) options.onDiagnosticFailure(result.reason)
        else console.warn('[Proxy] Could not inspect Windows excluded TCP ports:', result.reason)
        continue
      }
      const range = findExcludedPortRange(result.value, endpoint.port)
      if (range) {
        return zh
          ? `无法启动代理 ${address}：端口 ${endpoint.port} 位于 Windows 系统保留的 TCP 端口范围 ${range.start}–${range.end} 内，即使没有程序监听也可能无法绑定。请在代理设置中选择此范围以外的可用端口。${nativeDetail}`
          : `Cannot start proxy ${address}: port ${endpoint.port} is in the Windows excluded TCP port range ${range.start}–${range.end}. Binding can be denied even when no program is listening. Choose an available port outside this range in proxy settings. ${nativeDetail}`
      }
    }
    return zh
      ? `Windows 拒绝监听代理地址 ${address}。端口可能被其他服务独占、被系统保留或受安全策略限制；请在代理设置中选择其他可用端口。${nativeDetail}`
      : `Windows denied listening on proxy address ${address}. The port may be exclusively held by another service, reserved by the system, or blocked by a security policy; choose another available port in proxy settings. ${nativeDetail}`
  }
  return zh
    ? `系统拒绝监听代理地址 ${address}，请检查端口权限或在代理设置中选择其他可用端口。${nativeDetail}`
    : `The system denied listening on proxy address ${address}; check port permissions or choose another available port in proxy settings. ${nativeDetail}`
}
