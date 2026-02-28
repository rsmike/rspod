# CLAUDE.md — rspod

Self-hosted podcast server. Upload mp3/mp4 via web UI, manage them, serve an Apple Podcast-compatible RSS feed.

## Tech Stack

- **Backend**: Node.js 22, Express 4, CommonJS. Single-file server at `server/index.js` (~465 lines).
- **Frontend**: React 19, Vite 6, plain CSS (dark theme). No router, no state library.
- **Transcoding**: ffmpeg/ffprobe (system binary, installed via apk in Docker).
- **Storage**: Zero database — filesystem only. Media in `/media`, settings in `/media/.rspod.json`.
- **Auth**: None. Security via network-level access (Cloudflare tunnel / VPN).

## Project Structure

```
server/index.js        # Entire Express backend (API + RSS feed + static serving)
client/src/App.jsx     # Root component, tab navigation (Files / Settings)
client/src/FileManager.jsx  # Upload (chunked), file list, delete, rename, transcode
client/src/FileRow.jsx      # Single file row with inline rename
client/src/Settings.jsx     # Podcast metadata form + cover upload
Dockerfile             # Two-stage build: vite build → node:22-alpine + ffmpeg
```

## Development

```bash
npm run install:all    # Install root + server + client deps
npm run dev            # Vite dev (:5173) + Express (:3000) via concurrently
```

Vite proxies `/api`, `/podcast`, `/media` to localhost:3000.

Requires ffmpeg installed locally (e.g. `brew install ffmpeg`).

## Build & Deploy

```bash
docker build -t rspod .
docker run -p 3000:3000 -v ./podcasts:/media rspod
```

CI/CD: GitHub Actions builds multi-platform image on push to `main`, pushes to `ghcr.io/rsmike/rspod`.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | HTTP server port |

All other config (title, author, language, etc.) is managed in-app and stored in `/media/.rspod.json`.

## Key Design Decisions

- No database, no auth, no env files — minimal moving parts for a personal tool.
- Chunked uploads (50MB chunks) with client-side retry for reliability behind Cloudflare tunnels.
- Auto-transcode MP4 to H.264/AAC if incompatible (files <100MB only; larger files get manual button).
- `client/dist` is in `.gitignore` — Docker build stage produces it fresh.

## Conventions

- Keep the server as a single file unless it becomes unwieldy.
- Sanitize all user filenames with `path.basename()`.
- No over-engineering — this is a personal tool, not a product.
