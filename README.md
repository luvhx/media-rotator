# 媒体轮播 · Media Rotator

[![build](https://github.com/luvhx/media-rotator/actions/workflows/build.yml/badge.svg)](https://github.com/luvhx/media-rotator/actions/workflows/build.yml)

把 WebDAV 上的动画库变成一条**永不落幕的直播频道**：后端按多种规则编排播出时间表，任意时刻都能算出「现在在播哪一集、播到了第几秒」；前端打开就是直播，自动定位到当前进度，并提供 302 直链播放与自定义 URL 前缀。

```
WebDAV 媒体库 ──scan──> data/library.json（含每集真实时长）
                              │
                    ┌─────────┴─────────┐
                    │   编排引擎（多种规则）│
                    └─────────┬─────────┘
                              │  时间轴：entry = {视频文件, 起始时刻, 时长}
                    ┌─────────┴─────────┐
   /api/now ◀───────│  按「现在」定位     │───────> 302 直链 / 代理
   /api/schedule ◀──│  文件 + 播放进度    │
                    └───────────────────┘
```

核心思路：**时间轴是唯一事实来源**。客户端不做任何编排计算，只问后端「现在是什么、还剩多久」，然后用 `真实时长 − 剩余时间` 反推应播放的位置，所以即使索引里的时长有误差也能自动对齐。

---

## 特性

| 能力 | 说明 |
| --- | --- |
| 时间网格编排 | 按整点/半点对齐、每集占整数格、不足一格留白；固定名额 + 排队补位（播完一部补一部） |
| 播出日切 | 可设 06:00 之类的日切点，深夜番不会在 00:00 被截断 |
| 确定性随机 | 同一频道 + 同一循环/同一天永远得到同一编排，重启不变、可复现 |
| 无 ffprobe 取时长 | 直接解析 MKV(EBML)/MP4(mvhd) 容器头，只需 Range 读几十 KB，不下载整集 |
| 秒级定位 | 二分查找时间轴，`/api/now` 返回文件、起止时间、已播偏移、进度、下集列表 |
| 302 直链 | `/stream/<fileId>` 直接 302 到 WebDAV/CDN 地址，后端零带宽；也可切 `proxy` 模式由后端转发 |
| 自定义 URL 前缀 | 前端读取视频文件的地址前缀可配置（CDN、反代、内网域名），支持逐请求覆盖 |
| 前端自动同步 | 打开即在播，每秒校正漂移，可手动「重新同步」；播放器回写真实时长帮助索引自愈 |
| Web 管理界面 | `/admin` 里改配置、勾选节目、可视化编辑编排、实时预览节目单，改完即生效 |
| TMDB 元数据 | 封面、简介、评分、年份、类型、播出信息；自动按中文名匹配，可手动纠正 |
| TMDB 筛选 | 按年份 / 评分 / 类型 / 匹配状态筛选节目库，也能作为频道的选片条件 |
| 字幕自动加载 | 外挂 `.ass/.srt` 与 MKV 内挂字幕统一转 WebVTT 挂到 `<track>`，可一键开关 |
| 兼容模式 | MKV 按需转封装成 MP4（视频流复制 + 音频 AAC + `hvc1`），解决 iOS/Safari 完全放不了 MKV 的问题 |

---

## 快速开始

### 路线 A：Docker（推荐，两条命令）

```bash
docker compose up -d
# 打开 http://<宿主机>:8088/admin → 填 WebDAV → 扫描 → 选片 → 新建频道并编排
```

不用写任何配置文件，配置存在 `./data/settings.json`（随数据卷持久化）。

### 路线 B：本地 Node（改代码 / 调试用）

```bash
cp config.example.json config.json   # 可选：也可以全部在 /admin 里填
npm start                            # http://127.0.0.1:8088 ，打开 /admin 配置
npm run scan                         # 也可以在终端里建索引（首次约 25 分钟 / 4000 集）
```

> 本机实测（WebDAV 媒体库 / 158 部动画）：3993 集、1415 小时（约 59 天）、2.6 TB；时长 100% 由容器头解析（0 集估算）。首次扫描 1680 s，重扫 145 s。
>
> 默认 `stream.mode` 用 `proxy`（后端带凭据转发），保证浏览器开箱能播；WebDAV 免鉴权或前面挂了解析鉴权的反代时，改成 `redirect` 更省带宽（可在 /admin 里一键切换）。

没有第三方依赖，Node.js ≥ 20 即可（用到内置 `fetch`）。

### 常用命令

```bash
npm run scan -- --concurrency 12     # 加大并发加速扫描
npm run scan -- --no-probe           # 只建索引不探时长（按码率估算，快但精度低）
npm run plan -- --stats              # 查看各频道编排规模
npm run plan -- --channel daily --date 2026-11-15    # 打印某天的节目单
npm run plan -- --channel mix --at "2026-11-15T21:30:00+08:00" --hours 6
npm start -- --port 9000
npm run smoke                        # 接口 + 前端 + 管理界面自检（服务需已启动）
npm test                             # 编排引擎自检（不联网，CI 同款）
```

---

## 管理界面（/admin）

浏览器打开 `http://<宿主机>:8088/admin`，五个标签页覆盖完整配置流程。

### 概览

库规模、频道数、参与编排的节目数；「现在在播」实时预览；扫描入口（可选是否解析时长）与进度条；**TMDB 信息同步**（带进度条，同步后可用元数据筛选）。

### 配置

| 分组 | 内容 |
| --- | --- |
| WebDAV 源 | 地址、根目录、账号、密码、超时 |
| 取流方式 | `proxy`（后端转发）/ `redirect`（302 直链）、URL 前缀、鉴权 Token、直链内嵌凭据 |
| 时区 / TMDB | 编排时区、TMDB 语言、API Key（v3）或 Read Token（v4），带「测试连接」；`tmdb.baseUrl` 可换镜像、`tmdb.concurrency` 调并发 |

密码与 Key 保存后不会回显（接口只返回 `passwordSet: true`），留空表示不修改。

### 媒体库

按封面网格展示全库，勾选决定「哪些节目参与编排」：

- 默认「全部参与」，取消勾选任意一部即切换为「只播勾选的」；
- 支持搜索、全选、清空、选中当前筛选结果；
- **筛选**：年份起止、最低评分、TMDB 类型、是否已匹配 TMDB（先到「概览 → 同步 TMDB 信息」拉一次数据）；
- 卡片上直接显示「年份 · 评分 · 首个类型」，没匹配到的只显示本地信息；
- 封面 / 评分 / 原名来自 TMDB，滚动到可视区域才按批拉取（一次 24 部），带磁盘缓存。

### 编排

**默认没有任何频道**（镜像里不带预设编排），点「+ 新建」自己加一个，或套用一个模板。

左侧频道列表，右侧编辑器——只有一个表单，改完下方会实时给出**一句人话摘要**，例如
「每天 20:00 开始，播 3 部 × 2 集；7 天一轮，固定 21 个位置（片池 6 部）；按 30 分钟对齐，不足一格留白」。

可配置项：

- 频道名称、描述、播出日切（默认 00:00）、锚点（轮换第 0 天，通常设成某个周一）；
- **时间网格**：每天开始时间、对齐粒度（15/30/60 分钟）、每天几部、每部几集、循环周期（0 = 走完整池）、集数用完后是否循环；
- **片池**：每行一部，留空则按下面的选片条件从媒体库自动取；
- **选片条件**：年份起止、最低评分、类型、至少几集（基于 TMDB 索引）。

### 预览

选频道 + 时间窗口（6 小时 ~ 14 天），可指定起始时间，用**当前未保存的草稿**实时试算节目单；留空时段以灰色「留空」行显示。

> 所有改动点「保存」后立即生效：时间轴重建，播放器下次轮询（≤10s）自动切到新编排，无需重启服务。

### 访问控制

`/admin` 与 `/api/admin/*` 默认无鉴权（家庭内网够用）。要加一层 HTTP Basic：

```yaml
environment:
  ADMIN_PASSWORD: "你的密码"
```

### TMDB 配置

1. 到 [themoviedb.org](https://www.themoviedb.org/settings/api) 免费申请 API Key（v3）或 Read Token（v4）；
2. 填进 `配置 → TMDB`，点「测试连接」；
3. 打开「媒体库」，封面会按中文名自动匹配（相似度 ≥ 0.55 才算命中），卡片角标显示来源；
4. 匹配错了可以手动指定 TMDB ID：`POST /api/admin/series/:id/tmdb`，body `{"tmdbId": 12345}`。

没配 TMDB 也能正常播，只是没有封面与简介。

---

## 字幕

浏览器只认 WebVTT（MKV 里的 ASS 基本不支持），所以后端统一转码后挂到 `<track>`：

| 来源 | 处理方式 | 需要的镜像 |
| --- | --- | --- |
| 外挂 `.ass` / `.ssa` / `.srt` / `.vtt` | 纯 JS 解析 → WebVTT（去样式标签、保留台词与换行） | 默认镜像即可 |
| MKV 内挂字幕轨（ASS / SRT） | ffmpeg 抽取 → WebVTT，按集缓存到 `data/subs/` | `:latest-ffmpeg` 变体 |

- 播放器底栏有「字幕 开 / 关」按钮，开关状态存在浏览器里；
- 打开即自动挂载，`<track>` 自带时间轴，拖进度、切集都不用额外处理；
- `GET /subtitle/<fileId>` 返回 `text/vtt`，响应头 `X-Subtitle-Source: external|embedded` 标明来源；
- `/admin → 配置 → 字幕` 可以整体关闭（关掉后连接口都不再提供）。

内挂字幕第一次加载要把整集读一遍（实测 612 MB 的 MKV 抽取 408 条字幕约 23 秒，取决于 WebDAV 速度），转完写缓存，之后秒开；播放器会在当前一集快播完时**提前预热**下一集的字幕。

**限制**：ASS 的特效、定位、字体样式会丢失（WebVTT 不支持这些），只保留文本与换行；一个 `.ass` 里同时含日中双语的，两种都会显示出来。

---

## 兼容模式（iOS / Safari 放不了 MKV）

iOS / iPadOS 上所有浏览器（Safari、Chrome、"Gear" 等）都是 WebKit 内核，**不支持 MKV 容器**——即使视频轨是 HEVC 也放不出来，表现就是左下角一直转圈。

解决办法是后端按需把 MKV **转封装**成 MP4：

| 项目 | 说明 |
| --- | --- |
| 视频 | `-c:v copy`，不重新编码；HEVC 会打上 Apple 要求的 `hvc1` 标签 |
| 音频 | 转 AAC 192k 立体声（DTS / FLAC / TrueHD 在 iOS 上放不出来） |
| 容器 | MP4 + `+faststart`（moov 前置，可边下边播） |
| 缓存 | `data/remux/`，按集缓存，默认上限 20 GB，LRU 淘汰 |
| 依赖 | 需要带 ffmpeg 的镜像 `:latest-ffmpeg` |

- **自动**：iOS/iPadOS 打开播放器即走兼容模式，先显示「正在转封装… 42%」，完成后无缝播放；
- **手动**：底栏「兼容模式」按钮可随时切换（桌面端遇到 HEVC 放不出来也可以点）；URL 加 `?compat=1` 也能强制开启；
- 转封装后的 MP4 支持 Range，拖动与直播同步逻辑和普通文件完全一致；
- 首次播放某集要等一次转封装，之后秒开。实测 127 MB 约 4 秒、612 MB 约 30 秒。

> 如果你的 iPad 连 MP4 也放不出来（极老机型不支持 HEVC），只能改成 H.264 转码，那会慢很多，需要另外开一个配置项。


### 产物发布到 WebDAV（原片与产物可以用不同服务）

`compat.publish = "webdav"` 时，转封装产物会：

1. 先落本地 `data/remux/` —— **立即可播**，不用等上传；
2. 后台上传到（可以与原片不同的）WebDAV；
3. 直链探测通过后，`/stream/<id>?format=mp4` 直接 **302** 到 CDN，后端零带宽。

| 配置 | 说明 |
| --- | --- |
| `compat.publish` | `local`（默认，只存本地）/ `webdav`（上传 + 302） |
| `compat.webdav.baseUrl` / `root` / `username` / `password` | 独立的写入目标；`baseUrl` 留空 = 复用主 WebDAV |
| `compat.urlPrefix` | 独立的 302 前缀；留空 = 沿用 `stream.urlPrefix` |
| `compat.keepLocal` | 上传后是否保留本地副本（默认保留，回源更快） |

产物路径：`compat/<系列>/<原文件名>.mp4` —— **在扫描根目录之外**，不会被 scan 当成新剧集。

> **关于直链延迟**：部分 WebDAV/网盘后端对「刚上传」的文件可能暂时返回 5xx（直链还没索引）。所以上传成功后会先 `HEAD` 探测直链，通了才标记 `published` 切 302；不通就继续走本地服务，下次请求自动重试。

实测：20 MB 上传 0.74 秒（28.4 MB/s）、读回 39.6 MB/s。

---

## Docker 部署

镜像：`ghcr.io/luvhx/media-rotator`（`latest` / `2.0.0` / `main`，linux/amd64 + linux/arm64，压缩后约 59 MB，零依赖，**公开可匿名拉取**）

另有自带 ffmpeg 的变体 `ghcr.io/luvhx/media-rotator:latest-ffmpeg`（+约 50 MB），用于抽取 MKV 内挂字幕。

### 两条命令

```bash
git clone https://github.com/luvhx/media-rotator.git && cd media-rotator
docker compose up -d
```

打开 `http://<宿主机>:8088/admin`，在界面里填 WebDAV、扫描、选片、编排。**不需要 `.env`，也不需要预先准备 config.json。**

首屏会提示「未配置」，跟着引导走即可：

1. 配置 → 填 `WebDAV 地址`（如 `http://192.168.1.10:19798/dav/Media`）、根目录（如 `动画`）、账号密码 → 保存；
2. 概览 → 「开始扫描」（4000 集约 25 分钟，可先取消勾选「解析时长」快速建索引）；
3. 媒体库 → 勾选要播的节目（不勾 = 全部）；
4. 编排 → 改频道规则或套模板；
5. 预览 → 确认节目单，保存。

索引与设置都落在宿主机 `./data/`：

```
data/
├── library.json      # 媒体库索引
├── durations.json    # 时长缓存
├── tmdb-cache.json   # TMDB 查询缓存
└── settings.json     # Web UI 保存的配置（含 WebDAV 密码，注意备份权限）
```

### 环境变量（可选）

默认全走 Web UI。若想用环境变量注入（GitOps / 自动化部署），在 `docker-compose.yml` 里取消注释或写 `.env`：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APP_PORT` | `8088` | 宿主机端口 |
| `TZ` | `Asia/Shanghai` | 容器时区 |
| `WEBDAV_BASE_URL` | — | WebDAV 地址 |
| `WEBDAV_ROOT` | — | 根目录 |
| `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` | — | 账号 |
| `STREAM_MODE` | `proxy` | `proxy` / `redirect` |
| `STREAM_URL_PREFIX` | 跟随 baseUrl | 302 直链前缀 |
| `SCAN_ON_START` | `auto` | `auto` / `always` / `never` |
| `ADMIN_PASSWORD` | 空 | 给 `/admin` 加 Basic 认证 |

> 环境变量只作为**初始值**：UI 保存后以 `data/settings.json` 为准。

### 定时重扫（新增节目自动进时间轴）

```bash
docker compose -f docker-compose.yml -f docker-compose.recurring.yml up -d
```

sidecar 每天重扫一次，扫完调用 `POST /api/reload` 热加载，不用重启主服务。

### 本地构建镜像

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

### 反向代理（可选）

`proxy` 模式下浏览器只跟同源地址通信，前面加一层 TLS 即可：

```caddy
anime.example.com {
    reverse_proxy 127.0.0.1:8088
}
```

若想用 `redirect` 直链又需要鉴权，让反代注入凭据并设置前缀指向它：

```nginx
location /media/ {
    proxy_pass http://192.168.1.10:19798/dav/Media/;
    proxy_set_header Authorization "Basic <base64(账号:密码)>";
    proxy_set_header Range $http_range;
    proxy_buffering off;
    add_header Access-Control-Allow-Origin *;
}
```

然后在 `/admin → 配置 → 取流方式` 里选 `302 直链`，前缀填 `https://anime.example.com/media`。

### CI / 镜像说明

`.github/workflows/build.yml`：push 到 `main` 或打 `v*` tag 时，先跑语法检查 + 编排自检 + 冷启动冒烟，再构建 amd64/arm64 镜像推送到 GHCR。

镜像当前公开（已验证匿名拉取）。fork 后自行发布的话，记得在 **Packages → Package settings** 里把可见性设为 public，否则需要先 `docker login ghcr.io`。

---

## 工作原理

### 1. 索引（scan）

- 递归 `PROPFIND` 列出 `动画/` → 系列目录 → `Season N/` → 视频文件，按 `SxxExx` 解析季/集/标题，自动关联同名 `.ass/.srt` 字幕。
- 时长通过 **HTTP Range 读取容器头** 得到：
  - Matroska：`Segment > Info > Duration × TimecodeScale`
  - MP4/MOV：`moov > mvhd`（头里没有就再读尾部 2 MB）
  - 其它容器：按码率估算，并在前端播放时用 `<video>.duration` 自动回写校正
- 结果写入 `data/library.json`，时长缓存 `data/durations.json`（按 `路径|大小` 缓存，重复扫描秒过）。

### 2. 编排（program）

一个频道 = 一串「节目段」，每段由一条规则生成，段之间首尾相接：

```jsonc
"program": [
  { "label": "随机档", "rule": { "type": "shuffle" },  "hours": 2 },  // 播 2 小时
  { "label": "轮播档", "rule": { "type": "interleave" }, "count": 6 } // 再播 6 集
]
```

段的长度目标：`count`（集数）/ `minutes`、`hours`、`durationMs`（时长）/ `all`（规则跑完一轮）/ `fill`（填满当天，仅 daily 模式）。

**loop 模式**：从 `anchor` 开始把 program 展开成一个完整循环（整库播一遍），总长 `cycleLen`；任意时刻的位置 = `(now − anchor) mod cycleLen`，因此后续年份也能瞬间定位。
**daily 模式**：按「播出日」展开节目，填满 24 小时后截断。日切时间由频道的 `dayStart` 决定（默认 `00:00`；设成 `06:00` 就是 06:00 → 次日 06:00 的播出日，深夜番不会跨日断档）。跨日切点的节目标记 `truncated`；随机种子包含日期，所以每天编排不同但可复现。

### 3. 定位（/api/now）

```js
const r = timeline.resolve(Date.now());
// r = { episode, startsAt, endsAt, durationMs, offsetMs, remainingMs, progress, truncated }
```

后端只返回**事实**：这一集几点开始、几点结束、现在播到第几毫秒。

### 4. 前端同步

```js
// 时长可信时：用「真实时长 − 剩余时间」，对索引时长的误差免疫
target = video.duration - (endsAt - now) / 1000;
// 时长不可信（跨零点截断等）：退回按偏移
target = (now - startsAt) / 1000;
if (Math.abs(video.currentTime - target) > 4) video.currentTime = target;  // 每秒检查
```

- 每 10 秒刷新一次 `/api/now`（拿到下集列表、续期 `endsAt`）；
- 用后端 `serverTime` 校准本地时钟偏移，客户端改系统时间也不会错位；
- 快播完（剩余 < 250ms）时立刻拉下一集并换源，切集无感；
- `<video>.duration` 与索引时长差 > 3 秒时 POST `/api/report-duration` 回写，索引逐步自愈。

---

## 配置

```jsonc
{
  "server": { "host": "0.0.0.0", "port": 8088, "publicDir": "public" },
  "timezone": "Asia/Shanghai",          // 编排与展示使用的时区
  "webdav": {
    "baseUrl": "http://192.168.1.10:19798/dav/Media",
    "root": "动画",                      // baseUrl 下的节目根目录
    "username": "...", "password": "...",
    "timeoutMs": 20000
  },
  "paths": { "library": "data/library.json", "durations": "data/durations.json" },
  "stream": {
    "mode": "redirect",                  // redirect(302 直链) | proxy(后端转发)
    "urlPrefix": "http://192.168.1.10:19798/dav/Media",  // 前端读取视频的 URL 前缀
    "embedCredentials": false,           // 302 时把账号密码嵌进 URL
    "token": null,                       // 追加鉴权串，如 "xxx" 或 "?sign=..."
    "passRange": true,                   // proxy 模式透传 Range（拖动必需）
    "headers": {}                        // proxy 模式追加响应头
  },
  "library": { "fallbackDurationMs": 1440000 },  // 探测失败时的兜底时长
  "channels": [ /* 见下节 */ ]
}
```

---

## 编排规则：时间网格

v3 起编排只有**时间网格**一种模式：一个频道 = 一张按整点 / 半点对齐的节目表，
播不下的时间就留白（播放器显示待机）。

### 频道配置

```jsonc
{
  "id": "golden",
  "name": "黄金档",
  "dayStart": "00:00",                    // 播出日切点（可设 06:00，深夜不回断）
  "anchor": "2026-11-23T00:00:00+08:00",  // 轮换「第 0 天」，通常设成某个周一
  "grid": {
    "start": "20:00",                     // 每天几点开播
    "slotMinutes": 30,                    // 对齐粒度：15 / 30 / 60
    "perDay": 3,                          // 每天几部
    "episodes": 2,                        // 每部几集
    "cycleDays": 7,                       // 循环周期：0 = 走完整片池才回头
    "loopEpisodes": "wrap",               // 集数播完后：wrap 循环 / stop 不再播
    "pool": ["86-不存在的战区", "白箱"]    // 片池（留空 = 用下面的选片条件）
  },
  "library": {                            // 选片
    "minEpisodes": 12,
    "tmdb": { "yearFrom": 2015, "minVote": 7.5, "genres": ["动画"] }
  }
}
```

### 排片规则

1. **对齐**：第一集从 `start` 开始，之后每集都从整点或半点（`slotMinutes` 的整数倍）开始；
2. **占格**：每集占用 `ceil(时长 / slotMinutes)` 个网格，放不下就顺延到下一个网格点；
3. **留白**：一个网格没用满，剩下的时间就是空的（`/api/schedule` 里以 `gap` 行返回）；
4. **名单**：`cycleDays > 0` 时，`perDay × cycleDays` 是固定名额（比如 3 × 7 = 21 个位置）；
5. **排队**：片池超出名額的影片进入队列，某个位置上的影片播完最后一集后，队列补一部进来，从第 1 集开始；
6. **不设周期**：`cycleDays = 0` 时不做名单，每天按片池顺序往后取 `perDay` 部，走完整池才回头。

### 例子

**黄金档：每天 20:00，3 部 × 2 集，7 天一轮**

```jsonc
"grid": { "start": "20:00", "slotMinutes": 30, "perDay": 3, "episodes": 2, "cycleDays": 7 }
```

一周固定 21 个位置，每部每周播 2 集；12 集的番播 6 周后，队列里的下一部顶上。

**全天轮播：08:00 开始，12 部 × 2 集**

```jsonc
"grid": { "start": "08:00", "slotMinutes": 30, "perDay": 12, "episodes": 2, "cycleDays": 7 }
```

**不设周期：每天往后推 3 部**

```jsonc
"grid": { "start": "20:00", "slotMinutes": 30, "perDay": 3, "episodes": 2, "cycleDays": 0 }
```

### 留白时段

没有节目在播时，`/api/now` 返回 `{ off: true, until, next: [...] }`，
播放器显示「暂停播出 · 下一档 20:30」，节目单里出现灰色的「留空」行。

> 从 v2 升级：旧的 `program` 配置会自动迁移——取其中第一个 `grid` 规则作为网格参数，
> 没有则套用默认值（20:00 / 30 分钟 / 3 部 / 2 集 / 7 天）。其余规则（连播、随机、分时段等）不再生效。

---

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查、库统计 |
| GET | `/api/config` | 前端引导信息（频道、时区、流模式、前缀） |
| GET | `/api/channels` | 各频道编排规模（循环条数/天数、池大小） |
| GET | `/api/now?channel=main` | **当前节目**：文件、起止时间、已播偏移、进度、接下来 12 条 |
| GET | `/api/schedule?channel=main&from=&to=` | 节目单（支持 `date=YYYY-MM-DD`、`limit`） |
| GET | `/api/library?q=` | 媒体库系列列表 |
| POST | `/api/report-duration` | 前端回写真实时长 `{fileId, durationMs}`（异常值会被拒绝） |
| POST | `/api/reload` | 重新加载 `library.json` 并重建时间轴（重扫后热更新，无需重启） |
| GET | `/stream/<fileId>` | **302** 到直链，或（proxy 模式）转发视频字节流 |
| GET | `/api/admin/state` | 管理界面初始状态（配置脱敏 + 库统计 + 扫描状态） |
| PUT | `/api/admin/settings` | 保存设置（WebDAV / 取流 / 时区 / TMDB / 频道 / 选片），支持 `dryRun` 只校验 |
| POST | `/api/admin/scan` | 触发扫描 `{probe?: true}`，进度见 `/api/admin/state` |
| POST | `/api/admin/preview` | 用草稿编排试算节目单 `{channel, hours, settings?}` |
| GET | `/api/admin/series` | 媒体库（分页/搜索，带选中状态） |
| GET | `/api/admin/series/:id` | 单部详情（本地剧集 + TMDB 季/集信息） |
| GET | `/api/admin/posters?ids=a,b` | 批量取 TMDB 封面（≤24 部，带缓存） |
| GET | `/api/admin/tmdb/search?q=` | 手动匹配时搜索 TMDB |
| POST | `/api/admin/tmdb/test` | 测试 TMDB Key 是否可用 |
| POST | `/api/admin/series/:id/tmdb` | 手动指定 TMDB ID `{tmdbId}` |
| POST | `/api/admin/tmdb/sync` | 同步全部剧集的 TMDB 信息（后台任务，进度见 `/api/admin/state`） |
| GET | `/api/admin/tmdb/facets` | 类型/年份分布 + 匹配统计（筛选下拉用） |
| GET | `/subtitle/<fileId>` | 该集字幕的 WebVTT（外挂转换 / ffmpeg 抽取，带缓存） |
| GET | `/api/remux/<fileId>` | 转封装状态 `{state, playable, directUrl, uploadProgress}`（idle/working/ready/uploading/published/error/unavailable） |
| POST | `/api/remux/<fileId>` | 启动转封装（幂等） |
| GET | `/stream/<fileId>?format=mp4` | 转封装后的 MP4：已发布则 302 到 WebDAV，否则本地流（Range）；`&local=1` 强制本地 |

`/api/now` 响应节选：

```jsonc
{
  "serverTime": 1794749813351,
  "timezone": "Asia/Shanghai",
  "channel": { "id": "mix", "name": "混编轮播", "mode": "loop" },
  "now": {
    "fileId": "aep2000000", "series": "冰菓", "season": 1, "episode": 2, "title": "第2话",
    "streamUrl": "/stream/aep2000000",
    "directUrl": "http://192.168.1.10:19798/dav/Media/%E5%8A%A8%E7%94%BB/...",
    "startsAt": 1794748600000, "endsAt": 1794750000000,
    "durationMs": 1400000, "offsetMs": 1213351, "remainingMs": 186649,
    "progress": 0.867, "truncated": false, "segmentLabel": "轮播档"
  },
  "next": [ /* 接下来 12 条，字段同上 */ ]
}
```

前端也可以自己算地址：`directUrl` 已按配置的前缀拼好，直接丢给 `<video src>` 即可。

---

## 302 直链与自定义 URL 前缀

### 302 直链

```
浏览器 GET /stream/<fileId>
        └─> 302 Location: <urlPrefix>/<编码后的文件相对路径>[?token=...]
```

- 后端不转发字节，零带宽开销，天然支持 Range 拖动。
- `urlPrefix` 就是「前端读取视频文件时的 URL 前缀」，可以指向：
  - WebDAV 本身：`http://192.168.1.10:19798/dav/Media`
  - 带鉴权的反向代理 / CDN：`https://media.example.com/anime`
  - 站内路径：`/dav/Media`（同源，免 CORS）
- 前缀已经包含根目录（如 `.../Media/动画`）时不会重复拼接。
- 支持逐请求覆盖：`/stream/<fileId>?prefix=https://cdn.example.com/v` 或 `/api/now?...&prefix=...&mode=direct`。

> **鉴权提醒**：302 的目标地址需要浏览器能直接访问。若 WebDAV 需要 Basic 认证，浏览器不会替 `<video>` 自动带上凭据，此时三选一：
> 1. `"embedCredentials": true`（把账号密码拼进 URL，部分浏览器会拦截）；
> 2. 在前面加一层会注入 `Authorization` 的反向代理（推荐，见下方 nginx 示例）；
> 3. 改用 `"mode": "proxy"`，由后端带凭据转发。

### 代理模式

```jsonc
"stream": { "mode": "proxy", "passRange": true }
```

> 本仓库 `config.json` 默认就是 `proxy`，因为目标 WebDAV 需要 Basic 认证；这也是本机浏览器能直接播的唯一免配置方式。

后端带 `Authorization` 向 WebDAV 发 `Range` 请求并原样回传 `206/Content-Range`，浏览器看到的是同源地址，没有鉴权与跨域问题；代价是流量经过后端。

### nginx 反代示例（让 302 直链可用）

```nginx
location /media/ {
    proxy_pass http://192.168.1.10:19798/dav/Media/;
    proxy_set_header Authorization "Basic <base64(账号:密码)>";
    proxy_set_header Range $http_range;
    proxy_set_header If-Range $http_if_range;
    proxy_buffering off;
    add_header Access-Control-Allow-Origin *;
}
```

配置里写 `"urlPrefix": "https://media.example.com/media"`，302 就会指向这层反代，浏览器无需任何凭据。

---

## 目录结构

```
媒体轮播/
├── config.json                 # 本地运行配置（含 WebDAV 账号，已 gitignore）
├── config.example.json         # 配置模板
├── config.compose.json         # 容器内默认配置（频道内置，账号由 UI/环境变量提供）
├── Dockerfile                  # 预构建镜像（node:22-alpine，零依赖）
├── docker-compose.yml          # 主 compose（零配置启动）
├── docker-compose.recurring.yml# 可选：每天自动重扫
├── docker-compose.build.yml    # 本地构建覆盖层
├── docker-entrypoint.sh        # 入口：修权限 / 首次扫描 / 降权
├── .env.example                # 可选环境变量模板
├── .github/workflows/build.yml # CI：自检 + 多架构镜像推送 GHCR
├── data/                       # 运行期数据（索引/时长缓存/TMDB 缓存/设置）
├── public/                     # 前端（原生 JS，无构建）
│   ├── index.html
│   ├── app.js                  # 播放器：拉时间轴、换源、seek 同步、节目单
│   ├── style.css
│   ├── admin.html              # 管理界面
│   ├── admin.js                # 配置 / 媒体库 / 编排 / 预览
│   └── admin.css
├── tools/
│   ├── selftest.mjs            # 编排引擎自检（CI，不联网）
│   ├── selftest-subtitles.mjs  # 字幕转换自检（CI，不联网）
│   ├── selftest-tmdb.mjs       # TMDB 索引/筛选自检（CI，不联网）
│   ├── smoke-boot.mjs          # 冷启动冒烟（CI，不联网）
│   ├── smoke-api.mjs           # 播放接口端到端
│   ├── smoke-frontend.mjs      # 播放器 DOM 冒烟
│   ├── smoke-admin.mjs         # 管理接口冒烟
│   └── smoke-admin-ui.mjs      # 管理界面 DOM 冒烟
└── src/
    ├── webdav.mjs              # PROPFIND / Range GET 客户端
    ├── probe.mjs               # MKV(EBML) / MP4(mvhd) 时长解析
    ├── library.mjs             # 扫描、索引、时长缓存、库对象
    ├── scheduler.mjs           # 编排规则 + 时间轴（loop / daily）
    ├── tmdb.mjs                # TMDB 客户端（搜索/详情/季集，带缓存与节流）
    ├── tmdb-index.mjs          # TMDB 信息索引：同步、持久化、按年份/评分/类型筛选
    ├── settings.mjs            # 运行期设置：读写、校验、与配置合并
    ├── stream.mjs              # 302 直链、前缀拼接、代理转发
    ├── server.mjs              # 路由、公共 API、管理 API、扫描任务
    ├── config.mjs              # 配置加载/校验/环境变量覆盖
    └── cli/
        ├── scan.mjs            # 建索引
        ├── plan.mjs            # 预览节目单
        └── serve.mjs           # 启动服务
```

---

## 自检

```bash
npm run smoke
```

- `smoke-api`：时钟一致性（两次 /api/now 的 offset 增量 = 真实间隔）、节目单首尾相接、当天不超过 24:00、Range 返回 206 且是真实 MKV 字节、404 分支。
- `smoke-frontend`：用最小 DOM 桩加载 `public/app.js`，验证「取时间轴 → 设置 src → seek 到直播位置 → 漂移重同步」。
- `smoke-admin`：管理接口（状态脱敏、选片、预览、编排校验、非法输入拒绝、静态资源）。
- `smoke-admin-ui`：DOM 桩加载 `public/admin.js`，验证「概览 → 媒体库 → 编排 → 预览」整条交互链路无运行时错误。
- `npm test`：编排引擎自检 + 字幕转换自检 + 冷启动冒烟，都不联网，CI 同款。

本机运行结果：15 项接口检查 + 11 项前端检查全部通过。

## 常见问题

**时长不准怎么办？** 首选让 `scan` 完整跑完（解析容器头）。若某些文件探不到，前端播放时会用真实 `duration` 回写，索引会自动修正；只是回写前的那段时间轴可能有偏移。

**为什么节目单里有的节目被截断？** `daily` 模式在 24:00 硬截断，模拟真实电视台换日；被截断的节目 `truncated: true`，前端按偏移播放而不是按剩余时长。

**能边播边生成吗？** 编排是纯计算（几千条毫秒级），时间轴按需展开并缓存，不依赖后台定时任务；`loop` 模式用取模，跑几年也不会变慢。

**多个频道会重复扫描吗？** 不会，库只扫一次，所有频道共享同一份索引，各自维护自己的时间轴。

**前端回写时长会不会把时间轴搞乱？** 不会：索引里的时长来自容器解析时，只有落在 0.6x～1.4x 区间的回写才会被接受，超出范围（异常播放器、截断流）直接拒绝并返回 `{ignored:true, reason:"outlier"}`。

**换机器/换端口后 302 地址不对？** 改 `stream.urlPrefix`（或 `stream.mode`），不用重新扫描。

**配置存在哪？改了要重启吗？** 存在 `data/settings.json`（Web UI 保存的），优先级高于配置文件与环境变量。保存后立即生效：时间轴重建、播放器下一次轮询自动切换，不用重启。

**转封装是自动的吗？** 是。服务端每隔 20 秒检查一次节目单，把「正在播」和「下一集」提前转好并上传；已转好的直接跳过，客户端打开即播。上限用 `remux.maxFiles/maxBytes`（本地）与 `compat.maxFiles/maxBytes`（远端）控制，默认 0 = 不限制。

**不配 TMDB 能用吗？** 能。没有 Key 时只是没有封面/简介，编排、播放、节目单都正常。

**第一次打开只有「未配置」？** 这是预期行为：现在支持零配置启动，去 `/admin` 填 WebDAV 即可；`docker compose up -d` 不需要任何环境变量。

**怎么给 /admin 加密码？** 设置环境变量 `ADMIN_PASSWORD`，重启后 `/admin` 与 `/api/admin/*` 需要 HTTP Basic 认证。

**iPad 上一只转圈怎么办？** 那是 MKV 容器不被 iOS 支持：换成 `:latest-ffmpeg` 镜像后，播放器会自动走「兼容模式」把 MKV 转封装成 MP4 再播（也可以手动点底栏按钮）。


---

## 已知限制

- 只扫描 `root/系列/Season N/文件` 两层结构（系列根目录下的散文件也会被纳入）。
- AVI/RMVB 等容器不易解析时长，会走估算 + 前端回写。
- `daily` 模式的「跨零点截断」意味着深夜档可能只播半集，这是电视台行为，不是 bug。
- 播放器依赖浏览器解码能力（MKV 建议 H.264/VP9 + AAC/Opus；HEVC 视浏览器而定）。
