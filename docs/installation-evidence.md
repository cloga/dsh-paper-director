# 隔离 Profile 的真实安装与模块加载证据

## 结论（不是完整发布许可）

2026-09-06 在已安装 **DSH 0.1.2-rc.1、Cordis 4.0.2、Schemastery 3.18.2、Node 24.19.0、pnpm 11.7.0** 上实际运行了普通 npm tarball 安装、生产 Profile peer fallback、原生 Cordis Loader、Host 激活和 SQLite 生命周期测试。

- **Host / tools / core 的实际模块求值及 Host 创建/卸载通过**；不再只是 `require.resolve` / exports 检查，也没有从仓库的开发 `node_modules` 导入插件。
- `autoInstallPeers:false` 下，pnpm 不安装这些 peers。**正式 DSH 启动代码的 `healProfilesModuleFallback`** 将当前安装的依赖闭包投影到临时 `home/profiles/node_modules`；普通 Node parent-walk 找到这些 SDK peers。此机制不是 `scripts/link-sdk.mjs`，也不是本测试手写的 peer junction。
- **发现并修正了插件React支持范围声明过窄的问题：正式 fallback 选中的 React 是 18.3.1，而不是安装根的 19.2.8。** 它来自已安装 `@deepseek-ai/dsh-client-ui-renderer/node_modules/react`。父代理据插件只使用shared React `createElement` 的事实，将可选peer从 `^19.2.8` 改为 `>=18.3.1 <20`，dev依赖仍精确19.2.8，没有降级或改写SDK。测试按最终tarball声明，用真实semver校验生产fallback，不强迫它等同根React。
- 实际React18.3.1和19.2.8分别执行tarball Client ModuleLoader factory、Slot组件及 `createElement`，检查有效anchor/span、目标URL和宽窄标签；这只证明本插件的窄API用法，**不是混用两个React实例的支持承诺或真实浏览器mount验收**。
- 最终执行 **4/4 PASS、0FAIL、0SKIP、0TODO**。首轮旧 `^19.2.8` manifest确实因React不符而失败；中间隔离Host测试记录过1项React TODO，之后已改为正式peer范围硬断言，不再用TODO隐藏不兼容。最终快照指纹见下文。

## 可重复命令

仓库根下，由成人显式指定已经存在的匹配 SDK，值为 `node_modules/@deepseek-ai`，不是上一级 `node_modules`：

```powershell
$env:DSH_INSTALL_SMOKE = '1'
$env:DSH_ADAPTER_SDK_ROOT = '<existing-sdk>/node_modules/@deepseek-ai'
node --test tests/installation-smoke.test.mjs
Remove-Item Env:DSH_INSTALL_SMOKE, Env:DSH_ADAPTER_SDK_ROOT
```

建议在短命 PowerShell 进程中执行，以免覆盖调用者原有环境值。不需要设置当前 `DSH_HOME`，测试始终显式使用新建临时 home；实际 CLI 子进程只接收这个临时值。未启用 opt-in 时为明确 SKIP；SDK缺失/版本错误不是SKIP。

前置条件：已安装目标 SDK 的原生 Loader helper 可用，Node满足项目版本要求，npm及pnpm可用。测试不自动安装/降级SDK，不使用镜像或凭据。它用 `--offline` 安装本地tarball和全新临时store，因此 **没有 registry 下载成功的证据，也不要求 Cordis 4.0.2 已发布到 npm**。pnpm 日志的 `downloaded 1` 是本地 `file:` tarball，不是在线 peer 下载。

## 实际执行链

1. 使用 `npm pack --ignore-scripts --pack-destination <temporary>` 生成真实 `.tgz`，并用现有安全tar reader/validator检查普通文件、资源、exports和排除项。随后全部测试只使用该不可变tarball快照。
2. 用正式 `initProfile` 初始化临时 `home/profiles/paper-install-smoke`。保留默认 `nodeLinker: hoisted` 和 `autoInstallPeers:false`，初始bundle为空，`patchReload: startup`。这是为隔离测试选的最小Host composition，不启动base/web/model/provider。
3. 运行已安装 DSH 的真实 CLI：

   ```text
   node <sdk>/dsh/lib/bin.js plugin --profile paper-install-smoke add <temporary-tarball> --ignore-scripts --offline --store-dir <temporary-store>
   ```

   CLI调用pnpm并在exit0后正式reconcile。断言Profile依赖只有 `dsh-paper-director`，bundle列表只有同名；已安装文件逐个与tarball字节比较。包落在普通Profile目录而非开发源码junction；全部七项peer在Profile本地node_modules中均不存在。pnpm出现缺peer警告，安装仍成功。
4. 在独立子进程中 **真正 `import(installed/index.js)`**：在heal前因缺少 `@deepseek-ai/cordis` 得到 `ERR_MODULE_NOT_FOUND`。不是只验证导出地址存在。
5. 调用已安装 `loadProfile`、`healProfilesModuleFallback({installAnchor,profile,home})`。不调用开发link脚本，不自行创建SDK链接。检查生产API产生的共享父目录fallback；六项非React peers最终真实路径等同当前DSH安装解析结果。React18.3.1按包内声明 `>=18.3.1 <20` 校验通过，并与实际根React19.2.8分别执行Client factory/anchor测试。
6. 临时空 `cordis.yml` 加包内真实patch，再用临时dataDir覆盖表达式；实际 `appBoot.boot` 导入并激活 `dsh-paper-director`。未设置 `--expose-internals`，未改module hooks。检查原生 `ctx.loader.internal`，并通过它实际导入 `dsh-paper-director/tools` 和 `dsh-paper-director/core`。
7. 验证插件与SDK使用 **同一个 Cordis `Service` 构造函数对象**，不只是同版本字符串。
8. 通过真实Host Service创建/读取匿名项目；通过包的Core export在另一dataDir建立独立Core并创建项目。卸载root Fiber后Service消失、Core关闭；重新打开Host原dataDir并读取原项目，证明SQLite运行lease释放而不只是设置closed标志。
9. `finally`关闭Core/Fiber并删除整个临时home、数据库、tarball、npm cache及pnpm store。没有HTTP listener，也没有新GUI服务。

## 正式机制的源码锚点

以下路径均相对已安装 `node_modules/@deepseek-ai`，只读核对；hash后缀/行号随SDK更新变化。

| 文件 | 本次核对内容 |
| --- | --- |
| `dsh/lib/plugin-F7ZVfRyo.js:101–127` | Profile内pnpm执行；成功才reconcile。安装子命令本身不heal。 |
| `dsh/lib/profile-boot-BTzzdrGY.js:186–191,261–269` | 真正启动Profile时先load/prepare，再heal，后boot。证明heal是正式启动机制，不是测试特例。 |
| `dsh-app-boot/lib/index.js:365–397` | 新Profile默认hoisted、autoInstallPeers:false；不改已有文件。 |
| 同文件 `584–625` | 从安装anchor遍历dependencies及peerDependencies；每包名保留首次遇到的可解析路径。不是统一选根node_modules，也不是全局选择最高版本。React落到renderer局部版本由此解释。 |
| 同文件 `645–738` | 共享fallback及selected-bundle私有fallback；普通Node用junction/symlink；现有pnpm管理项优先，不由fallback覆盖。 |
| 同文件 `484–577` | 打包可执行文件 `process.pkg` 使用ESM proxies；本次普通Node未执行这个分支。 |
| 同文件 `1491–1511` | 真实boot加载Loader/include，等待树settle，审核加载和激活，失败dispose。 |
| `cordis-plugin-loader/lib/index.js:4–40` | 原生Node内部module loader探测；本次正常native helper路径。 |

这也意味着：`autoInstallPeers:false` 只关闭pnpm自动补peer，并不自动校验当前SDK闭包满足每项peer版本。Profile本地已有依赖仍优先，可能遮蔽共享fallback；不能把本次干净Profile的Cordis同实例结果泛化成任意旧Profile。

## 浏览器静态seed的只读证据

已安装磁盘artifact `dsh-web-frontend/dist/assets/index-Df-65__b.js` 包含以下确切链路（minified行25和107）：`pe.version="18.3.1"` → `Yl()` / `P=Yl()` → `q5=Yi({default:W5},[P])` → `zp(){return{react:q5,...}}` → `__ModuleLoader__.create({...,staticModules:zp(),...})`。renderer的 `dsh-client-ui-renderer/lib/client.js:10–13` 通过factory `require('react')` 等获得该shared seed；不是浏览器去加载本地node_modules。

这证明该**已安装shell产物静态seed为React18.3.1**，并非根开发React19.2.8。本轮未访问/刷新现有GUI，因此不声称浏览器当前页面一定已加载这些字节。实际factory测试分开使用两版本，也绝不将两版本元素混合交给同一renderer。

## 已测快照指纹

最终通过的是 **40文件** 快照，manifest版本 `dsh-paper-director@0.1.0`、React peer `>=18.3.1 <20`，含当时未提交的Agent loop改动。总计4/4通过，运行约5.7秒。前两轮39文件旧manifest快照的tarball SHA-256为 `ee2e558e9eb37726678fea41b843d33646b72461442fe2e08cac0454b6e5a731`；旧结果不替代新快照。

此快照不是最终release；本证据文档本身写入/更新以及父代理其他工作都会改变tarball。最终发布前必须重跑最新包，不能复用旧hash声称新包已测（把artifact自身hash写回artifact内文档也会改变hash）。以下是已完成的最终测试当时的字节指纹：

```text
tarball SHA-256:
066bf7373fd8cf8fc0a9a2c2e80d54317be26560d9aba5d1b5a76e656921d303
package.json SHA-256:
e03d1d9ec67454a5a7b4850227eef099b8ab9968d1881cdb0f2ff5f43885c9d8
index.js SHA-256:
169c25f2ddbfdfb39ac82eee790b58ae3d07b0a56c33ac91feb532bcf7743f68
src/core/service.js SHA-256:
b0bf47c26a58115bab0f8c0bf382e50c601eb38d9e79b3c49da54f757093ebb7
installed dsh-app-boot/lib/index.js SHA-256:
6fe919dceb1e399af50389d39c7548b3e0efaad20d752dd65fdabe8c7d6f07bf
```

## 不应从本测试推导的结论

- 未验证npm registry fresh-install SDK；原有Cordis4.0.2 ETARGET限制仍在。不降到4.0.1，不换镜像。
- React声明范围及本插件窄API测试已通过；仍未验证真实浏览器ModuleLoader mount、sidebar交互、现有GUI刷新后的插件。磁盘shell静态seed不是当前页面运行证据。
- 未验证 `process.pkg` executable proxy分支或Node22；本次仅普通Node24.19.0。
- 未启动base/full-profile服务，没有真实HTTP鉴权、Websocket或端口监听；未读取任何凭据。
- 未安装/挂载用户preset，没有 `agentPresets.standingKeyFor`、真实受限Agent回合、模型收费请求或ASR/Python媒体运行。
- 未修改运行中的 `DSH_HOME`、现有GUI、shipped preset、SDK、包manifest、Host/Core/Web业务源码，也未commit/push。
