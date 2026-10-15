// Dedicated workspace-chat QA bridge. State and filesystem operations live in the
// isolated test main process, so both pages exercise the actual IPC boundary.
const { contextBridge, ipcRenderer } = require('electron')
const invoke = (domain, action, ...args) => ipcRenderer.invoke('workspace-chat-qa:' + domain + ':' + action, ...args)
const methods = (domain, names) => Object.fromEntries(names.map(name => [name, (...args) => invoke(domain, name, ...args)]))

contextBridge.exposeInMainWorld('electronAPI', {
  app: methods('app', ['openExternal']),
  config: { ...methods('config', ['get', 'update']), onConfigChanged: () => () => {} },
  store: methods('store', ['get', 'set']),
  proxy: { ...methods('proxy', ['getStatus', 'getModels', 'start', 'stop']), onStatusChanged: () => () => {} },
  prompts: methods('prompts', ['getAll', 'update']),
  providers: methods('providers', ['getAll', 'getEffectiveModels']),
  accounts: methods('accounts', ['getAll']),
  statistics: methods('statistics', ['get']),
  companion: methods('companion', [
    'get', 'saveSettings', 'saveMessages', 'addWorkspace', 'updateWorkspace',
    'saveWorkspaceGroup', 'deleteWorkspaceGroup', 'listFiles', 'readFile',
    'startAgent', 'pollAgent', 'stopAgent', 'replyPermission',
    'openCodeStatus', 'checkOpenCodeUpdate', 'installOpenCodeUpdate', 'openCodeModels',
    'localSpeechStatus', 'warmupSpeech', 'cancelSpeech', 'synthesize', 'transcribe',
    'pickAvatar', 'pickAvatarModel', 'resetAvatar', 'resetAvatarModel',
  ]),
})
