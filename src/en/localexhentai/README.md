# local-exhentai

A Tachiyomi/Mihon extension + caching reverse proxy for E-Hentai/ExHentai, designed for GFW-restricted environments. Provides offline gallery browsing via server-side archiver download.

## Architecture

```
┌──────────────────────┐     HTTP/HTTPS      ┌──────────────────────┐     GFW      ┌─────────────┐
│  Tachiyomi / Mihon   │ ──────────────────→ │  Cache Server (Docker)│ ──────────→ │ E-Hentai /  │
│  (Android Extension) │                     │  port 3000           │             │ ExHentai    │
└──────────────────────┘                     │                      │             └─────────────┘
       │                                     │  - Proxy /proxy/*    │
       │  POST /api/download                 │  - API /api/*        │
       │  GET  /api/status                   │  - Dashboard /       │
       └─────────────────────────────────→   │  - Archiver download │
                                             │  - ZIP extraction    │
                                             │  - Image caching     │
                                             └──────────────────────┘
```

## Directory Structure

```
src/eu/kanade/tachiyomi/extension/en/localexhentai/     # Android Extension (Kotlin)
├── EHentai.kt              # Main source — interceptors, manga/search parsers, action tags
├── MenuActions.kt           # Intent URL system for menu actions
├── EHFactory.kt             # Source factory
├── EHUrlActivity.kt         # URL activity handler
├── EHUtil.kt                # Utilities
├── ExGalleryMetadata.kt     # Gallery metadata model
├── MetadataCopier.kt        # SManga ← ExGalleryMetadata mapper
├── Tag.kt                   # Tag model
├── UriFilter.kt / UriGroup.kt  # Search filter system

cache-server/                                       # Node.js Cache Server (Docker)
├── src/
│   ├── index.js             # Express app — proxy, API routes, caching, settings
│   ├── downloader.js        # Archiver flow — ZIP download, extraction, queue management
│   └── store.js             # File-based persistence (jobs, galleries, settings)
├── web/                                           # React Frontend (Vite + React Router)
│   └── src/
│       ├── App.jsx             # Routes: / /gallery /gallery/:gid
│       ├── api.js              # API client
│       ├── ThemeContext.jsx     # Dark/light/system theme
│       ├── pages/
│       │   ├── Dashboard.jsx        # Metrics, downloads, gallery library, settings
│       │   ├── GalleryOverview.jsx  # Gallery card grid with infinite scroll
│       │   └── GalleryDetail.jsx    # Image waterfall with lightbox
│       └── components/
│           ├── Lightbox.jsx     # Full-screen image viewer
│           └── ThemeBtn.jsx     # Theme toggle button
├── Dockerfile               # node:20-alpine (builds + serves frontend)
├── docker-compose.yml
└── package.json
```

## Extension — Key Features

### Base URL & Proxy
- `baseUrl` defaults to `e-hentai.org` or `exhentai.org` (cookie-based)
- **Cache Server URL** preference — when set, all requests are rewritten through the proxy with `/proxy` prefix
- Cache Rewrite Interceptor: rewrites URLs to `{cacheServer}/proxy/{path}`, adds `X-Original-Host`
- Image Backup Interceptor: similar rewrite for backup images

### Download & Status (Action Tags)
Gallery detail page shows clickable genre tags in `⚡操作` namespace:
| Tag | Action |
|-----|--------|
| `⚡dl:{gid}` | POST /api/download → queue download |
| `⚡st:{gid}` | GET /api/status → show progress |

Search interception: `fetchSearchManga` intercepts `⚡` prefix queries → executes API call → returns fake `MangasPage` with status in title.

### Double-Refresh Download
Refresh gallery detail twice within 500ms → automatically triggers download via `POST /api/download`.

### Download Status in Description
Every `mangaDetailsParse` call fetches `/api/status?gid=xxx` and prepends status line to description:
`✅ 下载完成 (850 MiB)` / `⬇ 下载中 45%` / `⏸ 未下载`

### Chapter List
- **Not downloaded**: shows only "Chapter" (normal E-Hentai page reader)
- **Downloaded**: shows only "📖 浏览" (local file browser via `/api/browse`)

### Downloaded Mode (Latest Tab)
Setting "Show Downloaded in Latest" → "Latest" tab fetches from `/api/downloaded` instead of E-Hentai, showing locally saved galleries with covers.

### Interceptor Chain
1. **Menu Action Handler**: handles `INTENT_PREFIX` URLs for action-result thumbnails and browse-msg/err
2. **Cache Rewrite**: rewrites all URLs to cache server with `/proxy` prefix
3. **Image Backup**: on image load failure, fetches backup URL through proxy
4. **Cookie Injector**: adds `ipb_member_id`, `ipb_pass_hash`, `igneous` cookies

## Cache Server — API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/` | GET | — | Dashboard (React SPA) |
| `/gallery` | GET | — | Gallery overview (React SPA) |
| `/gallery/:gid` | GET | — | Gallery detail waterfall (React SPA) |
| `/api/dashboard` | GET | — | Stats, active jobs, paginated galleries, failures |
| `/api/download` | POST | Cookie | Enqueue gallery download (merges client + default cookies) |
| `/api/status?gid=` | GET | — | Download status (idle/queued/downloading/completed/error) |
| `/api/browse?gid=` | GET | — | List local gallery files with image URLs |
| `/api/galleries/:gid/:file` | GET | — | Serve extracted gallery images |
| `/api/delete?gid=` | POST | — | Delete gallery files and record |
| `/api/downloaded` | GET | — | Paginated list of completed galleries |
| `/api/settings` | GET/PUT | — | Default credentials (`ipb_member_id/pass_hash/igneous`) |
| `/api/refresh-metadata` | POST | — | Re-fetch title + cover from gallery page |
| `/api/import` | POST | — | Upload ZIP + gallery URL for manual import |
| `/api/gallery-overview` | GET | — | Paginated gallery cards with first image + cover |
| `/api/gallery-detail/:gid` | GET | — | Paginated images with dimensions for waterfall |
| `/proxy/*` | ALL | — | Proxy to upstream E-Hentai/ExHentai (strips `/proxy` prefix) |

### Proxy Behavior
- Caches images (7d TTL) and HTML (1h TTL) — stale-while-revalidate fallback
- Detects and skips ban/captcha pages (`[BAN]` log tag)
- DNS-over-HTTPS via Cloudflare (`104.16.133.229`) for GFW bypass
- IP fallback: tries all resolved IPs on connection failure

### Download Flow (Archiver)
1. Extract token from gallery URL (`/g/{gid}/{token}/`)
2. `POST archiver.php?gid={gid}&token={token}` → H@H node URL
3. Access H@H node → download URL (`?start=1`)
4. Stream ZIP → `/app/cache/archives/{gid}/archive.zip`
5. Extract via `unzip` (fallback: `adm-zip`)
6. Fetch gallery metadata (title, thumbnail) → save `metadata.json` + `cover.ext`
7. Clean up archive temp files
8. Set gallery status to `completed`

### Concurrent Downloads
- Configurable via Dashboard (1-10, default 2)
- Queue management: `activeJobs` Map + FIFO queue
- Decreasing concurrency doesn't interrupt active tasks

### Dashboard Features (React SPA)
- **React 19** + **React Router v7** with three routes:
  - `/` — Dashboard: metrics, downloads, gallery library, settings, import
  - `/gallery` — Gallery card grid with infinite scroll (module-level cache preserves state across navigation)
  - `/gallery/:gid` — Multi-column flex waterfall with shortest-column distribution, image fade-in, lightbox
- **Dark Mode**: ☀️/🌙/🖥 cycle toggle, persists to localStorage
- **Gallery Library**: paginated (12/24/36/48 per page), searchable, Browse navigates to `/gallery/:gid`
- **Quick Download**: textarea for multi-URL batch submission
- **Import ZIP**: file upload + URL for manual gallery import
- **Settings**: default credentials, concurrent download limit
- **Activity Log**: failure history with Retry button
- **Browser Back Integration**: modals and lightbox intercept `popstate` to close instead of navigating away
- **Image Dimensions**: server pre-reads image dimensions (`image-size`), frontend uses `aspect-ratio` to prevent layout shift
- **Infinite Scroll**: `IntersectionObserver` with 400px rootMargin preloads next pages

## Data Storage (`/app/cache/`)

```
/app/cache/
├── cache/          # HTTP response cache (meta: {key}.json, data: {key}.{ext})
├── galleries/      # Extracted gallery images
│   └── {gid}/
│       ├── metadata.json   # Title, thumbnail URL
│       ├── cover.webp      # Gallery cover
│       ├── 001.webp        # Page images
│       └── ...
├── jobs/           # Download job tracking (JSON files)
└── settings.json   # Default credentials, maxConcurrent
```

## Key Technical Details

### URL Format for Manga Identity
- Normal feed URL: `/g/{gid}/{token}/?nw=always`
- Downloaded tab URL: `/g/{gid}/{token}/?nw=always` (matching)
- `?nw=always` is critical for bookshelf matching — without it, Tachiyomi treats the manga as a new entry

## Build & Deploy

```bash
# Build extension APK
cd extensions-source
./gradlew :src:en:localexhentai:assembleDebug

# Build frontend + build & run cache server
cd src/en/localexhentai/cache-server
npm --prefix web run build           # Build React SPA
docker-compose build
docker-compose up -d
```

## Configuration

### Extension Settings
- **Cache Server URL**: `http://<server-ip>:3000/proxy`
- **Show Downloaded in Latest**: replaces "Latest" tab with local gallery list
- **ipb_member_id / ipb_pass_hash / igneous**: E-Hentai auth cookies

### Dashboard Settings
- **Default Credentials**: used when client doesn't send cookies
- **Concurrent Downloads**: 1-10, doesn't interrupt active tasks
