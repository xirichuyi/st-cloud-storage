# ST Cloud Storage

[English](#english) | [中文](#中文)

---

<a id="中文"></a>

一个基于 Cloudflare R2 的自托管个人云存储方案，使用 Go + Next.js 构建。

## 功能特性

**文件管理**
- 文件/文件夹的上传、下载、重命名、移动、删除
- 文件夹整体上传（保留目录结构）
- 文件夹打包下载（ZIP 格式）
- 重复文件检测（覆盖或重命名）
- 全局搜索（按文件名搜索文件和文件夹）
- 批量操作（多选删除/下载）

**文件预览**
- 图片预览（支持缩放）
- 视频/音频播放
- PDF 预览（浏览器新标签页）
- Office 文件预览（通过 Google Docs Viewer，需公网域名）
- Markdown 渲染
- 代码/文本高亮

**文件分享**
- 公开分享 / 提取码分享（类似百度网盘）
- 链接自动内嵌提取码（`?code=xxxx`），收到即可直接访问
- 文件夹分享（展示文件列表 + 一键打包下载）
- 可设置过期时间
- 分享管理面板

**存储管理**
- Cloudflare R2 对象存储（S3 兼容，免费 10GB）
- 多 Bucket 管理，存满自动切换下一个
- 存储用量面板（通过 S3 ListObjects API 实时查询）
- 每日凌晨 2 点自动同步用量数据

**安全认证**
- Token 登录（主密码 + 临时短码）
- WebAuthn 生物识别（指纹/Face ID，需 HTTPS + 域名）
- 手机生成临时短码供电脑端登录

**界面体验**
- 移动端优先设计，完美适配手机/平板/桌面
- iOS 风格左滑删除
- 网格/列表视图切换
- 排序（名称/大小/日期）
- PWA 支持（可添加到手机主屏幕）
- 毛玻璃/Atmospheric Precision 设计风格

---

<a id="english"></a>

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

---

## 快速开始（中文）

### 环境要求

- Go 1.21+
- Node.js 18+
- Cloudflare R2 存储桶（[免费额度 10GB](https://developers.cloudflare.com/r2/)）

### 1. 克隆并构建

```bash
git clone https://github.com/xirichuyi/st-cloud-storage.git
cd st-cloud-storage

# 构建前端
npm install
npx next build

# 构建后端
cd server
cp config.example.json config.json  # 复制配置模板
go mod tidy
go build -o filestore .
```

### 2. 配置

编辑 `server/config.json`，填入你的 R2 密钥：

```json
{
  "masterToken": "你的登录密码",
  "sessionSecret": "随机字符串",
  "rpID": "",
  "rpOrigin": "",
  "r2": {
    "accountId": "Cloudflare 账户 ID",
    "accessKeyId": "R2 访问密钥 ID",
    "secretAccessKey": "R2 秘密访问密钥",
    "bucketName": "存储桶名称",
    "endpoint": "https://你的账户ID.r2.cloudflarestorage.com"
  }
}
```

R2 密钥获取：[Cloudflare 控制台](https://dash.cloudflare.com/?to=/:account/r2) → R2 对象存储 → 管理 R2 API 令牌 → 创建 API 令牌。

### 3. 启动

```bash
cd server
./filestore
```

打开 http://localhost:9090，使用 `masterToken` 登录。

### 4. 添加更多存储桶（可选）

设置 → Storage Buckets → Add Bucket。当一个桶存满时，上传会自动切换到下一个可用桶。

### 5. 部署到服务器

```bash
# 交叉编译 Linux 版本
cd server
GOOS=linux GOARCH=amd64 go build -o filestore .

# 上传到服务器
scp filestore config.json user@server:/opt/st-cloud/server/
scp -r ../out user@server:/opt/st-cloud/

# 设置 systemd 服务（开机自启）
# 参考上方 Systemd service 配置
```

### Cloudflare 部署建议

如果使用 Cloudflare 代理（橙云）：
1. SSL/TLS 设为 **灵活（Flexible）**
2. 规则 → Origin Rules → 创建规则：主机名 = 你的域名 → 目标端口重写为 `9090`

### 指纹/Face ID 登录

需要 HTTPS + 有效证书 + 域名（不支持 IP 地址），在 config.json 中设置：

```json
{
  "rpID": "你的域名.com",
  "rpOrigin": "https://你的域名.com"
}
```

## License

MIT
