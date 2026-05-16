# Cache Server 重构方案

## Archiver 流程验证结果

通过本机 Node.js 对 e-hentai.org archiver 进行了完整验证：

### 验证结论

| 步骤 | 结果 |
|------|------|
| 从画廊页提取 archiver token | ✅ Token = gallery URL 的 path 第二段 |
| 访问 archiver.php 获取下载选项 | ✅ 返回 Original (Free) / Resample (N/A) |
| POST 提交下载表单 | ✅ 返回 H@H 存档节点 URL |
| 访问 H@H 存档节点 | ✅ **本机可达**（IP: 37.48.92.176）|
| 实际文件下载 | ✅ ZIP 格式，1.5 GiB，~2-4 MB/s |
| 文件格式 | ✅ **ZIP**（不是 7z） |

### Archiver 完整请求流程

```
1. GET  /g/{gid}/{token}/           → 画廊页面（含 archiver 链接）
                                         ↓ 提取 token（= gallery URL 第二段）

2. POST /archiver.php?gid={gid}&token={token}
   Body: dltype=org&dlcheck=Download+Original+Archive
   Cookie: ipb_member_id=xxx; ipb_pass_hash=yyy; igneous=zzz
                                         ↓ HTML: 自动跳转到 H@H 节点

3. GET  https://{hath_node}/archive/{gid}/{hash}/{code}/0
                                         ↓ HTML: "file ready, click to download"

4. GET  https://{hath_node}/archive/{gid}/{hash}/{code}/0?start=1
                                         ↓ ZIP 文件流 (Content-Disposition: attachment)

5. unzip → /app/cache/galleries/{gid}/
```

### 关键发现

- **Token = gallery URL 第二段**：如 `g/3938685/4edf9c0152/` 中 `4edf9c0152` 就是 archiver token
- **下载链接来自 H@H 节点**，但本机可以直连（不需要 DoH 绕行），Docker 环境有待测试
- **文件为 ZIP 格式**，Node.js 可通过 `adm-zip` 或 `unzip` 命令直接解压
- **dltype=res 不总是可用**，需要 fallback 到 org
- **Estimated Size: 1.50 GiB**，需要稳定的大文件下载能力
- **需要 cookies**：ipb_member_id, ipb_pass_hash, igneous 缺一不可

---

## 新方案

放弃实时代理 H@H 图片，改为**服务端主动下载图包 + 本地文件服务**：

1. 信息流/章节列表/缩略图继续走代理（这些请求量小、速度快）
2. 新增「下载」菜单 → Server 从 Archiver 下载 ZIP 图包 → 解压到本地
3. 新增「浏览」菜单 → Server 检测是否下载完成 → 直接返回本地文件 URL

---

## 一、Server 端新增 API

### 1.1 `POST /api/download`

**请求：**
```json
{
  "gid": 3938898,
  "galleryUrl": "https://e-hentai.org/g/3938898/xxx",
  "dltype": "res"
}
```

**流程：**
1. 从 `galleryUrl` 提取 token（path 第二段）
2. 访问 `archiver.php?gid=xxx&token=xxx`（需要 cookies）
3. 优先选择 `dltype=res`，不可用则 fallback 到 `dltype=org`
4. POST 提交下载表单 → 获取 H@H 存档节点 URL
5. 访问 H@H URL → 点击 `?start=1` → 下载 ZIP 流
6. 流式写入 `/app/cache/archives/{gid}/archive.zip`
7. 解压到 `/app/cache/galleries/{gid}/`
8. 清理临时文件

**响应：**
```json
{ "status": "started" | "downloading" | "extracting" | "completed" | "error", "message": "..." }
```

### 1.2 `GET /api/status?gid=xxx`

```json
{ "status": "idle" | "queued" | "downloading" | "extracting" | "completed" | "error", "progress": 0-100, "totalImages": 20 }
```

### 1.3 `GET /api/browse?gid=xxx`

**未完成：**
```json
{ "status": "not_ready", "message": "Gallery not downloaded yet" }
```

**已完成：**
```json
{ "status": "ready", "gid": 3938898, "totalImages": 20, "images": ["/api/galleries/3938898/001.webp", ...] }
```

### 1.4 `GET /api/galleries/{gid}/{filename}`

直接读取磁盘文件返回，支持 `Range` 请求。

### 1.5 `GET /` — Dashboard

服务端 Web 管理界面，展示：

| 区域 | 内容 |
|------|------|
| 下载队列 | 当前正在下载/等待的任务，进度条 |
| 已完成画廊 | 已下载完成的画廊列表（缩略图、标题、页数、大小） |
| 失败任务 | 下载失败的任务及错误信息 |
| 系统信息 | 缓存占用、磁盘空间等 |

实现：服务端渲染的简单 HTML 页面，通过 JS 轮询 `/api/dashboard` 获取数据。

### 1.6 `GET /api/dashboard`

```json
{
  "queued": [
    { "gid": 3938898, "title": "...", "status": "downloading", "progress": 45, "totalImages": 20, "size": "1.50 GiB" }
  ],
  "completed": [
    { "gid": 3938897, "title": "...", "totalImages": 30, "size": "800 MiB", "downloadedAt": "2026-05-16T..." }
  ],
  "failed": [
    { "gid": 3938896, "title": "...", "error": "Connection timeout", "failedAt": "2026-05-16T..." }
  ],
  "system": {
    "diskUsed": "45 GiB",
    "diskFree": "120 GiB",
    "cacheDir": "/app/cache/galleries"
  }
}
```

---

## 二、扩展端修改

### 2.1 保留现有代理

- 信息流请求 → 仍走 Cache Rewrite → Cache Server → e-hentai.org
- 章节列表/缩略图 → 同上

### 2.2 新增菜单项

| 菜单名 | 章节 URL | 功能 |
|--------|----------|------|
| ⬇ 下载 | `eh://intent/download?gid=xxx` | 触发 Server 下载 ZIP |
| 📖 浏览 | `eh://intent/browse?gid=xxx` | 打开已下载的本地画廊 |
| 🔄 状态 | `eh://intent/status?gid=xxx` | 查看下载进度 |

### 2.3 Download 菜单流程

1. 用户点击「下载」
2. Menu interceptor 捕获 → 调用 `POST /api/download` → 返回状态页

### 2.4 Browse 菜单流程

1. 用户点击「浏览」
2. `fetchPageList` 调用 `GET /api/browse?gid=xxx`
3. 如果未完成 → 返回错误信息
4. 如果已完成 → 为每张图片创建 Page，URL 指向 cache server 文件服务
5. 图片请求 → 经过拦截器链 → Cache Server 直接读本地文件

---

## 三、文件结构

```
/app/cache/
├── archives/          # 临时：下载的 ZIP
│   └── {gid}/
│       ├── archive.zip
│       └── status.json
├── galleries/         # 持久：解压后的图片
│   └── {gid}/
│       ├── status.json
│       ├── 001.webp
│       ├── 001.jpg
│       └── ...
└── (原有缓存)
    └── ...
```

---

## 四、分阶段实施 — 当前状态

### ✅ Phase 1 — Server 基础框架 (已完成)
- ✅ Express 路由集成，所有 API 端点可用
- ✅ `http.createServer` + Express 中间件模式，API 路由优先，未匹配回退到代理
- ✅ 下载任务队列管理（顺序执行，状态持久化）
- ✅ Dashboard Web 管理界面（实时轮询状态）

### ✅ Phase 2 — Archiver 流程对接 (已完成)
- ✅ Token 提取（gallery URL path 第二段）
- ✅ archiver.php POST 提交（支持 dltype=res/org，cookie 传递）
- ✅ H@H 节点访问 + URL 解析
- ✅ ZIP 流式下载（支持大文件，进度跟踪）
- ✅ 系统 unzip 命令优先，adm-zip 后备
- ✅ 错误检测（ZIP 魔数校验、登录页检测、生成中检测）

### ✅ Phase 3 — 解压和文件服务 (已完成，与 Phase 2 合并)
- ✅ adm-zip / system unzip 解压
- ✅ 文件服务路由（/api/galleries/:gid/:filename）
- ✅ 路径穿越防护

### ✅ Phase 4 — 扩展菜单实现 (已完成)
- ✅ 菜单章节：⬇ 下载、📖 浏览、🔄 状态、★ 收藏、☆ 取消收藏
- ✅ download/status 菜单 → Interceptor 直接调 Cache Server API
- ✅ browse 菜单 → fetchPageList 同步调用 API，返回真实图片 URL
- ✅ Cache Rewrite Interceptor 跳过已指向 Cache Server 的 URL
- ✅ Cookie 传递（下载请求转发客户端 cookies 到 archiver）

### ⏳ Phase 5 — 测试和优化 (待进行)
- ⏳ 完整流程集成测试（需要真实 cookies + H@H 可达环境）
- ⏳ Docker 环境适配（H@H 节点可达性测试）
- ⏳ 大画廊压力测试
- ⏳ 下载进度实时反馈优化
