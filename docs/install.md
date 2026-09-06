# 安装与验证（成人操作）

> 第一次使用？先看 [图文上手：成人安装 → 配置 → 孩子创作 → 看/改电影](quick-start.md)，再按本页完成安装与安全验收。图文中的安装流程图、配置关系图是解释型示意图，不是真实操作截图；工作室截图/GIF 使用隔离 UI、匿名几何图与合成音调、人工时标和真实 Core 渲染，不代表真人录音、真实 ASR 或收费模型验证。演示媒体仅在仓库文档中提供，不改变发行包排除二进制媒体的规则。

## 状态与兼容性

目标是 **DSH 0.1.2-rc.1 / Cordis 4.0.2 / Schemastery 3.18.2**。侧栏只使用宿主共享 React 的 createElement，已分别验证生产闭包/磁盘shell的 **18.3.1** 与SDK根开发版本 **19.2.8**，可选peer范围为 `>=18.3.1 <20`；不是把两份React混合使用。开发时 npm registry 对 `@deepseek-ai/cordis@4.0.2` 返回 **ETARGET**；不要降到4.0.1或改镜像。正式DSH会通过其 `healProfilesModuleFallback` 提供已安装SDK依赖，这与源码开发的显式link不同。尚未验证其他DSH版本。

本项目是 plain JavaScript，不需要 TypeScript/JSX 编译。仓库已包含小型 `lib/client.js`，只从 DSH ModuleLoader 获取 `react`；不 bundle DSH shell、不启动第二个 Web 服务器，也不修改正在运行的 GUI。包安装与用户 preset 安装是两个分别授权的步骤。

下面 CLI 写法由上述目标版本的实际安装源码核对；它们是成人执行流程，不表示已在当前生产 Profile 执行。安全测试只使用自动清理的临时目录。**tarball 验证、实际 SDK schema/bundle 解析、pnpm 安装、真实 Host/preset mount、真实 Agent 回合是不同证据。**

### 本轮实测证据

已用真实npm tarball、隔离DSH_HOME/Profile、真实 `dsh plugin add ... --offline --ignore-scripts`、正式fallback与原生Loader完成Host激活、Core项目创建、卸载及SQLite重开；未修改当前生产Profile或GUI。插件factory分别使用真实React18.3.1/19.2.8测试。细节、复现命令和限定见 [实际安装证据](installation-evidence.md)。用户preset复制、路径/junction/并发保护也有独立测试；Windows普通文件symlink测试因OS权限明确跳过，而非冒充通过。媒体/浏览器/模型证据须分开：已验证真实HTTP和MP4播放；不把匿名音调+人工时间标记当作真实ASR识别率或付费模型推理证据。

## 1. 在源码目录离线检查 npm 产物

Node **22.19.0 或更高版本**（使用内建 SQLite）及 npm：

```sh
node --test tests/core.test.mjs tests/dsh-adapter.test.mjs tests/preset-install.test.mjs
node scripts/check-package.mjs
node --test tests/package.test.mjs tests/dsh-sdk.test.mjs
```

无需 `npm install`。`check-package.mjs` 真正执行 `npm pack --ignore-scripts`，在系统临时目录读取 `.tgz` 后清理；不是只检查工作树或 `--dry-run` 文件列表。它检查 Host、HTTP、tools、core、Python、Web、Client、patch、preset、installer、文档与各 exports 的资源名，并执行 Client ModuleLoader factory 验证 React 依赖；拒绝链接、路径穿越、`.env`（包括 example）、数据库、照片/音视频、`node_modules`、`.venv`、Python cache、测试及产物。当前发行包不含任何二进制媒体，匿名 demo 在测试时生成。此检查不是通用秘密扫描器；提交和发行前仍需人工审查源码/文档及扫描凭据，不能把文件名检查当成“任意内容均无秘密”的证明。

保存一个供安装的包（版本变化时使用 npm 实际输出的文件名）：

```sh
npm pack --ignore-scripts
# 当前 manifest 版本产物：dsh-paper-director-0.1.0.tgz
```

如果运行源码的完整实际 SDK schema/bundle 解析测试，由成人提供**已经存在且版本匹配**的 SDK。`DSH_ADAPTER_SDK_ROOT` 指向 `node_modules/@deepseek-ai`，不是 `node_modules`；不写机器路径到仓库：

```sh
DSH_ADAPTER_SDK_ROOT=/path/to/existing/node_modules/@deepseek-ai node --test tests/dsh-sdk.test.mjs tests/package.test.mjs
```

PowerShell 对应设置进程环境后运行，结束时移除：

```powershell
$env:DSH_ADAPTER_SDK_ROOT = '<existing-sdk>/node_modules/@deepseek-ai'
node --test tests/dsh-sdk.test.mjs tests/package.test.mjs
Remove-Item Env:DSH_ADAPTER_SDK_ROOT
```

未设置则输出明确 **SKIP**，不伪称 SDK 通过。已设置但无效应失败，不降级为 mock。bundle 测试调用实际 `dsh-app-boot` 的 `initProfile`、`resolveBundleDir`、`loadProfile`、`composeEntries`，将真实 tarball 的已验证普通文件放入一个临时 profile 的 `node_modules`；这证明正式解析/patch 组合路径，**不是 pnpm 安装、peer resolution 或 Host 激活测试**。它不启动 Profile、不改当前 `DSH_HOME` 或 shipped 文件。

## 2. 成人选择 Profile 并安装包

先确定真正服务现有 GUI 的 Profile 和该进程使用的 `DSH_HOME`。不要凭 `http://127.0.0.1:3080` 猜 Profile 为 `web`，也不要把新的 `dsh web` 当作更新现有 GUI。CLI 必须是目标 DSH 安装提供的 `dsh`，`pnpm` 必须在 PATH 中。

当前 DSH CLI 语法是 **`dsh plugin --profile <name> ...`**，不是 `dsh --profile <name> plugin ...`。它会初始化不存在的 Profile，再把余下参数原样交给该 Profile 目录内的 pnpm；只有 pnpm 成功后才将实际安装且声明 `dsh.bundle.patch` 的包加入 `dsh.profile.bundles`。

首次创建 Profile 会写：

```yaml
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
```

**旧 Profile 的 `pnpm-workspace.yaml` 不会自动重写**。成人应先查看 `${DSH_HOME:-~/.dsh}/profiles/<profile>/pnpm-workspace.yaml` 和实际 pnpm 设置，不能把新模板当成旧配置。不要为了本插件自动更改现有 Profile。禁止自动安装 peer 不代表不存在的 SDK 会凭空可用；仍须验证 Host 中同一套 SDK 的解析。

已发布 v0.1.0 的快速安装命令如下；将 `<真实profile>` 替换为前面确认的真实名称（不是根据 GUI 端口猜测），之后仍须完成独立用户 preset 和 Python 配置步骤：

```sh
dsh plugin --profile <真实profile> add github:cloga/dsh-paper-director#v0.1.0 --ignore-scripts
```

其他来源如下任选其一，`<profile>`、`<reviewed-commit>` 等为必须替换的占位符：

```sh
# 已检查的本地 tarball：从 tarball 所在目录调用；开头 ./ 保证按调用目录锚定
 dsh plugin --profile <profile> add ./dsh-paper-director-0.1.0.tgz --ignore-scripts

# 已审阅源码：固定完整 commit，避免安装时分支漂移；会访问 GitHub
 dsh plugin --profile <profile> add 'github:cloga/dsh-paper-director#<reviewed-commit>' --ignore-scripts

# 本地已存在的源码 checkout；这是本地依赖路径而非本项目安装器
 dsh plugin --profile <profile> add ./dsh-paper-director --ignore-scripts

# 仅在包实际发布且官方 registry/兼容性验证通过后使用；当前不宣称已发布
 dsh plugin --profile <profile> add dsh-paper-director@0.1.0 --ignore-scripts
```

本包不需要 `prepare` 或安装 lifecycle build，`--ignore-scripts` 不影响已包含的 plain JS/client 工件。DSH CLI 对 Git 包 prepare 的通用提示不意味着这个包需要放开 build scripts。不要因通用提示批量授权不相关依赖。

安装后检查 Profile manifest：dependencies 中是实际包名 `dsh-paper-director`，`dsh.profile.bundles` 包含同名，包的 `dsh.bundle.patch` 是 `./cordis.patch.yml`。Host 由普通 `name: dsh-paper-director` 行激活；没有 `dsh.host` 快捷字段。不要把提供共享 `paperDirector` Service 的 Host 行放进 Agent preset。

### 先在隔离 Profile 做真正安装验收

只有成人确认可以联网/写依赖时才执行。先建立一个全新临时 DSH home，**仅对子进程或当前短命 shell 设置 `DSH_HOME`**，再使用上面的 tarball 命令。PowerShell 示例：

```powershell
$testHome = Join-Path ([IO.Path]::GetTempPath()) ('paper-dsh-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testHome | Out-Null
$previousHome = $env:DSH_HOME
try {
  $env:DSH_HOME = $testHome
  dsh plugin --profile paper-install-test add ./dsh-paper-director-0.1.0.tgz --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'Profile package installation failed; do not activate it.' }
  # Inspect the new profile's manifest/settings and actual installed package resolution.
  # Do not start a replacement Web server or point tests at production data.
} finally {
  if ($null -eq $previousHome) { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue }
  else { $env:DSH_HOME = $previousHome }
}
# Review and remove only $testHome when no longer needed.
```

普通安装可能联网并产生依赖/store；本项目已用额外 `--offline` 的本地tarball在隔离Profile执行真实CLI/pnpm安装、正式依赖fallback和Host/Core加载，详见安装证据。不要把隔离验收当作已经修改你的运行Profile。干净registry下载该SDK仍受ETARGET限制；正式安装依赖已有的受支持DSH SDK，不能通过降级掩盖。

## 3. 显式安装独立用户 preset

包内 `presets/paper-director/{agent.cordis.yml,preset.yml}` 是资源，npm 安装不会让 roster 自动发现它。先从活动 DSH roster 的 `list()` / `resolve()` 确定**用户可写 preset root**，不要根据 shipped preset 路径推断。

在可信源码根目录，或已安装包的根目录运行：

```sh
node scripts/install-preset.mjs --root <verified-user-preset-root> --dry-run
node scripts/install-preset.mjs --root <verified-user-preset-root>
```

`--root` 是含多个用户 preset 目录的根，不是 `DSH_HOME`，也不是末级 `paper-director`。完成后目标是 `<root>/paper-director/`。省略 `--root` 时才使用 `${DSH_HOME:-~/.dsh}/.agent-presets`；若活动 roster 自定义路径，应显式传 `--root`。工具不自动查询或猜测当前 GUI 配置。

已经使用 CLI 安装进某个 Profile 时，从源码核对的安装资源路径是：

```text
<DSH_HOME>/profiles/<profile>/node_modules/dsh-paper-director/scripts/install-preset.mjs
```

此路径以该 Profile 的实际 package 安装为前提，pnpm 可以把目录链接到 store；从可信安装位置解析脚本即可，不需要再安装一份 npm 包。安装器复制的源是**脚本所在包内的两个资源**，不会根据调用 cwd 选资源。注意：为避免读取重定向资源，安装器严格拒绝源路径祖先的 symlink/junction；若包实际落在这样的布局，先将审核过的 tarball 解压到一个普通目录，再从解压包根运行，不能关闭检查或改写 shipped preset。

安全行为：

- 无 `postinstall`；导入 installer 模块也无副作用；不会写 Host composition、启动/重启 DSH 或调用 mount。
- 拒绝已有目录、文件、悬空链接目标；无 `--force`、无升级覆盖。升级先由成人另行审阅与处理已有用户 preset。
- 检查根及所有祖先目录，拒绝 symlink/junction/非目录；源文件也必须是普通文件。默认用户 `.agent-presets` 可用，`node_modules`、`agent-presets`、`presets` 等 package/shipped 路径被拒绝作为目标。
- `--dry-run` 仍验证源和目标，但不创建任何目录；只复制固定两个文件，不递归复制 `.env` 或其他额外资源。
- 并发安装用独占创建保证不会合并覆盖。父目录必须由成人拥有且没有不可信并发写者；这不是对恶意进程抢换目录的操作系统安全沙箱。

成人随后在隔离、授权环境调用真实 `agentPresets.standingKeyFor('paper-director')` 并测试两会话挂载/卸载。该 API 会真实挂载，不是只读 lint；本 installer 测试不做这件事。完成验收后再由成人重启原 Profile，并刷新**原 GUI URL**。

## 4. Python / 中文 / 匿名媒体验证

Python **3.11+**；独立虚拟环境内安装依赖，不装进 DSH 的 node_modules：

```sh
python -m venv .venv
# Activate .venv using your shell, then:
python -m pip install -r requirements.txt
python -m unittest discover -s tests/python -p 'test_*.py' -v
python tests/python/synthetic_demo.py --output-dir tests/python/.artifacts/demo
```

成人通过 Profile 自己的 `cordis.patch.yml` 覆盖 `paper-director` 行。当前patch按id替换整个config，因此应保留需要的所有字段，例如（路径必须换成自己的，不能原样复制）：

```yaml
- id: paper-director
  config:
    dataDir: !!js dshHomePath('paper-director')
    pythonPath: '/absolute/path/to/.venv/bin/python'
    # Windows示例形式：'C:\path\to\.venv\Scripts\python.exe'
    fontPath: ''
    asrModelPath: ''
    asrEngine: whisper
    allowCloudTts: false
    azureRegion: ''
    azureKeyEnv: AZURE_SPEECH_KEY
```

这是Host Profile的用户覆盖，不是Agent preset，更不能修改部署自带的composition。Windows路径使用单引号。需要自动对齐时，先在该虚拟环境安装 `requirements-asr.txt`，由成人准备本地Whisper/Vosk模型目录，再填写 `asrModelPath` 和对应引擎；默认不下载模型，也不把录音传到云端。没有模型仍可使用页面的人工时间标记。

如需Azure片头旁白，由成人在启动DSH的进程环境配置上述变量，再填写真实区域并明确开启 `allowCloudTts`。不要把密钥写入项目JSON、对话或公共仓库。

中文依赖真实CJK字体；Ubuntu CI安装 `fonts-noto-cjk`。页面工作室检查会提示缺失组件。测试使用几何图和合成音调，不含儿童照片或录音；提供的台词不是ASR识别，不能由技术测试声称“已听过”。

`.github/workflows/verify.yml` 将 Node 无依赖合同/真实 tarball 与 Python 匿名媒体分开：不运行 `npm install`、不偷偷降 Cordis；SDK schema/实际 bundle resolver 没有显式 SDK_ROOT 时报告 SKIP。Python job 安装字体和 Python 依赖，运行实际编码/解码、worker 测试、匿名 CLI demo，并用 `PAPER_DIRECTOR_TEST_PYTHON` 打开 Node 的真实 Python 测试。CI 不验证生产模型、Azure、实际 ASR 推理、真实 DSH 会话或人工试听，也不上传产物作为私有媒体。

## CLI 源码证据（相对目标安装的 node_modules/@deepseek-ai）

- `dsh/lib/bin.js:77–104`：`plugin --profile` 独立子命令和参数解析。
- `dsh/lib/plugin-F7ZVfRyo.js:25–77`：以真实安装包名 reconcile bundle；Git/path/tarball spec 不作为虚构包名。
- 同文件 `80–125`：`./` / `../` / `file:` / `link:` 相对路径锚定调用 cwd；profile 内运行 pnpm，失败不 reconcile；Git prepare 仅为通用错误提示。
- `dsh-app-boot/lib/index.js:323–397`：Profile 路径、初始化默认 pnpm 设置、已有文件不改。
- 同文件 `799–879`：正式 `resolveBundleDir` 和 `loadProfile` 先看 DSH 安装，再看 Profile，读取真实 `dsh.bundle.patch`。
- `dsh-client-modules/lib/index.js:139–165`：`dsh.client` 元数据与 `exports['./client']`，不是 Web shell build。

以上针对核对的安装版本；文件 hash 后缀和行号会随版本变化。更新 DSH 后必须重新核对，不能复用本页声称新版本已兼容。
