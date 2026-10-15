import { app, safeStorage } from 'electron'
import { mkdir, readFile, writeFile, rename, realpath, stat, unlink, readdir, cp } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { DEFAULT_COMPANION_SETTINGS, validateSettings, boundedText } from '../../shared/companion'
import type { CompanionSettings, CompanionMessage, WorkspaceGrant, WorkspaceGroup, WorkspaceGroupInput } from '../../shared/companion'
import { AVATAR_MODEL_MAX_BYTES, validateAvatarModel } from '../../shared/avatarModel'
import { validateWorkspaceGroup } from './workspaceGroups'

interface SavedState { settings: CompanionSettings; workspaces: WorkspaceGrant[]; groups: WorkspaceGroup[]; messages: CompanionMessage[] }
export function companionHome(): string {
  if (process.env.DAILYWORKMATE_COMPANION_HOME) return path.resolve(process.env.DAILYWORKMATE_COMPANION_HOME)
  if (!app.isPackaged) return path.join(app.getAppPath(), 'companion')
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR) return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'companion')
  if (existsSync(path.join(path.dirname(process.execPath), 'dailyworkmate-portable'))) return path.join(path.dirname(process.execPath), 'companion')
  if (process.platform === 'linux' && process.env.APPIMAGE) return path.join(path.dirname(process.env.APPIMAGE), 'companion')
  return path.join(app.getPath('userData'), 'companion')
}

export class CompanionStorage {
  readonly home = companionHome()
  private state: SavedState | null = null
  private pending: Promise<void> = Promise.resolve()
  private avatarCache = new Map<string, { stamp: string; url: string }>()
  readonly warnings: string[] = []

  private crypt(value: string, encrypt: boolean): string {
    if (!value) return ''
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('Secure key storage is unavailable. Configure the system keyring or use a local speech service without an API key.')
    }
    return encrypt ? safeStorage.encryptString(value).toString('base64') : safeStorage.decryptString(Buffer.from(value, 'base64'))
  }

  async get(): Promise<SavedState> {
    if (!this.state) {
      await mkdir(path.join(this.home, 'data'), { recursive: true })
      if (app.isPackaged && !process.env.DAILYWORKMATE_COMPANION_HOME && !process.env.PORTABLE_EXECUTABLE_DIR && !process.env.APPIMAGE) {
        const parent = process.platform === 'darwin' ? path.resolve(path.dirname(app.getPath('exe')), '../../..') : path.dirname(app.getPath('exe'))
        const legacy = path.join(parent, 'companion', 'data')
        try { await stat(path.join(this.home, 'data', 'companion.json')) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; try { await stat(path.join(legacy, 'companion.json')); await cp(legacy, path.join(this.home, 'data'), { recursive: true, force: false, errorOnExist: false }) } catch (legacyError) { if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') throw legacyError } }
      }
      let saved: SavedState
      try {
        const text = await readFile(path.join(this.home, 'data', 'companion.json'), 'utf8')
        if (text.length > 8 * 1024 * 1024) throw new Error('Companion data exceeds the size limit')
        const input = JSON.parse(text) as SavedState
        const decrypt = (value: string) => { try { return this.crypt(boundedText(value, 'encrypted speech key', 16000), false) } catch (error) { this.warnings.push('Speech API key could not be decrypted. Re-enter the key in settings.'); console.error('[Companion] Cannot decrypt speech key:', error instanceof Error ? error.message : String(error)); return '' } }
        const recoverEndpoint = <T extends string>(mode: T, endpoint: { baseUrl?: string }): T | 'local' => mode === 'api' && !endpoint?.baseUrl ? 'local' : mode
        const settings = validateSettings({ ...input.settings,
          sttMode: recoverEndpoint(input.settings.sttMode, input.settings.stt), ttsMode: recoverEndpoint(input.settings.ttsMode, input.settings.tts),
          stt: { ...input.settings.stt, apiKey: decrypt(input.settings.stt.apiKey) },
          tts: { ...input.settings.tts, apiKey: decrypt(input.settings.tts.apiKey) },
        })
        const workspaces = this.validateGrants(input.workspaces)
        if (input.groups !== undefined && (!Array.isArray(input.groups) || input.groups.length > 64)) throw new Error('Invalid workspace groups')
        const groups = (input.groups || []).map(group => validateWorkspaceGroup(group, workspaces, group.id))
        if (new Set(groups.map(group => group.id)).size !== groups.length) throw new Error('Duplicate workspace group IDs')
        saved = { settings, workspaces, groups, messages: this.validateMessages(input.messages) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          const file = path.join(this.home, 'data', 'companion.json')
          await cp(file, file + '.recovery-' + Date.now(), { force: false, errorOnExist: true })
          this.warnings.push('助手数据已备份，当前使用恢复设置，请重新授权文件夹。 / Companion data was backed up. Recovery settings are active; authorize folders again.')
          console.error('[Companion] Recovery:', error instanceof Error ? error.message : String(error))
        }
        const settings = structuredClone(DEFAULT_COMPANION_SETTINGS)
        const locale = app.getLocale()
        saved = { settings: { ...settings, language: locale, ...(locale.toLowerCase().startsWith('zh') ? {} : { name: 'Companion', persona: 'You are a helpful assistant. Reply in the user’s language. Ask before taking actions that change files.' }) }, workspaces: [], groups: [], messages: [] }
      }
      this.state = saved
    }
    return structuredClone(this.state)
  }

  private validateGrants(value: WorkspaceGrant[]): WorkspaceGrant[] {
    if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid workspace list')
    return value.map(grant => {
      if (typeof grant.writable !== 'boolean' || !path.isAbsolute(grant.path)) throw new Error('Invalid workspace')
      return { id: boundedText(grant.id, 'workspace ID', 80, true), path: boundedText(grant.path, 'workspace path', 4096, true), name: boundedText(grant.name, 'workspace name', 255, true), writable: grant.writable }
    })
  }

  private validateMessages(value: CompanionMessage[]): CompanionMessage[] {
    if (!Array.isArray(value) || value.length > 200) throw new Error('Keep at most 200 companion messages')
    const messages = value.map(message => {
      if (!['user', 'assistant'].includes(message.role) || !['chat', 'agent'].includes(message.mode) || !Number.isFinite(message.createdAt)) throw new Error('Invalid message')
      const metadata = (value: unknown, name: string, limit: number) => {
        const checked = boundedText(value, name, limit, true)
        if (/[\u0000-\u001f\u007f]/.test(checked)) throw new Error('Invalid ' + name)
        return checked
      }
      return { id: boundedText(message.id, 'message ID', 80), role: message.role, content: boundedText(message.content, 'message', 200000), mode: message.mode, createdAt: message.createdAt,
        ...(message.role === 'assistant' && message.model !== undefined ? { model: metadata(message.model, 'message model', 300) } : {}),
        ...(message.role === 'assistant' && message.retryOf !== undefined ? { retryOf: metadata(message.retryOf, 'retry message ID', 80) } : {}),
      }
    })
    if (JSON.stringify(messages).length > 6 * 1024 * 1024) throw new Error('Conversation exceeds 6 MiB; start a new conversation')
    return messages
  }

  private update(change: (state: SavedState) => SavedState): Promise<void> {
    const operation = this.pending.then(async () => {
      const state = change(await this.get())
      const disk = { ...state, settings: { ...state.settings,
        stt: { ...state.settings.stt, apiKey: this.crypt(state.settings.stt.apiKey, true) },
        tts: { ...state.settings.tts, apiKey: this.crypt(state.settings.tts.apiKey, true) },
      } }
      const file = path.join(this.home, 'data', 'companion.json')
      const temporary = file + '.' + randomUUID() + '.tmp'
      await writeFile(temporary, JSON.stringify(disk), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, file)
      this.state = state
    })
    this.pending = operation.catch(error => { console.error('[Companion] Save failed:', error.message) })
    return operation
  }

  saveSettings(settings: CompanionSettings) {
    const checked = validateSettings(settings)
    return this.update(state => ({ ...state, settings: { ...checked, avatar: state.settings.avatar, avatarModel: state.settings.avatarModel } }))
  }
  saveMessages(messages: CompanionMessage[]) {
    const checked = this.validateMessages(messages)
    return this.update(state => ({ ...state, messages: checked }))
  }
  async addWorkspace(selected: string) {
    const directory = await realpath(selected)
    if (!(await stat(directory)).isDirectory()) throw new Error('Select a folder')
    await this.update(state => {
      if (state.workspaces.length >= 32) throw new Error('At most 32 folders can be authorized')
      if (state.workspaces.some(grant => path.relative(grant.path, directory) === '')) return state
      return { ...state, workspaces: [...state.workspaces, { id: randomUUID(), path: directory, name: path.basename(directory) || directory, writable: false }] }
    })
  }
  updateWorkspace(id: string, writable: boolean | null) {
    boundedText(id, 'workspace ID', 80, true)
    if (writable !== null && typeof writable !== 'boolean') throw new Error('Invalid workspace access')
    return this.update(state => ({ ...state,
      workspaces: writable === null ? state.workspaces.filter(grant => grant.id !== id) : state.workspaces.map(grant => grant.id === id ? { ...grant, writable } : grant),
      groups: writable === null ? state.groups.map(group => ({ ...group, workspaceIds: group.workspaceIds.filter(member => member !== id) })) : state.groups,
    }))
  }
  saveWorkspaceGroup(input: WorkspaceGroupInput) {
    if (!input || typeof input !== 'object') throw new Error('Invalid workspace group')
    const id = input.id === undefined ? randomUUID() : boundedText(input.id, 'group ID', 80, true)
    return this.update(state => {
      const existing = state.groups.some(group => group.id === id)
      if (input.id && !existing) throw new Error('This workspace group no longer exists')
      if (!existing && state.groups.length >= 64) throw new Error('At most 64 workspace groups can be created')
      const group = validateWorkspaceGroup(input, state.workspaces, id)
      return { ...state, groups: existing ? state.groups.map(item => item.id === id ? group : item) : [...state.groups, group] }
    })
  }
  deleteWorkspaceGroup(id: string) {
    boundedText(id, 'group ID', 80, true)
    return this.update(state => ({ ...state, groups: state.groups.filter(group => group.id !== id) }))
  }
  async grant(id: string) {
    const grant = (await this.get()).workspaces.find(item => item.id === id)
    if (!grant) throw new Error('This folder is not authorized')
    return grant
  }
  async resetAvatar() { await this.update(state => ({ ...state, settings: { ...state.settings, avatar: '' } })) }
  async setAvatar(file: string) {
    const extension = path.extname(file).toLowerCase()
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extension]
    if (!mime || (await stat(file)).size > 5 * 1024 * 1024) throw new Error('Choose a PNG, JPEG, WebP or GIF smaller than 5 MiB')
    const bytes = await readFile(file)
    const name = 'avatar' + extension
    await writeFile(path.join(this.home, 'data', name), bytes)
    await this.update(state => ({ ...state, settings: { ...state.settings, avatar: name } }))
  }
  async avatarUrl() {
    const name = (await this.get()).settings.avatar
    if (!name) return ''
    if (!/^avatar\.(png|jpe?g|webp|gif)$/.test(name)) throw new Error('Invalid saved avatar')
    if ((await stat(path.join(this.home, 'data', name))).size > 5 * 1024 * 1024) throw new Error('Saved avatar exceeds 5 MiB')
    const mime = name.endsWith('jpg') || name.endsWith('jpeg') ? 'image/jpeg' : 'image/' + name.split('.').pop()
    return 'data:' + mime + ';base64,' + (await readFile(path.join(this.home, 'data', name))).toString('base64')
  }
  async cachedAsset(file: string, build: (bytes: Buffer) => string) {
    const info = await stat(file), stamp = String(info.mtimeMs) + ':' + info.size
    const cached = this.avatarCache.get(file)
    if (cached?.stamp === stamp) return cached.url
    const url = build(await readFile(file)); this.avatarCache = new Map([[file, { stamp, url }]])
    return url
  }
  async cleanAvatarModels() {
    const current = (await this.get()).settings.avatarModel
    for (const name of await readdir(path.join(this.home, 'data'))) {
      if (/^avatar-model-[0-9a-f-]{36}\.glb$/.test(name) && name !== current) await unlink(path.join(this.home, 'data', name))
    }
    this.avatarCache = new Map()
  }
  async reset() {
    await this.update(() => ({ settings: structuredClone(DEFAULT_COMPANION_SETTINGS), workspaces: [], groups: [], messages: [] }))
    await this.cleanAvatarModels()
    for (const name of await readdir(path.join(this.home, 'data'))) if (/^avatar\.(png|jpe?g|webp|gif)$/.test(name)) await unlink(path.join(this.home, 'data', name))
  }
  async setAvatarModel(file: string) {
    if (path.extname(file).toLowerCase() !== '.glb' || (await stat(file)).size > AVATAR_MODEL_MAX_BYTES) throw new Error('请选择 15 MiB 以内的 GLB 模型。 / Choose a GLB model up to 15 MiB.')
    const bytes = await readFile(file)
    validateAvatarModel(bytes)
    const name = 'avatar-model-' + randomUUID() + '.glb'
    await this.get()
    await writeFile(path.join(this.home, 'data', name), bytes, { flag: 'wx', mode: 0o600 })
    try { await this.update(state => ({ ...state, settings: { ...state.settings, avatarModel: name, avatarMode: '3d', avatarVisible: true } })) }
    catch (error) { await unlink(path.join(this.home, 'data', name)); throw error }
    await this.cleanAvatarModels()
  }
  async resetAvatarModel() {
    await this.update(state => ({ ...state, settings: { ...state.settings, avatarModel: '', avatar: '', avatarMode: '2d' } }))
    await this.cleanAvatarModels()
  }
  async avatarModelUrl() {
    const name = (await this.get()).settings.avatarModel
    if (!name) return ''
    if (!/^avatar-model-[0-9a-f-]{36}\.glb$/.test(name)) throw new Error('Invalid saved 3D avatar')
    const file = path.join(this.home, 'data', name)
    if ((await stat(file)).size > AVATAR_MODEL_MAX_BYTES) throw new Error('Saved 3D avatar exceeds 15 MiB')
    return this.cachedAsset(file, bytes => { validateAvatarModel(bytes); return 'data:model/gltf-binary;base64,' + bytes.toString('base64') })
  }
}
