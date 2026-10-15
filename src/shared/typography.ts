export interface TypographySettings {
  fontSize: number
  fontFamily: 'readable' | 'system'
  fontWeight: 400 | 500
}

export const DEFAULT_TYPOGRAPHY: TypographySettings = { fontSize: 18, fontFamily: 'readable', fontWeight: 400 }
export const TYPOGRAPHY_FONTS = {
  readable: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Segoe UI", sans-serif',
  system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", sans-serif',
} as const

export function normalizeTypography(input: unknown): TypographySettings {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Partial<TypographySettings> : {}
  return {
    fontSize: Number.isInteger(value.fontSize) && value.fontSize! >= 14 && value.fontSize! <= 24 ? value.fontSize! : DEFAULT_TYPOGRAPHY.fontSize,
    fontFamily: value.fontFamily === 'system' ? 'system' : 'readable',
    fontWeight: value.fontWeight === 500 ? 500 : 400,
  }
}

export function validateTypography(input: unknown): TypographySettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid typography settings')
  const value = input as TypographySettings
  const normalized = normalizeTypography(input)
  if (normalized.fontSize !== value.fontSize || normalized.fontFamily !== value.fontFamily || normalized.fontWeight !== value.fontWeight) {
    throw new Error('Font size must be 14–24 px, with a supported font and weight')
  }
  return normalized
}
