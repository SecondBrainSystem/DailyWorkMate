const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const sources = {
  'SHERPA-ONNX-LICENSE.txt': 'https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.8/LICENSE',
  'ESPEAK-NG-COPYING.txt': 'https://raw.githubusercontent.com/csukuangfj/espeak-ng/ed530aa113046142eb5115cf2fc9157854d0ffe1/COPYING',
  'ONNXRUNTIME-LICENSE.txt': 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/LICENSE',
  'ONNXRUNTIME-ThirdPartyNotices.txt': 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/ThirdPartyNotices.txt',
  'SENSEVOICE-MODEL-LICENSE.txt': 'https://raw.githubusercontent.com/modelscope/FunASR/58830eca4012644aac0c3218c3ccc7d98f003fda/MODEL_LICENSE',
}
module.exports = async root => {
  const directory = path.join(root, 'licenses')
  await fs.mkdir(directory, { recursive: true })
  const records = await Promise.all(Object.entries(sources).map(async ([name, url]) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error('Cannot obtain bundled license ' + name + ': HTTP ' + response.status)
    const bytes = Buffer.from(await response.arrayBuffer())
    await fs.writeFile(path.join(directory, name), bytes)
    return { name, url, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  }))
  await fs.writeFile(path.join(directory, 'THIRD-PARTY-NOTICES.txt'), `DailyWorkMate local speech resources\n\nMatcha Chinese/English acoustic model and Vocos 16kHz vocoder by dengcunqin, Apache License 2.0 as declared in the original author's ModelScope metadata. Original notices and the full license are in models/matcha-icefall-zh-en.\nhttps://modelscope.cn/models/dengcunqin/matcha_tts_zh_en_20251010\nhttps://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/matcha-icefall-zh-en.html\n\nKokoro v1.1 Chinese/English by hexgrad, Apache-2.0. License also included in the model directory.\nhttps://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh\n\nSenseVoiceSmall by Alibaba Group / FunAudioLLM, FunASR Model License 1.1. Original model name, authors and full model license are preserved.\nhttps://huggingface.co/FunAudioLLM/SenseVoiceSmall\n\nCPU int8 conversions and sherpa-onnx 1.13.8 by the sherpa-onnx contributors (Apache-2.0).\nhttps://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8\n\nThe native speech frontend includes eSpeak NG (GPL-3.0). Corresponding source and build instructions:\nhttps://github.com/csukuangfj/espeak-ng/tree/ed530aa113046142eb5115cf2fc9157854d0ffe1\nhttps://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/cmake/espeak-ng-for-piper.cmake\n\nONNX Runtime 1.28.2 (MIT) and third-party notices are included.\nhttps://github.com/microsoft/onnxruntime/tree/v1.28.2\n\nNode.js 22.22.0 (MIT and bundled third-party licenses), see bin/NODE-LICENSE.txt.\nhttps://nodejs.org/dist/v22.22.0/\n\nLicense source hashes:\n${JSON.stringify(records, null, 2)}\n`)
}
