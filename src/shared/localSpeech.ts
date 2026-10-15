export interface LocalSpeechStatus { available: boolean; engine: string; model: string; error?: string; ready?: boolean; warming?: boolean; readyEngine?: 'fast' | 'kokoro'; fastAvailable?: boolean; fastModel?: string; fastError?: string; recognitionAvailable?: boolean; recognitionModel?: string; recognitionError?: string }

// Official Kokoro v1.1 speaker order, shared by UI labels and the native worker request.
const female = [1, 2, 3, 4, 5, 6, 7, 8, 17, 18, 19, 21, 22, 23, 24, 26, 27, 28, 32, 36, 38, 39, 40, 42, 43, 44, 46, 47, 48, 49, 51, 59, 60, 67, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 83, 84, 85, 86, 87, 88, 90, 92, 93, 94, 99]
const male = [9, 10, 11, 12, 13, 14, 15, 16, 20, 25, 29, 30, 31, 33, 34, 35, 37, 41, 45, 50, 52, 53, 54, 55, 56, 57, 58, 61, 62, 63, 64, 65, 66, 68, 69, 80, 81, 82, 89, 91, 95, 96, 97, 98, 100]
export const LOCAL_SPEECH_VOICES = [
  ...['af_maple', 'af_sol', 'bf_vale'].map((id, sid) => ({ id, sid, language: 'en', gender: 'female' })),
  ...female.map((number, index) => ({ id: 'zf_' + String(number).padStart(3, '0'), sid: index + 3, language: 'zh', gender: 'female' })),
  ...male.map((number, index) => ({ id: 'zm_' + String(number).padStart(3, '0'), sid: index + 58, language: 'zh', gender: 'male' })),
] as const

export function localSpeechSpeaker(voice: string, language: string, text: string): number {
  if (voice && voice !== 'auto') {
    const selected = LOCAL_SPEECH_VOICES.find(item => item.id === voice)
    if (!selected) throw new Error('Unknown local speech voice')
    return selected.sid
  }
  return /[\u3400-\u9fff]/u.test(text) || language.startsWith('zh') ? 3 : 0
}
