# AGENTS.md · NetScope 开发约定

> 本文件是给后续 AI 助手/协作者看的约定说明，**务必遵守**。

## 测试：只用增量测试

**默认只跑增量测试，除非用户明确要求全量。**

```powershell
node test/run-tests.js --only=unit               # 最快：纯逻辑改动
node test/run-tests.js --only=unit,mapstyle,lan  # 按本次改动挑选
node test/run-tests.js --list                    # 查看全部可用名称
node test/run-tests.js --all                     # 全量（仅用户明确要求时）
```

- 全量 22 项约 7 分钟；增量通常 3～60 秒。改动后按"受影响的模块"挑用例，
  例如：改了 `draw.js` 的着色 → `color`；改了底图/视图逻辑 →
  `viewswitch,keepview,lanlock,amaptobuiltin,matrix`；改了地图数据/渲染 → `mapstyle`；
  改了地图数据加载/服务端静态资源 → `cache,smoke`；
  改了打包或 Android 代码 → `bundle,android`；
  改了高德凭据或底图设置持久化 → `amappersist,deskpersist,matrix`；
  改了 runtime-config 或静态资源服务 → `bundle,cache,smoke`。
  **改动涉及"视图/底图/模式"状态机时，务必跑 `matrix`** —— 单一场景测试
  容易漏掉状态残留类缺陷。
- 单个测试文件也可以直接 `node test/xxx-e2e.js`。

### 测试清单（`--only=` 可用名）

| 名称 | 说明 | 需浏览器 |
| --- | --- | --- |
| `unit` | 单元测试（106 用例） | 否 |
| `smoke` | 接口冒烟（12 项，会真实访问网络） | 否 |
| `cache` | 世界地图数据缓存行为（ETag / 304 / 前端不再 force-cache） | 否 |
| `lan` | 局域网拓扑验收（真实扫描） | 是 |
| `color` | 节点着色规则（13 种角色组合） | 是 |
| `mapstyle` | 世界地图默认样式（按国家划分） | 是 |
| `amap` | 高德底图验收 | 是 |
| `switch` | 底图切换与跳数标签 | 是 |
| `style` | 图例与样式一致性 | 是 |
| `lantrace` | 局域网扫描后再探测 | 是 |
| `viewswitch` | 视图切换与底图保持 | 是 |
| `topoperf` | 两种拓扑显示与性能 | 是 |
| `graphtrace` | 探测外网的逻辑拓扑 | 是 |
| `amapgraph` | 高德底图的逻辑拓扑 | 是 |
| `keepview` | 切底图保持视图 | 是 |
| `lanlock` | 局域网锁定世界地图 | 是 |
| `amaptobuiltin` | 高德逻辑拓扑切回内置地图（含底图初始化竞态） | 是 |
| `matrix` | 视图×底图全组合矩阵（21 条路径，状态残留类缺陷的兜底） | 是 |
| `bundle` | 打包产物验收（启动 exe + 校验 APK + runtime-config 回归） | 否 |
| `android` | 手机端后端桌面验证（纯 Java，脱离 Android 运行） | 否 |
| `amappersist` | 高德 Key 持久化（新窗口无本地缓存） | 是 |
| `deskpersist` | 桌面版设置持久化（跨重启保留，需已构建 exe） | 是 |

分组：`core`（unit, smoke, cache）、`pack`（打包产物 + deskpersist）、`map`（全部地图/底图/拓扑类）。

## 服务与调试

- 服务：`node src/server.js --port 8787`（默认 127.0.0.1:8787），改完前端 JS/CSS/HTML 后
  浏览器需 **Ctrl+F5** 硬刷新（静态资源有 `max-age`；`data/` 与 HTML 是 `no-cache`）。
- 改了 `src/server.js` 必须**重启服务**才生效。
- 浏览器验收依赖本机 Chrome：`C:\Program Files\Google\Chrome\Application\chrome.exe`
  （可用 `CHROME_PATH` 覆盖）。
- 高德凭据通过环境变量传入测试：`NS_AMAP_KEY` / `NS_AMAP_SECURITY`。

## 环境注意事项（Windows）

- npm 的 `.ps1` 被组策略拦截 → **直接用 `node`**，不要用 `npm`/`npx`。
  需要某个 npm 包时用自带的 `tools/fetch-npm-package.js`（直接下载 tarball 并解包），
  例如 exe 打包所需的 postject 就是这样装到 `build/tools` 的。
- Node 24 在 Windows 上 `spawnSync` 直接调用 `.bat`/`.cmd` 会返回 `EINVAL`，
  必须用 `shell: true`（见 `tools/build-apk.js` 的 `run()`）。
- PowerShell 里 `node -e "..."` 的引号极易出错 → **写成临时 `.js` 文件再执行**，
  且不要用 `Get-Content`/`Set-Content` 做文件内容往返（会破坏编码）。
- 多行提交信息用 `git commit -F <文件>`，不要用 `git commit -m "多行"`。

## 打包（Windows exe / Android APK）

- `node tools/build-exe.js` → `dist/netscope.exe`：
  先用 `tools/bundle.js` 把 `src/` 打成单文件（SEA 的 require 只支持内置模块，
  相对路径 require 会抛 `ERR_UNKNOWN_BUILTIN_MODULE`），再用 postject 注入。
  `public/` 必须与 exe 同级分发。
- `node tools/build-apk.js` → `dist/android/netscope-1.1.0.apk`：
  直接调用 aapt2 / javac / d8 / zipalign / apksigner，**不使用 Gradle**。
  工具链由 `tools/fetch-android-tools.js` 下载到 `build/android-sdk`。
  前端资源通过 aapt2 的 `-A assets` 打进 APK 的 `assets/web/`；
  注意 Windows 上 aapt2 写出的 ZIP 条目可能是**反斜杠路径**，校验时要兼容两种分隔符。
- 改完打包相关代码后跑 `node test/run-tests.js --only=bundle,android`。

## 手机端架构（Android 独立运行）

- 手机端**不需要电脑**：应用内启动 HTTP 服务（`core/NetHttpd` + `core/NetApi`），
  探测由 `core/Probe.java` 在本机完成，WebView 加载 `http://127.0.0.1:<port>/`。
- `android/java/com/netscope/app/core/` 下的类**不得引用任何 Android API**
  （环境信息通过 `Env.setInfo()` 从 `NetScopeApp` 注入，`ServerInfo` 接口解耦 HTTP 实现）。
  这样 `test/android-backend-verify.js` 才能在桌面 JVM 上直接验证整个后端。
- 平台限制要**如实呈现**，绝不伪造数据：Android 无 root 时拿不到中间路由器 IP，
  引擎只给出目标、RTT 与由回弹 TTL 推算的跳数距离，并在 notes 里说明原因。
- 桌面 exe 的窗口行为：用浏览器 `--app` 模式打开独立窗口，**关窗即退出进程**；
  改 `src/sea-entry.js` 的窗口逻辑后要实测"关窗即停"。

## 桌面端设置持久化（两个易踩的坑）

1. **应用窗口必须用稳定 profile 目录**（`%LOCALAPPDATA%\NetScope\browser-profile`）。
   浏览器按"来源 + profile 目录"隔离 localStorage；若每次启动都用
   `netscope-window-<pid>` 这类临时目录，用户的设置与高德 Key 每次都丢，
   表现为"设置不能被缓存"。**不要**在退出时删除该目录。
   > 测试持久化时，浏览器必须**优雅退出**（CDP `Browser.close`）才会把
   > localStorage 刷盘；强杀进程会丢数据，导致假阴性。

2. **`public/js/runtime-config.js` 是生成物，绝不能当静态文件读**。
   它若落盘就会被打进 `dist/public/` 并把端口写死，换端口启动后整个界面
   连不上后端；开发机上残留的旧文件也会覆盖当前地址。
   现在的做法：`serveStatic()` 里直接拦截该路径，按请求的 Host 头即时生成，
   并带 `no-store` 禁缓存。**任何情况下都不要把它写回 `public/`。**

3. 前端凭据解析要**双来源**：先读 localStorage，缺失时回落到服务端
   `data/amap-config.json`（`GET /api/amap/config?includePlain=1`，仅回环可用）。
   只看 localStorage 会在 exe 新窗口场景误报"未配置 Key"。

## 代码约定

- 前端为无构建步骤的原生 JS（ES5 风格），零第三方运行时依赖。
- 新增 DOM id 后要同步更新 `test/validate-frontend.js` 的白名单。
- 地图数据是构建产物：改 `tools/build-world-map.js` 后需重新运行生成
  `public/data/world-110m.json`。**默认样式是按国家划分（`--no-admin1`）**；
  `--admin1=50m` 会额外生成行政区划线，但该数据集含海上划界线与多套争议边界，
  观感杂乱（已按用户要求回退），非必要不要再开。
- 高德底图是**异步初始化**的，任何与底图切换相关的改动都必须考虑竞态：
  用 `baseMapToken` 校验异步结果是否已被新的切换取代，
  用 `pendingBaseMapInit` 取消待执行的启动恢复任务。
- 涉及"视图 / 底图 / 拓扑"的改动，注意这五条不变量：
  1. 底图选择（`state.baseMap` + localStorage）只在用户切换底图时改变；
  2. 切换底图不改变当前视图（世界地图 / 逻辑拓扑）；
  3. 逻辑拓扑按"跳"展开（`merge: false`），世界地图按地理坐标合并；
  4. 扫描局域网后锁定世界地图，下一次探测外网自动解锁；
  5. **渲染器模式必须与 `state.view` 对齐**：`drawCurrentTrace()` 只按"当前模式"
     绘制、不会改模式，所以任何切换路径都要显式把 `renderer.mode` 调到
     视图对应的值（`map`/`graph`）—— 否则会"视图是地图、渲染器还在画逻辑拓扑"，
     表现就是内置世界地图完全不显示。
