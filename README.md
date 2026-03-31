# ST Cloud Storage

A self-hosted personal cloud storage solution with Cloudflare R2 as the storage backend. Built with Go + Next.js.

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
git clone https://github.com/your-username/st-cloud-storage.git
cd st-cloud-storage

# Build frontend
npm install
npx next build

# Build backend
cd server
go mod tidy
go build -o filestore .
```

### 2. Configure

Edit `server/config.json`:

```json
{
  "masterToken": "your-secure-token-here",
  "sessionSecret": "random-secret-key",
  "rpID": "",
  "rpOrigin": "",
  "r2": {
    "accountId": "your-cloudflare-account-id",
    "accessKeyId": "your-r2-access-key",
    "secretAccessKey": "your-r2-secret-key",
    "bucketName": "your-bucket-name",
    "endpoint": "https://your-account-id.r2.cloudflarestorage.com"
  }
}
```

Get R2 credentials from [Cloudflare Dashboard](https://dash.cloudflare.com/?to=/:account/r2) → R2 → Manage R2 API Tokens.

### 3. Run

```bash
cd server
./filestore
```

Open http://localhost:9090 and login with your `masterToken`.

### 4. Add more buckets (optional)

Go to Settings → Storage Buckets → Add Bucket. When one bucket fills up, uploads automatically switch to the next available bucket.

## Deployment

### Build for Linux

```bash
cd server
GOOS=linux GOARCH=amd64 go build -o filestore .
```

### Systemd service

```ini
[Unit]
Description=ST Cloud Storage
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/st-cloud/server
ExecStart=/opt/st-cloud/server/filestore
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Nginx reverse proxy

```nginx
server {
    listen 80;
    server_name your-domain.com;
    client_max_body_size 200M;

    location / {
        proxy_pass http://127.0.0.1:9090;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

### HTTPS with Cloudflare

If using Cloudflare proxy (orange cloud), set SSL mode to **Flexible** and create an Origin Rule to rewrite the destination port to `9090`.

### WebAuthn (Fingerprint/Face ID)

Requires HTTPS with a valid certificate and a domain name (not IP address). Set `rpID` and `rpOrigin` in config.json:

```json
{
  "rpID": "your-domain.com",
  "rpOrigin": "https://your-domain.com"
}
```

## File Sharing

- **Public share**: Anyone with the link can download
- **Protected share**: Requires an access code
- **Auto-embedded code**: Links include `?code=xxxx` so recipients don't need to type it
- **Folder share**: Shows file listing with "Download All as ZIP" button
- **Expiration**: Optional time-limited shares

## Storage Architecture

```
User → Go Backend → Cloudflare R2 (S3 API)
                  → SQLite (metadata, folders, shares, auth)
```

- Files are stored in R2 with path: `uploads/YYYY/MM/DD/timestamp_filename`
- Folder structure exists only in SQLite, not in R2
- Moving/renaming files only updates the database, no R2 operations needed
- Multi-bucket: when one bucket fills up, uploads automatically go to the next

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/login | No | Login with token |
| GET | /api/auth/check | No | Check session |
| POST | /api/upload | Yes | Upload file |
| GET | /api/files | Yes | List files/folders |
| POST | /api/folders | Yes | Create folder |
| DELETE | /api/files/:id | Yes | Delete file |
| DELETE | /api/folders/:id | Yes | Delete folder (recursive) |
| PUT | /api/files/:id/rename | Yes | Rename file |
| PUT | /api/files/:id/move | Yes | Move file |
| GET | /api/search?q= | Yes | Search files |
| GET | /api/stats | Yes | Storage stats |
| GET | /api/folders/:id/download | Yes | Download folder as ZIP |
| POST | /api/shares | Yes | Create share link |
| GET | /s/:id | No | Access shared file/folder |
| GET | /api/settings/buckets | Yes | List R2 buckets |
| POST | /api/settings/buckets | Yes | Add R2 bucket |

## License

MIT
