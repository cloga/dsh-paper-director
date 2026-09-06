# 纸上小导演 · Paper Director

把孩子自己的故事、照片、台词和**一整段配音**，做成一部可以观看、修改和导出的剪纸小电影。

> **开发中，尚未发布可安装版本。** 项目核心、媒体内核、DSH接入和儿童界面已有实现；目前还在连接真实HTTP/任务服务及完成端到端验收。不要把独立模块测试通过理解为完整产品已经可以安装使用。进度见 [实施状态](docs/implementation-status.md)，跟踪 [Issue #1](https://github.com/cloga/dsh-paper-director/issues/1)。

## 创作流程

1. 孩子先有故事构思。
2. 拍摄并排列照片。
3. 为每张图填写角色对白和必要动作说明。
4. 录制或上传**一整段**配音，不强制逐幕录音。
5. Agent 帮忙对齐、加漫画对白、选过场/音效、补头尾并制作视频。
6. 孩子观看后说“这里停太久”“这句是另一个人说的”，工具做可撤销的局部修改。

原则：**丰富表现，不擅自改故事。** 作者说明、确认台词、实际录音和ASR观察分开保存；听不清的声音不能自动当作静音删除。

## 项目形态

- 正式 Cordis/DSH Host 插件，持久化作品与版本。
- 独立同源儿童 Web 工作室 `/paper-director/`，DSH侧栏只增加轻量入口。
- 受限 Agent preset，仅能操作所绑定作品，不暴露通用终端、任意文件读取或凭据。
- 独立 Python 媒体内核：真实格式探测、可选本地ASR、共享画面渲染、H.264/AAC MP4。
- 所有插件页面、API和媒体地址都必须经过 DSH 当前 `connection.requestRejection()` 的鉴权/跨站检查。

## 开发验证

Node.js 22.19+（当前测试24.x），Python 3.11+。当前兼容基线为 **DSH 0.1.2-rc.1 / Cordis 4.0.2 / React 19.2.8**。

当前安装版 SDK 的 Cordis 4.0.2 尚不能从已配置的 npm registry 安装（ETARGET）。**不会静默降级SDK，也不提供镜像绕过。** 在已有对应 DSH 安装的开发机上，可显式链接该SDK：

```sh
node scripts/link-sdk.mjs /path/to/installed/dsh/node_modules
npm test
```

脚本核对每个依赖的真实版本，只写本仓库被忽略的 `node_modules`，不修改DSH安装。

```sh
python -m venv .venv
# Activate .venv using your platform's usual command, then:
python -m pip install -r requirements.txt
python -m unittest discover -s tests/python -v
python tests/python/synthetic_demo.py --output-dir tests/python/.artifacts/demo
```

Python demo 使用新生成的匿名几何图片和音调；provided transcript 是显式测试输入，不冒充识别真实语音。真实ASR需要管理员准备本地模型，程序不自动下载模型或上传孩子的录音。

浏览器 UI 测试和媒体内核验证的边界分别见 [UI测试说明](tests/ui/README.md) 与 [媒体验证](tests/python/VERIFICATION.md)。正式安装/打包说明正在完善，底层接入协议见 [DSH集成](docs/dsh-integration.md)。

## 隐私与素材

- 不包含开发家庭的照片、录音、电影或密钥。
- 原始媒体不可变；修改产生新版本，可恢复。
- Azure旁白默认关闭，只在成人配置后发送批准的文本，不发送完整录音。
- 声音素材需要明确的来源与授权记录。
- 自动技术检查不等于人工听感审核。

## License

[MIT](LICENSE)。第三方运行库、字体和用户自行导入的素材各自遵守其许可。
