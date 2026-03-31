# ST Cloud Storage

A self-hosted personal cloud storage solution with Cloudflare R2 as the storage backend. Built with Go + Next.js.

[中文文档](./README.md)

## Features

- **File Management** — Upload, download, rename, move, delete files and folders
- **Cloudflare R2 Storage** — S3-compatible object storage with multi-bucket support and automatic bucket switching
- **File Sharing** — Share files/folders with public links or access codes (like Baidu Netdisk)
- **File Preview** — Images, videos, audio, PDF, Markdown, text/code files
- **Office Preview** — DOCX/XLSX/PPTX via Google Docs Viewer (requires public domain)
- **Authentication** — Token-based login, WebAuthn biometrics (fingerprint/Face ID), temporary short codes
- **Folder Upload** — Upload entire folder structures preserving directory hierarchy
- **Folder ZIP Download** — Download entire folders as ZIP archives
- **Batch Operations** — Multi-select files for batch delete/download
- **Duplicate Detection** — Overwrite or rename when uploading duplicate files
- **Search** — Search files and folders by name
- **Responsive UI** — Mobile-first design with swipe-to-delete, PWA support
- **Storage Management** — Multi-bucket R2 management with usage monitoring via S3 ListObjects API
- **Daily Sync** — Automatic storage usage sync at 2:00 AM

## Tech Stack

- **Backend**: Go (pure stdlib, no frameworks)
- **Frontend**: Next.js 15 + React 19 + Tailwind CSS + shadcn/ui
- **Storage**: Cloudflare R2 (S3-compatible)
- **Database**: SQLite (via modernc.org/sqlite, pure Go)
- **Auth**: WebAuthn + Token-based sessions

## Quick Start

### Prerequisites

- Go 1.21+
- Node.js 18+
- A Cloudflare R2 bucket ([free tier: 10GB](https://developers.cloudflare.com/r2/))

### 1. Clone and build

```bash
git clone https://github.com/xirichuyi/st-cloud-storage.git
cd st-cloud-storage

npm install
npx next build

cd server
cp config.example.json config.json
go mod tidy
go build -o filestore .
```

### 2. Configure

Edit `server/config.json` with your R2 credentials.

### 3. Run

```bash
cd server
./filestore
```

Open http://localhost:9090 and login with your `masterToken`.

## Deployment

See [Chinese docs](./README.md) for detailed deployment guide including Systemd, Nginx, and Cloudflare setup.

## License

MIT
