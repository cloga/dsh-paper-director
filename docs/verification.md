# 验证说明

## 真实执行的部分

- Node Core + SQLite：项目、不可变版本、恢复、历史素材配额、并发版本冲突、任务持久化与资源上限。
- Python/PyAV/Pillow：真实媒体格式探测、生成的PNG/音调、音轨片段和音效混合、字幕/角色标识、中文头尾、H.264/AAC编码与解码、limited BT.709。
- 实际浏览器 + 真实HTTP：素材上传、原生MediaRecorder生成音频、WebM/Opus探测与渲染、Range播放、真实MP4播放、来源时间与影片时间区分、试听并批准提案后重新制作。
- Core Agent闭环：快速任务在执行前订阅；对齐/旁白完成通知正确会话；成功出片不重复唤醒；确认/拒绝持久化；重复通知、旧版本定位、关闭竞态及过期提案防护。
- DSH真实SDK：原生Session/surface数据结构、可见助手文字提取（不含reasoning/工具/被替换历史）、插件来源消息、实际Cordis生命周期。
- 正式安装：真实npm tarball → 临时DSH_HOME/Profile → 真实CLI/pnpm离线安装 → 正式依赖fallback → 原生Loader加载Host/tools/core → 项目创建、卸载及SQLite重开。未修改用户现运行的DSH。
- 浏览器界面回归：版本冲突不会丢草稿；重试写入最新版必须明确确认；未保存录音及时间标记不静默替换。

## 不把这些测试说成什么

匿名示例是程序生成的几何图片与音调。提供的台词时标不代表机器真的从音调识别出了中文；受控Agent回调不代表调用了收费的大模型。真实模型推理、童声识别准确率与人工听感需要部署者用已授权的资料另外验收。

HTTP集成测试使用隔离的认证fixture；实际DSH认证委托及Cookie/Origin调用边界单独测试。不存在为了测试而关闭当前用户DSH鉴权的步骤。

测试里的强制终止异常分支使用可控进程stub；软磁盘监测不是OS硬配额，也不声称能终止任何操作系统拒绝终止的进程。

## 可重复命令

在源码目录按安装文档准备匹配SDK、Python虚拟环境和可选浏览器测试依赖后：

```sh
npm test
node --test tests/ui/studio.test.mjs
python -m unittest discover -s tests/python -p 'test*.py' -v
npm run check
npm run demo
```

`PAPER_DIRECTOR_TEST_PYTHON` 可显式选择已安装媒体依赖的Python；否则测试查找源码目录的 `.venv`。`DSH_ADAPTER_SDK_ROOT` 指向已安装SDK的 `node_modules/@deepseek-ai`，不是下载请求。

隔离真实安装测试额外要求显式设置 `DSH_INSTALL_SMOKE=1`，然后运行：

```sh
node --test tests/installation-smoke.test.mjs
```

该测试只创建并清理临时Profile，不更改当前GUI/Profile。未配置相关环境时，测试会明确跳过，不冒充通过。Windows无法创建普通文件symlink时，对应单项也明确跳过；目录junction及Linux可用路径测试仍执行。

## 兼容性结论

首版只声明已核对的DSH `0.1.2-rc.1` / Cordis `4.0.2`。当前安装的生产依赖闭包和磁盘Web shell使用React `18.3.1`，SDK根开发依赖是 `19.2.8`。小型Client仅消费宿主共享 `createElement`，分别测试两版本，不打包或混用React。

Registry中的Cordis `4.0.2` 曾返回ETARGET；开发使用显式SDK链接，正式Profile使用DSH自己的依赖fallback。没有降低版本、改镜像或关闭TLS来掩盖这个事实。
