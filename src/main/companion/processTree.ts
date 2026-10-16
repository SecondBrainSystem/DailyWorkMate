import { execFile, type ChildProcess } from 'node:child_process'
import path from 'node:path'

/** Stop owned descendants while leaving detached psmux servers for the exit confirmation. */
export async function stopProcessTree(pid: number, group = false): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('Invalid child process ID')
  if (process.platform !== 'win32') {
    try { process.kill(group ? -pid : pid, 'SIGTERM') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    return
  }
  // Select by ancestry and recheck creation time before killing each PID. Do not use taskkill /T:
  // it would also destroy detached psmux servers after the user chose to retain them.
  const script = `
$ErrorActionPreference = 'Stop'
$items = @(Get-CimInstance Win32_Process)
$byId = @{}
$byParent = @{}
foreach ($entry in $items) {
  $byId[[uint32]$entry.ProcessId] = $entry
  $parent = [uint32]$entry.ParentProcessId
  $byParent[$parent] = @($byParent[$parent]) + @($entry)
}
function Stop-Owned([uint32]$target) {
  $item = $byId[$target]
  if (!$item) { return }
  if ($item.Name -match '^(psmux|pmux|tmux)\\.exe$' -and $item.CommandLine -match '(?:^|\\s)server(?:\\s|$)') { return }
  foreach ($child in @($byParent[$target])) {
    if (!$child) { continue }
    if ($child.CreationDate -ge $item.CreationDate) { Stop-Owned $child.ProcessId }
  }
  $current = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $target)
  if ($current -and $current.CreationDate -eq $item.CreationDate) {
    try { Stop-Process -Id $target -Force -ErrorAction Stop }
    catch { if (Get-Process -Id $target -ErrorAction SilentlyContinue) { throw } }
  }
}
Stop-Owned ${pid}
`
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  await new Promise<void>((resolve, reject) => {
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000, maxBuffer: 65536 }, error => error ? reject(error) : resolve())
  })
}

export async function stopChildProcess(child: ChildProcess | null, group = false) {
  if (!child || child.exitCode != null || child.signalCode != null) return
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.off('exit', done); reject(new Error('Child process did not stop')) }, 20000)
    const done = () => { clearTimeout(timer); resolve() }
    child.once('exit', done)
  })
  // Attach a rejection handler immediately while the OS operation is pending.
  await Promise.all([exited, child.pid ? stopProcessTree(child.pid, group) : Promise.resolve(child.kill())])
}
