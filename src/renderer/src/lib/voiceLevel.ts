/**
 * The microphone/playback meter updates every 70–100 ms. Keeping it out of React state means only
 * the avatar that draws it does any work; the rest of the assistant page does not re-render.
 */
export interface VoiceLevel {
  get(): number
  subscribe(listener: (level: number) => void): () => void
}

export function createVoiceLevel(): VoiceLevel & { set(level: number): void } {
  let level = 0
  let listeners: ReadonlyArray<(level: number) => void> = []
  return {
    get: () => level,
    set(next) {
      const value = Number.isFinite(next) ? Math.min(1, Math.max(0, next)) : 0
      if (value === level) return
      level = value
      for (const listener of listeners) listener(value)
    },
    subscribe(listener) {
      listeners = [...listeners, listener]
      return () => { listeners = listeners.filter(item => item !== listener) }
    },
  }
}
