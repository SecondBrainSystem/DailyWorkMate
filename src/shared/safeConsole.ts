import { redactSecrets } from './redaction.ts'

const write = (level: 'log' | 'info' | 'warn' | 'error' | 'debug') => (...values: unknown[]) => console[level](...values.map(value => value instanceof Error ? { name: value.name, message: redactSecrets(value.message), stack: redactSecrets(value.stack) } : redactSecrets(value)))
export const safeConsole = { log: write('log'), info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') }
