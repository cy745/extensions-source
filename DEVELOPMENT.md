---
name: development-guide
description: "Complete development guide for the e-hentai cache server project — architecture, conventions, workflows, and lessons learned from migrating Preact SPA to Vite + React + React Router."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 85f83b0e-5b60-4da7-a25b-47e43b35598f
---

## Project Overview

A Tachiyomi/Mihon Android extension (`local-exhentai`) + Node.js cache server for E-Hentai/ExHentai. The cache server provides proxying, archiver-based gallery downloading, image caching, and a management dashboard/gallery UI.

**Stack**: Docker (node:20-alpine), Express 5, React 19 + React Router 7 + Vite

**Repository structure**:
```
extensions-source/
├── src/en/localexhentai/           # Android Extension (Kotlin)
└── cache-server/                   # Node.js Backend + React Frontend
    ├── src/
    │   ├── index.js               # Express server (proxy, API, caching)
    │   ├── downloader.js           # Archiver download flow + queue mgmt
    │   └── store.js                # File-based persistence (JSON files)
    ├── web/                        # Vite + React project
    │   ├── src/
    │   │   ├── App.jsx            # Routes: / /gallery /gallery/:gid /gallery/random/:seed
    │   │   ├── App.css            # All styles (single file, CSS variables theming)
    │   │   ├── api.js             # API client functions
    │   │   ├── ThemeContext.jsx    # Dark/light/system theme
    │   │   ├── pages/
    │   │   │   ├── Dashboard.jsx       # Management dashboard
    │   │   │   ├── GalleryOverview.jsx # Gallery card grid with infinite scroll
    │   │   │   ├── GalleryDetail.jsx   # Image waterfall + lightbox + auto-scroll
    │   │   │   └── RandomPreview.jsx   # Random image waterfall from all galleries
    │   │   └── components/
    │   │       ├── Lightbox.jsx        # Horizontal carousel lightbox
    │   │       ├── ScrollPreview.jsx   # Right-side thumbnail scroll preview
    │   │       ├── AutoScroll.jsx      # Auto-scroll panel with loop
    │   │       └── ThemeBtn.jsx        # Theme toggle button
    ├── Dockerfile
    └── package.json
```

---

## Development Workflow & Conventions

### Build & Deploy
```bash
# Build React frontend
cd cache-server/web && npm run build

# Build & start Docker
cd cache-server && docker compose down && docker compose build && docker compose up -d

# For clean rebuild (no cache):
docker compose build --no-cache

# After code changes: rebuild React → rebuild Docker → test
npm --prefix web run build && docker compose down && docker compose build && docker compose up -d
```

### Design Conventions
- **Single CSS file** (`App.css`) — no CSS modules or Tailwind
- **CSS variables** for theming — `--bg`, `--surface`, `--text`, `--border`, `--btn-border`, `--divider`, `--muted`, etc. Dark mode via `[data-theme="dark"]` selector. System preference via `@media(prefers-color-scheme:dark)`
- **Minimalist style** — no emoji icons (use SVG or text), subtle transitions (150-300ms), adequate whitespace, clickable elements have `cursor:pointer`
- **React functional components** with hooks (no class components)
- **Module-level cache** for state that must survive route changes — refs inside components don't survive unmount, so use module-level variables for GalleryOverview and RandomPreview data
- **Dark mode**: `ThemeContext.jsx` with `cycleTheme()` — light → dark → system

### CSS Classes Naming
- `.app` — main wrapper, `max-width: 1280px`, centered
- `.app--gallery` — wider variant (1440px), smaller padding
- `.app--fullscreen` — `max-width: 100%; padding: clamp(3px, 0.5vw, 8px)`
- `.header` — page header with flex layout
- `.section` — content section with title header
- `.btn` — reusable buttons, `.btn-delete` (red), `.btn-primary` (filled)
- `.theme-btn` — small icon button (same style as `.btn` but without its padding)
- `.refresh-btn` — outlined action button with border
- `.load-more-wrap` / `.load-more-btn` — pagination/infinite scroll
- Prefix `sp-` for ScrollPreview, `as-` for AutoScroll
- BEM-like but not strict

---

## Key Architecture Decisions

### React Frontend (replaced Preact SPA)
**Decision**: Migrated from single-file Preact SPA (no routing) to Vite + React + React Router.

**Why**: React Router provides proper URL-based routing (`/gallery/:gid`), enabling:
- Direct URL access to gallery detail pages
- Browser back/forward navigation
- Clean separation of components

**Build**: Vite bundles all JS/CSS into `dist/`. Zero CDN dependencies — works fully offline on LAN.

### Routing
```
/                    → Dashboard (management UI)
/gallery             → Gallery card grid (infinite scroll)
/gallery/random/:seed → Random preview from all galleries
/gallery/:gid        → Gallery detail waterfall + lightbox
/legacy              → (removed) old Preact HTML for comparison
```

Note: `/gallery/random/:seed` must be defined BEFORE `/gallery/:gid` in React Router so `random` is not interpreted as a `gid`.

### Waterfall Layout — Multi-Column Flex (not CSS Columns)
**Problem with CSS Columns**: Appending content causes complete column rebalance → existing items change position → jarring visual shift.

**Solution**: Flex-based multi-column with `appendCols()`:
1. Images distributed to shortest column (not round-robin)  
2. New images append to existing columns via `appendCols()` — existing DOM unchanged
3. Stable keys (`img.url`) prevent React re-mount

**Implementation**:
```javascript
// Distributing: each image goes to the column with smallest total height
function pushToCols(items, existingCols, existingColHeights) {
  items.forEach(img => {
    const minIdx = findShortestColumn(colHeights);
    cols[minIdx].push(img);
    colHeights[minIdx] += calculateHeight(img, colWidth);
  });
}
```

### Image Dimensions — Server-Side Pre-Read
**Problem**: Unknown image sizes cause layout shift when images load in CSS waterfall.

**Solution**: `image-size` npm package on server reads image dimensions. API returns `{url, w, h}` for every image. Frontend sets `aspect-ratio: w/h` on container, preventing cumulative layout shift.

**Performance**: Dimensions read via `imageSize(fs.readFileSync(path))`. Shuffled list of all images cached 30min. Per-page dimensions read on-demand.

### Random Preview — Seeded Deterministic Shuffle
**Problem**: Need reproducible random image selection from all galleries.

**Solution**: `mulberry32` seeded PRNG + Fisher-Yates shuffle:
```
seed → mulberry32 PRNG → shuffle all image indices → paginate
```
Same seed → same order. Cached 5min. Images scanned from all completed galleries, cached 30min.

### Lightbox — Horizontal Carousel (not Modal)
**Decision**: Replaced single-image modal with horizontally scrollable carousel.

**Implementation**: 
- Horizontal flex container with `overflow-x: auto` (no CSS `scroll-snap-type` — conflicts with programmatic scrolling)
- Lerp-based smooth scrolling: `target` value accumulates wheel delta, animation loop interpolates `scrollLeft` toward target
- On wheel: disable snap → lerp → 150ms idle → JS-based snap to nearest slide
- Keyboard/buttons: `scrollTo()` via lerp
- Images `height: 100dvh; width: auto; max-width: 100vw` — fill height first, cap width
- Click image → `scrollTo(i)` (lerp to center it)

### Fullscreen — screenfull Library + F11 Fallback
**Why screenfull**: Cross-browser fullscreen API with vendor prefix handling.

**F11 Detection**: `fullscreenchange` event doesn't reliably fire for F11. Added `resize` listener checking `window.innerHeight ≈ screen.height`.

**Scroll preservation**: Before fullscreen toggle, save center element's `data-global` index. After layout change, `scrollIntoView({block:'center'})` to restore.

### Infinite Scroll — IntersectionObserver
**Implementation**: Sentinel `div` at bottom (inside `load-more-wrap`), observed with `rootMargin: '400px'` for preloading. Auto-triggers `loadMore` when sentinel enters view.

**Load All** button in header fetches all remaining pages sequentially.

### Browser Back Interception for Modals
**Problem**: Lightbox and dashboard modals trigger browser back navigation (leaving the page) instead of just closing.

**Solution**: 
1. Open: `history.pushState(null, '')` + ref tracking
2. Close: `history.back()` clears the pushed entry
3. `popstate` listener: if modal/lightbox is open → close it, don't navigate

### Automatic Scroll (AutoScroll)
- Floating button → expandable panel with speed slider (0–5, step 0.5)
- `requestAnimationFrame` loop with fractional pixel accumulator
- Pause on wheel/keyboard (1s), pause during lightbox (resume 2s after close)
- Loop mode: mark start/end scroll positions, jump back on reaching end

---

## Pain Points & Lessons Learned

### 1. Module-Level Cache for Cross-Route State
React Router unmounts components when navigating. State lost on return. **Fix**: Module-level variables persist across mounts:
```javascript
let cached = null;  // survives component unmount/remount
export default function GalleryOverview() {
  const [galleries, setGalleries] = useState(cached || []);
  // ...
}
```

### 2. Node.js require() for image-size
Newer `image-size` export is `{ imageSize }` (named), not default. Also only accepts `Buffer`, not file path:
```javascript
const { imageSize } = require('image-size');
const dim = imageSize(fs.readFileSync(path)); // NOT imageSize(path)
```

### 3. `useMemo` + `images` Dependency → Full Recalc
Every `images` change causes entire column recalculation. All DOM nodes get new object references → React re-renders all items. **Fix**: Use state-based column management with `appendCols()` for incremental updates.

### 4. CSS `scroll-snap-type` Conflicts with JS Scrolling
`scroll-snap-type: x mandatory` causes the browser to immediately snap after any manual `scrollLeft` change. **Fix**: No CSS scroll-snap at all. Use JS-based snap with lerp animation.

### 5. Express v5 Route Wildcards
Express v5/path-to-regexp v8 doesn't accept bare `*`. Use `{*path}` for catch-all params:
```javascript
app.all('/proxy/{*path}', handler);   // ✓ Express v5 syntax
app.get('*', handler);                // ✗ Error in Express v5
```

### 6. Git and Large Files
`git add` on the whole `cache-server/` directory accidentally included `node_modules/` and `test-downloads/` (287MB ZIP). **Prevention**: Have `.gitignore` in place BEFORE adding, exclude `node_modules/`, `test-*`, and `*.zip`.

### 7. Express App.get('*') Fails in Express 5
The path `*` is no longer valid. Use `app.use()` middleware instead:
```javascript
// Instead of: app.get('*', handler)
app.use((req, res, next) => { ... });  // ✓
```

### 8. React Button Font Rendering
`<button>` elements use browser default font (system UI), not inherited font-family. `<a>` elements inherit font-family. For consistent styling, either set `font-family` explicitly or use the right element type.

### 9. scrollIntoView and IntersectionObserver Timing
`smooth` scrollIntoView takes unpredictable time. For "wait until element visible then do something": use `IntersectionObserver` on the target element after `scrollIntoView`.

### 10. Docker Volume Mounts
Docker on Windows with Git Bash: paths like `/app/cache/jobs/` get translated to Windows paths. Always use `docker exec ehentai-cache sh -c "command"` to avoid path translation.

---

## Reusable Patterns

### Scroll Position Preservation
```javascript
// Save before navigation
savedScrollY = window.scrollY;
// Restore on mount
useEffect(() => {
  if (savedScrollY > 0) {
    requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
    savedScrollY = 0;
  }
}, []);
```

### Focus-Flash Animation (CSS)
```css
@keyframes focusZoom {
  0% { transform: scale(1) }
  50% { transform: scale(1.035) }
  100% { transform: scale(1) }
}
.w-item.focus-flash { animation: focusZoom .8s cubic-bezier(.25,.46,.45,.94), focusGlow 2.5s ease-out .5s }
```

### Seeded Random
```javascript
function mulberry32(seed) {
  let s = seed | 0;
  return function() {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
```

### Smooth Lerp Scroll
```javascript
const animate = () => {
  const diff = target - carousel.scrollLeft;
  if (Math.abs(diff) > 0.5) {
    carousel.scrollLeft += diff * 0.12;
    rafId = requestAnimationFrame(animate);
  } else {
    carousel.scrollLeft = target;
  }
};
```

### Modal/Lightbox Back Button Intercept
```javascript
const openLb = idx => { setLbIndex(idx); lbRef.current = true; history.pushState(null, ''); };
const closeLb = (lastIdx) => { if (lbRef.current) { lbRef.current = false; setLbIndex(-1); history.back(); /* scroll to lastIdx */ } };

useEffect(() => {
  const onPop = () => {
    if (lbRef.current) {
      setLbIndex(-1); lbRef.current = false;
      // scroll to lbIdxRef.current
    }
  };
  window.addEventListener('popstate', onPop);
  return () => window.removeEventListener('popstate', onPop);
}, []);
```

---

## Testing Checklist
After any significant change:
1. `npm --prefix web run build` succeeds
2. `docker compose build` succeeds
3. `docker compose up -d` → container starts without crash
4. Dashboard loads at `/`
5. Gallery overview loads at `/gallery`
6. Gallery detail loads at `/gallery/:gid`
7. Random preview at `/gallery/random/:seed`
8. Lightbox opens/closes, keyboard/wheel navigation works
9. Fullscreen toggle works (button + F11)
10. Load More / Load All works without layout shift
11. Browser back/forward navigation is correct
12. Downloads queue and restart correctly
