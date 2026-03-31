package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"crypto/subtle"
	"encoding/hex"
	"html"
	"encoding/json"
	"archive/zip"
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// ---------- Models ----------

type FileRecord struct {
	ID           int64  `json:"id"`
	OriginalName string `json:"originalName"`
	FileName     string `json:"fileName"`
	URL          string `json:"url"`
	Size         int64  `json:"size"`
	ParentID     *int64 `json:"parentId"`
	MimeType     string `json:"mimeType"`
	CreatedAt    string `json:"createdAt"`
}

type FolderRecord struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	ParentID  *int64 `json:"parentId"`
	CreatedAt string `json:"createdAt"`
}

type BreadcrumbItem struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type StatsResponse struct {
	TotalFiles   int            `json:"totalFiles"`
	TotalFolders int            `json:"totalFolders"`
	TotalSize    int64          `json:"totalSize"`
	Categories   map[string]int `json:"categories,omitempty"`
}

type ListResponse struct {
	Files   []FileRecord   `json:"files"`
	Folders []FolderRecord `json:"folders"`
}

// ---------- Auth Models ----------

type R2Config struct {
	AccountID      string `json:"accountId"`
	AccessKeyID    string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	BucketName     string `json:"bucketName"`
	Endpoint       string `json:"endpoint"`
}

type AppConfig struct {
	MasterToken   string   `json:"masterToken"`
	SessionSecret string   `json:"sessionSecret"`
	R2            R2Config `json:"r2"`
}

// ---------- Globals ----------

var db *sql.DB
var appConfig AppConfig

// ---------- Base64URL helpers ----------

func base64URLEncode(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

func base64URLDecode(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(s)
}

// ---------- WebAuthn helpers ----------

func generateRandomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

func getRPID(r *http.Request) string {
	host := r.Host
	// Strip port
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return host
}

func isIPAddress(host string) bool {
	return net.ParseIP(host) != nil
}

// ---------- Config loading ----------

func loadConfig() {
	configPath := filepath.Join(".", "config.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		log.Printf("Warning: could not read config.json: %v (using defaults)", err)
		appConfig = AppConfig{
			MasterToken:   "filestore2026",
			SessionSecret: "default-secret",
		}
		return
	}
	if err := json.Unmarshal(data, &appConfig); err != nil {
		log.Fatal("Failed to parse config.json:", err)
	}
}

// ---------- Random helpers ----------

func generateRandomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func parseFlexibleTime(s string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02T15:04:05Z"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("cannot parse time: %s", s)
}

func generateShortToken(length int) (string, error) {
	const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, length)
	randomBytes := make([]byte, length)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", err
	}
	for i := range b {
		b[i] = charset[int(randomBytes[i])%len(charset)]
	}
	return string(b), nil
}

// ---------- DB init ----------

func initDB() {
	var err error
	db, err = sql.Open("sqlite", "./filestore.db")
	if err != nil {
		log.Fatal("Failed to open database:", err)
	}

	// Enable WAL mode and foreign keys
	db.Exec("PRAGMA journal_mode=WAL")
	db.Exec("PRAGMA foreign_keys=ON")

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS folders (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			parent_id INTEGER,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (parent_id) REFERENCES folders(id)
		)
	`)
	if err != nil {
		log.Fatal("Failed to create folders table:", err)
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS files (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			original_name TEXT NOT NULL,
			file_name TEXT NOT NULL,
			url TEXT NOT NULL,
			size INTEGER NOT NULL,
			parent_id INTEGER,
			mime_type TEXT NOT NULL DEFAULT '',
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (parent_id) REFERENCES folders(id)
		)
	`)
	if err != nil {
		log.Fatal("Failed to create files table:", err)
	}

	// Migration: add columns if upgrading from old schema
	db.Exec("ALTER TABLE files ADD COLUMN parent_id INTEGER")
	db.Exec("ALTER TABLE files ADD COLUMN mime_type TEXT NOT NULL DEFAULT ''")

	// Indexes
	db.Exec("CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_id)")
	db.Exec("CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id)")

	// Auth tables
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS credentials (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL DEFAULT 'Fingerprint',
			credential_id TEXT NOT NULL UNIQUE,
			public_key BLOB,
			sign_count INTEGER NOT NULL DEFAULT 0,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`)
	if err != nil {
		log.Fatal("Failed to create credentials table:", err)
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS challenges (
			id TEXT PRIMARY KEY,
			challenge TEXT NOT NULL,
			type TEXT NOT NULL,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`)
	if err != nil {
		log.Fatal("Failed to create challenges table:", err)
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			token TEXT PRIMARY KEY,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			expires_at DATETIME NOT NULL
		)
	`)
	if err != nil {
		log.Fatal("Failed to create sessions table:", err)
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS temp_tokens (
			token TEXT PRIMARY KEY,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			expires_at DATETIME NOT NULL
		)
	`)
	if err != nil {
		log.Fatal("Failed to create temp_tokens table:", err)
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS shares (
			id TEXT PRIMARY KEY,
			file_id INTEGER,
			folder_id INTEGER,
			code TEXT DEFAULT '',
			expires_at TEXT DEFAULT '',
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (file_id) REFERENCES files(id),
			FOREIGN KEY (folder_id) REFERENCES folders(id)
		)
	`)
	if err != nil {
		log.Fatal("Failed to create shares table:", err)
	}

	// Migration: add folder_id column if upgrading from old schema
	db.Exec("ALTER TABLE shares ADD COLUMN folder_id INTEGER")

	// Migration: recreate shares table if file_id has NOT NULL constraint (old schema)
	// Check by trying to insert a test row with NULL file_id
	_, testErr := db.Exec("INSERT INTO shares (id, file_id, folder_id, code, expires_at, enabled) VALUES ('__test_null__', NULL, NULL, '', '', 0)")
	if testErr != nil && strings.Contains(testErr.Error(), "NOT NULL") {
		// Need to migrate: recreate table without NOT NULL on file_id
		db.Exec("ALTER TABLE shares RENAME TO shares_old")
		db.Exec(`CREATE TABLE shares (
			id TEXT PRIMARY KEY,
			file_id INTEGER,
			folder_id INTEGER,
			code TEXT DEFAULT '',
			expires_at TEXT DEFAULT '',
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (file_id) REFERENCES files(id),
			FOREIGN KEY (folder_id) REFERENCES folders(id)
		)`)
		db.Exec("INSERT INTO shares (id, file_id, folder_id, code, expires_at, enabled, created_at) SELECT id, file_id, folder_id, code, expires_at, enabled, created_at FROM shares_old")
		db.Exec("DROP TABLE shares_old")
		log.Println("Migrated shares table: removed NOT NULL constraint on file_id")
	} else {
		// Clean up test row
		db.Exec("DELETE FROM shares WHERE id = '__test_null__'")
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS r2_buckets (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			account_id TEXT NOT NULL,
			access_key_id TEXT NOT NULL,
			secret_access_key TEXT NOT NULL,
			bucket_name TEXT NOT NULL,
			endpoint TEXT NOT NULL,
			max_size INTEGER NOT NULL DEFAULT 10737418240,
			current_size INTEGER NOT NULL DEFAULT 0,
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`)
	if err != nil {
		log.Fatal("Failed to create r2_buckets table:", err)
	}

	// Migration: add bucket_id column to files if not present
	db.Exec("ALTER TABLE files ADD COLUMN bucket_id INTEGER")
	db.Exec("ALTER TABLE r2_buckets ADD COLUMN api_token TEXT NOT NULL DEFAULT ''")
}

// ---------- Cleanup expired records ----------

func cleanupExpired() {
	// Use RFC3339 consistently — matches how sessions and temp_tokens are stored
	now := time.Now().UTC().Format(time.RFC3339)
	db.Exec("DELETE FROM sessions WHERE expires_at < ?", now)
	db.Exec("DELETE FROM temp_tokens WHERE expires_at < ?", now)
	fiveMinAgo := time.Now().UTC().Add(-5 * time.Minute).Format(time.RFC3339)
	db.Exec("DELETE FROM challenges WHERE created_at < ?", fiveMinAgo)
}

// ---------- Session helpers ----------

func createSession() (string, error) {
	token, err := generateRandomHex(32)
	if err != nil {
		return "", err
	}
	now := time.Now().UTC()
	expiresAt := now.Add(7 * 24 * time.Hour)
	_, err = db.Exec("INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)",
		token, now.Format(time.RFC3339), expiresAt.Format(time.RFC3339))
	if err != nil {
		return "", err
	}
	return token, nil
}

func validateSession(r *http.Request) bool {
	token := extractToken(r)
	if token == "" {
		return false
	}
	var expiresAt string
	err := db.QueryRow("SELECT expires_at FROM sessions WHERE token = ?", token).Scan(&expiresAt)
	if err != nil {
		return false
	}
	t, parseErr := parseFlexibleTime(expiresAt)
	if parseErr != nil {
		log.Printf("validateSession: parse error: %v", parseErr)
		return false
	}
	return time.Now().UTC().Before(t)
}

func extractToken(r *http.Request) string {
	// Check Authorization header first
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	// Check session cookie
	cookie, err := r.Cookie("session")
	if err == nil {
		return cookie.Value
	}
	return ""
}

func setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   7 * 24 * 60 * 60,
	})
}

// ---------- Helpers ----------

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func jsonOK(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func detectMimeType(filename string) string {
	ext := filepath.Ext(filename)
	if ext == "" {
		return "application/octet-stream"
	}
	mt := mime.TypeByExtension(ext)
	if mt == "" {
		return "application/octet-stream"
	}
	return mt
}

// ---------- R2 Bucket Management ----------

func migrateConfigR2ToDB() {
	var count int
	err := db.QueryRow("SELECT COUNT(*) FROM r2_buckets").Scan(&count)
	if err != nil || count > 0 {
		return // already has buckets or table issue
	}
	cfg := appConfig.R2
	if cfg.Endpoint == "" || cfg.AccessKeyID == "" {
		return // no R2 config to migrate
	}
	_, err = db.Exec(`INSERT INTO r2_buckets (name, account_id, access_key_id, secret_access_key, bucket_name, endpoint, max_size, current_size, enabled)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)`,
		"Default", cfg.AccountID, cfg.AccessKeyID, cfg.SecretAccessKey, cfg.BucketName, cfg.Endpoint, int64(10737418240))
	if err != nil {
		log.Printf("Warning: failed to migrate R2 config to DB: %v", err)
		return
	}
	// Set bucket_id=1 for all existing files that have R2 URLs
	db.Exec("UPDATE files SET bucket_id = 1 WHERE url LIKE '/api/r2/%' AND bucket_id IS NULL")
	log.Println("Migrated R2 config from config.json to r2_buckets table")
}

func getActiveBucket() (*R2Config, int64, error) {
	return getActiveBucketForSize(0)
}

func getActiveBucketForSize(requiredSize int64) (*R2Config, int64, error) {
	rows, err := db.Query("SELECT id, account_id, access_key_id, secret_access_key, bucket_name, endpoint, max_size, current_size FROM r2_buckets WHERE enabled = 1 ORDER BY id ASC")
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query buckets: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var id, maxSize, currentSize int64
		var cfg R2Config
		err := rows.Scan(&id, &cfg.AccountID, &cfg.AccessKeyID, &cfg.SecretAccessKey, &cfg.BucketName, &cfg.Endpoint, &maxSize, &currentSize)
		if err != nil {
			continue
		}
		if requiredSize > 0 {
			if currentSize+requiredSize <= maxSize {
				return &cfg, id, nil
			}
		} else {
			if currentSize < maxSize {
				return &cfg, id, nil
			}
		}
	}
	return nil, 0, fmt.Errorf("no storage space available")
}

func getBucketConfig(bucketID int64) (*R2Config, error) {
	var cfg R2Config
	err := db.QueryRow("SELECT account_id, access_key_id, secret_access_key, bucket_name, endpoint FROM r2_buckets WHERE id = ?", bucketID).
		Scan(&cfg.AccountID, &cfg.AccessKeyID, &cfg.SecretAccessKey, &cfg.BucketName, &cfg.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("bucket not found: %w", err)
	}
	return &cfg, nil
}

// ---------- R2 / S3 helpers (AWS Signature V4, pure stdlib) ----------

func hmacSHA256(key []byte, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func sha256Hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func signingKey(secretKey, dateStamp, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secretKey), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	kSigning := hmacSHA256(kService, []byte("aws4_request"))
	return kSigning
}

// signedS3Request creates a signed AWS Signature V4 request for S3-compatible APIs.
func signedS3Request(method, objectKey string, body []byte, contentType string) (*http.Request, error) {
	return signedS3RequestWithConfig(appConfig.R2, method, objectKey, body, contentType)
}

func signedS3RequestWithConfig(cfg R2Config, method, objectKey string, body []byte, contentType string) (*http.Request, error) {

	// Build URL: endpoint/bucketName/objectKey (URL-encode each path segment)
	encodedKey := ""
	for i, seg := range strings.Split(objectKey, "/") {
		if i > 0 {
			encodedKey += "/"
		}
		encodedKey += url.PathEscape(seg)
	}
	urlStr := fmt.Sprintf("%s/%s/%s", strings.TrimRight(cfg.Endpoint, "/"), cfg.BucketName, encodedKey)

	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	region := "auto"
	service := "s3"

	// Payload hash — for GET/DELETE with no body, hash the empty string
	if body == nil {
		body = []byte{}
	}
	payloadHash := sha256Hex(body)

	req, err := http.NewRequest(method, urlStr, nil)
	if err != nil {
		return nil, err
	}

	// Set body for PUT
	if len(body) > 0 {
		req.Body = io.NopCloser(strings.NewReader(string(body)))
		req.ContentLength = int64(len(body))
	}

	// Required headers
	host := req.URL.Host
	req.Header.Set("Host", host)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}

	// Build canonical headers and signed headers (must be sorted)
	signedHeaderKeys := []string{"host", "x-amz-content-sha256", "x-amz-date"}
	if contentType != "" {
		signedHeaderKeys = append(signedHeaderKeys, "content-type")
	}
	sort.Strings(signedHeaderKeys)

	var canonicalHeaders strings.Builder
	for _, k := range signedHeaderKeys {
		switch k {
		case "host":
			canonicalHeaders.WriteString("host:" + host + "\n")
		case "x-amz-content-sha256":
			canonicalHeaders.WriteString("x-amz-content-sha256:" + payloadHash + "\n")
		case "x-amz-date":
			canonicalHeaders.WriteString("x-amz-date:" + amzDate + "\n")
		case "content-type":
			canonicalHeaders.WriteString("content-type:" + contentType + "\n")
		}
	}
	signedHeaders := strings.Join(signedHeaderKeys, ";")

	// Canonical URI — must match the URL-encoded path used in the actual request
	canonicalURI := "/" + cfg.BucketName + "/" + encodedKey

	// Canonical request
	canonicalRequest := strings.Join([]string{
		method,
		canonicalURI,
		"", // no query string
		canonicalHeaders.String(),
		signedHeaders,
		payloadHash,
	}, "\n")

	// Credential scope
	credentialScope := dateStamp + "/" + region + "/" + service + "/aws4_request"

	// String to sign
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		sha256Hex([]byte(canonicalRequest)),
	}, "\n")

	// Signing key and signature
	sKey := signingKey(cfg.SecretAccessKey, dateStamp, region, service)
	signature := hex.EncodeToString(hmacSHA256(sKey, []byte(stringToSign)))

	// Authorization header
	authHeader := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		cfg.AccessKeyID, credentialScope, signedHeaders, signature)
	req.Header.Set("Authorization", authHeader)

	return req, nil
}

func uploadToR2(fileBytes []byte, key string, contentType string) (string, error) {
	return uploadToR2WithConfig(appConfig.R2, fileBytes, key, contentType)
}

func uploadToR2WithConfig(cfg R2Config, fileBytes []byte, key string, contentType string) (string, error) {
	req, err := signedS3RequestWithConfig(cfg, "PUT", key, fileBytes, contentType)
	if err != nil {
		return "", fmt.Errorf("R2 sign request: %w", err)
	}

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("R2 upload request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("R2 upload failed (HTTP %d): %s", resp.StatusCode, string(respBody))
	}

	return "/api/r2/" + key, nil
}

func deleteFromR2(key string) error {
	return deleteFromR2WithConfig(appConfig.R2, key)
}

func deleteFromR2WithConfig(cfg R2Config, key string) error {
	req, err := signedS3RequestWithConfig(cfg, "DELETE", key, nil, "")
	if err != nil {
		return fmt.Errorf("R2 sign delete request: %w", err)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("R2 delete request: %w", err)
	}
	defer resp.Body.Close()

	// S3 DELETE returns 204 on success (or 200)
	if resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("R2 delete failed (HTTP %d): %s", resp.StatusCode, string(respBody))
	}

	return nil
}

func handleR2Serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Support two URL patterns:
	// Old: /api/r2/uploads/... (uses default/first bucket or global config)
	// New: /api/r2/b/{bucketId}/uploads/... (uses specific bucket)
	fullPath := strings.TrimPrefix(r.URL.Path, "/api/r2/")
	if fullPath == "" {
		jsonError(w, "Missing file key", http.StatusBadRequest)
		return
	}

	var cfg R2Config
	var key string

	if strings.HasPrefix(fullPath, "b/") {
		// New format: b/{bucketId}/uploads/...
		rest := strings.TrimPrefix(fullPath, "b/")
		slashIdx := strings.Index(rest, "/")
		if slashIdx < 0 {
			jsonError(w, "Invalid bucket URL", http.StatusBadRequest)
			return
		}
		bucketIDStr := rest[:slashIdx]
		key = rest[slashIdx+1:]
		bucketID, err := strconv.ParseInt(bucketIDStr, 10, 64)
		if err != nil {
			jsonError(w, "Invalid bucket ID", http.StatusBadRequest)
			return
		}
		bucketCfg, err := getBucketConfig(bucketID)
		if err != nil {
			jsonError(w, "Bucket not found", http.StatusNotFound)
			return
		}
		cfg = *bucketCfg
	} else {
		// Old format: uploads/... (use global config)
		key = fullPath
		cfg = appConfig.R2
	}

	// Use empty body hash for GET
	req, err := signedS3RequestWithConfig(cfg, "GET", key, nil, "")
	if err != nil {
		jsonError(w, "Failed to sign R2 request: "+err.Error(), http.StatusInternalServerError)
		return
	}

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		jsonError(w, "Failed to fetch from R2: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		jsonError(w, "File not found", http.StatusNotFound)
		return
	}
	if resp.StatusCode >= 300 {
		jsonError(w, fmt.Sprintf("R2 returned HTTP %d", resp.StatusCode), http.StatusBadGateway)
		return
	}

	// Forward Content-Type from R2 response
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	// Cache for 1 hour — reduces R2 re-fetches on repeated views
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if etag := resp.Header.Get("ETag"); etag != "" {
		w.Header().Set("ETag", etag)
	}

	// Extract filename from key for Content-Disposition
	parts := strings.Split(key, "/")
	fileName := parts[len(parts)-1]
	// Remove the timestamp prefix (e.g., "1711234567_filename.pdf" -> "filename.pdf")
	if idx := strings.Index(fileName, "_"); idx > 0 {
		fileName = fileName[idx+1:]
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=\"%s\"", fileName))

	// Stream the response body
	io.Copy(w, resp.Body)
}

func parseOptionalID(s string) *int64 {
	if s == "" || s == "null" || s == "undefined" {
		return nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return nil
	}
	return &v
}

func parseIDFromPath(path, prefix, suffix string) (int64, bool) {
	s := strings.TrimPrefix(path, prefix)
	s = strings.TrimSuffix(s, suffix)
	id, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, false
	}
	return id, true
}

// deleteR2ByURL deletes an R2 object given a file URL and optional bucket_id.
func deleteR2ByURL(fileURL string, bucketID sql.NullInt64, fileSize int64) {
	if !strings.HasPrefix(fileURL, "/api/r2/") {
		return
	}
	var r2Key string
	var delCfg R2Config

	if strings.HasPrefix(fileURL, "/api/r2/b/") {
		rest := strings.TrimPrefix(fileURL, "/api/r2/b/")
		if slashIdx := strings.Index(rest, "/"); slashIdx > 0 {
			bidStr := rest[:slashIdx]
			r2Key = rest[slashIdx+1:]
			bid, _ := strconv.ParseInt(bidStr, 10, 64)
			if bcfg, err := getBucketConfig(bid); err == nil {
				delCfg = *bcfg
				// Update size
				db.Exec("UPDATE r2_buckets SET current_size = CASE WHEN current_size > ? THEN current_size - ? ELSE 0 END WHERE id = ?", fileSize, fileSize, bid)
			} else {
				delCfg = appConfig.R2
			}
		}
	} else {
		r2Key = strings.TrimPrefix(fileURL, "/api/r2/")
		if bucketID.Valid {
			if bcfg, err := getBucketConfig(bucketID.Int64); err == nil {
				delCfg = *bcfg
				db.Exec("UPDATE r2_buckets SET current_size = CASE WHEN current_size > ? THEN current_size - ? ELSE 0 END WHERE id = ?", fileSize, fileSize, bucketID.Int64)
			} else {
				delCfg = appConfig.R2
			}
		} else {
			delCfg = appConfig.R2
		}
	}

	if r2Key != "" {
		if err := deleteFromR2WithConfig(delCfg, r2Key); err != nil {
			log.Printf("Warning: failed to delete R2 object (key=%s): %v", r2Key, err)
		}
	}
}

// Recursively delete a folder and all its contents.
func deleteFolderRecursive(folderID int64) error {
	// First, delete R2 objects for files in this folder
	fileRows, ferr := db.Query("SELECT url, size, bucket_id FROM files WHERE parent_id = ?", folderID)
	if ferr == nil {
		for fileRows.Next() {
			var fileURL string
			var fileSize int64
			var bucketID sql.NullInt64
			fileRows.Scan(&fileURL, &fileSize, &bucketID)
			deleteR2ByURL(fileURL, bucketID, fileSize)
		}
		fileRows.Close()
	}

	// Delete shares for files in this folder
	db.Exec("DELETE FROM shares WHERE file_id IN (SELECT id FROM files WHERE parent_id = ?)", folderID)

	// Delete file records from DB
	_, err := db.Exec("DELETE FROM files WHERE parent_id = ?", folderID)
	if err != nil {
		return err
	}

	// Find child folders
	rows, err := db.Query("SELECT id FROM folders WHERE parent_id = ?", folderID)
	if err != nil {
		return err
	}
	var childIDs []int64
	for rows.Next() {
		var cid int64
		rows.Scan(&cid)
		childIDs = append(childIDs, cid)
	}
	rows.Close()

	for _, cid := range childIDs {
		if err := deleteFolderRecursive(cid); err != nil {
			return err
		}
	}

	// Delete the folder itself
	_, err = db.Exec("DELETE FROM folders WHERE id = ?", folderID)
	return err
}

// ---------- Auth Handlers ----------

func handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	valid := false
	isTempToken := false

	// Check master token
	if body.Token == appConfig.MasterToken {
		valid = true
	}

	// Check temp_tokens table
	if !valid {
		var expiresAt string
		err := db.QueryRow("SELECT expires_at FROM temp_tokens WHERE token = ?", body.Token).Scan(&expiresAt)
		if err == nil {
			t, _ := parseFlexibleTime(expiresAt)
			if !t.IsZero() && time.Now().UTC().Before(t) {
				valid = true
				isTempToken = true
			}
		}
	}

	if !valid {
		jsonError(w, "Invalid token", http.StatusUnauthorized)
		return
	}

	// Delete used temp token
	if isTempToken {
		db.Exec("DELETE FROM temp_tokens WHERE token = ?", body.Token)
	}

	sessionToken, err := createSession()
	if err != nil {
		jsonError(w, "Failed to create session", http.StatusInternalServerError)
		return
	}

	setSessionCookie(w, sessionToken)
	jsonOK(w, map[string]string{"sessionToken": sessionToken})
}

func handleAuthCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	authenticated := validateSession(r)
	jsonOK(w, map[string]bool{"authenticated": authenticated})
}

func handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	token := extractToken(r)
	if token != "" {
		db.Exec("DELETE FROM sessions WHERE token = ?", token)
	}

	// Clear the cookie
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})

	jsonOK(w, map[string]string{"message": "logged out"})
}

func handleRegisterStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !validateSession(r) {
		jsonError(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	challengeBytes, err := generateRandomBytes(32)
	if err != nil {
		jsonError(w, "Failed to generate challenge", http.StatusInternalServerError)
		return
	}
	challenge := base64URLEncode(challengeBytes)

	challengeID, err := generateRandomHex(16)
	if err != nil {
		jsonError(w, "Failed to generate challenge ID", http.StatusInternalServerError)
		return
	}

	_, err = db.Exec("INSERT INTO challenges (id, challenge, type, created_at) VALUES (?, ?, ?, ?)",
		challengeID, challenge, "webauthn.create", time.Now().Format(time.RFC3339))
	if err != nil {
		jsonError(w, "Failed to store challenge", http.StatusInternalServerError)
		return
	}

	rpHost := getRPID(r)

	rp := map[string]interface{}{
		"name": "ST",
	}
	if !isIPAddress(rpHost) {
		rp["id"] = rpHost
	}

	options := map[string]interface{}{
		"challengeId": challengeID,
		"publicKey": map[string]interface{}{
			"challenge": challenge,
			"rp":        rp,
			"user": map[string]interface{}{
				"id":          base64URLEncode([]byte("filestore-user")),
				"name":        "ST User",
				"displayName": "ST User",
			},
			"pubKeyCredParams": []map[string]interface{}{
				{"type": "public-key", "alg": -7},
				{"type": "public-key", "alg": -257},
			},
			"authenticatorSelection": map[string]interface{}{
				"authenticatorAttachment": "platform",
				"userVerification":        "required",
			},
			"timeout":     60000,
			"attestation": "none",
		},
	}

	jsonOK(w, options)
}

func handleRegisterFinish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !validateSession(r) {
		jsonError(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var body struct {
		ChallengeID       string `json:"challengeId"`
		CredentialID      string `json:"credentialId"`
		ClientDataJSON    string `json:"clientDataJSON"`
		AttestationObject string `json:"attestationObject"`
		Name              string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	// Verify challenge
	var storedChallenge, storedType string
	err := db.QueryRow("SELECT challenge, type FROM challenges WHERE id = ?", body.ChallengeID).Scan(&storedChallenge, &storedType)
	if err != nil {
		jsonError(w, "Challenge not found or expired", http.StatusBadRequest)
		return
	}
	db.Exec("DELETE FROM challenges WHERE id = ?", body.ChallengeID)

	if storedType != "webauthn.create" {
		jsonError(w, "Invalid challenge type", http.StatusBadRequest)
		return
	}

	// Decode and verify clientDataJSON
	clientDataBytes, err := base64URLDecode(body.ClientDataJSON)
	if err != nil {
		jsonError(w, "Invalid clientDataJSON encoding", http.StatusBadRequest)
		return
	}

	var clientData struct {
		Type      string `json:"type"`
		Challenge string `json:"challenge"`
	}
	if err := json.Unmarshal(clientDataBytes, &clientData); err != nil {
		jsonError(w, "Invalid clientDataJSON", http.StatusBadRequest)
		return
	}

	if clientData.Type != "webauthn.create" {
		jsonError(w, "Invalid clientData type", http.StatusBadRequest)
		return
	}

	if clientData.Challenge != storedChallenge {
		jsonError(w, "Challenge mismatch", http.StatusBadRequest)
		return
	}

	// Decode attestation object
	attestationBytes, err := base64URLDecode(body.AttestationObject)
	if err != nil {
		jsonError(w, "Invalid attestationObject encoding", http.StatusBadRequest)
		return
	}

	name := body.Name
	if name == "" {
		name = "Fingerprint"
	}

	createdAt := time.Now().Format("2006-01-02 15:04:05")
	result, err := db.Exec("INSERT INTO credentials (name, credential_id, public_key, sign_count, created_at) VALUES (?, ?, ?, ?, ?)",
		name, body.CredentialID, attestationBytes, 0, createdAt)
	if err != nil {
		jsonError(w, "Failed to store credential: "+err.Error(), http.StatusInternalServerError)
		return
	}

	credID, _ := result.LastInsertId()
	jsonOK(w, map[string]interface{}{
		"id":        credID,
		"name":      name,
		"createdAt": createdAt,
	})
}

func handleVerifyStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// No session required — this is the login flow

	challengeBytes, err := generateRandomBytes(32)
	if err != nil {
		jsonError(w, "Failed to generate challenge", http.StatusInternalServerError)
		return
	}
	challenge := base64URLEncode(challengeBytes)

	challengeID, err := generateRandomHex(16)
	if err != nil {
		jsonError(w, "Failed to generate challenge ID", http.StatusInternalServerError)
		return
	}

	_, err = db.Exec("INSERT INTO challenges (id, challenge, type, created_at) VALUES (?, ?, ?, ?)",
		challengeID, challenge, "webauthn.get", time.Now().Format(time.RFC3339))
	if err != nil {
		jsonError(w, "Failed to store challenge", http.StatusInternalServerError)
		return
	}

	// Get all registered credential IDs
	rows, err := db.Query("SELECT credential_id FROM credentials")
	if err != nil {
		jsonError(w, "Failed to query credentials", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var allowCredentials []map[string]interface{}
	for rows.Next() {
		var credID string
		rows.Scan(&credID)
		allowCredentials = append(allowCredentials, map[string]interface{}{
			"type": "public-key",
			"id":   credID,
		})
	}

	if len(allowCredentials) == 0 {
		jsonError(w, "No credentials registered", http.StatusNotFound)
		return
	}

	rpHost := getRPID(r)

	publicKey := map[string]interface{}{
		"challenge":        challenge,
		"allowCredentials": allowCredentials,
		"userVerification": "required",
		"timeout":          60000,
	}
	if !isIPAddress(rpHost) {
		publicKey["rpId"] = rpHost
	}

	jsonOK(w, map[string]interface{}{
		"challengeId": challengeID,
		"publicKey":   publicKey,
	})
}

func handleVerifyFinish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// No session required — this is the login flow

	var body struct {
		ChallengeID    string `json:"challengeId"`
		CredentialID   string `json:"credentialId"`
		ClientDataJSON string `json:"clientDataJSON"`
		AuthenticatorData string `json:"authenticatorData"`
		Signature      string `json:"signature"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	// Verify challenge
	var storedChallenge, storedType string
	err := db.QueryRow("SELECT challenge, type FROM challenges WHERE id = ?", body.ChallengeID).Scan(&storedChallenge, &storedType)
	if err != nil {
		jsonError(w, "Challenge not found or expired", http.StatusBadRequest)
		return
	}
	db.Exec("DELETE FROM challenges WHERE id = ?", body.ChallengeID)

	if storedType != "webauthn.get" {
		jsonError(w, "Invalid challenge type", http.StatusBadRequest)
		return
	}

	// Decode and verify clientDataJSON
	clientDataBytes, err := base64URLDecode(body.ClientDataJSON)
	if err != nil {
		jsonError(w, "Invalid clientDataJSON encoding", http.StatusBadRequest)
		return
	}

	var clientData struct {
		Type      string `json:"type"`
		Challenge string `json:"challenge"`
	}
	if err := json.Unmarshal(clientDataBytes, &clientData); err != nil {
		jsonError(w, "Invalid clientDataJSON", http.StatusBadRequest)
		return
	}

	if clientData.Type != "webauthn.get" {
		jsonError(w, "Invalid clientData type", http.StatusBadRequest)
		return
	}

	if clientData.Challenge != storedChallenge {
		jsonError(w, "Challenge mismatch", http.StatusBadRequest)
		return
	}

	// Verify credential exists
	var credCount int
	err = db.QueryRow("SELECT COUNT(*) FROM credentials WHERE credential_id = ?", body.CredentialID).Scan(&credCount)
	if err != nil || credCount == 0 {
		jsonError(w, "Unknown credential", http.StatusUnauthorized)
		return
	}

	// Create session
	sessionToken, err := createSession()
	if err != nil {
		jsonError(w, "Failed to create session", http.StatusInternalServerError)
		return
	}

	// Generate temp token automatically
	tempToken, err := generateShortToken(6)
	if err != nil {
		setSessionCookie(w, sessionToken)
		jsonOK(w, map[string]interface{}{
			"sessionToken": sessionToken,
		})
		return
	}

	now := time.Now().UTC()
	expiresAt := now.Add(5 * time.Minute)
	db.Exec("INSERT INTO temp_tokens (token, created_at, expires_at) VALUES (?, ?, ?)",
		tempToken, now.Format(time.RFC3339), expiresAt.Format(time.RFC3339))

	setSessionCookie(w, sessionToken)
	jsonOK(w, map[string]interface{}{
		"sessionToken":       sessionToken,
		"tempToken":          tempToken,
		"tempTokenExpiresIn": 300,
	})
}

func handleListCredentials(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !validateSession(r) {
		jsonError(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	rows, err := db.Query("SELECT id, name, created_at FROM credentials ORDER BY created_at DESC")
	if err != nil {
		jsonError(w, "Failed to query credentials", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var creds []map[string]interface{}
	for rows.Next() {
		var id int64
		var name, createdAt string
		rows.Scan(&id, &name, &createdAt)
		creds = append(creds, map[string]interface{}{
			"id":        id,
			"name":      name,
			"createdAt": createdAt,
		})
	}
	if creds == nil {
		creds = []map[string]interface{}{}
	}

	jsonOK(w, creds)
}

func handleDeleteCredential(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !validateSession(r) {
		jsonError(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	id, ok := parseIDFromPath(r.URL.Path, "/api/auth/credentials/", "")
	if !ok {
		jsonError(w, "Invalid credential ID", http.StatusBadRequest)
		return
	}

	result, err := db.Exec("DELETE FROM credentials WHERE id = ?", id)
	if err != nil {
		jsonError(w, "Failed to delete credential", http.StatusInternalServerError)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		jsonError(w, "Credential not found", http.StatusNotFound)
		return
	}

	jsonOK(w, map[string]string{"message": "deleted"})
}

func handleGenerateToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !validateSession(r) {
		jsonError(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	token, err := generateShortToken(6)
	if err != nil {
		jsonError(w, "Failed to generate token", http.StatusInternalServerError)
		return
	}

	now := time.Now().UTC()
	expiresAt := now.Add(5 * time.Minute)
	_, err = db.Exec("INSERT INTO temp_tokens (token, created_at, expires_at) VALUES (?, ?, ?)",
		token, now.Format(time.RFC3339), expiresAt.Format(time.RFC3339))
	if err != nil {
		jsonError(w, "Failed to store token", http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]interface{}{
		"token":     token,
		"expiresIn": 300,
	})
}

// ---------- Existing Handlers ----------

func handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	err := r.ParseMultipartForm(100 << 20)
	if err != nil {
		jsonError(w, "Failed to parse form: "+err.Error(), http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		jsonError(w, "Failed to get file: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	originalName := header.Filename
	fileSize := header.Size
	mimeType := detectMimeType(originalName)

	// Optional folderId
	var parentID *int64
	folderIDStr := r.FormValue("folderId")
	parentID = parseOptionalID(folderIDStr)

	// Check for duplicate filename in same folder
	overwrite := r.FormValue("overwrite") == "true"
	var existingID int64
	var existingURL string
	var duplicateFound bool
	if parentID == nil {
		err = db.QueryRow("SELECT id, url FROM files WHERE original_name = ? AND parent_id IS NULL", originalName).Scan(&existingID, &existingURL)
	} else {
		err = db.QueryRow("SELECT id, url FROM files WHERE original_name = ? AND parent_id = ?", originalName, *parentID).Scan(&existingID, &existingURL)
	}
	if err == nil {
		duplicateFound = true
	}

	if duplicateFound && !overwrite {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":      "File already exists",
			"duplicateId": existingID,
			"fileName":   originalName,
		})
		return
	}

	// If overwriting, delete old file from R2 and DB
	if duplicateFound && overwrite {
		// Look up old file's bucket_id and size for proper cleanup
		var oldSize int64
		var oldBucketID sql.NullInt64
		db.QueryRow("SELECT size, bucket_id FROM files WHERE id = ?", existingID).Scan(&oldSize, &oldBucketID)
		deleteR2ByURL(existingURL, oldBucketID, oldSize)
		db.Exec("DELETE FROM shares WHERE file_id = ?", existingID)
		db.Exec("DELETE FROM files WHERE id = ?", existingID)
	}

	// Read file content
	fileBytes, err := io.ReadAll(file)
	if err != nil {
		jsonError(w, "Failed to read file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Get active bucket from DB — find one with enough space for this file
	bucketCfg, bucketID, bucketErr := getActiveBucketForSize(fileSize)
	if bucketErr != nil {
		// Fallback to global config if no buckets in DB
		if appConfig.R2.Endpoint == "" || appConfig.R2.AccessKeyID == "" {
			jsonError(w, "Not enough storage space", http.StatusInsufficientStorage)
			return
		}
		bucketCfg = &appConfig.R2
		bucketID = 0
	}

	// Generate unique key: uploads/YYYY/MM/DD/timestamp_originalname
	now := time.Now()
	uniqueID := fmt.Sprintf("%d", now.UnixNano()/int64(time.Millisecond))
	// Sanitize original name for use in key (replace spaces with underscores)
	safeName := strings.ReplaceAll(originalName, " ", "_")
	key := fmt.Sprintf("uploads/%s/%s_%s", now.Format("2006/01/02"), uniqueID, safeName)

	r2URL, err := uploadToR2WithConfig(*bucketCfg, fileBytes, key, mimeType)
	if err != nil {
		log.Printf("R2 upload error: %v", err)
		jsonError(w, "Failed to upload file to storage: "+err.Error(), http.StatusBadGateway)
		return
	}

	// Build the URL with bucket ID for new uploads
	var fileURL string
	if bucketID > 0 {
		fileURL = fmt.Sprintf("/api/r2/b/%d/%s", bucketID, key)
	} else {
		fileURL = r2URL
	}

	fileName := originalName

	createdAt := time.Now().Format("2006-01-02 15:04:05")

	var bucketIDParam interface{}
	if bucketID > 0 {
		bucketIDParam = bucketID
	}

	result, err := db.Exec(
		"INSERT INTO files (original_name, file_name, url, size, parent_id, mime_type, created_at, bucket_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		originalName, fileName, fileURL, fileSize, parentID, mimeType, createdAt, bucketIDParam,
	)
	if err != nil {
		jsonError(w, "Failed to save record: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Update bucket current_size
	if bucketID > 0 {
		db.Exec("UPDATE r2_buckets SET current_size = current_size + ? WHERE id = ?", fileSize, bucketID)
	}

	id, _ := result.LastInsertId()

	record := FileRecord{
		ID:           id,
		OriginalName: originalName,
		FileName:     fileName,
		URL:          fileURL,
		Size:         fileSize,
		ParentID:     parentID,
		MimeType:     mimeType,
		CreatedAt:    createdAt,
	}
	jsonOK(w, record)
}

func handleListFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	folderIDStr := r.URL.Query().Get("folderId")

	var files []FileRecord
	var folders []FolderRecord

	// Query files
	var fileRows *sql.Rows
	var err error
	if folderIDStr == "" || folderIDStr == "null" {
		fileRows, err = db.Query("SELECT id, original_name, file_name, url, size, parent_id, mime_type, created_at FROM files WHERE parent_id IS NULL ORDER BY created_at DESC")
	} else {
		fileRows, err = db.Query("SELECT id, original_name, file_name, url, size, parent_id, mime_type, created_at FROM files WHERE parent_id = ? ORDER BY created_at DESC", folderIDStr)
	}
	if err != nil {
		jsonError(w, "Failed to query files: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer fileRows.Close()

	for fileRows.Next() {
		var rec FileRecord
		var pid sql.NullInt64
		err := fileRows.Scan(&rec.ID, &rec.OriginalName, &rec.FileName, &rec.URL, &rec.Size, &pid, &rec.MimeType, &rec.CreatedAt)
		if err != nil {
			jsonError(w, "Failed to scan file row: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if pid.Valid {
			rec.ParentID = &pid.Int64
		}
		files = append(files, rec)
	}

	// Query folders
	var folderRows *sql.Rows
	if folderIDStr == "" || folderIDStr == "null" {
		folderRows, err = db.Query("SELECT id, name, parent_id, created_at FROM folders WHERE parent_id IS NULL ORDER BY name ASC")
	} else {
		folderRows, err = db.Query("SELECT id, name, parent_id, created_at FROM folders WHERE parent_id = ? ORDER BY name ASC", folderIDStr)
	}
	if err != nil {
		jsonError(w, "Failed to query folders: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer folderRows.Close()

	for folderRows.Next() {
		var rec FolderRecord
		var pid sql.NullInt64
		err := folderRows.Scan(&rec.ID, &rec.Name, &pid, &rec.CreatedAt)
		if err != nil {
			jsonError(w, "Failed to scan folder row: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if pid.Valid {
			rec.ParentID = &pid.Int64
		}
		folders = append(folders, rec)
	}

	if files == nil {
		files = []FileRecord{}
	}
	if folders == nil {
		folders = []FolderRecord{}
	}

	jsonOK(w, ListResponse{Files: files, Folders: folders})
}

func handleDeleteFile(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDFromPath(r.URL.Path, "/api/files/", "")
	if !ok {
		jsonError(w, "Invalid file ID", http.StatusBadRequest)
		return
	}

	// Fetch the URL, size, and bucket_id before deleting so we can remove from R2
	var fileURL string
	var fileSize int64
	var bucketID sql.NullInt64
	err := db.QueryRow("SELECT url, size, bucket_id FROM files WHERE id = ?", id).Scan(&fileURL, &fileSize, &bucketID)
	if err != nil {
		jsonError(w, "File not found", http.StatusNotFound)
		return
	}

	// Delete shares first
	db.Exec("DELETE FROM shares WHERE file_id = ?", id)

	result, err := db.Exec("DELETE FROM files WHERE id = ?", id)
	if err != nil {
		jsonError(w, "Failed to delete file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		jsonError(w, "File not found", http.StatusNotFound)
		return
	}

	// Delete from R2 and update bucket size
	deleteR2ByURL(fileURL, bucketID, fileSize)

	jsonOK(w, map[string]string{"message": "deleted"})
}

func handleMoveFile(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDFromPath(r.URL.Path, "/api/files/", "/move")
	if !ok {
		jsonError(w, "Invalid file ID", http.StatusBadRequest)
		return
	}

	var body struct {
		FolderID *int64 `json:"folderId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	result, err := db.Exec("UPDATE files SET parent_id = ? WHERE id = ?", body.FolderID, id)
	if err != nil {
		jsonError(w, "Failed to move file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		jsonError(w, "File not found", http.StatusNotFound)
		return
	}
	jsonOK(w, map[string]string{"message": "moved"})
}

func handleRenameFile(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDFromPath(r.URL.Path, "/api/files/", "/rename")
	if !ok {
		jsonError(w, "Invalid file ID", http.StatusBadRequest)
		return
	}

	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		jsonError(w, "Invalid JSON body or empty name", http.StatusBadRequest)
		return
	}

	result, err := db.Exec("UPDATE files SET original_name = ? WHERE id = ?", body.Name, id)
	if err != nil {
		jsonError(w, "Failed to rename file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		jsonError(w, "File not found", http.StatusNotFound)
		return
	}
	jsonOK(w, map[string]string{"message": "renamed"})
}

func handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		Name     string `json:"name"`
		ParentID *int64 `json:"parentId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		jsonError(w, "Invalid JSON body or empty name", http.StatusBadRequest)
		return
	}

	createdAt := time.Now().Format("2006-01-02 15:04:05")
	result, err := db.Exec("INSERT INTO folders (name, parent_id, created_at) VALUES (?, ?, ?)", body.Name, body.ParentID, createdAt)
	if err != nil {
		jsonError(w, "Failed to create folder: "+err.Error(), http.StatusInternalServerError)
		return
	}

	id, _ := result.LastInsertId()
	jsonOK(w, FolderRecord{
		ID:        id,
		Name:      body.Name,
		ParentID:  body.ParentID,
		CreatedAt: createdAt,
	})
}

func handleDeleteFolder(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDFromPath(r.URL.Path, "/api/folders/", "")
	if !ok {
		jsonError(w, "Invalid folder ID", http.StatusBadRequest)
		return
	}

	// Check folder exists
	var exists int
	err := db.QueryRow("SELECT COUNT(*) FROM folders WHERE id = ?", id).Scan(&exists)
	if err != nil || exists == 0 {
		jsonError(w, "Folder not found", http.StatusNotFound)
		return
	}

	if err := deleteFolderRecursive(id); err != nil {
		jsonError(w, "Failed to delete folder: "+err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]string{"message": "deleted"})
}

func handleMoveFolder(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDFromPath(r.URL.Path, "/api/folders/", "/move")
	if !ok {
		jsonError(w, "Invalid folder ID", http.StatusBadRequest)
		return
	}

	var body struct {
		ParentID *int64 `json:"parentId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	// Prevent moving folder into itself
	if body.ParentID != nil && *body.ParentID == id {
		jsonError(w, "Cannot move folder into itself", http.StatusBadRequest)
		return
	}

	result, err := db.Exec("UPDATE folders SET parent_id = ? WHERE id = ?", body.ParentID, id)
	if err != nil {
		jsonError(w, "Failed to move folder: "+err.Error(), http.StatusInternalServerError)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		jsonError(w, "Folder not found", http.StatusNotFound)
		return
	}
	jsonOK(w, map[string]string{"message": "moved"})
}

func handleRenameFolder(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDFromPath(r.URL.Path, "/api/folders/", "/rename")
	if !ok {
		jsonError(w, "Invalid folder ID", http.StatusBadRequest)
		return
	}

	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		jsonError(w, "Invalid JSON body or empty name", http.StatusBadRequest)
		return
	}

	result, err := db.Exec("UPDATE folders SET name = ? WHERE id = ?", body.Name, id)
	if err != nil {
		jsonError(w, "Failed to rename folder: "+err.Error(), http.StatusInternalServerError)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		jsonError(w, "Folder not found", http.StatusNotFound)
		return
	}
	jsonOK(w, map[string]string{"message": "renamed"})
}

func handleBreadcrumb(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	id, ok := parseIDFromPath(r.URL.Path, "/api/folders/", "/breadcrumb")
	if !ok {
		jsonError(w, "Invalid folder ID", http.StatusBadRequest)
		return
	}

	var crumbs []BreadcrumbItem
	currentID := id

	for {
		var name string
		var parentID sql.NullInt64
		err := db.QueryRow("SELECT name, parent_id FROM folders WHERE id = ?", currentID).Scan(&name, &parentID)
		if err != nil {
			break
		}
		crumbs = append([]BreadcrumbItem{{ID: currentID, Name: name}}, crumbs...)
		if !parentID.Valid {
			break
		}
		currentID = parentID.Int64
	}

	if crumbs == nil {
		crumbs = []BreadcrumbItem{}
	}
	jsonOK(w, crumbs)
}

func handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	q := r.URL.Query().Get("q")

	var rows *sql.Rows
	var err error
	if q == "" || q == "*" {
		rows, err = db.Query("SELECT id, original_name, file_name, url, size, parent_id, mime_type, created_at FROM files ORDER BY created_at DESC")
	} else {
		rows, err = db.Query("SELECT id, original_name, file_name, url, size, parent_id, mime_type, created_at FROM files WHERE original_name LIKE ? ORDER BY created_at DESC", "%"+q+"%")
	}
	if err != nil {
		jsonError(w, "Search failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	files := []FileRecord{}
	for rows.Next() {
		var rec FileRecord
		var pid sql.NullInt64
		err := rows.Scan(&rec.ID, &rec.OriginalName, &rec.FileName, &rec.URL, &rec.Size, &pid, &rec.MimeType, &rec.CreatedAt)
		if err != nil {
			continue
		}
		if pid.Valid {
			rec.ParentID = &pid.Int64
		}
		files = append(files, rec)
	}

	// Also search folders (skip for wildcard queries used by category filtering)
	folders := []FolderRecord{}
	if q != "" && q != "*" {
		folderRows, ferr := db.Query("SELECT id, name, parent_id, created_at FROM folders WHERE name LIKE ? ORDER BY name ASC", "%"+q+"%")
		if ferr == nil {
			defer folderRows.Close()
			for folderRows.Next() {
				var rec FolderRecord
				var pid sql.NullInt64
				folderRows.Scan(&rec.ID, &rec.Name, &pid, &rec.CreatedAt)
				if pid.Valid {
					rec.ParentID = &pid.Int64
				}
				folders = append(folders, rec)
			}
		}
	}

	jsonOK(w, ListResponse{Files: files, Folders: folders})
}

func handleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var stats StatsResponse
	db.QueryRow(`
		SELECT
			(SELECT COUNT(*) FROM files),
			(SELECT COUNT(*) FROM folders),
			(SELECT COALESCE(SUM(size), 0) FROM files)
	`).Scan(&stats.TotalFiles, &stats.TotalFolders, &stats.TotalSize)

	// Per-category counts via SQL (no full table scan)
	cats := map[string]int{"images": 0, "videos": 0, "documents": 0, "audio": 0, "others": 0}
	imgExts := map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".svg": true, ".webp": true, ".bmp": true, ".ico": true, ".tiff": true}
	vidExts := map[string]bool{".mp4": true, ".mov": true, ".avi": true, ".mkv": true, ".webm": true, ".flv": true}
	audExts := map[string]bool{".mp3": true, ".wav": true, ".ogg": true, ".flac": true, ".aac": true, ".m4a": true}
	docExts := map[string]bool{".pdf": true, ".doc": true, ".docx": true, ".xls": true, ".xlsx": true, ".ppt": true, ".pptx": true, ".txt": true, ".csv": true, ".rtf": true, ".odt": true, ".ods": true, ".odp": true}
	catRows, err := db.Query("SELECT original_name FROM files")
	if err == nil {
		defer catRows.Close()
		for catRows.Next() {
			var name string
			catRows.Scan(&name)
			ext := strings.ToLower(filepath.Ext(name)) // filepath.Ext gets the LAST dot extension
			switch {
			case imgExts[ext]:
				cats["images"]++
			case vidExts[ext]:
				cats["videos"]++
			case audExts[ext]:
				cats["audio"]++
			case docExts[ext]:
				cats["documents"]++
			default:
				cats["others"]++
			}
		}
	}
	stats.Categories = cats

	jsonOK(w, stats)
}

// ---------- Share HTML Templates ----------

const sharePasswordHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ST - Shared File</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9f9fb; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: white; border-radius: 16px; padding: 40px; max-width: 400px; width: 90%; box-shadow: 0 24px 48px rgba(45,51,56,0.08); text-align: center; }
    .icon { width: 64px; height: 64px; background: #e4e9ee; border-radius: 16px; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; }
    .icon svg { width: 32px; height: 32px; color: #596065; }
    h1 { font-size: 18px; color: #2d3338; margin-bottom: 8px; }
    p { font-size: 14px; color: #596065; margin-bottom: 24px; }
    input { width: 100%; padding: 12px 16px; border: none; background: #e4e9ee; border-radius: 12px; font-size: 16px; text-align: center; letter-spacing: 0.2em; outline: none; }
    input:focus { background: white; box-shadow: 0 0 0 2px #5e5e5e; }
    button { width: 100%; padding: 12px; background: #5e5e5e; color: white; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 12px; }
    button:hover { background: #525252; }
    .error { color: #9e3f4e; font-size: 13px; margin-top: 12px; }
    .filename { font-size: 13px; color: #757c81; margin-bottom: 4px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div>
    <p class="filename">{{FILENAME}}</p>
    <h1>Enter access code</h1>
    <p>This file is protected with an access code.</p>
    <form method="POST" action="/s/{{SHARE_ID}}">
      <input type="text" name="code" placeholder="Enter code" autofocus required>
      <button type="submit">Download</button>
    </form>
    {{ERROR_MSG}}
  </div>
</body>
</html>`

const shareErrorHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ST - Shared File</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9f9fb; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: white; border-radius: 16px; padding: 40px; max-width: 400px; width: 90%; box-shadow: 0 24px 48px rgba(45,51,56,0.08); text-align: center; }
    .icon { width: 64px; height: 64px; background: #e4e9ee; border-radius: 16px; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; }
    .icon svg { width: 32px; height: 32px; color: #596065; }
    h1 { font-size: 18px; color: #2d3338; margin-bottom: 8px; }
    p { font-size: 14px; color: #596065; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>
    <h1>{{TITLE}}</h1>
    <p>{{MESSAGE}}</p>
  </div>
</body>
</html>`

const shareFolderHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ST - {{FOLDER_NAME}}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9f9fb; min-height: 100vh; }
    .container { max-width: 600px; margin: 0 auto; padding: 32px 16px; }
    .header { text-align: center; margin-bottom: 32px; }
    .icon { width: 64px; height: 64px; background: #e4e9ee; border-radius: 16px; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; }
    .icon svg { width: 32px; height: 32px; color: #596065; }
    h1 { font-size: 20px; color: #2d3338; margin-bottom: 4px; }
    .subtitle { font-size: 14px; color: #757c81; }
    .file-list { background: white; border-radius: 16px; box-shadow: 0 24px 48px rgba(45,51,56,0.08); overflow: hidden; }
    .file-item { display: flex; align-items: center; padding: 14px 20px; border-bottom: 1px solid #f2f4f6; text-decoration: none; color: inherit; transition: background 0.15s; }
    .file-item:last-child { border-bottom: none; }
    .file-item:hover { background: #f9f9fb; }
    .file-icon { width: 36px; height: 36px; border-radius: 10px; background: #e4e9ee; display: flex; align-items: center; justify-content: center; margin-right: 14px; flex-shrink: 0; }
    .file-icon svg { width: 18px; height: 18px; color: #596065; }
    .file-info { flex: 1; min-width: 0; }
    .file-name { font-size: 14px; font-weight: 600; color: #2d3338; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .file-size { font-size: 12px; color: #757c81; margin-top: 2px; }
    .download-icon { color: #757c81; flex-shrink: 0; margin-left: 12px; }
    .download-icon svg { width: 18px; height: 18px; }
    .empty { text-align: center; padding: 48px 20px; color: #757c81; font-size: 14px; }
    .download-all { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 14px; background: #5e5e5e; color: white; border: none; border-radius: 12px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 16px; text-decoration: none; transition: background 0.15s; }
    .download-all:hover { background: #525252; }
    .download-all svg { width: 18px; height: 18px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>
      <h1>{{FOLDER_NAME}}</h1>
      <p class="subtitle">{{FILE_COUNT}} file{{FILE_PLURAL}}</p>
    </div>
    <div class="file-list">
      {{FILE_ITEMS}}
    </div>
    {{DOWNLOAD_ALL_BTN}}
  </div>
</body>
</html>`

const shareFolderPasswordHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ST - Shared Folder</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9f9fb; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: white; border-radius: 16px; padding: 40px; max-width: 400px; width: 90%; box-shadow: 0 24px 48px rgba(45,51,56,0.08); text-align: center; }
    .icon { width: 64px; height: 64px; background: #e4e9ee; border-radius: 16px; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; }
    .icon svg { width: 32px; height: 32px; color: #596065; }
    h1 { font-size: 18px; color: #2d3338; margin-bottom: 8px; }
    p { font-size: 14px; color: #596065; margin-bottom: 24px; }
    input { width: 100%; padding: 12px 16px; border: none; background: #e4e9ee; border-radius: 12px; font-size: 16px; text-align: center; letter-spacing: 0.2em; outline: none; }
    input:focus { background: white; box-shadow: 0 0 0 2px #5e5e5e; }
    button { width: 100%; padding: 12px; background: #5e5e5e; color: white; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 12px; }
    button:hover { background: #525252; }
    .error { color: #9e3f4e; font-size: 13px; margin-top: 12px; }
    .foldername { font-size: 13px; color: #757c81; margin-bottom: 4px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>
    <p class="foldername">{{FOLDERNAME}}</p>
    <h1>Enter access code</h1>
    <p>This folder is protected with an access code.</p>
    <form method="POST" action="/s/{{SHARE_ID}}">
      <input type="text" name="code" placeholder="Enter code" autofocus required>
      <button type="submit">View Folder</button>
    </form>
    {{ERROR_MSG}}
  </div>
</body>
</html>`

// ---------- Share Handlers ----------

func handleCreateShare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		FileID    *int64 `json:"fileId"`
		FolderID  *int64 `json:"folderId"`
		Code      string `json:"code"`
		ExpiresIn int64  `json:"expiresIn"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	if body.FileID == nil && body.FolderID == nil {
		jsonError(w, "Either fileId or folderId is required", http.StatusBadRequest)
		return
	}
	if body.FileID != nil && body.FolderID != nil {
		jsonError(w, "Cannot share both a file and a folder at once", http.StatusBadRequest)
		return
	}

	if body.FileID != nil {
		// Check file exists
		var fileExists int
		err := db.QueryRow("SELECT COUNT(*) FROM files WHERE id = ?", *body.FileID).Scan(&fileExists)
		if err != nil || fileExists == 0 {
			jsonError(w, "File not found", http.StatusNotFound)
			return
		}
	} else {
		// Check folder exists
		var folderExists int
		err := db.QueryRow("SELECT COUNT(*) FROM folders WHERE id = ?", *body.FolderID).Scan(&folderExists)
		if err != nil || folderExists == 0 {
			jsonError(w, "Folder not found", http.StatusNotFound)
			return
		}
		// Remove any existing share for this folder (one share per folder)
	}

	shareID, err := generateShortToken(6)
	if err != nil {
		jsonError(w, "Failed to generate share ID", http.StatusInternalServerError)
		return
	}

	var expiresAt string
	if body.ExpiresIn > 0 {
		expiresAt = time.Now().UTC().Add(time.Duration(body.ExpiresIn) * time.Second).Format(time.RFC3339)
	}

	_, err = db.Exec("INSERT INTO shares (id, file_id, folder_id, code, expires_at, enabled) VALUES (?, ?, ?, ?, ?, 1)",
		shareID, body.FileID, body.FolderID, body.Code, expiresAt)
	if err != nil {
		jsonError(w, "Failed to create share: "+err.Error(), http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]interface{}{
		"id":        shareID,
		"url":       "/s/" + shareID,
		"code":      body.Code,
		"expiresAt": expiresAt,
		"enabled":   true,
	})
}

func handleListShares(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rows, err := db.Query(`
		SELECT s.id, s.file_id, s.folder_id, f.original_name, f.size, fld.name, s.code, s.expires_at, s.enabled, s.created_at
		FROM shares s
		LEFT JOIN files f ON s.file_id = f.id
		LEFT JOIN folders fld ON s.folder_id = fld.id
		ORDER BY s.created_at DESC
	`)
	if err != nil {
		jsonError(w, "Failed to query shares: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var shares []map[string]interface{}
	for rows.Next() {
		var id, code, expiresAt, createdAt string
		var fileID, folderID sql.NullInt64
		var enabled int
		var fileName, folderName sql.NullString
		var fileSize sql.NullInt64
		err := rows.Scan(&id, &fileID, &folderID, &fileName, &fileSize, &folderName, &code, &expiresAt, &enabled, &createdAt)
		if err != nil {
			continue
		}
		entry := map[string]interface{}{
			"id":        id,
			"code":      code,
			"expiresAt": expiresAt,
			"enabled":   enabled == 1,
			"createdAt": createdAt,
		}
		if folderID.Valid {
			entry["folderId"] = folderID.Int64
			fn := ""
			if folderName.Valid {
				fn = folderName.String
			}
			entry["folderName"] = fn
			entry["fileName"] = fn
			entry["fileSize"] = int64(0)
			entry["fileId"] = int64(0)
			entry["type"] = "folder"
		} else {
			fid := int64(0)
			if fileID.Valid {
				fid = fileID.Int64
			}
			entry["fileId"] = fid
			fn := ""
			if fileName.Valid {
				fn = fileName.String
			}
			entry["fileName"] = fn
			var fs int64
			if fileSize.Valid {
				fs = fileSize.Int64
			}
			entry["fileSize"] = fs
			entry["type"] = "file"
		}
		shares = append(shares, entry)
	}
	if shares == nil {
		shares = []map[string]interface{}{}
	}

	jsonOK(w, shares)
}

func handleDeleteShare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	shareID := strings.TrimPrefix(r.URL.Path, "/api/shares/")
	if shareID == "" {
		jsonError(w, "Missing share ID", http.StatusBadRequest)
		return
	}

	result, err := db.Exec("DELETE FROM shares WHERE id = ?", shareID)
	if err != nil {
		jsonError(w, "Failed to delete share: "+err.Error(), http.StatusInternalServerError)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		jsonError(w, "Share not found", http.StatusNotFound)
		return
	}

	jsonOK(w, map[string]string{"message": "deleted"})
}

func handleToggleShare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Path: /api/shares/:id/toggle
	shareID := strings.TrimPrefix(r.URL.Path, "/api/shares/")
	shareID = strings.TrimSuffix(shareID, "/toggle")
	if shareID == "" {
		jsonError(w, "Missing share ID", http.StatusBadRequest)
		return
	}

	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	enabledInt := 0
	if body.Enabled {
		enabledInt = 1
	}

	result, err := db.Exec("UPDATE shares SET enabled = ? WHERE id = ?", enabledInt, shareID)
	if err != nil {
		jsonError(w, "Failed to toggle share: "+err.Error(), http.StatusInternalServerError)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		jsonError(w, "Share not found", http.StatusNotFound)
		return
	}

	jsonOK(w, map[string]interface{}{"enabled": body.Enabled})
}

func esc(s string) string { return html.EscapeString(s) }

func codeMatch(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func serveShareErrorPage(w http.ResponseWriter, title, message string) {
	page := shareErrorHTML
	page = strings.ReplaceAll(page, "{{TITLE}}", esc(title))
	page = strings.ReplaceAll(page, "{{MESSAGE}}", esc(message))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(page))
}

func serveSharePasswordPage(w http.ResponseWriter, shareID, filename, errorMsg string) {
	page := sharePasswordHTML
	page = strings.ReplaceAll(page, "{{SHARE_ID}}", esc(shareID))
	page = strings.ReplaceAll(page, "{{FILENAME}}", esc(filename))
	if errorMsg != "" {
		page = strings.ReplaceAll(page, "{{ERROR_MSG}}", `<p class="error">`+esc(errorMsg)+`</p>`)
	} else {
		page = strings.ReplaceAll(page, "{{ERROR_MSG}}", "")
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(page))
}

func serveShareFolderPasswordPage(w http.ResponseWriter, shareID, folderName, errorMsg string) {
	page := shareFolderPasswordHTML
	page = strings.ReplaceAll(page, "{{SHARE_ID}}", esc(shareID))
	page = strings.ReplaceAll(page, "{{FOLDERNAME}}", esc(folderName))
	if errorMsg != "" {
		page = strings.ReplaceAll(page, "{{ERROR_MSG}}", `<p class="error">`+esc(errorMsg)+`</p>`)
	} else {
		page = strings.ReplaceAll(page, "{{ERROR_MSG}}", "")
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(page))
}

func formatSizeForHTML(size int64) string {
	if size == 0 {
		return "0 B"
	}
	units := []string{"B", "KB", "MB", "GB", "TB"}
	i := 0
	fSize := float64(size)
	for fSize >= 1024 && i < len(units)-1 {
		fSize /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d B", size)
	}
	return fmt.Sprintf("%.1f %s", fSize, units[i])
}

func serveSharedFolderListing(w http.ResponseWriter, s *shareInfo) {
	rows, err := db.Query("SELECT id, original_name, size FROM files WHERE parent_id = ? ORDER BY original_name ASC", s.FolderID)
	if err != nil {
		serveShareErrorPage(w, "Error", "Failed to list folder contents.")
		return
	}
	defer rows.Close()

	var fileItems strings.Builder
	fileCount := 0
	for rows.Next() {
		var fid int64
		var name string
		var size int64
		if err := rows.Scan(&fid, &name, &size); err != nil {
			continue
		}
		fileCount++
		downloadURL := fmt.Sprintf("/s/%s/file/%d", s.ID, fid)
		if s.Code != "" {
			downloadURL += "?code=" + url.QueryEscape(s.Code)
		}
		fileItems.WriteString(fmt.Sprintf(`<a href="%s" class="file-item">
  <div class="file-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
  <div class="file-info"><div class="file-name">%s</div><div class="file-size">%s</div></div>
  <div class="download-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div>
</a>`, downloadURL, esc(name), formatSizeForHTML(size)))
	}

	if fileCount == 0 {
		fileItems.WriteString(`<div class="empty">This folder is empty</div>`)
	}

	plural := "s"
	if fileCount == 1 {
		plural = ""
	}

	// Download All button
	downloadAllBtn := ""
	if fileCount > 0 {
		downloadAllURL := fmt.Sprintf("/s/%s/download-all", s.ID)
		if s.Code != "" {
			downloadAllURL += "?code=" + url.QueryEscape(s.Code)
		}
		downloadAllBtn = fmt.Sprintf(`<a href="%s" class="download-all"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download All as ZIP</a>`, downloadAllURL)
	}

	page := shareFolderHTML
	page = strings.ReplaceAll(page, "{{FOLDER_NAME}}", esc(s.FolderName))
	page = strings.ReplaceAll(page, "{{FILE_COUNT}}", fmt.Sprintf("%d", fileCount))
	page = strings.ReplaceAll(page, "{{FILE_PLURAL}}", plural)
	page = strings.ReplaceAll(page, "{{FILE_ITEMS}}", fileItems.String())
	page = strings.ReplaceAll(page, "{{DOWNLOAD_ALL_BTN}}", downloadAllBtn)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(page))
}

// lookupShare fetches share info. Returns share fields and whether it's valid for access.
type shareInfo struct {
	ID           string
	FileID       int64
	FolderID     int64
	IsFolder     bool
	Code         string
	ExpiresAt    string
	Enabled      int
	OriginalName string
	FolderName   string
	FileURL      string
	MimeType     string
}

func lookupShare(shareID string) (*shareInfo, error) {
	var s shareInfo
	var fileID, folderID sql.NullInt64
	var originalName, fileURL, mimeType, folderName sql.NullString
	err := db.QueryRow(`
		SELECT s.id, s.file_id, s.folder_id, s.code, s.expires_at, s.enabled, f.original_name, f.url, f.mime_type, fld.name
		FROM shares s
		LEFT JOIN files f ON s.file_id = f.id
		LEFT JOIN folders fld ON s.folder_id = fld.id
		WHERE s.id = ?
	`, shareID).Scan(&s.ID, &fileID, &folderID, &s.Code, &s.ExpiresAt, &s.Enabled, &originalName, &fileURL, &mimeType, &folderName)
	if err != nil {
		return nil, err
	}
	if fileID.Valid {
		s.FileID = fileID.Int64
	}
	if folderID.Valid {
		s.FolderID = folderID.Int64
		s.IsFolder = true
	}
	if originalName.Valid {
		s.OriginalName = originalName.String
	}
	if fileURL.Valid {
		s.FileURL = fileURL.String
	}
	if mimeType.Valid {
		s.MimeType = mimeType.String
	}
	if folderName.Valid {
		s.FolderName = folderName.String
	}
	return &s, nil
}

func isShareExpired(s *shareInfo) bool {
	if s.ExpiresAt == "" {
		return false
	}
	t, err := parseFlexibleTime(s.ExpiresAt)
	if err != nil {
		return false
	}
	return time.Now().UTC().After(t)
}

func streamFileFromR2(w http.ResponseWriter, originalName, fileURL, mimeType string) {
	if fileURL == "" {
		serveShareErrorPage(w, "File not found", "The shared file no longer exists.")
		return
	}

	var r2Key string
	var cfg R2Config

	if strings.HasPrefix(fileURL, "/api/r2/b/") {
		rest := strings.TrimPrefix(fileURL, "/api/r2/b/")
		if slashIdx := strings.Index(rest, "/"); slashIdx > 0 {
			bidStr := rest[:slashIdx]
			r2Key = rest[slashIdx+1:]
			bid, _ := strconv.ParseInt(bidStr, 10, 64)
			if bcfg, err := getBucketConfig(bid); err == nil {
				cfg = *bcfg
			} else {
				cfg = appConfig.R2
			}
		}
	} else {
		r2Key = strings.TrimPrefix(fileURL, "/api/r2/")
		cfg = appConfig.R2
	}

	req, err := signedS3RequestWithConfig(cfg, "GET", r2Key, nil, "")
	if err != nil {
		serveShareErrorPage(w, "Error", "Failed to prepare download.")
		return
	}

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		serveShareErrorPage(w, "Error", "Failed to fetch file from storage.")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		serveShareErrorPage(w, "File not found", "The shared file no longer exists in storage.")
		return
	}
	if resp.StatusCode >= 300 {
		serveShareErrorPage(w, "Error", "Storage returned an error.")
		return
	}

	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	} else if mimeType != "" {
		w.Header().Set("Content-Type", mimeType)
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", originalName))
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		w.Header().Set("Content-Length", cl)
	}
	io.Copy(w, resp.Body)
}

func handleSharePage(w http.ResponseWriter, r *http.Request) {
	// Routes: GET /s/:id, POST /s/:id, GET /s/:id/download, GET /s/:id/file/:fileId
	path := r.URL.Path
	trimmed := strings.TrimPrefix(path, "/s/")

	// Check for /file/:fileId pattern (folder share file download)
	if strings.Contains(trimmed, "/file/") {
		parts := strings.SplitN(trimmed, "/file/", 2)
		shareID := parts[0]
		fileIDStr := parts[1]
		fileID, err := strconv.ParseInt(fileIDStr, 10, 64)
		if err != nil {
			serveShareErrorPage(w, "Not found", "Invalid file ID.")
			return
		}
		handleShareFolderFileDownload(w, r, shareID, fileID)
		return
	}

	// Check for /download-all (must be before /download check)
	if strings.HasSuffix(trimmed, "/download-all") {
		handleShareFolderDownloadAll(w, r)
		return
	}

	// Check for /download suffix
	isDownload := strings.HasSuffix(trimmed, "/download")
	shareID := strings.TrimSuffix(trimmed, "/download")

	if shareID == "" {
		serveShareErrorPage(w, "Not found", "Invalid share link.")
		return
	}

	s, err := lookupShare(shareID)
	if err != nil {
		serveShareErrorPage(w, "Not found", "This share link does not exist.")
		return
	}

	if s.Enabled == 0 {
		serveShareErrorPage(w, "Link disabled", "This share link has been disabled.")
		return
	}

	if isShareExpired(s) {
		serveShareErrorPage(w, "Link expired", "This share link has expired.")
		return
	}

	// ---------- Folder share ----------
	if s.IsFolder {
		if s.FolderName == "" {
			serveShareErrorPage(w, "Folder not found", "The shared folder no longer exists.")
			return
		}

		// POST /s/:id — verify code for folder
		if r.Method == http.MethodPost {
			var code string
			ct := r.Header.Get("Content-Type")
			if strings.Contains(ct, "application/json") {
				var body struct {
					Code string `json:"code"`
				}
				json.NewDecoder(r.Body).Decode(&body)
				code = body.Code
			} else {
				r.ParseForm()
				code = r.FormValue("code")
			}

			if s.Code == "" || codeMatch(code, s.Code) {
				serveSharedFolderListing(w, s)
				return
			}
			serveShareFolderPasswordPage(w, shareID, s.FolderName, "Invalid access code. Please try again.")
			return
		}

		// GET /s/:id
		if r.Method == http.MethodGet {
			if s.Code == "" || codeMatch(r.URL.Query().Get("code"), s.Code) {
				serveSharedFolderListing(w, s)
				return
			}
			serveShareFolderPasswordPage(w, shareID, s.FolderName, "")
			return
		}

		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// ---------- File share ----------
	if s.OriginalName == "" {
		serveShareErrorPage(w, "File not found", "The shared file no longer exists.")
		return
	}

	// GET /s/:id/download
	if isDownload && r.Method == http.MethodGet {
		if s.Code != "" {
			code := r.URL.Query().Get("code")
			if !codeMatch(code, s.Code) {
				serveShareErrorPage(w, "Invalid code", "The access code is incorrect.")
				return
			}
		}
		streamFileFromR2(w, s.OriginalName, s.FileURL, s.MimeType)
		return
	}

	// POST /s/:id — verify code and download
	if r.Method == http.MethodPost {
		var code string
		ct := r.Header.Get("Content-Type")
		if strings.Contains(ct, "application/json") {
			var body struct {
				Code string `json:"code"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			code = body.Code
		} else {
			r.ParseForm()
			code = r.FormValue("code")
		}

		if s.Code == "" || codeMatch(code, s.Code) {
			streamFileFromR2(w, s.OriginalName, s.FileURL, s.MimeType)
			return
		}

		serveSharePasswordPage(w, shareID, s.OriginalName, "Invalid access code. Please try again.")
		return
	}

	// GET /s/:id
	if r.Method == http.MethodGet {
		if s.Code == "" || codeMatch(r.URL.Query().Get("code"), s.Code) {
			// No code needed or code in URL matches
			streamFileFromR2(w, s.OriginalName, s.FileURL, s.MimeType)
			return
		}
		serveSharePasswordPage(w, shareID, s.OriginalName, "")
		return
	}

	jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
}

// handleShareFolderFileDownload handles GET /s/:shareId/file/:fileId
func handleShareFolderFileDownload(w http.ResponseWriter, r *http.Request, shareID string, fileID int64) {
	if r.Method != http.MethodGet {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	s, err := lookupShare(shareID)
	if err != nil {
		serveShareErrorPage(w, "Not found", "This share link does not exist.")
		return
	}

	if s.Enabled == 0 {
		serveShareErrorPage(w, "Link disabled", "This share link has been disabled.")
		return
	}

	if isShareExpired(s) {
		serveShareErrorPage(w, "Link expired", "This share link has expired.")
		return
	}

	if !s.IsFolder {
		serveShareErrorPage(w, "Invalid", "This is not a folder share.")
		return
	}

	// Verify code if required
	if s.Code != "" {
		code := r.URL.Query().Get("code")
		if !codeMatch(code, s.Code) {
			serveShareErrorPage(w, "Invalid code", "The access code is incorrect.")
			return
		}
	}

	// Verify the file belongs to this shared folder
	var originalName, fileURL string
	var mimeType sql.NullString
	err = db.QueryRow("SELECT original_name, url, mime_type FROM files WHERE id = ? AND parent_id = ?", fileID, s.FolderID).
		Scan(&originalName, &fileURL, &mimeType)
	if err != nil {
		serveShareErrorPage(w, "File not found", "This file does not exist in the shared folder.")
		return
	}

	mt := ""
	if mimeType.Valid {
		mt = mimeType.String
	}
	streamFileFromR2(w, originalName, fileURL, mt)
}

// ---------- Bucket Management Handlers ----------

func handleListBuckets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rows, err := db.Query("SELECT id, name, bucket_name, endpoint, max_size, current_size, enabled, created_at FROM r2_buckets ORDER BY id ASC")
	if err != nil {
		jsonError(w, "Failed to query buckets: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var buckets []map[string]interface{}
	for rows.Next() {
		var id, maxSize, currentSize int64
		var enabled int
		var name, bucketName, endpoint, createdAt string
		err := rows.Scan(&id, &name, &bucketName, &endpoint, &maxSize, &currentSize, &enabled, &createdAt)
		if err != nil {
			continue
		}
		buckets = append(buckets, map[string]interface{}{
			"id":          id,
			"name":        name,
			"bucketName":  bucketName,
			"endpoint":    endpoint,
			"maxSize":     maxSize,
			"currentSize": currentSize,
			"enabled":     enabled == 1,
			"createdAt":   createdAt,
		})
	}
	if buckets == nil {
		buckets = []map[string]interface{}{}
	}

	jsonOK(w, buckets)
}

func handleCreateBucket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		Name           string `json:"name"`
		AccountID      string `json:"accountId"`
		AccessKeyID    string `json:"accessKeyId"`
		SecretAccessKey string `json:"secretAccessKey"`
		BucketName     string `json:"bucketName"`
		Endpoint       string `json:"endpoint"`
		MaxSize        int64  `json:"maxSize"`
		APIToken       string `json:"apiToken"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	if body.AccessKeyID == "" || body.SecretAccessKey == "" || body.BucketName == "" || body.Endpoint == "" {
		jsonError(w, "Access Key, Secret Key, Bucket Name and Endpoint are required", http.StatusBadRequest)
		return
	}
	// Auto-fill missing fields
	if body.Name == "" {
		body.Name = body.BucketName
	}
	if body.AccountID == "" {
		// Extract from endpoint: https://{accountId}.r2.cloudflarestorage.com
		parts := strings.Split(strings.TrimPrefix(body.Endpoint, "https://"), ".")
		if len(parts) > 0 {
			body.AccountID = parts[0]
		}
	}

	if body.MaxSize <= 0 {
		body.MaxSize = 10737418240 // 10GB default
	}

	// Validate by trying a HEAD request (list bucket)
	testCfg := R2Config{
		AccountID:      body.AccountID,
		AccessKeyID:    body.AccessKeyID,
		SecretAccessKey: body.SecretAccessKey,
		BucketName:     body.BucketName,
		Endpoint:       body.Endpoint,
	}
	testKey := "__filestore_test_" + fmt.Sprintf("%d", time.Now().UnixNano())
	testData := []byte("test")
	req, err := signedS3RequestWithConfig(testCfg, "PUT", testKey, testData, "text/plain")
	if err != nil {
		jsonError(w, "Failed to create test request: "+err.Error(), http.StatusBadRequest)
		return
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		jsonError(w, "Failed to connect to bucket: "+err.Error(), http.StatusBadRequest)
		return
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		jsonError(w, fmt.Sprintf("Bucket test failed (HTTP %d). Check credentials and endpoint.", resp.StatusCode), http.StatusBadRequest)
		return
	}

	// Clean up test object
	delReq, _ := signedS3RequestWithConfig(testCfg, "DELETE", testKey, nil, "")
	if delReq != nil {
		delResp, _ := client.Do(delReq)
		if delResp != nil {
			delResp.Body.Close()
		}
	}

	createdAt := time.Now().Format("2006-01-02 15:04:05")
	result, err := db.Exec(`INSERT INTO r2_buckets (name, account_id, access_key_id, secret_access_key, bucket_name, endpoint, max_size, current_size, enabled, api_token, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
		body.Name, body.AccountID, body.AccessKeyID, body.SecretAccessKey, body.BucketName, body.Endpoint, body.MaxSize, body.APIToken, createdAt)
	if err != nil {
		jsonError(w, "Failed to create bucket: "+err.Error(), http.StatusInternalServerError)
		return
	}

	id, _ := result.LastInsertId()
	jsonOK(w, map[string]interface{}{
		"id":          id,
		"name":        body.Name,
		"bucketName":  body.BucketName,
		"endpoint":    body.Endpoint,
		"maxSize":     body.MaxSize,
		"currentSize": 0,
		"enabled":     true,
		"createdAt":   createdAt,
	})
}

func handleUpdateBucket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	id, ok := parseIDFromPath(r.URL.Path, "/api/settings/buckets/", "")
	if !ok {
		jsonError(w, "Invalid bucket ID", http.StatusBadRequest)
		return
	}

	var body struct {
		Name     string `json:"name"`
		MaxSize  int64  `json:"maxSize"`
		Enabled  *bool  `json:"enabled"`
		APIToken *string `json:"apiToken"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	// Build update query dynamically
	sets := []string{}
	args := []interface{}{}
	if body.Name != "" {
		sets = append(sets, "name = ?")
		args = append(args, body.Name)
	}
	if body.MaxSize > 0 {
		sets = append(sets, "max_size = ?")
		args = append(args, body.MaxSize)
	}
	if body.APIToken != nil {
		sets = append(sets, "api_token = ?")
		args = append(args, *body.APIToken)
	}
	if body.Enabled != nil {
		enabledInt := 0
		if *body.Enabled {
			enabledInt = 1
		}
		sets = append(sets, "enabled = ?")
		args = append(args, enabledInt)
	}

	if len(sets) == 0 {
		jsonError(w, "No fields to update", http.StatusBadRequest)
		return
	}

	args = append(args, id)
	query := "UPDATE r2_buckets SET " + strings.Join(sets, ", ") + " WHERE id = ?"
	result, err := db.Exec(query, args...)
	if err != nil {
		jsonError(w, "Failed to update bucket: "+err.Error(), http.StatusInternalServerError)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		jsonError(w, "Bucket not found", http.StatusNotFound)
		return
	}

	jsonOK(w, map[string]string{"message": "updated"})
}

func handleDeleteBucket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	id, ok := parseIDFromPath(r.URL.Path, "/api/settings/buckets/", "")
	if !ok {
		jsonError(w, "Invalid bucket ID", http.StatusBadRequest)
		return
	}

	// Check no files reference this bucket
	var fileCount int
	err := db.QueryRow("SELECT COUNT(*) FROM files WHERE bucket_id = ?", id).Scan(&fileCount)
	if err != nil {
		jsonError(w, "Failed to check file references: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if fileCount > 0 {
		jsonError(w, fmt.Sprintf("Cannot delete bucket: %d files still reference it", fileCount), http.StatusConflict)
		return
	}

	result, err := db.Exec("DELETE FROM r2_buckets WHERE id = ?", id)
	if err != nil {
		jsonError(w, "Failed to delete bucket: "+err.Error(), http.StatusInternalServerError)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		jsonError(w, "Bucket not found", http.StatusNotFound)
		return
	}

	jsonOK(w, map[string]string{"message": "deleted"})
}

// syncBucketViaListObjects uses S3 ListObjects to calculate real bucket size
func syncBucketViaListObjects(bucketID int64) (totalSize int64, objectCount int64, err error) {
	cfg, err := getBucketConfig(bucketID)
	if err != nil {
		return 0, 0, fmt.Errorf("bucket not found: %w", err)
	}

	var marker string
	for {
		// Build ListObjectsV2 request
		queryParams := "list-type=2&max-keys=1000"
		if marker != "" {
			queryParams += "&continuation-token=" + url.QueryEscape(marker)
		}

		listURL := fmt.Sprintf("%s/%s/?%s", strings.TrimRight(cfg.Endpoint, "/"), cfg.BucketName, queryParams)
		req, err := http.NewRequest("GET", listURL, nil)
		if err != nil {
			return 0, 0, err
		}

		// Sign the request
		now := time.Now().UTC()
		amzDate := now.Format("20060102T150405Z")
		dateStamp := now.Format("20060102")
		payloadHash := sha256Hex([]byte{})

		req.Header.Set("Host", req.URL.Host)
		req.Header.Set("X-Amz-Date", amzDate)
		req.Header.Set("X-Amz-Content-Sha256", payloadHash)

		signedHeaderKeys := []string{"host", "x-amz-content-sha256", "x-amz-date"}
		sort.Strings(signedHeaderKeys)
		var canonicalHeaders strings.Builder
		for _, k := range signedHeaderKeys {
			switch k {
			case "host":
				canonicalHeaders.WriteString("host:" + req.URL.Host + "\n")
			case "x-amz-content-sha256":
				canonicalHeaders.WriteString("x-amz-content-sha256:" + payloadHash + "\n")
			case "x-amz-date":
				canonicalHeaders.WriteString("x-amz-date:" + amzDate + "\n")
			}
		}
		signedHeaders := strings.Join(signedHeaderKeys, ";")
		canonicalURI := "/" + cfg.BucketName + "/"
		canonicalRequest := strings.Join([]string{"GET", canonicalURI, queryParams, canonicalHeaders.String(), signedHeaders, payloadHash}, "\n")
		credentialScope := dateStamp + "/auto/s3/aws4_request"
		stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex([]byte(canonicalRequest))}, "\n")
		sKey := signingKey(cfg.SecretAccessKey, dateStamp, "auto", "s3")
		signature := hex.EncodeToString(hmacSHA256(sKey, []byte(stringToSign)))
		req.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", cfg.AccessKeyID, credentialScope, signedHeaders, signature))

		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			return 0, 0, fmt.Errorf("ListObjects request failed: %w", err)
		}
		respBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode >= 300 {
			return 0, 0, fmt.Errorf("ListObjects returned HTTP %d: %s", resp.StatusCode, string(respBody[:min(200, len(respBody))]))
		}

		// Parse XML response
		type Contents struct {
			Key  string `xml:"Key"`
			Size int64  `xml:"Size"`
		}
		type ListResult struct {
			Contents            []Contents `xml:"Contents"`
			IsTruncated         bool       `xml:"IsTruncated"`
			NextContinuationToken string   `xml:"NextContinuationToken"`
		}
		var result ListResult
		if err := xml.Unmarshal(respBody, &result); err != nil {
			return 0, 0, fmt.Errorf("failed to parse ListObjects XML: %w", err)
		}

		for _, obj := range result.Contents {
			totalSize += obj.Size
			objectCount++
		}

		if !result.IsTruncated || result.NextContinuationToken == "" {
			break
		}
		marker = result.NextContinuationToken
	}
	return totalSize, objectCount, nil
}

// syncAllBuckets syncs usage for all enabled buckets
func syncAllBuckets() {
	rows, err := db.Query("SELECT id, name FROM r2_buckets WHERE enabled = 1")
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var name string
		rows.Scan(&id, &name)
		totalSize, objectCount, err := syncBucketViaListObjects(id)
		if err != nil {
			log.Printf("Sync bucket %s (id=%d) failed: %v", name, id, err)
			continue
		}
		db.Exec("UPDATE r2_buckets SET current_size = ? WHERE id = ?", totalSize, id)
		log.Printf("Synced bucket %s: %d objects, %d bytes", name, objectCount, totalSize)
	}
}

// startDailySync runs syncAllBuckets every day at 2:00 AM
func startDailySync() {
	go func() {
		for {
			now := time.Now()
			next := time.Date(now.Year(), now.Month(), now.Day(), 2, 0, 0, 0, now.Location())
			if now.After(next) {
				next = next.Add(24 * time.Hour)
			}
			timer := time.NewTimer(next.Sub(now))
			<-timer.C
			log.Println("Starting daily bucket sync...")
			syncAllBuckets()
		}
	}()
}

func handleSyncBucketUsage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	id, ok := parseIDFromPath(r.URL.Path, "/api/settings/buckets/", "/sync")
	if !ok {
		jsonError(w, "Invalid bucket ID", http.StatusBadRequest)
		return
	}

	totalSize, objectCount, err := syncBucketViaListObjects(id)
	if err != nil {
		jsonError(w, "Sync failed: "+err.Error(), http.StatusBadGateway)
		return
	}

	db.Exec("UPDATE r2_buckets SET current_size = ? WHERE id = ?", totalSize, id)

	jsonOK(w, map[string]interface{}{
		"currentSize":  totalSize,
		"objectCount":  objectCount,
	})
}

// ---------- Preview Link Handler ----------

func handlePreviewLink(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		FileID int64 `json:"fileId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.FileID == 0 {
		jsonError(w, "Invalid JSON body or missing fileId", http.StatusBadRequest)
		return
	}

	// Check file exists
	var fileExists int
	err := db.QueryRow("SELECT COUNT(*) FROM files WHERE id = ?", body.FileID).Scan(&fileExists)
	if err != nil || fileExists == 0 {
		jsonError(w, "File not found", http.StatusNotFound)
		return
	}

	// Check for existing preview share (empty code, expiry within next 10 min)
	now := time.Now().UTC()
	tenMinFromNow := now.Add(10 * time.Minute).Format(time.RFC3339)
	var existingID string
	err = db.QueryRow(
		"SELECT id FROM shares WHERE file_id = ? AND code = '' AND enabled = 1 AND expires_at != '' AND expires_at > ? AND expires_at <= ?",
		body.FileID, now.Format(time.RFC3339), tenMinFromNow,
	).Scan(&existingID)

	if err == nil && existingID != "" {
		// Reuse existing preview share
		scheme := "https"
		if r.TLS == nil {
			fwdProto := r.Header.Get("X-Forwarded-Proto")
			if fwdProto == "https" {
				scheme = "https"
			} else {
				scheme = "http"
			}
		}
		publicURL := fmt.Sprintf("%s://%s/s/%s", scheme, r.Host, existingID)
		jsonOK(w, map[string]string{"url": publicURL})
		return
	}

	// Create a new preview share: no code, expires in 10 minutes
	shareID, err := generateShortToken(6)
	if err != nil {
		jsonError(w, "Failed to generate share ID", http.StatusInternalServerError)
		return
	}

	expiresAt := now.Add(10 * time.Minute).Format(time.RFC3339)
	_, err = db.Exec("INSERT INTO shares (id, file_id, folder_id, code, expires_at, enabled) VALUES (?, ?, NULL, '', ?, 1)",
		shareID, body.FileID, expiresAt)
	if err != nil {
		jsonError(w, "Failed to create preview share: "+err.Error(), http.StatusInternalServerError)
		return
	}

	scheme := "https"
	if r.TLS == nil {
		fwdProto := r.Header.Get("X-Forwarded-Proto")
		if fwdProto == "https" {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	publicURL := fmt.Sprintf("%s://%s/s/%s", scheme, r.Host, shareID)
	jsonOK(w, map[string]string{"url": publicURL})
}

// ---------- Folder ZIP Download Handlers ----------

type zipFileEntry struct {
	OriginalName string
	FileURL      string
	MimeType     string
	BucketID     sql.NullInt64
	Path         string
}

// collectFolderFiles recursively collects all files in a folder
func collectFolderFiles(folderID int64, prefix string) ([]zipFileEntry, error) {
	var results []zipFileEntry

	// Get files in this folder
	rows, err := db.Query("SELECT original_name, url, mime_type, bucket_id FROM files WHERE parent_id = ?", folderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var e zipFileEntry
		var mt sql.NullString
		err := rows.Scan(&e.OriginalName, &e.FileURL, &mt, &e.BucketID)
		if err != nil {
			continue
		}
		if mt.Valid {
			e.MimeType = mt.String
		}
		e.Path = prefix + e.OriginalName
		results = append(results, e)
	}

	// Get subfolders
	subRows, err := db.Query("SELECT id, name FROM folders WHERE parent_id = ?", folderID)
	if err != nil {
		return results, nil
	}
	defer subRows.Close()

	type subFolder struct {
		ID   int64
		Name string
	}
	var subs []subFolder
	for subRows.Next() {
		var sf subFolder
		subRows.Scan(&sf.ID, &sf.Name)
		subs = append(subs, sf)
	}

	for _, sf := range subs {
		subFiles, err := collectFolderFiles(sf.ID, prefix+sf.Name+"/")
		if err != nil {
			continue
		}
		results = append(results, subFiles...)
	}

	return results, nil
}

// fetchR2FileBody fetches a file from R2 and returns its body reader
func fetchR2FileBody(fileURL string, bucketIDVal sql.NullInt64) (io.ReadCloser, error) {
	var r2Key string
	var cfg R2Config

	if strings.HasPrefix(fileURL, "/api/r2/b/") {
		rest := strings.TrimPrefix(fileURL, "/api/r2/b/")
		if slashIdx := strings.Index(rest, "/"); slashIdx > 0 {
			bidStr := rest[:slashIdx]
			r2Key = rest[slashIdx+1:]
			bid, _ := strconv.ParseInt(bidStr, 10, 64)
			if bcfg, err := getBucketConfig(bid); err == nil {
				cfg = *bcfg
			} else {
				cfg = appConfig.R2
			}
		}
	} else {
		r2Key = strings.TrimPrefix(fileURL, "/api/r2/")
		cfg = appConfig.R2
	}

	req, err := signedS3RequestWithConfig(cfg, "GET", r2Key, nil, "")
	if err != nil {
		return nil, err
	}

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 300 {
		resp.Body.Close()
		return nil, fmt.Errorf("R2 returned HTTP %d", resp.StatusCode)
	}

	return resp.Body, nil
}

func handleFolderDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	id, ok := parseIDFromPath(r.URL.Path, "/api/folders/", "/download")
	if !ok {
		jsonError(w, "Invalid folder ID", http.StatusBadRequest)
		return
	}

	// Get folder name
	var folderName string
	err := db.QueryRow("SELECT name FROM folders WHERE id = ?", id).Scan(&folderName)
	if err != nil {
		jsonError(w, "Folder not found", http.StatusNotFound)
		return
	}

	files, err := collectFolderFiles(id, "")
	if err != nil {
		jsonError(w, "Failed to collect files: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s.zip\"", folderName))

	zipWriter := zip.NewWriter(w)
	defer zipWriter.Close()

	for _, f := range files {
		body, err := fetchR2FileBody(f.FileURL, f.BucketID)
		if err != nil {
			log.Printf("Warning: failed to fetch file for zip (path=%s): %v", f.Path, err)
			continue
		}
		entry, err := zipWriter.Create(f.Path)
		if err != nil {
			body.Close()
			continue
		}
		io.Copy(entry, body)
		body.Close()
	}
}

func handleShareFolderDownloadAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Path: /s/:id/download-all
	path := r.URL.Path
	trimmed := strings.TrimPrefix(path, "/s/")
	shareID := strings.TrimSuffix(trimmed, "/download-all")

	s, err := lookupShare(shareID)
	if err != nil {
		serveShareErrorPage(w, "Not found", "This share link does not exist.")
		return
	}

	if s.Enabled == 0 {
		serveShareErrorPage(w, "Link disabled", "This share link has been disabled.")
		return
	}

	if isShareExpired(s) {
		serveShareErrorPage(w, "Link expired", "This share link has expired.")
		return
	}

	if !s.IsFolder {
		serveShareErrorPage(w, "Invalid", "This is not a folder share.")
		return
	}

	// Verify code if required
	if s.Code != "" {
		code := r.URL.Query().Get("code")
		if !codeMatch(code, s.Code) {
			serveShareErrorPage(w, "Invalid code", "The access code is incorrect.")
			return
		}
	}

	files, err := collectFolderFiles(s.FolderID, "")
	if err != nil {
		serveShareErrorPage(w, "Error", "Failed to collect folder files.")
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s.zip\"", s.FolderName))

	zipWriter := zip.NewWriter(w)
	defer zipWriter.Close()

	for _, f := range files {
		body, err := fetchR2FileBody(f.FileURL, f.BucketID)
		if err != nil {
			continue
		}
		entry, err := zipWriter.Create(f.Path)
		if err != nil {
			body.Close()
			continue
		}
		io.Copy(entry, body)
		body.Close()
	}
}

// ---------- Router ----------

func apiRouter(w http.ResponseWriter, r *http.Request) {
	// Limit request body for non-upload endpoints (1MB)
	if r.URL.Path != "/api/upload" {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	}

	// CORS — allow same-origin and local network origins
	origin := r.Header.Get("Origin")
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	path := r.URL.Path
	method := r.Method

	// --- Auth routes (no auth middleware) ---
	if strings.HasPrefix(path, "/api/auth/") {
		switch {
		case path == "/api/auth/login" && method == http.MethodPost:
			handleAuthLogin(w, r)
		case path == "/api/auth/check" && method == http.MethodGet:
			handleAuthCheck(w, r)
		case path == "/api/auth/logout" && method == http.MethodPost:
			handleAuthLogout(w, r)
		case path == "/api/auth/register/start" && method == http.MethodPost:
			handleRegisterStart(w, r)
		case path == "/api/auth/register/finish" && method == http.MethodPost:
			handleRegisterFinish(w, r)
		case path == "/api/auth/verify/start" && method == http.MethodPost:
			handleVerifyStart(w, r)
		case path == "/api/auth/verify/finish" && method == http.MethodPost:
			handleVerifyFinish(w, r)
		case path == "/api/auth/credentials" && method == http.MethodGet:
			handleListCredentials(w, r)
		case strings.HasPrefix(path, "/api/auth/credentials/") && method == http.MethodDelete:
			handleDeleteCredential(w, r)
		case path == "/api/auth/generate-token" && method == http.MethodPost:
			handleGenerateToken(w, r)
		default:
			jsonError(w, "Not found", http.StatusNotFound)
		}
		return
	}

	// --- Auth middleware for all other /api/ routes ---
	if !validateSession(r) {
		jsonError(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// --- R2 file serving (under auth middleware) ---
	if (strings.HasPrefix(path, "/api/r2/uploads/") || strings.HasPrefix(path, "/api/r2/b/")) && method == http.MethodGet {
		handleR2Serve(w, r)
		return
	}

	// --- Bucket management routes ---
	if path == "/api/settings/buckets" && method == http.MethodGet {
		handleListBuckets(w, r)
		return
	}
	if path == "/api/settings/buckets" && method == http.MethodPost {
		handleCreateBucket(w, r)
		return
	}
	if strings.HasPrefix(path, "/api/settings/buckets/") {
		if strings.HasSuffix(path, "/sync") && method == http.MethodPost {
			handleSyncBucketUsage(w, r)
			return
		}
		if method == http.MethodPut {
			handleUpdateBucket(w, r)
			return
		}
		if method == http.MethodDelete {
			handleDeleteBucket(w, r)
			return
		}
	}

	// --- Preview link ---
	if path == "/api/preview-link" && method == http.MethodPost {
		handlePreviewLink(w, r)
		return
	}

	// --- Folder ZIP download ---
	if strings.HasPrefix(path, "/api/folders/") && strings.HasSuffix(path, "/download") && method == http.MethodGet {
		handleFolderDownload(w, r)
		return
	}

	// --- Exact path matches ---
	if path == "/api/upload" && method == http.MethodPost {
		handleUpload(w, r)
		return
	}
	if path == "/api/files" && method == http.MethodGet {
		handleListFiles(w, r)
		return
	}
	if path == "/api/folders" && method == http.MethodPost {
		handleCreateFolder(w, r)
		return
	}
	if path == "/api/search" && method == http.MethodGet {
		handleSearch(w, r)
		return
	}
	if path == "/api/stats" && method == http.MethodGet {
		handleStats(w, r)
		return
	}

	// --- Share management routes ---
	if path == "/api/shares" && method == http.MethodPost {
		handleCreateShare(w, r)
		return
	}
	if path == "/api/shares" && method == http.MethodGet {
		handleListShares(w, r)
		return
	}
	if strings.HasPrefix(path, "/api/shares/") {
		if strings.HasSuffix(path, "/toggle") && method == http.MethodPut {
			handleToggleShare(w, r)
			return
		}
		if method == http.MethodDelete {
			handleDeleteShare(w, r)
			return
		}
	}

	// --- Pattern matches for /api/files/:id/* ---
	if strings.HasPrefix(path, "/api/files/") {
		if strings.HasSuffix(path, "/move") && method == http.MethodPut {
			handleMoveFile(w, r)
			return
		}
		if strings.HasSuffix(path, "/rename") && method == http.MethodPut {
			handleRenameFile(w, r)
			return
		}
		if method == http.MethodDelete {
			handleDeleteFile(w, r)
			return
		}
	}

	// --- Pattern matches for /api/folders/:id/* ---
	if strings.HasPrefix(path, "/api/folders/") {
		if strings.HasSuffix(path, "/breadcrumb") && method == http.MethodGet {
			handleBreadcrumb(w, r)
			return
		}
		if strings.HasSuffix(path, "/move") && method == http.MethodPut {
			handleMoveFolder(w, r)
			return
		}
		if strings.HasSuffix(path, "/rename") && method == http.MethodPut {
			handleRenameFolder(w, r)
			return
		}
		if method == http.MethodDelete {
			handleDeleteFolder(w, r)
			return
		}
	}

	jsonError(w, "Not found", http.StatusNotFound)
}

// ---------- Main ----------

func main() {
	loadConfig()
	initDB()
	defer db.Close()

	// Migrate R2 config from config.json to DB on first run
	migrateConfigR2ToDB()

	// Clean up expired data on startup and periodically
	cleanupExpired()
	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			cleanupExpired()
		}
	}()

	// Daily sync at 2:00 AM
	startDailySync()

	staticDir := filepath.Join("..", "out")
	if _, err := os.Stat(staticDir); os.IsNotExist(err) {
		log.Printf("Warning: static directory %s does not exist", staticDir)
	}

	mux := http.NewServeMux()

	// API routes
	mux.HandleFunc("/api/", apiRouter)

	// Public share routes (no auth required)
	mux.HandleFunc("/s/", handleSharePage)

	// Serve static files from Next.js export with SPA fallback
	fileServer := http.FileServer(http.Dir(staticDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")

		// Try to serve the file directly
		filePath := filepath.Join(staticDir, r.URL.Path)
		if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}

		// For SPA: try path.html (Next.js static export convention)
		htmlPath := filepath.Join(staticDir, r.URL.Path+".html")
		if _, err := os.Stat(htmlPath); err == nil {
			http.ServeFile(w, r, htmlPath)
			return
		}

		// Fallback to index.html for SPA routing
		indexPath := filepath.Join(staticDir, "index.html")
		if _, err := os.Stat(indexPath); err == nil {
			http.ServeFile(w, r, indexPath)
			return
		}

		fileServer.ServeHTTP(w, r)
	})

	// Start both HTTP and HTTPS
	httpAddr := ":9090"
	httpsAddr := ":8443"

	// Check if TLS certs exist
	_, certErr := os.Stat("cert.pem")
	_, keyErr := os.Stat("key.pem")
	hasTLS := certErr == nil && keyErr == nil

	if hasTLS {
		go func() {
			fmt.Printf("HTTPS server listening on https://0.0.0.0%s\n", httpsAddr)
			if err := http.ListenAndServeTLS(httpsAddr, "cert.pem", "key.pem", mux); err != nil {
				log.Printf("HTTPS server error: %v", err)
			}
		}()
	}

	fmt.Printf("HTTP server listening on http://0.0.0.0%s\n", httpAddr)
	log.Fatal(http.ListenAndServe(httpAddr, mux))
}
