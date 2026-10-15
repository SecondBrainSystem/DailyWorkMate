/** Short tab name for a folder: its last segment (`C:\work\api` → `api`, `C:\` → `C:`, `/` → `/`). */
export function folderLabel(directory: string): string {
  const trimmed = directory.trim()
  if (!trimmed) return ''
  const parts = trimmed.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) || (trimmed.startsWith('/') ? '/' : trimmed)
}
