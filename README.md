# NetScope · 网络连接探测与世界地图拓扑可视化

输入一个 **IP 地址 / 域名 / 网址**，NetScope 会：

1. **解析目标**：DNS 解析、反向解析、地址性质判定（公网 / 内网 / CGNAT / 保留地址）；
2. **探测连接情况**：ICMP 延迟与丢包、TCP 端口连通与时延、HTTP(S) 响应码与 TTFB、TLS 证书链；
3. **追踪完整路由**：逐跳 IP、主机名、延迟（最小/平均/最大/抖动）、每跳丢包率；
4. **地理定位每一跳**：把每个节点落到经纬度（多数据源自动降级 + 本地缓存 + 内置离线库）；
5. **在世界地图上画出完整网络拓扑图**：本机 → 接入路由器 → 城域网 → 骨干网 → 国际出口 → 目标，弧线颜色表达延迟/丢包，并带数据包流动画；
6. **查看当前网络的拓扑图**：一键读取本机网卡、默认网关、DNS、ARP 邻居表、监听端口与公网出口，
   并**主动扫描整个网段**发现同网段的其他设备（手机 / 电脑 / 打印机 / NAS / 摄像头 / 智能家居等），
   以网关为中心画成星型拓扑图，标注每台设备的局域网地址、MAC、厂商与设备类型。

**底图可切换**：内置世界地图（全球覆盖，跨洲路由显示完整）或 **高德地图**（国内地理信息更细，
街道/建筑/中文标注），在工具栏一键切换。

界面还提供：逐跳延迟曲线、连通性报告、端口扫描、DNS 记录与委派链路、证书安全检查、JSON / CSV / GeoJSON / PNG 导出。

---

## 一、快速开始

### 环境要求

- **Node.js ≥ 18**（推荐 20/22/24；本项目只在 Node 内置模块上运行，**零第三方依赖**，无需 `npm install`）
- Windows / Linux / macOS 均可

### 启动

```powershell
git clone https://github.com/nakiriasagao/webtraceor.git
cd webtraceor
node src/server.js
```

仓库中已包含预投影好的世界地图数据（`public/data/world-110m.json`），**克隆后即可直接运行**。
如需重新生成地图数据（例如想换分辨率或更新国界）：

```powershell
node tools/build-world-map.js
```

看到下面的横幅即成功：

```
  界面地址   http://127.0.0.1:8787
  接口地址   http://127.0.0.1:8787/api/health
```

用浏览器打开 <http://127.0.0.1:8787>，在顶部输入框填入 `8.8.8.8` 或 `www.baidu.com`，回车即可。

常用启动参数：

```powershell
node src/server.js --port 8899        # 换端口
node src/server.js --host 0.0.0.0     # 允许局域网其它设备访问（注意安全，见第六节）
node src/server.js --open             # 启动后自动打开浏览器
node src/server.js --help             # 查看全部参数与环境变量
```

### 命令行使用（不打开浏览器也能用）

```powershell
node bin/netscope.js 8.8.8.8                      # 完整探测 + 路由 + 地理定位
node bin/netscope.js www.baidu.com --hops 20      # 限制最大跳数
node bin/netscope.js github.com --json            # 输出完整 JSON（可管道给 jq）
node bin/netscope.js github.com --csv > route.csv # 导出逐跳 CSV（Excel 可直接打开）
node bin/netscope.js example.com --ports 80,443,8080
node bin/netscope.js --local                      # 查看本机网络拓扑
node bin/netscope.js --dns example.com            # DNS 诊断
```

---

## 二、地图底图：内置世界地图 / 高德地图

工具栏「底图」下拉框可随时切换，选择会记在浏览器本地，下次打开自动恢复。

| 底图 | 适用场景 | 说明 |
| --- | --- | --- |
| **内置世界地图** | 跨洲路由追踪 | 全球 176 个国家/地区，数据本地打包，不依赖任何 CDN 与网络 |
| **高德地图** | 国内节点、需要街道级细节 | 高德 JS API 2.0，中文标注与建筑物细节齐全；需配置 Key |

> **两套底图的拓扑样式完全一致**：高德只负责绘制底图，节点、连线、标签、动画
> 全部由内置引擎绘制到一个透明叠加层上（共用同一份绘制代码），
> 因此节点半径、呼吸光晕、弧线弧度、数据包动画、标签样式在两套底图下看起来一模一样。

### 配置高德 Key（约 3 分钟）

1. 打开 <https://lbs.amap.com/> 注册并完成 **个人开发者实名认证**（控制台 → 账号管理 → 实名认证）；
2. 进入「应用管理 → 我的应用 → 创建新应用」，名称随意（如 `NetScope`）；
3. 点该应用的「添加 Key」，**添加两次**：
   - 服务平台选 **「Web端(JS API)」** —— 用于加载地图底图，**这个是必须的**；
   - 服务平台选 **「Web服务」** —— 用于服务端 IP 定位 / 逆地理编码，**可选**；
4. 在 Key 的「设置」里查看 **安全密钥 jscode**（2021-12-02 之后申请的 Key 必须携带）；
5. 回到 NetScope，点左侧「⚙ 地图设置」，填入 Key 与安全密钥 → 点「测试连接」→「保存并应用」。

**密钥存放位置**：`data/amap-config.json`（已加入 `.gitignore`，不会上传到 GitHub）。
安全密钥由服务端代理使用，页面源码里看不到它。

### 常见报错对照

| 报错 | 原因与处理 |
| --- | --- |
| `INVALID_USER_KEY` | Key 无效或未生效，确认复制完整、服务已开通 |
| `INVALID_USER_SCODE` | 缺安全密钥：把 jscode 一并填入设置面板 |
| `USERKEY_PLAT_NOMATCH` | 用「Web端(JS API)」的 Key 调用了 Web 服务接口。**底图不受影响**，只有 IP 定位不可用；如需该功能请再建一个「Web服务」Key |
| `INVALID_USER_DOMAIN` | 域名白名单限制，把该 Key 的域名白名单设为「不限制」 |
| `INVALID_USER_IP` | Web 服务 Key 的 IP 白名单限制，把本机公网 IP 加入或清空白名单 |
| `DAILY_QUERY_OVER_LIMIT` | 当日配额用完，次日恢复 |

未配置 Key 时程序**自动使用内置世界地图**，功能不受影响，只会在状态栏提示"未配置 Key"。

---

## 三、局域网设备发现（当前网络拓扑）

点左侧「扫描局域网设备」，程序会依次做这些事：

1. **读取本机信息**：网卡地址/掩码、默认网关、DNS、接口列表；
2. **网段存活探测**：对所在网段（如 `192.168.1.0/24`，最多 512 个地址、并发 64）做
   TCP 连接探测（80/443/445/22/8080/3389 等端口）——很多设备丢弃 ICMP 但会响应 TCP，
   这一步同时把设备"喂"进系统 ARP 表；
3. **读取 ARP 邻居表**：拿到 IP ↔ MAC 对应关系（已过滤广播与多播组地址）；
4. **反向 DNS / 主机名**：把 IP 解析成主机名；
5. **SSDP（UPnP）发现**：组播 M-SEARCH，可拿到智能电视、路由器、NAS 的设备描述；
6. **mDNS 查询**：查询 `_services._dns-sd._udp` 等常见服务类型；
7. **MAC 厂商识别**：内置 OUI 表（919 条常用厂商），识别 Apple / 华为 / 小米 / TP-Link / Realtek 等；
   若 MAC 是**本地管理地址**（第二位最低有效位为 1，常见于虚拟机、随机化 MAC、Mesh 节点），
   会明确标注原因而不是笼统写"未知"；
8. **设备类型推断**：结合厂商、主机名、SSDP 描述推断为
   电脑 / 手机 / 路由器 / 打印机 / NAS / 摄像头 / 电视 / IoT / 虚拟网卡等。

### 拓扑图怎么读

局域网设备使用**私有地址，在世界地图上没有真实经纬度**，因此本地网络用**星型拓扑**表达连接关系：

```
              本机 (192.168.1.111)
                     │
   设备 ──── 网关/路由器 (192.168.1.1) ──── 设备
                     │
                 互联网（公网出口 IP）
```

- **中心**：网关（黄色），显示其 IP 与主机名；
- **环绕**：同网段的其它设备，标签显示"局域网地址 + 主机名"，颜色按设备类型区分；
- **上方**：本机（绿色）；**下方**：互联网（粉色），并显示公网出口 IP；
- 点击任意节点查看详情：局域网地址、MAC、厂商、SSDP/mDNS 信息、ARP 类型；
- 右侧「路由跳点」表会切换为设备清单，可直接对照查看。

> 说明：若同时启用了高德底图，扫描局域网时会自动切回内置引擎——高德是地理底图，
> 无法表达没有经纬度的私有地址设备。

---

## 四、界面说明

| 区域 | 功能 |
| --- | --- |
| 顶部搜索栏 | 输入目标（IP / 域名 / 带协议的网址均可，自动识别端口），`Enter` 开始探测 |
| **开始探测** | 解析 + 连通性 + 路由追踪 + 地理定位（最常用） |
| **深度诊断** | 在探测基础上追加 HTTP 响应、TLS 证书安全检查 |
| **环境自检** | 检测本机各项探测能力与数据源可用性（DNS / ICMP / TCP / HTTPS / 地理服务 / 追踪引擎） |
| **图例说明** | 展开/收起右上角的图例面板（**默认展开**），说明每种颜色与线条的含义 |
| **导出** | JSON（完整数据）、CSV（逐跳表格）、GeoJSON（GIS 软件可打开）、PNG（地图截图，可选白底） |
| 左侧 · 快速目标 | 常用目标的快捷入口 |
| 左侧 · 探测参数 | 最大跳数、每跳探测次数、单跳超时、反向解析开关、追踪引擎选择 |
| 左侧 · 本机网络拓扑 | 扫描局域网设备 / 仅读本机信息 / 出口信息 / ⚙ 地图设置 |
| 左侧 · 端口扫描 | 常用端口 / 自定义列表 / 端口区间三种模式 |
| 左侧 · 显示选项 | 标签、连线、经纬网格、数据包动画、昼夜分界、连线着色方式 |
| 中间地图 | **世界地图视图**（地理拓扑）与**逻辑拓扑视图**（力导向链路图）一键切换 |
| 底图选择器 | 内置世界地图 / 高德地图（配置 Key 后可用，二者拓扑样式完全一致） |
| 右侧面板 | 路由跳点表、连通性、端口、本机网络、DNS、安全证书六个标签页 |

> **关于逻辑拓扑与高德底图**：高德是*地理*底图，而逻辑拓扑表达的是*链路关系*（与地理位置无关），
> 两者语义不兼容。因此切到逻辑拓扑时会**临时挂起**高德、改用内置引擎绘制，
> 但**你的底图选择会被完整保留**——切回世界地图会自动恢复高德底图。

> **两种拓扑的节点合并规则不同**：
> - **世界地图**按地理坐标合并（同一城市的多个跳点显示为一个标记，避免标记重叠）；
> - **逻辑拓扑**按「跳」展开（每一跳各一个节点，同城节点自动加 `#2`、`#3` 序号）。
>
> 否则"上海 6 跳"会被合并成一个点，逻辑拓扑看起来就像只有一条线。

### 地图交互

| 操作 | 效果 |
| --- | --- |
| 滚轮 | 以光标为中心缩放 |
| 按住拖动 | 平移地图 |
| 悬停节点 | 高亮该节点及其连线，显示标签 |
| 单击节点 | 锁定节点详情卡片（IP、主机名、位置、运营商、ASN、每跳延迟/丢包/抖动） |
| 点击跳点表格行 | 地图自动定位并高亮该跳对应节点 |
| 图例 | 起点（绿）/ 中间节点（蓝）/ 目标（粉）/ 无响应（灰） |

### 节点着色规则

颜色表达**角色**，时延与丢包只用于标记**异常**：

| 节点 | 颜色 |
| --- | --- |
| 起点 / 本机 | 绿色（带呼吸光晕） |
| 中间节点（正常） | **本色蓝** |
| 中间节点 · 丢包 ≥ 20% | 黄色 |
| 中间节点 · 丢包 ≥ 50% / 超时跳 / 时延 > 180ms | 红色 |
| 目标 | 粉色（带同心环） |
| 完全无响应（`* * *`） | 灰色 |

也就是说，图上的**绿色节点只可能有一个**——本机（或本机与网关合并后的"本机 / 接入点"）。
其余中间节点默认都是蓝色，只有确实出现丢包或高时延才会变黄、变红。

### 连线含义

- **颜色**：跟随目标节点的颜色（正常蓝 / 异常黄红），也可在左侧「连线着色」中切换为
  按跳数渐变、按丢包率或单色；
- **线上的文字**：第 N 跳 · 延迟值（或"超时"）——**内置地图与高德地图都会显示**；
- **节点标签**：名称 + 「第 N 跳 · 延迟」，例如 `Hong Kong  第 9-10 跳 · 180 ms`；
- **流动光点**：数据包动画，**延迟越高流动越慢**，直观表达"慢在哪一段"；
- **向上拱起**：水平方向的链路统一向上拱，垂直方向统一向右拱，避免出现"绕地球一圈"的假象。

> 右上角「图例说明」面板（默认展开）里有完整的颜色与线条对照表，可随时收起。

---

## 五、工作原理

```
浏览器前端（Canvas + SVG，无任何前端框架）
        │  REST / SSE
        ▼
Node.js HTTP 服务（零依赖）
        │
        ├── 目标解析        DNS 解析 / 反向解析 / 地址性质判定
        ├── 连通性探测      ICMP ping、TCP 连接计时、HTTP(S) 请求
        ├── 路由追踪        双引擎（原生 ICMP 套接字 / 系统 tracert·traceroute）
        ├── 地理定位        多数据源 + 磁盘缓存 + 内置离线库
        ├── 本机拓扑        网卡 / 网关 / DNS / ARP / netstat / 公网出口
        └── DNS 诊断        记录查询 / 多解析器对比 / 委派链路追踪
```

### 路由追踪的两个引擎

| 引擎 | 说明 | 适用场景 |
| --- | --- | --- |
| **原生 ICMP 套接字** | 用 UDP 低 TTL 探测 + 原始套接字接收 ICMP 超时报文，无需外部命令，速度快、可控每跳探测次数 | Linux / macOS 默认可用；Windows 需管理员权限或网络策略放开 |
| **系统命令** | 调用系统自带 `tracert`（Windows）或 `traceroute`（Linux/macOS），兼容性最好 | Windows 默认可用，无需管理员权限 |

程序会**先做一次轻量能力探测**：若原生套接字在当前环境收不到 ICMP 回包，会自动回退到系统命令引擎，并在界面上给出提示（不会静默降级，也不会让你等两次超时）。也可在左侧"追踪引擎"中手动指定。

### 命令输出捕获的三级降级

部分受限环境（容器、应用沙箱、安全软件）会禁止子进程的标准输出管道（`spawn` 直接报 `EPERM`）。NetScope 内置三级降级策略，保证在受限环境里依然能读到命令输出：

1. **管道**（标准做法，最快）
2. **PowerShell 输出重定向到临时文件** 再读文件（Node 不接触管道，规避限制）
3. **cmd.exe `>` 重定向**

同时内置多编码自动识别（UTF-8 / **GBK** / Big5 / UTF-16LE / UTF-16BE / BOM），因此中文 Windows 上 `tracert`、`ipconfig`、`ping` 输出的中文不会变成乱码，解析结果也不会因为编码问题丢字段。

### 地理定位策略

按顺序尝试，任一成功即返回：

1. **在线服务**：`ipwho.is` → `ipapi.co` → `ipinfo.io`（自动降级，可用环境变量调整顺序）
2. **本地磁盘缓存**：`data/geoip-cache.json`，默认 30 天有效 —— 重复查询不再请求网络
3. **内置离线库**：`src/data/offline-geo.js`，收录根 DNS、公共 DNS 任播、主要 IXP、大型云与 CDN 的公开地址段，以及中国主要运营商骨干段；在线不可用时仍能大致落点，并明确标注"离线估算"，**不会编造坐标**
4. **兜底**：无法定位的节点归入地图右下角"未定位"区域，不参与自动取景，避免污染视野

**私有地址处理**：`192.168.x.x`、`10.x.x.x`、`127.0.0.1` 等内网地址本身没有地理位置。NetScope 会把它们落到**本机公网出口所在位置**（通过在线服务获取出口 IP 后定位），并在详情卡片里注明"私有地址，已按公网出口位置落点"，从而避免世界地图上出现跨洲的假连线。

---

## 六、HTTP 接口

所有接口返回统一结构 `{ ok: true, ... }`，出错返回 `{ ok: false, error: "..." }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 服务状态与能力（捕获策略、地理缓存、并发情况） |
| GET | `/api/selftest` | 环境自检：逐项检测探测能力与数据源 |
| POST | `/api/analyze` | 解析目标（DNS / 地址性质），body: `{ target }` |
| POST | `/api/probe` | 连通性探测：ping、TCP、HTTP，body: `{ target }` |
| POST | `/api/trace` | 同步路由追踪，body: `{ target, maxHops, queries, resolveNames, engine }` |
| GET | `/api/trace/stream` | **SSE 流式路由追踪**，query: `target`、`maxHops`、`queries`、`timeoutMs`、`resolveNames`、`engine` |
| GET | `/api/diagnose/stream` | **SSE 流式完整诊断**（解析 → 探测 → 追踪 → 定位 → 可选端口扫描） |
| GET | `/api/result?taskId=` | 取回某个任务的完整结果 |
| POST | `/api/geo` | 批量地理定位，body: `{ ips: [...] }` |
| GET | `/api/local` | 本机网络拓扑，query: `includePorts`、`includeNeighbors`、`includePublicIP` |
| GET | `/api/egress` | 公网出口 IP 与归属地 |
| POST | `/api/dns` | DNS 记录诊断，body: `{ domain }` |
| POST | `/api/dns/compare` | 多解析器结果对比 |
| GET | `/api/dns/delegation/stream` | **SSE** 根 → 顶级域 → 权威服务器的委派链路追踪 |
| POST | `/api/portscan` | 端口扫描，body: `{ target, mode: 'quick'\|'list'\|'range', ports, from, to }` |
| POST | `/api/security` | TLS 证书链与安全检查 |
| POST | `/api/lanscan` | **局域网设备扫描**，body: `{ deep, maxHosts, timeoutMs, includeSsdp, includeMdns, hostname }`，返回设备列表 + 星型拓扑结构 |
| GET | `/api/amap/config` | 高德配置状态（密钥以掩码返回） |
| POST | `/api/amap/config` | 保存高德 Key 与安全密钥，body: `{ key, security, enabled }` |
| POST | `/api/amap/test` | 高德连通性检测（可用临时密钥，不落盘） |
| POST | `/api/amap/ip` | 高德 IP 定位，body: `{ ip }` |
| POST | `/api/amap/regeo` | 高德逆地理编码，body: `{ lon, lat }` |
| GET | `/api/tasks` | 任务列表 |
| POST | `/api/cancel` | 取消任务，body: `{ taskId }` |

SSE 事件类型：`start`、`task`、`progress`（`stage` 为 `resolve`/`probe`/`trace`/`geo`/`ports`/`hops`/`done`）、`done`、`error`、`canceled`。
其中逐跳数据以 `progress` + `stage="hops"` **分批**推送，前端可以边收边画；`done` 事件携带完整结果。

示例：

```powershell
curl.exe -X POST http://127.0.0.1:8787/api/analyze -H "Content-Type: application/json" -d "{\"target\":\"www.baidu.com\"}"
curl.exe "http://127.0.0.1:8787/api/trace/stream?target=8.8.8.8&maxHops=20"
```

---

## 七、环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NETSCOPE_PORT` | `8787` | 监听端口 |
| `NETSCOPE_HOST` | `127.0.0.1` | 监听地址（`0.0.0.0` 表示允许局域网访问） |
| `NETSCOPE_GEO_ONLINE` | `1` | 设为 `0` 关闭在线地理定位，仅用缓存 + 内置离线库（适合完全离线环境） |
| `NETSCOPE_GEO_PROVIDERS` | `ipwhois,ipapi,ipinfo` | 地理服务尝试顺序 |
| `NETSCOPE_DISABLE_ICMP` | — | 设为 `1` 禁用原生套接字引擎，只用系统命令 |
| `NETSCOPE_LOG` | `1` | 设为 `0` 关闭访问日志 |
| `NETSCOPE_ALLOW_PRIVATE_TARGETS` | `1` | 设为 `0` 禁止探测内网/保留地址 |
| `NETSCOPE_TRACE_MAX_HOPS` 等 | 见 `src/config.js` | 各类探测参数默认值 |

示例（完全离线运行）：

```powershell
$env:NETSCOPE_GEO_ONLINE='0'; node src/server.js
```

---

## 八、安全与合规

- 服务**默认只监听 `127.0.0.1`**，不会被局域网其它设备访问。如需局域网访问，请自觉确认所在网络环境可信。
- **端口扫描属于主动探测行为，请仅对你拥有或已获得明确授权的目标使用。** 扫描公网主机可能违反服务条款或当地法律。
- 默认允许探测内网地址（用于查看自己的局域网拓扑）；如需收紧，设置 `NETSCOPE_ALLOW_PRIVATE_TARGETS=0`。
- 所有目标参数都以**参数数组**传给子进程，不做字符串拼接，不存在命令注入；静态资源服务做了路径穿越防护。
- 并发限制：路由追踪最多 4 个、端口扫描最多 2 个，避免把本机网络打满。

---

## 九、目录结构

```
NetScope/
├── src/
│   ├── server.js              HTTP 服务、静态资源、启动入口
│   ├── config.js              全部可调参数与环境变量
│   ├── http-utils.js          请求体读取、JSON/SSE 响应、CORS
│   ├── tasks.js               后台任务注册、取消与并发控制
│   ├── api/routes.js          REST / SSE 路由表
│   ├── core/
│   │   ├── iputils.js         目标解析、地址性质判定、CIDR 计算
│   │   ├── exec.js            子进程执行 + 三级输出捕获 + 多编码解码
│   │   ├── parsers.js         tracert / traceroute / ping 输出解析
│   │   ├── trace.js           路由追踪双引擎
│   │   ├── reachability.js    ping / TCP / HTTP / 端口扫描 / DNS 解析
│   │   ├── geo.js             地理定位（多源降级 + 缓存 + 离线库）
│   │   ├── sysinfo.js         本机网络拓扑发现
│   │   ├── dns.js             DNS 记录、多解析器对比、委派链路追踪
│   │   ├── lanscan.js         局域网设备发现（网段探测 + ARP + SSDP/mDNS + 厂商识别）
│   │   ├── amap.js            高德地图服务端代理（配置管理 + 连通性检测 + IP 定位）
│   │   └── orchestrator.js    完整诊断流程编排
│   └── data/
│       ├── offline-geo.js     内置离线地理库（种子数据）
│       └── oui-vendors.js     MAC 厂商前缀表（919 条常用厂商）
├── public/
│   ├── index.html             界面结构
│   ├── css/style.css          界面样式
│   ├── js/{config,api,draw,export,app}.js   前端逻辑
│   ├── js/amap-map.js         高德地图接入层（加载器 + 覆盖物绘制 + 回退）
│   └── data/world-110m.json   预投影世界地图（176 个国家/地区，等距圆柱投影）
├── tools/build-world-map.js   世界地图数据构建脚本
├── bin/netscope.js            命令行工具
├── test/
│   ├── unit.test.js           单元测试（101 个用例）
│   ├── smoke-api.js           HTTP 接口冒烟测试（12 项）
│   ├── browser-e2e.js         浏览器端到端测试（CDP + 真实渲染审计）
│   ├── render-audit.js         地图渲染对抗性审计
│   ├── layout-e2e.js           投影与统计栏布局验收
│   ├── lan-topology-e2e.js     局域网拓扑验收
│   ├── amap-e2e.js             高德底图验收
│   ├── validate-frontend.js    前端静态校验
│   └── run-tests.js           汇总入口
└── data/                      缓存与截图输出（自动生成）
```

---

## 十、测试

```powershell
node test/run-tests.js            # 单元测试 + 接口冒烟（自动跳过未启动的服务）
node --test test/unit.test.js     # 仅单元测试（101 个用例，约 0.2 秒）
node test/smoke-api.js            # 仅接口冒烟测试（需服务已启动）
node test/browser-e2e.js          # 浏览器端到端测试（需 Chrome/Edge 与服务）
node test/render-audit.js         # 地图渲染对抗性审计（需 Chrome/Edge 与服务）
node test/layout-e2e.js           # 布局与投影验收：真实探测 + 截图（需 Chrome/Edge 与服务）
node test/lan-topology-e2e.js     # 局域网拓扑验收：真实扫描 + 截图（需 Chrome/Edge 与服务）
node test/amap-e2e.js <key> <security>   # 高德底图验收（未配置 Key 时自动跳过）
node test/node-color-check.js     # 节点着色规则断言（13 种角色组合）
node test/map-switch-e2e.js       # 底图切换与跳数标签验收
node test/style-consistency-e2e.js # 图例完整性 + 两套底图样式一致性
node test/lan-then-trace-e2e.js    # 扫描局域网后再探测的全流程回归
node test/view-switch-basemap-e2e.js # 视图切换保持底图选择 + 绘制性能
node test/topology-perf-e2e.js     # 两种拓扑的显示与分阶段性能采样
node test/graph-trace-e2e.js       # 探测外网的逻辑拓扑（含增量绘制阶段）
node test/validate-frontend.js    # 前端静态校验（DOM id、标签闭合、脚本顺序、资源存在性）
```

一次性跑全部（含浏览器验收）：

```powershell
$env:NS_WITH_BROWSER='1'
$env:NS_AMAP_KEY='你的Key'; $env:NS_AMAP_SECURITY='你的安全密钥'   # 可选，用于高德验收
node test/run-tests.js
```

`test/lan-topology-e2e.js` 会真实触发一次局域网扫描，断言星型拓扑正确绘制
（含网关/本机/互联网/设备节点、设备表与统计栏），并输出 `data/screenshots/lan-topology.png`。

`test/amap-e2e.js` 会真实加载高德底图，断言脚本加载、地图实例创建、瓦片接口返回 200、
并对地图容器做像素抽样确认内容确实渲染出来，最后输出 `data/screenshots/amap-basemap.png`。

`test/layout-e2e.js` 会真实追踪一次跨洲目标，断言**投影等比例**（经纬方向每度像素比必须为 1）、
**统计栏与画布左右对齐**、**目标地址不溢出**、**连线不跨越未定位节点**，并输出
`data/screenshots/final-map.png`（常规目标）与 `final-map-long-target.png`（超长地址）对照图。

`test/browser-e2e.js` 会启动无头浏览器，真实加载页面、执行一次完整探测，并审计渲染结果（画布是否真的画出了陆地和连线、节点与表格数量、视图切换、缩放、命中测试、导出），同时收集所有 console 错误与未捕获异常，最后在 `data/screenshots/` 留下截图。

`test/render-audit.js` 用合成数据做对抗性验证：中间跳点无法定位、全部跳点无法定位、跨洲极端纬度、视图越界平移/缩放、窄窗口布局、超长目标地址的统计栏布局，确保「连线不跨越未定位节点」「地图不会被拖出视野」等约束不被回归破坏。

---

## 十一、常见问题

**Q：为什么某一跳显示"无响应"（`*`）？**
骨干路由器普遍对 ICMP 限速或直接不响应探测包，这是**正常现象**，不代表链路中断。请结合前后跳的延迟与丢包判断。

**Q：提示"原生 ICMP 套接字收不到回包，已改用系统命令引擎"？**
说明当前网络或权限不允许读取 ICMP 原始报文（Windows 上常见），已自动回退到系统 `tracert`，功能不受影响，只是速度稍慢。

**Q：某些跳点显示"未知位置"？**
说明该地址不在内置离线库范围内，且在线地理服务也不可用（或被限流）。可以稍后重试，或配置 `NETSCOPE_GEO_PROVIDERS` 更换数据源。程序不会为未知地址编造坐标。

**Q：探测一次比较慢？**
路由追踪必须逐跳等待超时。把"单跳超时"调小（如 500 ms）、"每跳探测次数"调小（如 1）、"最大跳数"调小（如 15）可以显著加快。

**Q：端口扫描很慢？**
默认每个端口最多等 700 ms，被防火墙静默丢弃的端口会走满超时。缩小端口范围或使用"常用端口"模式即可。

**Q：想在没有网络的环境使用？**
设置 `NETSCOPE_GEO_ONLINE=0`，程序会完全依赖本地缓存与内置离线库，地图与拓扑图仍可正常绘制。

---

## 十二、许可

本项目为自用工具，代码可自由修改与分发。地图数据来源为 Natural Earth 1:110m（公有领域），由 `tools/build-world-map.js` 在构建期下载并预投影，运行时不依赖任何外部 CDN。
