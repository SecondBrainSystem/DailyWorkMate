// Bundle only a native runtime verified for the target OS/architecture.
const fs = require('node:fs')
const path = require('node:path')
module.exports = async context => {
  const root = path.resolve(__dirname, '..', 'companion', 'runtime', 'opencode-v2')
  const manifestFile = path.join(root, 'runtime-manifest.json')
  const arches = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']
  const arch = typeof context.arch === 'number' ? arches[context.arch] : context.arch
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  // Native PTY bindings must live outside app.asar alongside their platform helpers.
  // node-pty's prebuilds are N-API, so they load in Electron as-is; packaging sets
  // npmRebuild:false instead of recompiling them (which needs Visual Studio on Windows).
  const pty = path.resolve(__dirname, '..', 'node_modules', 'node-pty')
  const ptyTarget = path.join(resources, 'companion-terminal', 'node-pty')
  fs.mkdirSync(path.dirname(ptyTarget), { recursive: true })
  fs.copyFileSync(path.join(__dirname, 'companion-pty-host.cjs'), path.join(path.dirname(ptyTarget), 'companion-pty-host.cjs'))
  if (!fs.existsSync(path.join(pty, 'lib', 'index.js'))) throw new Error('OpenCode terminal dependency is missing: node-pty')
  const prebuilt = 'prebuilds/' + context.electronPlatformName + '-' + arch
  const native = fs.existsSync(path.join(pty, prebuilt)) ? prebuilt : 'build/Release'
  if (!fs.existsSync(path.join(pty, native))) throw new Error('Build node-pty for the target OS and architecture before packaging')
  for (const relative of ['package.json', 'lib', 'LICENSE', native]) {
    const source = path.join(pty, relative)
    if (fs.existsSync(source)) fs.cpSync(source, path.join(ptyTarget, relative), { recursive: true, filter: source => !/\.(?:pdb|map)$|\.test\.js$/i.test(source) })
  }
  const speech = path.resolve(__dirname, '..', 'companion', 'runtime', 'speech')
  const speechManifest = path.join(speech, 'runtime-manifest.json')
  if (fs.existsSync(speechManifest)) {
    const metadata = JSON.parse(fs.readFileSync(speechManifest, 'utf8'))
    if (metadata.platform === context.electronPlatformName && metadata.arch === arch) {
      if (metadata.fast?.family !== 'matcha') throw new Error('Fast local speech is missing. Run npm run companion:speech:setup.')
      for (const relative of ['bin/node.exe', 'licenses/THIRD-PARTY-NOTICES.txt', metadata.directory + '/' + metadata.file, metadata.recognition?.directory + '/' + metadata.recognition?.file,
        metadata.fast.directory + '/' + metadata.fast.file, metadata.fast.directory + '/' + metadata.fast.vocoder, metadata.fast.directory + '/tokens.txt', metadata.fast.directory + '/lexicon.txt']) {
        const resolved = path.resolve(speech, relative)
        if (!relative || !resolved.startsWith(speech + path.sep) || !fs.existsSync(resolved)) throw new Error('Local speech package is incomplete. Run npm run companion:speech:setup.')
      }
      const destination = path.join(resources, 'speech-runtime')
      fs.cpSync(speech, destination, { recursive: true, filter: source => !/\.(?:zip|bz2|pdb)$/i.test(source) && !source.split(path.sep).includes('test_wavs') })
      fs.copyFileSync(path.join(__dirname, 'local-speech-worker.cjs'), path.join(destination, 'local-speech-worker.cjs'))
    } else console.warn('[Companion] Local speech runtime belongs to a different OS/architecture; skipping.')
  } else console.warn('[Companion] Local speech resources missing. Run npm run companion:speech:setup to bundle offline voices and recognition.')
  if (!fs.existsSync(manifestFile)) {
    console.warn('[Companion] Optional OpenCode runtime missing. Run npm run companion:setup before packaging to include it.')
    return
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  if (!/^2\.\d+\.\d+$/.test(manifest.version) || manifest.package !== '@opencode/cli') throw new Error('Companion packaging requires a verified OpenCode V2 runtime. Run npm run companion:setup.')
  if (manifest.platform !== context.electronPlatformName || manifest.arch !== arch) {
    console.warn('[Companion] Skipping OpenCode runtime for a different OS/architecture. Install it on the target build machine.')
    return
  }
  const target = path.join(resources, 'companion-runtime')
  fs.mkdirSync(target, { recursive: true })
  fs.copyFileSync(path.join(root, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'), path.join(target, 'opencode.exe'))
  fs.chmodSync(path.join(target, 'opencode.exe'), 0o755)
  fs.copyFileSync(manifestFile, path.join(target, 'runtime-manifest.json'))
  const license = path.join(root, 'node_modules', '@opencode', 'cli', 'LICENSE')
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(target, 'OPENCODE-LICENSE.txt'))
  else {
    // @opencode/cli 2.0.24 omits LICENSE from npm. Preserve its upstream notice:
    // https://github.com/anomalyco/opencode/blob/v2.0.24/LICENSE
    fs.writeFileSync(path.join(target, 'OPENCODE-LICENSE.txt'), `MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`)
  }
}
