# Local speech / 本地语音

DailyWorkMate can use local speech recognition and synthesis, system voices, or separately configured compatible speech APIs.

## Setup

```bash
npm run companion:speech:setup
```

The scripts download the runtime, recognition and synthesis models into `companion/runtime/speech/`. This is optional, requires network access, and uses several hundred megabytes of storage. The resources are excluded from Git. Run setup before packaging to bundle the resources for the matching target platform. The current scripts and bundled runtime have been exercised on Windows x64.

In the assistant's role/voice settings, choose local speech, a suitable voice and full or summarized reading. Alternatively choose system speech, or supply your own ASR/TTS endpoint and model. Allow microphone access in the operating system to use voice input.

## Components and notices

The setup includes sherpa-onnx, SenseVoiceSmall recognition, fast Matcha/Vocos synthesis, and Kokoro synthesis, plus their required runtimes. Availability and permitted use depend on each component's own license. Read `companion/runtime/speech/licenses/THIRD-PARTY-NOTICES.txt` and the model license files installed by the setup scripts.

Speech APIs are separate from the chat proxy. Local speech does not make a remotely hosted chat model local. If speech resources are missing, install them or choose an available system/API voice.

中文：执行上面的安装命令后，在助手“角色与语音”中选择本地语音。资源位于 `companion/runtime/speech/`，体积较大且不提交到 Git；打包前安装可将其随程序分发。使用麦克风需要系统授权。若不安装本地资源，可以使用系统声音或自行配置语音接口。各模型与运行时的许可证随下载资源保存。
