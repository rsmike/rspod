# rspod

Self-hosted podcast server. Upload mp3/mp4 files via a web UI, manage them, and serve an Apple Podcast-compatible RSS feed.

## Features

- Drag-and-drop file upload with chunked transfer (works behind Cloudflare tunnels)
- File management: rename, delete
- MP4 codec detection: flags incompatible videos, auto-transcodes to H.264/AAC
- Dynamic `/podcast` RSS feed with iTunes namespace
- Podcast settings and cover image via web UI
- Single Docker image, ~300MB

## Quick start

```bash
docker run -p 3000:3000 -v ./podcasts:/media rsmike/rspod
```

Open http://localhost:3000 to manage files. Add `/podcast` to your podcast app as the feed URL.

## Configuration

All configuration is done through the web UI (Settings tab):
- Podcast title, author, description, language
- Explicit content flag
- Cover image

Settings are stored in `/media/.rspod.json`.

## Development

```bash
npm run install:all
npm run dev
```

Vite dev server runs on `:5173`, Express API on `:3000`.

## Build

```bash
docker build -t rspod .
docker run -p 3000:3000 -v ./podcasts:/media rspod
```

Multi-platform build (amd64 + arm64):

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t rspod .
```
