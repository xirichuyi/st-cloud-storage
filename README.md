# ST Cloud Storage

一个基于 Cloudflare R2 的自托管个人云存储方案，使用 Go + Next.js 构建。

[English](./README_EN.md)

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

## 技术栈

- **后端**：Go（纯标准库，无框架）
- **前端**：Next.js 15 + React 19 + Tailwind CSS + shadcn/ui
- **存储**：Cloudflare R2（S3 兼容）
- **数据库**：SQLite（modernc.org/sqlite，纯 Go 实现）
- **认证**：WebAuthn + Token 会话

## 快速开始

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
cp config.example.json config.json
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

## 部署指南

### 编译 Linux 版本

```bash
cd server
GOOS=linux GOARCH=amd64 go build -o filestore .
```

### Systemd 服务（开机自启）

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

```bash
sudo cp filestore.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable filestore
sudo systemctl start filestore
```

### Nginx 反向代理

```nginx
server {
    listen 80;
    server_name 你的域名.com;
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

### Cloudflare 部署

如果使用 Cloudflare 代理（橙云）：
1. SSL/TLS 加密模式设为 **灵活（Flexible）**
2. 规则 → Origin Rules → 创建规则：主机名 = 你的域名 → 目标端口重写为 `9090`

### 指纹/Face ID 登录

需要 HTTPS + 有效证书 + 域名（不支持 IP 地址），在 config.json 中设置：

```json
{
  "rpID": "你的域名.com",
  "rpOrigin": "https://你的域名.com"
}
```

## 存储架构

```
用户 → Go 后端 → Cloudflare R2（S3 API）
              → SQLite（元数据、文件夹、分享、认证）
```

- 文件存储在 R2 中，路径格式：`uploads/年/月/日/时间戳_文件名`
- 文件夹结构仅存在于 SQLite 数据库中，R2 只存文件
- 移动/重命名文件只更新数据库，不操作 R2
- 多 Bucket：当一个桶存满时，上传自动切换到下一个

## 接口列表

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | /api/auth/login | 否 | 登录 |
| GET | /api/auth/check | 否 | 检查登录状态 |
| POST | /api/upload | 是 | 上传文件 |
| GET | /api/files | 是 | 获取文件/文件夹列表 |
| POST | /api/folders | 是 | 创建文件夹 |
| DELETE | /api/files/:id | 是 | 删除文件 |
| DELETE | /api/folders/:id | 是 | 删除文件夹（递归） |
| PUT | /api/files/:id/rename | 是 | 重命名文件 |
| PUT | /api/files/:id/move | 是 | 移动文件 |
| GET | /api/search?q= | 是 | 搜索 |
| GET | /api/stats | 是 | 存储统计 |
| GET | /api/folders/:id/download | 是 | 下载文件夹（ZIP） |
| POST | /api/shares | 是 | 创建分享链接 |
| GET | /s/:id | 否 | 访问分享 |
| GET | /api/settings/buckets | 是 | 存储桶列表 |
| POST | /api/settings/buckets | 是 | 添加存储桶 |

## 开源协议

MIT  https://linux.do/
