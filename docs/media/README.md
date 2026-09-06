# 文档媒体来源与复现

本目录是 **GitHub图文文档** 的媒体，不是用户项目素材，也不是插件运行依赖；现有npm发布白名单不打包这些PNG/GIF。

## 来源与许可

- 本目录新增示意图、截图和GIF采用仓库 [MIT许可](../../LICENSE)。
- `install-overview.png` / `configuration-map.png` 是根据真实安装步骤与配置字段绘制的**解释型示意图**，不是终端截图或不存在的设置页面。
- 其余截图来自真实应用的独立、临时Core/HTTP工作室，浏览器上下文全新；不访问现有生产GUI，不导出或复用生产cookie/storage。
- 图片为代码生成的匿名几何图；音轨为生成的音调，源生成器见 `scripts/demo-media.mjs`（CC0生成素材）。没有真实儿童照片、麦克风录音、云ASR、模型推理或付费TTS。
- 时间标记在真实UI明确填写，电影由真实Python内核渲染；确认卡由真实Core提案接口产生，没有虚构助手回复。
- GIF上方步骤标题与鼠标箭头是文档注解；不修改应用源码，也不把整段制作耗时压缩后冒充实时。
- 系统字体只用于本机栅格化，未复制或发布字体文件。图内只有配置项名称，没有密钥值、登录步骤或账户身份。

## 媒体规格

| 文件 | 规格 |
| --- | --- |
| `install-overview.png` | 1000×650，安装流程图 |
| `configuration-map.png` | 1000×650，配置关系图 |
| `storyboard.png` | 1000×700，图片与逐图对白 |
| `recording.png` | 1000×700，完整录音区域 |
| `review.png` | 1000×700，试听原段与确认/保留选择 |
| `movie.png` | 1000×700，实际MP4播放器画面 |
| `studio-flow.gif` | **1000×742，5个关键帧，7.70秒，316901字节（约310KiB）** |

GIF展示：构思/署名 → 图片/台词 → 完整录音 → 人工时标示例 → 实际电影。确认卡另用静态图说明，GIF无音轨。

完整实测字节数与SHA-256见 [manifest.json](manifest.json)。已检查第一、中间、最后关键帧的可读性；逐帧128色、无抖动优化保留文字边缘和示例的黄色/蓝色，避免缩略图公共调色板产生色偏。

## 复现（仅文档开发）

需要项目Python媒体环境、中文字体、Node22.19+，以及安装在 `tests/ui/.deps` 的Playwright。Windows优先用已安装的Edge；本流程不需要真实登录、麦克风、模型或密钥。

```sh
node docs/scripts/capture-studio.mjs
python docs/scripts/render-guides.py
# 使用已安装的ui-flow-gif技能；<skill-dir>是该技能目录，不是项目路径
python <skill-dir>/scripts/build_ui_flow_gif.py --spec .test-output/docs-media/flow-spec.json
python docs/scripts/refine-flow-palette.py .test-output/docs-media/flow-spec.json
python <skill-dir>/scripts/build_ui_flow_gif.py --check docs/media/studio-flow.gif
python docs/scripts/verify-media.py --write
```

用安装了Pillow/媒体依赖的解释器执行上述Python命令；例如Windows的 `.venv/Scripts/python.exe`。捕获脚本只启动自动清理的临时loopback fixture，不是给现有DSH更换服务器。原始关键帧、诊断截图与spec位于被忽略的 `.test-output/docs-media`，临时工作室数据库自动删除。

日常校验不重写清单：

```sh
python docs/scripts/verify-media.py
node --test tests/docs-media.test.mjs
```

重新生成后，必须再次人工检查图片，不可只更新哈希跳过隐私/真实性审核。
