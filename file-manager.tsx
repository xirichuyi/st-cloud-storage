"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import {
  ArrowLeft,
  ArrowUpDown,
  CheckSquare,
  ChevronRight,
  Clock,
  Cloud,
  Copy,
  Download,
  Edit3,
  Eye,
  File,
  FileAudio,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderUp,
  HardDrive,
  ImageIcon,
  Fingerprint,
  KeyRound,
  LayoutGrid,
  LayoutList,
  Loader2,
  LogOut,
  Menu,
  MoreVertical,
  Move,
  Music,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Share2,
  Shield,
  Square,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react"
import { Switch } from "@/components/ui/switch"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import ReactDOM from "react-dom"
import { toast, Toaster } from "sonner"

// ---------- Types ----------

interface FileItem {
  id: number
  originalName: string
  fileName: string
  name: string
  size: number
  url: string
  createdAt: string
  updatedAt?: string
  folderId?: number | null
  type: "file"
}

interface FolderItem {
  id: number
  name: string
  parentId: number | null
  createdAt: string
  updatedAt?: string
  itemCount?: number
  type: "folder"
}

type ListItem = FileItem | FolderItem

interface BreadcrumbSegment {
  id: number | null
  name: string
}

interface StorageStats {
  totalFiles: number
  totalFolders: number
  totalSize: number
  categories?: {
    images: number
    videos: number
    documents: number
    audio: number
    others: number
  }
}

interface CredentialRecord {
  id: number
  name: string
  createdAt: string
}

type CategoryFilter = "all" | "recent" | "images" | "videos" | "documents" | "audio" | "others"
type ViewMode = "grid" | "list"
type SortMode = "name-asc" | "name-desc" | "size-asc" | "size-desc" | "date-asc" | "date-desc"

// ---------- Clipboard Helper (works on HTTP) ----------

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return } catch {}
  }
  // Fallback for HTTP
  const ta = document.createElement("textarea")
  ta.value = text
  ta.style.cssText = "position:fixed;left:-9999px;top:-9999px"
  document.body.appendChild(ta)
  ta.select()
  document.execCommand("copy")
  document.body.removeChild(ta)
}

// ---------- WebAuthn Base64URL Helpers ----------

function base64urlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let str = ""
  for (const byte of bytes) str += String.fromCharCode(byte)
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64urlDecode(str: string): ArrayBuffer {
  str = str.replace(/-/g, "+").replace(/_/g, "/")
  while (str.length % 4) str += "="
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

// ---------- API Fetch Helper ----------

let _onAuthExpired: (() => void) | null = null

async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const token = localStorage.getItem("session")
  const res = await fetch(url, {
    ...options,
    credentials: "include",
    headers: {
      ...options?.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (res.status === 401) {
    localStorage.removeItem("session")
    _onAuthExpired?.()
  }
  return res
}

// ---------- Helpers ----------

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function timeAgo(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000)

  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tiff"]
const VIDEO_EXTS = ["mp4", "mov", "avi", "mkv", "webm", "flv"]
const AUDIO_EXTS = ["mp3", "wav", "ogg", "flac", "aac", "m4a"]
const DOC_EXTS = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "rtf", "odt", "ods", "odp"]
const ARCHIVE_EXTS = ["zip", "rar", "7z", "tar", "gz", "bz2"]
const CODE_EXTS = ["js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "c", "cpp", "h", "css", "html", "json", "yaml", "yml", "xml", "sh", "sql", "md"]
const TEXT_EXTS = ["txt", "csv", "rtf", "log", "md", ...CODE_EXTS]

function getFileExtension(name: string): string {
  const parts = name.split(".")
  return parts.length > 1 ? parts.pop()!.toLowerCase() : ""
}

function getFileCategory(name: string): "images" | "videos" | "documents" | "audio" | "others" {
  const ext = getFileExtension(name)
  if (IMAGE_EXTS.includes(ext)) return "images"
  if (VIDEO_EXTS.includes(ext)) return "videos"
  if (AUDIO_EXTS.includes(ext)) return "audio"
  if (DOC_EXTS.includes(ext)) return "documents"
  return "others"
}

function getFileIcon(name: string, size: string = "h-10 w-10") {
  const ext = getFileExtension(name)
  if (IMAGE_EXTS.includes(ext)) return <FileImage className={cn(size, "text-pink-500")} />
  if (["pdf"].includes(ext)) return <FileText className={cn(size, "text-red-500")} />
  if (["doc", "docx", "txt", "rtf", "odt"].includes(ext)) return <FileText className={cn(size, "text-blue-500")} />
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return <FileSpreadsheet className={cn(size, "text-emerald-600")} />
  if (["ppt", "pptx", "odp"].includes(ext)) return <FileText className={cn(size, "text-orange-500")} />
  if (VIDEO_EXTS.includes(ext)) return <FileVideo className={cn(size, "text-purple-500")} />
  if (AUDIO_EXTS.includes(ext)) return <FileAudio className={cn(size, "text-amber-600")} />
  if (ARCHIVE_EXTS.includes(ext)) return <FileArchive className={cn(size, "text-amber-700")} />
  if (CODE_EXTS.includes(ext)) return <FileCode className={cn(size, "text-emerald-500")} />
  return <File className={cn(size, "text-[#757c81]")} />
}

function getExtensionColor(ext: string): string {
  if (IMAGE_EXTS.includes(ext)) return "bg-[#e4e2e5] text-pink-600"
  if (VIDEO_EXTS.includes(ext)) return "bg-[#e4e2e5] text-purple-600"
  if (AUDIO_EXTS.includes(ext)) return "bg-[#e4e2e5] text-amber-700"
  if (["pdf"].includes(ext)) return "bg-[#e4e2e5] text-red-600"
  if (["doc", "docx", "txt", "rtf", "odt"].includes(ext)) return "bg-[#e4e2e5] text-blue-600"
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return "bg-[#e4e2e5] text-emerald-600"
  if (["ppt", "pptx", "odp"].includes(ext)) return "bg-[#e4e2e5] text-orange-600"
  if (ARCHIVE_EXTS.includes(ext)) return "bg-[#e4e2e5] text-amber-700"
  if (CODE_EXTS.includes(ext)) return "bg-[#e4e2e5] text-emerald-600"
  return "bg-[#e4e2e5] text-[#525154]"
}

function getListFileIconBg(name: string): string {
  const ext = getFileExtension(name)
  if (["pdf"].includes(ext)) return "bg-red-50"
  if (IMAGE_EXTS.includes(ext)) return "bg-blue-50"
  if (VIDEO_EXTS.includes(ext)) return "bg-purple-50"
  if (["doc", "docx", "txt", "rtf", "odt"].includes(ext)) return "bg-indigo-50"
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return "bg-emerald-50"
  if (["ppt", "pptx", "odp"].includes(ext)) return "bg-orange-50"
  if (AUDIO_EXTS.includes(ext)) return "bg-amber-50"
  if (ARCHIVE_EXTS.includes(ext)) return "bg-amber-50"
  if (CODE_EXTS.includes(ext)) return "bg-emerald-50"
  return "bg-[#e4e9ee]"
}

function isFolder(item: ListItem): item is FolderItem {
  return item.type === "folder"
}

function isPreviewable(name: string): boolean {
  const ext = getFileExtension(name)
  return (
    IMAGE_EXTS.includes(ext) ||
    VIDEO_EXTS.includes(ext) ||
    AUDIO_EXTS.includes(ext) ||
    ext === "pdf" ||
    OFFICE_EXTS.includes(ext) ||
    TEXT_EXTS.includes(ext)
  )
}

const OFFICE_EXTS = ["doc", "docx", "xls", "xlsx", "ppt", "pptx"]

function getPreviewType(name: string): "image" | "video" | "audio" | "pdf" | "text" | "office" | null {
  const ext = getFileExtension(name)
  if (IMAGE_EXTS.includes(ext)) return "image"
  if (VIDEO_EXTS.includes(ext)) return "video"
  if (AUDIO_EXTS.includes(ext)) return "audio"
  if (ext === "pdf") return "pdf"
  if (OFFICE_EXTS.includes(ext)) return "office"
  if (TEXT_EXTS.includes(ext)) return "text"
  return null
}

// ---------- Login Page ----------

function LoginPage({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [isMobile, setIsMobile] = useState(false)
  const [loginMode, setLoginMode] = useState<"fingerprint" | "token">("fingerprint")
  const [token, setToken] = useState("")
  const [loading, setLoading] = useState(false)
  const [generatedCode, setGeneratedCode] = useState<string | null>(null)
  const [codeExpiry, setCodeExpiry] = useState(0)
  const [webAuthnAvailable, setWebAuthnAvailable] = useState(false)
  const [hasCredentials, setHasCredentials] = useState(false)
  const codeTimerRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => () => { if (codeTimerRef.current) clearInterval(codeTimerRef.current) }, [])

  useEffect(() => {
    const mobile =
      window.innerWidth < 768 ||
      /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    setIsMobile(mobile)

    const waAvailable = !!(window.PublicKeyCredential && navigator.credentials?.create)
    setWebAuthnAvailable(waAvailable)

    if (!waAvailable) {
      setLoginMode("token")
    }

    // Check if any credentials are registered
    if (waAvailable) {
      fetch("/api/auth/verify/start", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      })
        .then((r) => {
          if (r.ok) {
            setHasCredentials(true)
          } else {
            setLoginMode("token")
          }
        })
        .catch(() => {
          setLoginMode("token")
        })
    }
  }, [])

  const handleTokenLogin = async () => {
    if (!token.trim()) return
    setLoading(true)
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        throw new Error(err?.error || "Invalid token")
      }
      const data = await res.json()
      if (data.sessionToken) {
        localStorage.setItem("session", data.sessionToken)
      }
      toast.success("Logged in successfully")
      onAuthenticated()
    } catch (err: any) {
      toast.error(err?.message || "Login failed")
    } finally {
      setLoading(false)
    }
  }

  const handleFingerprintLogin = async () => {
    setLoading(true)
    try {
      // Step 1: Get challenge from server
      const startRes = await fetch("/api/auth/verify/start", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      })
      if (!startRes.ok) {
        const err = await startRes.json().catch(() => null)
        throw new Error(err?.error || "Failed to start verification")
      }
      const startData = await startRes.json()

      // Step 2: Call navigator.credentials.get
      const publicKey = startData.publicKey
      const credential = await navigator.credentials.get({
        publicKey: {
          challenge: base64urlDecode(publicKey.challenge),
          allowCredentials: publicKey.allowCredentials.map((c: any) => ({
            type: c.type,
            id: base64urlDecode(c.id),
          })),
          userVerification: publicKey.userVerification || "required",
          timeout: publicKey.timeout || 60000,
          ...(publicKey.rpId ? { rpId: publicKey.rpId } : {}),
        },
      }) as PublicKeyCredential

      const response = credential.response as AuthenticatorAssertionResponse

      // Step 3: Send response to server
      const finishRes = await fetch("/api/auth/verify/finish", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId: startData.challengeId,
          credentialId: base64urlEncode(credential.rawId),
          clientDataJSON: base64urlEncode(response.clientDataJSON),
          authenticatorData: base64urlEncode(response.authenticatorData),
          signature: base64urlEncode(response.signature),
        }),
      })

      if (!finishRes.ok) {
        const err = await finishRes.json().catch(() => null)
        throw new Error(err?.error || "Verification failed")
      }

      const data = await finishRes.json()
      if (data.sessionToken) {
        localStorage.setItem("session", data.sessionToken)
      }
      toast.success("Authenticated with fingerprint")

      // Show temp token if returned
      if (data.tempToken) {
        setGeneratedCode(data.tempToken)
        setCodeExpiry(data.tempTokenExpiresIn || 300)
        if (codeTimerRef.current) clearInterval(codeTimerRef.current)
        codeTimerRef.current = setInterval(() => {
          setCodeExpiry((prev) => {
            if (prev <= 1) {
              if (codeTimerRef.current) clearInterval(codeTimerRef.current)
              return 0
            }
            return prev - 1
          })
        }, 1000)
      } else {
        onAuthenticated()
      }
    } catch (err: any) {
      if (err?.name === "NotAllowedError") {
        toast.error("Authentication was cancelled")
      } else {
        toast.error(err?.message || "Fingerprint verification failed")
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#f9f9fb] flex items-center justify-center relative overflow-hidden">
      {/* Background decoration */}
      <div className="pointer-events-none absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-[#dde3e9]/30 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-[#d6d4d7]/20 blur-[150px]" />

      <Toaster position="bottom-right" richColors />

      <div className="bg-white/70 backdrop-blur-2xl rounded-2xl shadow-[0_32px_64px_-12px_rgba(45,51,56,0.15)] border border-[#acb3b8]/10 w-full max-w-sm mx-4 p-8">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="bg-[#5e5e5e] rounded-xl p-3 flex items-center justify-center mb-3">
            <Cloud className="h-6 w-6 text-[#f8f8f8]" />
          </div>
          <h1 className="text-xl font-black text-[#2d3338] tracking-tight">ST</h1>
          <p className="text-[10px] font-medium uppercase tracking-widest text-[#596065]/70 mt-0.5">
            Cloud Storage
          </p>
        </div>

        {generatedCode ? (
          /* Show generated code after fingerprint success */
          <div className="space-y-4">
            <p className="text-center text-xs text-[#596065]">Web access code generated</p>
            <div className="relative flex items-center justify-center gap-2 p-4 bg-[#f9f9fb] rounded-xl">
              <span className="text-3xl font-black tracking-[0.4em] text-[#2d3338] uppercase font-mono">
                {generatedCode}
              </span>
              <button
                onClick={async () => {
                  try {
                    await copyToClipboard(generatedCode)
                    toast.success("Code copied!")
                  } catch {
                    toast.error("Copy failed")
                  }
                }}
                className="absolute right-3 p-2 rounded-lg hover:bg-[#e4e9ee] transition-colors"
                title="Copy code"
              >
                <Copy className="h-4 w-4 text-[#596065]" />
              </button>
            </div>
            <p className="text-center text-[11px] text-[#757c81]">
              Expires in {Math.floor(codeExpiry / 60)}:{(codeExpiry % 60).toString().padStart(2, "0")}
              {" · "}Copy code for web login
            </p>
            <button
              onClick={() => onAuthenticated()}
              className="w-full flex items-center justify-center gap-2 h-12 bg-gradient-to-br from-[#5e5e5e] to-[#525252] hover:from-[#525252] hover:to-[#484848] text-[#f8f8f8] rounded-xl text-sm font-bold shadow-[0_4px_12px_rgba(94,94,94,0.2)] transition-all"
            >
              Enter Now
            </button>
          </div>
        ) : webAuthnAvailable && hasCredentials && loginMode === "fingerprint" ? (
          /* Mobile: Fingerprint login */
          <div className="space-y-4">
            <button
              onClick={handleFingerprintLogin}
              disabled={loading}
              className="w-full flex flex-col items-center justify-center gap-3 py-8 bg-[#f9f9fb] rounded-xl hover:bg-[#f2f4f6] transition-colors disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="h-12 w-12 animate-spin text-[#757c81]" />
              ) : (
                <Fingerprint className="h-12 w-12 text-[#5e5e5e]" />
              )}
              <span className="text-sm font-bold text-[#2d3338]">
                {loading ? "Verifying..." : "Login with Biometrics"}
              </span>
            </button>
            <button
              onClick={() => setLoginMode("token")}
              className="w-full text-center text-sm text-[#596065] hover:text-[#2d3338] transition-colors"
            >
              Or enter token
            </button>
          </div>
        ) : (
          /* Token input (desktop, or mobile token mode) */
          <div className="space-y-4">
            <div>
              <input
                type="text"
                placeholder="Enter your access token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleTokenLogin()}
                autoFocus
                className="w-full h-14 bg-[#e4e9ee] border-none rounded-xl text-center text-2xl tracking-[0.3em] uppercase text-[#2d3338] placeholder:text-[#757c81] placeholder:text-sm placeholder:tracking-normal placeholder:normal-case focus:outline-none focus:ring-1 focus:ring-[#757c81]/30 transition-all"
              />
            </div>
            <button
              onClick={handleTokenLogin}
              disabled={loading || !token.trim()}
              className="w-full flex items-center justify-center gap-2 h-12 bg-gradient-to-br from-[#5e5e5e] to-[#525252] hover:from-[#525252] hover:to-[#484848] text-[#f8f8f8] rounded-xl text-sm font-bold shadow-[0_4px_12px_rgba(94,94,94,0.2)] transition-all disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Login
            </button>
            {!isMobile && (
              <p className="text-center text-[11px] text-[#757c81]">Get token from mobile app</p>
            )}
            {webAuthnAvailable && hasCredentials && (
              <button
                onClick={() => setLoginMode("fingerprint")}
                className="w-full text-center text-sm text-[#596065] hover:text-[#2d3338] transition-colors"
              >
                Use fingerprint instead
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- Settings Panel ----------

interface BucketRecord {
  id: number
  name: string
  bucketName: string
  endpoint: string
  maxSize: number
  currentSize: number
  enabled: boolean
  createdAt: string
}

function SettingsPanel() {
  const [credentials, setCredentials] = useState<CredentialRecord[]>([])
  const [loadingCredentials, setLoadingCredentials] = useState(true)
  const [showRegisterDialog, setShowRegisterDialog] = useState(false)
  const [newCredentialName, setNewCredentialName] = useState("")
  const [registering, setRegistering] = useState(false)
  const [webAuthnAvailable, setWebAuthnAvailable] = useState(false)
  const [generatingToken, setGeneratingToken] = useState(false)
  const [generatedToken, setGeneratedToken] = useState<string | null>(null)
  const [tokenExpiry, setTokenExpiry] = useState<number>(0)
  const tokenTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Bucket state
  const [buckets, setBuckets] = useState<BucketRecord[]>([])
  const [loadingBuckets, setLoadingBuckets] = useState(true)
  const [showAddBucket, setShowAddBucket] = useState(false)
  const [editBucket, setEditBucket] = useState<any>(null)
  const [editForm, setEditForm] = useState({ name: "", maxSizeGB: "", apiToken: "" })
  const [savingEdit, setSavingEdit] = useState(false)
  const [addingBucket, setAddingBucket] = useState(false)
  const [bucketForm, setBucketForm] = useState({
    name: "",
    accountId: "",
    accessKeyId: "",
    secretAccessKey: "",
    bucketName: "",
    endpoint: "",
    maxSizeGB: "10",
  })
  const [togglingBucket, setTogglingBucket] = useState<number | null>(null)
  const [deletingBucket, setDeletingBucket] = useState<number | null>(null)

  useEffect(() => {
    setWebAuthnAvailable(!!(window.PublicKeyCredential && navigator.credentials?.create))
    fetchCredentials()
    fetchBuckets()
    return () => {
      if (tokenTimerRef.current) clearInterval(tokenTimerRef.current)
    }
  }, [])

  const fetchBuckets = async () => {
    setLoadingBuckets(true)
    try {
      const res = await apiFetch("/api/settings/buckets")
      if (res.ok) {
        const data = await res.json()
        setBuckets(Array.isArray(data) ? data : [])
      }
    } catch {
      // ignore
    } finally {
      setLoadingBuckets(false)
    }
  }

  const handleAddBucket = async () => {
    setAddingBucket(true)
    try {
      const maxSize = Math.round(parseFloat(bucketForm.maxSizeGB || "10") * 1073741824)
      const res = await apiFetch("/api/settings/buckets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: bucketForm.name,
          accountId: bucketForm.accountId,
          accessKeyId: bucketForm.accessKeyId,
          secretAccessKey: bucketForm.secretAccessKey,
          bucketName: bucketForm.bucketName,
          endpoint: bucketForm.endpoint,
          maxSize,
          apiToken: bucketForm.apiToken,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        throw new Error(err?.error || "Failed to add bucket")
      }
      toast.success("Bucket added successfully")
      setShowAddBucket(false)
      setBucketForm({ name: "", accountId: "", accessKeyId: "", secretAccessKey: "", bucketName: "", endpoint: "", maxSizeGB: "10", apiToken: "" })
      fetchBuckets()
    } catch (err: any) {
      toast.error(err?.message || "Failed to add bucket")
    } finally {
      setAddingBucket(false)
    }
  }

  const handleToggleBucket = async (id: number, enabled: boolean) => {
    setTogglingBucket(id)
    try {
      const res = await apiFetch(`/api/settings/buckets/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) throw new Error()
      setBuckets((prev) => prev.map((b) => b.id === id ? { ...b, enabled } : b))
      toast.success(enabled ? "Bucket enabled" : "Bucket disabled")
    } catch {
      toast.error("Failed to update bucket")
    } finally {
      setTogglingBucket(null)
    }
  }

  const handleDeleteBucket = async (id: number) => {
    setDeletingBucket(id)
    try {
      const res = await apiFetch(`/api/settings/buckets/${id}`, { method: "DELETE" })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        throw new Error(err?.error || "Failed to delete bucket")
      }
      toast.success("Bucket deleted")
      fetchBuckets()
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete bucket")
    } finally {
      setDeletingBucket(null)
    }
  }

  const fetchCredentials = async () => {
    setLoadingCredentials(true)
    try {
      const res = await apiFetch("/api/auth/credentials")
      if (res.ok) {
        const data = await res.json()
        setCredentials(Array.isArray(data) ? data : [])
      }
    } catch {
      // ignore
    } finally {
      setLoadingCredentials(false)
    }
  }

  const handleDeleteCredential = async (id: number) => {
    try {
      const res = await apiFetch(`/api/auth/credentials/${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error()
      toast.success("Credential deleted")
      fetchCredentials()
    } catch {
      toast.error("Failed to delete credential")
    }
  }

  const handleRegister = async () => {
    setRegistering(true)
    try {
      // Step 1: Get registration options
      const startRes = await apiFetch("/api/auth/register/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      if (!startRes.ok) throw new Error("Failed to start registration")
      const startData = await startRes.json()

      const publicKey = startData.publicKey

      // Step 2: Call navigator.credentials.create
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: base64urlDecode(publicKey.challenge),
          rp: publicKey.rp,
          user: {
            ...publicKey.user,
            id: base64urlDecode(publicKey.user.id),
          },
          pubKeyCredParams: publicKey.pubKeyCredParams,
          authenticatorSelection: publicKey.authenticatorSelection,
          timeout: publicKey.timeout,
          attestation: publicKey.attestation,
        },
      }) as PublicKeyCredential

      const response = credential.response as AuthenticatorAttestationResponse

      // Step 3: Send response to server
      const finishRes = await apiFetch("/api/auth/register/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId: startData.challengeId,
          credentialId: base64urlEncode(credential.rawId),
          clientDataJSON: base64urlEncode(response.clientDataJSON),
          attestationObject: base64urlEncode(response.attestationObject),
          name: newCredentialName.trim() || "Fingerprint",
        }),
      })

      if (!finishRes.ok) throw new Error("Failed to complete registration")
      toast.success("Fingerprint registered successfully")
      setShowRegisterDialog(false)
      setNewCredentialName("")
      fetchCredentials()
    } catch (err: any) {
      if (err?.name === "NotAllowedError") {
        toast.error("Registration was cancelled")
      } else {
        toast.error(err?.message || "Failed to register fingerprint")
      }
    } finally {
      setRegistering(false)
    }
  }

  const handleGenerateToken = async () => {
    setGeneratingToken(true)
    try {
      const res = await apiFetch("/api/auth/generate-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      if (!res.ok) throw new Error("Failed to generate token")
      const data = await res.json()
      setGeneratedToken(data.token)
      setTokenExpiry(300) // 5 minutes

      // Start countdown
      if (tokenTimerRef.current) clearInterval(tokenTimerRef.current)
      tokenTimerRef.current = setInterval(() => {
        setTokenExpiry((prev) => {
          if (prev <= 1) {
            if (tokenTimerRef.current) clearInterval(tokenTimerRef.current)
            setGeneratedToken(null)
            return 0
          }
          return prev - 1
        })
      }, 1000)
    } catch {
      toast.error("Failed to generate token")
    } finally {
      setGeneratingToken(false)
    }
  }

  const copyToken = async () => {
    if (!generatedToken) return
    try {
      await copyToClipboard(generatedToken)
      toast.success("Token copied to clipboard")
    } catch {
      toast.error("Failed to copy token")
    }
  }

  const formatCountdown = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, "0")}`
  }

  return (
    <div className="flex-1 overflow-auto px-4 py-6 md:px-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h2 className="text-lg font-black text-[#2d3338] tracking-tight">Settings</h2>
          <p className="text-sm text-[#596065] mt-1">Manage security and authentication</p>
        </div>

        {/* Security Section */}
        <div className="bg-white/70 backdrop-blur-sm rounded-2xl shadow-[0_24px_48px_rgba(45,51,56,0.04)] border border-[#acb3b8]/5 p-6 space-y-6">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-[#5e5e5e]" />
            <h3 className="text-base font-bold text-[#2d3338] tracking-tight">Security</h3>
          </div>

          {/* Registered Fingerprints */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold text-[#2d3338]">Registered Fingerprints</h4>
              {webAuthnAvailable && (
                <button
                  onClick={() => setShowRegisterDialog(true)}
                  className="flex items-center gap-1.5 text-sm text-[#5e5e5e] hover:text-[#2d3338] font-medium transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Register New
                </button>
              )}
            </div>

            {!webAuthnAvailable && (
              <div className="text-center py-4 px-3 bg-amber-50 rounded-xl">
                <p className="text-sm text-amber-700">Biometric auth requires HTTPS with a valid certificate</p>
              </div>
            )}

            {loadingCredentials ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-[#757c81]" />
              </div>
            ) : credentials.length === 0 ? (
              <div className="text-center py-6 bg-[#f9f9fb] rounded-xl">
                <Fingerprint className="h-8 w-8 text-[#757c81] mx-auto mb-2" />
                <p className="text-sm text-[#596065]">No fingerprints registered</p>
                {webAuthnAvailable && (
                  <button
                    onClick={() => setShowRegisterDialog(true)}
                    className="mt-3 text-sm text-[#5e5e5e] hover:text-[#2d3338] font-medium transition-colors"
                  >
                    Register your first fingerprint
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {credentials.map((cred) => (
                  <div
                    key={cred.id}
                    className="flex items-center justify-between p-3 bg-[#f9f9fb] rounded-xl"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Fingerprint className="h-4 w-4 text-[#5e5e5e] shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-[#2d3338] truncate">
                          {cred.name}
                        </p>
                        <p className="text-[11px] text-[#757c81]">
                          Added {formatDate(cred.createdAt)}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteCredential(cred.id)}
                      className="p-1.5 rounded-lg hover:bg-red-50 text-[#757c81] hover:text-red-500 transition-colors shrink-0"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-[#acb3b8]/10" />

          {/* Generate Web Token */}
          <div className="space-y-3">
            <h4 className="text-sm font-bold text-[#2d3338]">Web Access Token</h4>
            <p className="text-[12px] text-[#596065]">
              Generate a temporary token to log in from a desktop browser.
            </p>

            {generatedToken ? (
              <div className="space-y-3">
                <div className="flex items-center justify-center gap-2 p-4 bg-[#f9f9fb] rounded-xl">
                  <span className="text-3xl font-black tracking-[0.4em] text-[#2d3338] uppercase font-mono">
                    {generatedToken}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-[#757c81]">
                    Expires in {formatCountdown(tokenExpiry)}
                  </span>
                  <button
                    onClick={copyToken}
                    className="flex items-center gap-1.5 text-sm text-[#5e5e5e] hover:text-[#2d3338] font-medium transition-colors"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={handleGenerateToken}
                disabled={generatingToken}
                className="flex items-center justify-center gap-2 w-full h-11 bg-[#e4e9ee] hover:bg-[#dde3e9] text-[#2d3338] rounded-xl text-sm font-bold transition-colors disabled:opacity-50"
              >
                {generatingToken ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <KeyRound className="h-4 w-4" />
                )}
                Generate Token
              </button>
            )}
          </div>
        </div>

        {/* Storage Overview */}
        {buckets.length > 0 && (() => {
          const totalUsed = buckets.reduce((s, b) => s + (b.currentSize || 0), 0)
          const totalMax = buckets.reduce((s, b) => s + (b.maxSize || 0), 0)
          const totalPercent = totalMax > 0 ? Math.round((totalUsed / totalMax) * 100) : 0
          const totalObjects = buckets.reduce((s, b) => s + (b.objectCount || 0), 0)
          return (
            <div className="bg-white/70 backdrop-blur-sm rounded-2xl shadow-[0_24px_48px_rgba(45,51,56,0.04)] border border-[#acb3b8]/5 p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <HardDrive className="h-5 w-5 text-[#5e5e5e]" />
                  <h3 className="text-base font-bold text-[#2d3338] tracking-tight">Storage Overview</h3>
                </div>
                <button
                  onClick={async () => {
                    for (const bucket of buckets) {
                      try {
                        const res = await apiFetch(`/api/settings/buckets/${bucket.id}/sync`, { method: "POST" })
                        if (res.ok) {
                          const data = await res.json()
                          setBuckets((prev) => prev.map((b) => b.id === bucket.id ? { ...b, currentSize: data.currentSize } : b))
                        }
                      } catch {}
                    }
                    toast.success("All buckets synced")
                  }}
                  className="flex items-center gap-1.5 text-xs text-[#5e5e5e] hover:text-[#2d3338] font-medium transition-colors"
                >
                  <RefreshCw className="h-3 w-3" />
                  Sync All
                </button>
              </div>

              {/* Total usage */}
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-3xl font-black text-[#2d3338] tracking-tight">{formatFileSize(totalUsed)}</p>
                  <p className="text-[11px] text-[#757c81] mt-0.5">of {formatFileSize(totalMax)} total capacity</p>
                </div>
                <p className="text-2xl font-black text-[#2d3338]">{totalPercent}%</p>
              </div>

              {/* Total progress bar */}
              <div className="w-full h-2 bg-[#e4e9ee] rounded-full overflow-hidden">
                <div className="h-full bg-[#5e5e5e] rounded-full transition-all duration-500" style={{ width: `${Math.min(totalPercent, 100)}%` }} />
              </div>

              {/* Per-bucket breakdown */}
              {buckets.length > 1 && (
                <div className="space-y-2 pt-2">
                  {buckets.map((bucket) => {
                    const pct = bucket.maxSize > 0 ? Math.round((bucket.currentSize / bucket.maxSize) * 100) : 0
                    const colors = ["bg-[#5e5e5e]", "bg-blue-400", "bg-emerald-400", "bg-amber-400", "bg-purple-400"]
                    const colorIdx = buckets.indexOf(bucket) % colors.length
                    return (
                      <div key={bucket.id} className="flex items-center gap-3">
                        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${colors[colorIdx]}`} />
                        <span className="text-xs text-[#2d3338] font-medium flex-1 truncate">{bucket.name}</span>
                        <span className="text-xs text-[#757c81] tabular-nums">{formatFileSize(bucket.currentSize)}</span>
                        <span className="text-[10px] text-[#757c81] w-8 text-right tabular-nums">{pct}%</span>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Stats row */}
              <div className="flex gap-4 pt-2 border-t border-[#acb3b8]/10">
                <div className="flex-1 text-center">
                  <p className="text-lg font-black text-[#2d3338]">{buckets.length}</p>
                  <p className="text-[10px] text-[#757c81] uppercase tracking-wider">Buckets</p>
                </div>
                <div className="flex-1 text-center">
                  <p className="text-lg font-black text-[#2d3338]">{buckets.filter(b => b.enabled).length}</p>
                  <p className="text-[10px] text-[#757c81] uppercase tracking-wider">Active</p>
                </div>
                <div className="flex-1 text-center">
                  <p className="text-lg font-black text-[#2d3338]">{formatFileSize(totalMax - totalUsed)}</p>
                  <p className="text-[10px] text-[#757c81] uppercase tracking-wider">Available</p>
                </div>
              </div>
            </div>
          )
        })()}

        {/* Storage Buckets Section */}
        <div className="bg-white/70 backdrop-blur-sm rounded-2xl shadow-[0_24px_48px_rgba(45,51,56,0.04)] border border-[#acb3b8]/5 p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HardDrive className="h-5 w-5 text-[#5e5e5e]" />
              <h3 className="text-base font-bold text-[#2d3338] tracking-tight">Storage Buckets</h3>
            </div>
            <button
              onClick={() => setShowAddBucket(true)}
              className="flex items-center gap-1.5 text-sm text-[#5e5e5e] hover:text-[#2d3338] font-medium transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Bucket
            </button>
          </div>

          {loadingBuckets ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-[#757c81]" />
            </div>
          ) : buckets.length === 0 ? (
            <div className="text-center py-6 bg-[#f9f9fb] rounded-xl">
              <HardDrive className="h-8 w-8 text-[#757c81] mx-auto mb-2" />
              <p className="text-sm text-[#596065]">No storage buckets configured</p>
              <button
                onClick={() => setShowAddBucket(true)}
                className="mt-3 text-sm text-[#5e5e5e] hover:text-[#2d3338] font-medium transition-colors"
              >
                Add your first bucket
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {buckets.map((bucket) => {
                const usagePercent = bucket.maxSize > 0 ? Math.min(100, Math.round((bucket.currentSize / bucket.maxSize) * 100)) : 0
                const isFull = usagePercent >= 100
                const statusColor = !bucket.enabled
                  ? "bg-[#e4e9ee] text-[#757c81]"
                  : isFull
                    ? "bg-red-50 text-red-600"
                    : "bg-emerald-50 text-emerald-600"
                const statusLabel = !bucket.enabled ? "Disabled" : isFull ? "Full" : "Active"
                const barColor = !bucket.enabled
                  ? "bg-[#acb3b8]"
                  : isFull
                    ? "bg-red-500"
                    : usagePercent > 80
                      ? "bg-amber-500"
                      : "bg-emerald-500"

                return (
                  <div key={bucket.id} className="p-4 bg-[#f9f9fb] rounded-xl space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-bold text-[#2d3338] truncate">{bucket.name}</p>
                          <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase leading-none", statusColor)}>
                            {statusLabel}
                          </span>
                        </div>
                        <p className="text-[11px] text-[#757c81] truncate mt-0.5" title={`${bucket.bucketName} - ${bucket.endpoint}`}>
                          {bucket.bucketName} &middot; {bucket.endpoint.replace(/^https?:\/\//, "").slice(0, 40)}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => {
                            setEditBucket(bucket)
                            setEditForm({ name: bucket.name, maxSizeGB: String(Math.round(bucket.maxSize / 1073741824)), apiToken: "" })
                          }}
                          className="p-1.5 rounded-lg hover:bg-[#e4e9ee] text-[#757c81] hover:text-[#2d3338] transition-colors"
                          title="Edit bucket"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={async () => {
                            try {
                              const res = await apiFetch(`/api/settings/buckets/${bucket.id}/sync`, { method: "POST" })
                              if (!res.ok) { const e = await res.json().catch(() => null); throw new Error(e?.error || "Sync failed") }
                              const data = await res.json()
                              setBuckets((prev) => prev.map((b) => b.id === bucket.id ? { ...b, currentSize: data.currentSize } : b))
                              toast.success(`Synced: ${formatFileSize(data.currentSize)} used`)
                            } catch (err: any) { toast.error(err?.message || "Sync failed") }
                          }}
                          className="p-1.5 rounded-lg hover:bg-[#e4e9ee] text-[#757c81] hover:text-[#2d3338] transition-colors"
                          title="Sync usage from R2"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                        <Switch
                          checked={bucket.enabled}
                          onCheckedChange={(v) => handleToggleBucket(bucket.id, v)}
                          disabled={togglingBucket === bucket.id}
                        />
                        <button
                          onClick={() => handleDeleteBucket(bucket.id)}
                          disabled={deletingBucket === bucket.id || bucket.currentSize > 0}
                          className="p-1.5 rounded-lg hover:bg-red-50 text-[#757c81] hover:text-red-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          title={bucket.currentSize > 0 ? "Cannot delete: bucket has files" : "Delete bucket"}
                        >
                          {deletingBucket === bucket.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                    {/* Usage bar */}
                    <div>
                      <div className="flex items-center justify-between text-[11px] text-[#596065] mb-1">
                        <span>{formatFileSize(bucket.currentSize)} / {formatFileSize(bucket.maxSize)}</span>
                        <span>{usagePercent}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-[#e4e9ee] rounded-full overflow-hidden">
                        <div
                          className={cn("h-full rounded-full transition-all duration-500", barColor)}
                          style={{ width: `${usagePercent}%` }}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Register New Fingerprint Dialog */}
      <Dialog open={showRegisterDialog} onOpenChange={(v) => { if (!v) { setShowRegisterDialog(false); setNewCredentialName("") } }}>
        <DialogContent className="sm:max-w-sm rounded-2xl bg-white shadow-[0_32px_64px_-12px_rgba(45,51,56,0.15)] border border-[#acb3b8]/5">
          <DialogHeader>
            <DialogTitle className="text-base font-bold tracking-tight text-[#2d3338]">Register Fingerprint</DialogTitle>
            <DialogDescription className="text-sm text-[#596065]">Add a fingerprint for quick biometric login.</DialogDescription>
          </DialogHeader>
          <div className="py-3 space-y-4">
            <div>
              <label className="text-xs font-bold text-[#596065] mb-1.5 block">Name</label>
              <Input
                placeholder="e.g. My Phone"
                value={newCredentialName}
                onChange={(e) => setNewCredentialName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleRegister()}
                autoFocus
                className="bg-[#e4e9ee] !border-0 !shadow-none rounded-lg text-sm focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:bg-white focus:!shadow-[0_0_0_1px_rgba(117,124,129,0.3)] transition-all h-10"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={handleRegister}
              disabled={registering}
              className="w-full bg-[#5e5e5e] hover:bg-[#525252] text-[#f8f8f8] rounded-xl"
            >
              {registering ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Fingerprint className="h-4 w-4 mr-2" />}
              Register
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Bucket Dialog */}
      <Dialog open={showAddBucket} onOpenChange={(v) => { if (!v) { setShowAddBucket(false); setBucketForm({ name: "", accountId: "", accessKeyId: "", secretAccessKey: "", bucketName: "", endpoint: "", maxSizeGB: "10", apiToken: "" }) } }}>
        <DialogContent className="sm:max-w-lg w-[95vw] rounded-2xl bg-white shadow-[0_32px_64px_-12px_rgba(45,51,56,0.15)] border border-[#acb3b8]/5">
          <DialogHeader>
            <DialogTitle className="text-base font-bold tracking-tight text-[#2d3338]">Add Storage Bucket</DialogTitle>
            <DialogDescription className="text-sm text-[#596065]">Connect a new R2 storage bucket. Credentials will be tested before saving.</DialogDescription>
          </DialogHeader>
          <div className="py-3 space-y-3">
            <div>
              <label className="text-xs font-bold text-[#596065] mb-1.5 block">S3 API Endpoint</label>
              <Input
                placeholder="https://xxx.r2.cloudflarestorage.com"
                value={bucketForm.endpoint}
                onChange={(e) => {
                  const val = e.target.value
                  setBucketForm((f) => {
                    const updated = { ...f, endpoint: val }
                    // Auto-extract Account ID from endpoint
                    const match = val.match(/https:\/\/([a-f0-9]+)\.r2\./)
                    if (match) updated.accountId = match[1]
                    return updated
                  })
                }}
                className="bg-[#e4e9ee] !border-0 !shadow-none rounded-lg text-sm focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:bg-white focus:!shadow-[0_0_0_1px_rgba(117,124,129,0.3)] transition-all h-10"
              />
              <p className="text-[10px] text-[#757c81] mt-1">From Cloudflare R2 dashboard → Account Details → S3 API</p>
            </div>
            <div>
              <label className="text-xs font-bold text-[#596065] mb-1.5 block">Access Key ID</label>
              <Input
                placeholder="Paste your Access Key ID"
                value={bucketForm.accessKeyId}
                onChange={(e) => setBucketForm((f) => ({ ...f, accessKeyId: e.target.value }))}
                className="bg-[#e4e9ee] !border-0 !shadow-none rounded-lg text-sm focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:bg-white focus:!shadow-[0_0_0_1px_rgba(117,124,129,0.3)] transition-all h-10"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-[#596065] mb-1.5 block">Secret Access Key</label>
              <Input
                type="password"
                placeholder="Paste your Secret Access Key"
                value={bucketForm.secretAccessKey}
                onChange={(e) => setBucketForm((f) => ({ ...f, secretAccessKey: e.target.value }))}
                className="bg-[#e4e9ee] !border-0 !shadow-none rounded-lg text-sm focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:bg-white focus:!shadow-[0_0_0_1px_rgba(117,124,129,0.3)] transition-all h-10"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-[#596065] mb-1.5 block">Bucket Name</label>
              <Input
                placeholder="e.g. filestore"
                value={bucketForm.bucketName}
                onChange={(e) => setBucketForm((f) => ({ ...f, bucketName: e.target.value, name: f.name || e.target.value }))}
                className="bg-[#e4e9ee] !border-0 !shadow-none rounded-lg text-sm focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:bg-white focus:!shadow-[0_0_0_1px_rgba(117,124,129,0.3)] transition-all h-10"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-[#596065] mb-1.5 block">API Token <span className="font-normal text-[#757c81]">(optional, for usage sync)</span></label>
              <Input
                type="password"
                placeholder="Cloudflare API Token"
                value={bucketForm.apiToken || ""}
                onChange={(e) => setBucketForm((f) => ({ ...f, apiToken: e.target.value }))}
                className="bg-[#e4e9ee] !border-0 !shadow-none rounded-lg text-sm focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:bg-white focus:!shadow-[0_0_0_1px_rgba(117,124,129,0.3)] transition-all h-10"
              />
              <p className="text-[10px] text-[#757c81] mt-1">For real-time storage stats. Found in R2 API Tokens page.</p>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={handleAddBucket}
              disabled={addingBucket || !bucketForm.accessKeyId.trim() || !bucketForm.secretAccessKey.trim() || !bucketForm.bucketName.trim() || !bucketForm.endpoint.trim()}
              className="w-full bg-[#5e5e5e] hover:bg-[#525252] text-[#f8f8f8] rounded-xl"
            >
              {addingBucket ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <HardDrive className="h-4 w-4 mr-2" />}
              Test & Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Bucket Dialog */}
      <Dialog open={editBucket !== null} onOpenChange={(v) => { if (!v) setEditBucket(null) }}>
        <DialogContent className="sm:max-w-md w-[95vw] rounded-2xl bg-white shadow-[0_32px_64px_-12px_rgba(45,51,56,0.15)] border border-[#acb3b8]/5">
          <DialogHeader>
            <DialogTitle className="text-base font-bold tracking-tight text-[#2d3338]">Edit Bucket</DialogTitle>
            <DialogDescription className="text-sm text-[#596065]">{editBucket?.bucketName}</DialogDescription>
          </DialogHeader>
          <div className="py-3 space-y-3">
            <div>
              <label className="text-xs font-bold text-[#596065] mb-1.5 block">Display Name</label>
              <Input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} className="bg-[#e4e9ee] !border-0 !shadow-none rounded-lg text-sm focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:bg-white focus:!shadow-[0_0_0_1px_rgba(117,124,129,0.3)] transition-all h-10" />
            </div>
            <div>
              <label className="text-xs font-bold text-[#596065] mb-1.5 block">Max Size (GB)</label>
              <Input type="number" min="1" value={editForm.maxSizeGB} onChange={(e) => setEditForm((f) => ({ ...f, maxSizeGB: e.target.value }))} className="bg-[#e4e9ee] !border-0 !shadow-none rounded-lg text-sm focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:bg-white focus:!shadow-[0_0_0_1px_rgba(117,124,129,0.3)] transition-all h-10" />
            </div>
            <div>
              <label className="text-xs font-bold text-[#596065] mb-1.5 block">API Token <span className="font-normal text-[#757c81]">(for usage sync)</span></label>
              <Input type="password" placeholder="Leave empty to keep current" value={editForm.apiToken} onChange={(e) => setEditForm((f) => ({ ...f, apiToken: e.target.value }))} className="bg-[#e4e9ee] !border-0 !shadow-none rounded-lg text-sm focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:bg-white focus:!shadow-[0_0_0_1px_rgba(117,124,129,0.3)] transition-all h-10" />
              <p className="text-[10px] text-[#757c81] mt-1">Cloudflare API Token with R2 read permission</p>
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={savingEdit}
              onClick={async () => {
                if (!editBucket) return
                setSavingEdit(true)
                try {
                  const payload: any = {}
                  if (editForm.name.trim()) payload.name = editForm.name.trim()
                  if (editForm.maxSizeGB) payload.maxSize = Math.round(parseFloat(editForm.maxSizeGB) * 1073741824)
                  if (editForm.apiToken) payload.apiToken = editForm.apiToken
                  const res = await apiFetch(`/api/settings/buckets/${editBucket.id}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                  })
                  if (!res.ok) throw new Error("Failed to update")
                  toast.success("Bucket updated")
                  setEditBucket(null)
                  fetchBuckets()
                } catch { toast.error("Failed to update bucket") } finally { setSavingEdit(false) }
              }}
              className="w-full bg-[#5e5e5e] hover:bg-[#525252] text-[#f8f8f8] rounded-xl"
            >
              {savingEdit && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------- Sidebar Nav Item ----------

function NavItem({
  icon,
  children,
  active,
  count,
  onClick,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  active?: boolean
  count?: number
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 px-4 py-3 text-sm font-medium uppercase tracking-widest rounded-xl transition-all duration-200",
        active
          ? "bg-white/50 shadow-[0_1px_3px_rgba(0,0,0,0.05),0_0_20px_rgba(94,94,94,0.1)] text-[#2d3338]"
          : "text-[#596065] hover:translate-x-1 transition-transform hover:bg-[#dde3e9]/40"
      )}
    >
      {icon}
      <span className="flex-1 text-left">{children}</span>
      {count !== undefined && (
        <span className="text-[11px] tabular-nums text-[#757c81]">{count}</span>
      )}
    </button>
  )
}

// ---------- Media Preview Modal ----------

function simpleMarkdownToHtml(md: string): string {
  let html = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  // Headers
  html = html.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>")
  html = html.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>")
  html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>")
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>")
  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>")
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code style="background:#e4e9ee;padding:1px 5px;border-radius:4px;font-size:0.875em">$1</code>')
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:#5e5e5e;text-decoration:underline">$1</a>')
  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid #e4e9ee;margin:1em 0">')
  // Line breaks: convert remaining single newlines to <br>, but respect block elements
  html = html.replace(/\n\n/g, "</p><p>")
  html = "<p>" + html + "</p>"
  html = html.replace(/<p><(h[1-6]|hr)/g, "<$1")
  html = html.replace(/<\/(h[1-6])><\/p>/g, "</$1>")
  return html
}

function MediaPreviewModal({
  file,
  open,
  onClose,
}: {
  file: FileItem | null
  open: boolean
  onClose: () => void
}) {
  const [textContent, setTextContent] = useState<string>("")
  const [loadingText, setLoadingText] = useState(false)
  const [zoom, setZoom] = useState(1)

  // Reset zoom when file changes
  useEffect(() => { setZoom(1) }, [file])


  useEffect(() => {
    if (!file || !open) return
    const previewType = getPreviewType(file.name)
    if (previewType === "text") {
      setTextContent("")
      setLoadingText(true)
      apiFetch(file.url)
        .then((r) => r.text())
        .then((t) => setTextContent(t))
        .catch(() => setTextContent("Failed to load file content."))
        .finally(() => setLoadingText(false))
    }
  }, [file, open])

  if (!file) return null

  const previewType = getPreviewType(file.name)
  const isMarkdown = getFileExtension(file.name) === "md"
  const isDarkBg = previewType === "video" || previewType === "audio" || previewType === "image"

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className={cn(
          "shadow-[0_32px_64px_-12px_rgba(45,51,56,0.15)]",
          "max-w-4xl w-[95vw] rounded-2xl",
          isDarkBg
            ? "bg-[#0c0e10] border border-[#acb3b8]/10 text-white [&>button]:text-white [&>button]:hover:text-zinc-300"
            : "bg-white border border-[#acb3b8]/5"
        )}
      >
        <DialogHeader>
          <DialogTitle
            className={cn(
              "truncate pr-8 text-sm font-bold tracking-tight",
              isDarkBg ? "text-white" : "text-[#2d3338]"
            )}
          >
            {file.name}
          </DialogTitle>
          <DialogDescription className="sr-only">Preview of {file.name}</DialogDescription>
        </DialogHeader>

        <div className="mt-2">
          {previewType === "image" && (
            <div className="relative group">
              <div
                className="flex items-center justify-center max-h-[75vh] overflow-auto rounded-xl cursor-zoom-in"
                onClick={() => setZoom((z) => z >= 3 ? 1 : z + 0.5)}
                style={{ cursor: zoom > 1 ? "zoom-out" : "zoom-in" }}
              >
                <img
                  src={file.url}
                  alt={file.name}
                  className="rounded-xl transition-transform duration-200"
                  style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}
                  onClick={(e) => { if (zoom > 1) { e.stopPropagation(); setZoom(1) } }}
                />
              </div>
              {zoom > 1 && (
                <div className="absolute top-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded-full">{Math.round(zoom * 100)}%</div>
              )}
              <div className="absolute bottom-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.5))} className="bg-black/50 text-white w-8 h-8 rounded-full flex items-center justify-center text-lg hover:bg-black/70">−</button>
                <button onClick={() => setZoom((z) => Math.min(5, z + 0.5))} className="bg-black/50 text-white w-8 h-8 rounded-full flex items-center justify-center text-lg hover:bg-black/70">+</button>
                <button onClick={() => setZoom(1)} className="bg-black/50 text-white w-8 h-8 rounded-full flex items-center justify-center text-xs hover:bg-black/70">1:1</button>
              </div>
            </div>
          )}

          {previewType === "video" && (
            <div className="rounded-xl overflow-hidden bg-black">
              <video
                src={file.url}
                controls
                autoPlay
                className="w-full max-h-[70vh]"
                controlsList="nodownload"
              >
                Your browser does not support the video tag.
              </video>
            </div>
          )}

          {previewType === "audio" && (
            <div className="flex flex-col items-center gap-6 py-12">
              <div className="w-24 h-24 rounded-full bg-[#1A1A1A] flex items-center justify-center">
                <Music className="h-12 w-12 text-[#5e5e5e]" />
              </div>
              <p className="text-zinc-300 text-sm">{file.name}</p>
              <audio src={file.url} controls autoPlay className="w-full max-w-md">
                Your browser does not support the audio tag.
              </audio>
            </div>
          )}


          {previewType === "text" && (
            <div className="max-h-[70vh] overflow-auto rounded-xl bg-[#f9f9fb] border border-[#acb3b8]/10">
              {loadingText ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-[#757c81]" />
                </div>
              ) : isMarkdown ? (
                <div
                  className="p-4 text-sm text-[#2d3338] leading-relaxed [&_h1]:text-2xl [&_h1]:font-black [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:mt-3 [&_h2]:mb-2 [&_h3]:text-lg [&_h3]:font-bold [&_h3]:mt-3 [&_h3]:mb-1 [&_p]:mb-2 [&_strong]:font-bold [&_em]:italic"
                  dangerouslySetInnerHTML={{ __html: simpleMarkdownToHtml(textContent) }}
                />
              ) : (
                <pre className="p-4 text-sm font-mono text-[#2d3338] whitespace-pre-wrap break-words">
                  {textContent}
                </pre>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Create Folder Dialog ----------

function CreateFolderDialog({
  open,
  onClose,
  onCreated,
  parentId,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
  parentId: number | null
}) {
  const [name, setName] = useState("")
  const [creating, setCreating] = useState(false)

  const handleCreate = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      const res = await apiFetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), parentId }),
      })
      if (!res.ok) throw new Error("Failed to create folder")
      toast.success(`Created folder "${name.trim()}"`)
      setName("")
      onClose()
      onCreated()
    } catch {
      toast.error("Failed to create folder")
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setName(""); onClose() } }}>
      <DialogContent className="sm:max-w-md rounded-2xl bg-white shadow-[0_32px_64px_-12px_rgba(45,51,56,0.15)] border border-[#acb3b8]/5">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-tight text-[#2d3338]">Create New Folder</DialogTitle>
          <DialogDescription className="text-sm text-[#596065]">Enter a name for the new folder.</DialogDescription>
        </DialogHeader>
        <div className="py-3">
          <Input
            placeholder="Folder name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            autoFocus
            className="bg-[#e4e9ee] !border-0 !shadow-none rounded-lg text-sm focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:bg-white focus:!shadow-[0_0_0_1px_rgba(117,124,129,0.3)] transition-all h-10"
          />
        </div>
        <DialogFooter>
          <Button onClick={handleCreate} disabled={!name.trim() || creating} className="w-full bg-[#5e5e5e] hover:bg-[#525252] text-[#f8f8f8] rounded-xl">
            {creating && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Rename Dialog ----------

function RenameDialog({
  open,
  onClose,
  item,
  onRenamed,
}: {
  open: boolean
  onClose: () => void
  item: ListItem | null
  onRenamed: () => void
}) {
  const [name, setName] = useState("")
  const [renaming, setRenaming] = useState(false)

  useEffect(() => {
    if (item) setName(item.name)
  }, [item])

  if (!item) return null

  const handleRename = async () => {
    if (!name.trim()) return
    setRenaming(true)
    try {
      const endpoint = isFolder(item)
        ? `/api/folders/${item.id}/rename`
        : `/api/files/${item.id}/rename`
      const res = await apiFetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (!res.ok) throw new Error("Rename failed")
      toast.success(`Renamed to "${name.trim()}"`)
      onClose()
      onRenamed()
    } catch {
      toast.error("Failed to rename")
    } finally {
      setRenaming(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md rounded-2xl bg-white shadow-[0_32px_64px_-12px_rgba(45,51,56,0.15)] border border-[#acb3b8]/5">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-tight text-[#2d3338]">Rename</DialogTitle>
          <DialogDescription className="text-sm text-[#596065]">Enter a new name for &quot;{item.name}&quot;.</DialogDescription>
        </DialogHeader>
        <div className="py-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleRename()}
            autoFocus
            className="bg-[#e4e9ee] !border-0 !shadow-none rounded-lg text-sm focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:bg-white focus:!shadow-[0_0_0_1px_rgba(117,124,129,0.3)] transition-all h-10"
          />
        </div>
        <DialogFooter>
          <Button onClick={handleRename} disabled={!name.trim() || renaming} className="w-full bg-[#5e5e5e] hover:bg-[#525252] text-[#f8f8f8] rounded-xl">
            {renaming && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Move Dialog ----------

function MoveDialog({
  open,
  onClose,
  item,
  onMoved,
}: {
  open: boolean
  onClose: () => void
  item: ListItem | null
  onMoved: () => void
}) {
  const [folders, setFolders] = useState<FolderItem[]>([])
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null)
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbSegment[]>([{ id: null, name: "Root" }])
  const [loading, setLoading] = useState(false)
  const [moving, setMoving] = useState(false)

  const fetchFolders = useCallback(async (folderId: number | null) => {
    setLoading(true)
    try {
      const url = folderId ? `/api/files?folderId=${folderId}` : "/api/files"
      const res = await apiFetch(url)
      if (!res.ok) throw new Error()
      const data = await res.json()
      const folderArr = data.folders ?? []
      const folderList: FolderItem[] = folderArr
        .map((f: any) => ({ ...f, type: "folder" as const }))
        .filter((f: any) => !item || !(isFolder(item) && f.id === item.id))
      setFolders(folderList)
    } catch {
      setFolders([])
    } finally {
      setLoading(false)
    }
  }, [item])

  useEffect(() => {
    if (open) {
      setCurrentFolderId(null)
      setBreadcrumb([{ id: null, name: "Root" }])
      fetchFolders(null)
    }
  }, [open, fetchFolders])

  const navigateToFolder = async (folderId: number, folderName: string) => {
    setCurrentFolderId(folderId)
    setBreadcrumb((prev) => [...prev, { id: folderId, name: folderName }])
    fetchFolders(folderId)
  }

  const navigateToBreadcrumb = (index: number) => {
    const segment = breadcrumb[index]
    setCurrentFolderId(segment.id)
    setBreadcrumb((prev) => prev.slice(0, index + 1))
    fetchFolders(segment.id)
  }

  const handleMove = async () => {
    if (!item) return
    setMoving(true)
    try {
      const endpoint = isFolder(item)
        ? `/api/folders/${item.id}/move`
        : `/api/files/${item.id}/move`
      const body = isFolder(item)
        ? { parentId: currentFolderId }
        : { folderId: currentFolderId }
      const res = await apiFetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error()
      toast.success(`Moved "${item.name}"`)
      onClose()
      onMoved()
    } catch {
      toast.error("Failed to move item")
    } finally {
      setMoving(false)
    }
  }

  if (!item) return null

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md rounded-2xl bg-white shadow-[0_32px_64px_-12px_rgba(45,51,56,0.15)] border border-[#acb3b8]/5">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-tight text-[#2d3338]">Move &quot;{item.name}&quot;</DialogTitle>
          <DialogDescription className="text-sm text-[#596065]">Select a destination folder.</DialogDescription>
        </DialogHeader>
        <div className="py-3">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1 text-sm text-[#596065] mb-3 flex-wrap">
            {breadcrumb.map((seg, i) => (
              <React.Fragment key={i}>
                {i > 0 && <ChevronRight className="h-3 w-3 text-[#757c81]" />}
                <button
                  onClick={() => navigateToBreadcrumb(i)}
                  className={cn(
                    "hover:text-[#2d3338] transition-colors",
                    i === breadcrumb.length - 1 ? "text-[#2d3338] font-bold" : ""
                  )}
                >
                  {seg.name}
                </button>
              </React.Fragment>
            ))}
          </div>

          {/* Folder list */}
          <div className="bg-white rounded-xl max-h-60 overflow-auto shadow-[0_24px_48px_rgba(45,51,56,0.04)] border border-[#acb3b8]/5">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-[#757c81]" />
              </div>
            ) : folders.length === 0 ? (
              <div className="text-center py-8 text-sm text-[#757c81]">No subfolders here</div>
            ) : (
              folders.map((folder) => (
                <button
                  key={folder.id}
                  className="flex items-center gap-2 w-full px-4 py-3 text-sm hover:bg-[#f2f4f6]/30 transition-colors text-left border-b border-[#f2f4f6]/50 last:border-b-0"
                  onClick={() => navigateToFolder(folder.id, folder.name)}
                >
                  <Folder className="h-4 w-4 text-[#5e5e5e] shrink-0" />
                  <span className="truncate text-[#2d3338]">{folder.name}</span>
                  <ChevronRight className="h-3 w-3 ml-auto text-[#757c81] shrink-0" />
                </button>
              ))
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleMove} disabled={moving} className="w-full bg-[#5e5e5e] hover:bg-[#525252] text-[#f8f8f8] rounded-xl">
            {moving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Move Here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Delete Confirmation ----------

function DeleteConfirmDialog({
  open,
  onClose,
  item,
  onDeleted,
}: {
  open: boolean
  onClose: () => void
  item: ListItem | null
  onDeleted: () => void
}) {
  const [deleting, setDeleting] = useState(false)

  if (!item) return null

  const handleDelete = async () => {
    setDeleting(true)
    try {
      const endpoint = isFolder(item)
        ? `/api/folders/${item.id}`
        : `/api/files/${item.id}`
      const res = await apiFetch(endpoint, { method: "DELETE" })
      if (!res.ok) throw new Error()
      toast.success(`Deleted "${item.name}"`)
      onClose()
      onDeleted()
    } catch {
      toast.error("Failed to delete")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent className="rounded-2xl bg-white shadow-[0_32px_64px_-12px_rgba(45,51,56,0.15)] border border-[#acb3b8]/5">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base font-bold tracking-tight text-[#2d3338]">
            Delete {isFolder(item) ? "Folder" : "File"}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-sm text-[#596065]">
            Are you sure you want to delete &quot;{item.name}&quot;?
            {isFolder(item) && " This will also delete all files and subfolders inside it."}
            {" "}This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-row gap-2">
          <AlertDialogCancel disabled={deleting} className="flex-1 bg-[#e2e2e2] border-none text-[#525252] rounded-xl hover:bg-[#d8d8d8] mt-0">Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={deleting}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white rounded-xl"
          >
            {deleting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------- Item Actions Menu ----------

function ItemActionsContent({
  item,
  onPreview,
  onDownload,
  onCopyLink,
  onShare,
  onRename,
  onMove,
  onDelete,
}: {
  item: ListItem
  onPreview: () => void
  onDownload: () => void
  onCopyLink: () => void
  onShare: () => void
  onRename: () => void
  onMove: () => void
  onDelete: () => void
}) {
  const isFile = !isFolder(item)
  const canPreview = isFile && isPreviewable(item.name)

  return (
    <>
      {canPreview && (
        <DropdownMenuItem onClick={onPreview}>
          <Eye className="h-4 w-4 mr-2 text-[#596065]" />
          Preview
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onClick={onDownload}>
        <Download className="h-4 w-4 mr-2 text-[#596065]" />
        Download
      </DropdownMenuItem>
      {isFile && (
        <DropdownMenuItem onClick={onCopyLink}>
          <Copy className="h-4 w-4 mr-2 text-[#596065]" />
          Copy Link
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onClick={onShare}>
        <Share2 className="h-4 w-4 mr-2 text-[#596065]" />
        Share
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onRename}>
        <Edit3 className="h-4 w-4 mr-2 text-[#596065]" />
        Rename
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onMove}>
        <Move className="h-4 w-4 mr-2 text-[#596065]" />
        Move to...
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onDelete} className="text-red-500 focus:text-red-500">
        <Trash2 className="h-4 w-4 mr-2" />
        Delete
      </DropdownMenuItem>
    </>
  )
}

function ContextActionsContent({
  item,
  onPreview,
  onDownload,
  onCopyLink,
  onShare,
  onRename,
  onMove,
  onDelete,
}: {
  item: ListItem
  onPreview: () => void
  onDownload: () => void
  onCopyLink: () => void
  onShare: () => void
  onRename: () => void
  onMove: () => void
  onDelete: () => void
}) {
  const isFile = !isFolder(item)
  const canPreview = isFile && isPreviewable(item.name)

  return (
    <>
      {canPreview && (
        <ContextMenuItem onClick={onPreview}>
          <Eye className="h-4 w-4 mr-2 text-[#596065]" />
          Preview
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={onDownload}>
        <Download className="h-4 w-4 mr-2 text-[#596065]" />
        Download
      </ContextMenuItem>
      {isFile && (
        <ContextMenuItem onClick={onCopyLink}>
          <Copy className="h-4 w-4 mr-2 text-[#596065]" />
          Copy Link
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={onShare}>
        <Share2 className="h-4 w-4 mr-2 text-[#596065]" />
        Share
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onRename}>
        <Edit3 className="h-4 w-4 mr-2 text-[#596065]" />
        Rename
      </ContextMenuItem>
      <ContextMenuItem onClick={onMove}>
        <Move className="h-4 w-4 mr-2 text-[#596065]" />
        Move to...
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onDelete} className="text-red-500 focus:text-red-500">
        <Trash2 className="h-4 w-4 mr-2" />
        Delete
      </ContextMenuItem>
    </>
  )
}

// ---------- Extension Badge ----------

function ExtBadge({ name }: { name: string }) {
  const ext = getFileExtension(name)
  if (!ext) return null
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase leading-none", getExtensionColor(ext))}>
      .{ext}
    </span>
  )
}

// ---------- Grid Card ----------

function GridCard({
  item,
  onOpen,
  onPreview,
  onDownload,
  onCopyLink,
  onShare,
  onRename,
  onMove,
  onDelete,
  selectionMode,
  selected,
  onToggleSelect,
}: {
  item: ListItem
  onOpen: () => void
  onPreview: () => void
  onDownload: () => void
  onCopyLink: () => void
  onShare: () => void
  onRename: () => void
  onMove: () => void
  onDelete: () => void
  selectionMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
}) {
  const isFolderItem = isFolder(item)
  const handleClick = selectionMode ? onToggleSelect : (isFolderItem ? onOpen : undefined)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn("group relative overflow-hidden rounded-xl bg-white/50 backdrop-blur-xl border border-white/40 shadow-[0_24px_48px_rgba(45,51,56,0.04)] hover:bg-white/70 hover:shadow-[0_24px_48px_rgba(45,51,56,0.08)] transition-all duration-200 cursor-pointer", selected && "ring-2 ring-[#5e5e5e] bg-[#e8ecf0]/50")}
          onDoubleClick={selectionMode ? undefined : onOpen}
          onClick={handleClick}
        >
          <div
            className="flex items-center justify-center aspect-square bg-[#f9f9fb] relative rounded-t-xl"
            onClick={selectionMode ? undefined : (!isFolderItem ? onOpen : undefined)}
          >
            {selectionMode && (
              <div className="absolute top-2 left-2 z-10">
                {selected ? (
                  <CheckSquare className="h-5 w-5 text-[#5e5e5e]" />
                ) : (
                  <Square className="h-5 w-5 text-[#acb3b8]" />
                )}
              </div>
            )}
            {isFolderItem ? (
              <Folder className="h-10 w-10 text-[#5e5e5e]" />
            ) : (
              getFileIcon(item.name, "h-10 w-10")
            )}
            {!isFolderItem && (
              <div className="absolute bottom-2 right-2">
                <ExtBadge name={item.name} />
              </div>
            )}
          </div>
          <div className="p-2.5">
            <div className="flex items-start justify-between gap-1">
              <h3 className="font-bold text-[#2d3338] text-sm tracking-tight truncate flex-1" title={item.name}>
                {item.name}
              </h3>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="p-0.5 rounded-full hover:bg-[#e4e9ee] sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0" onClick={(e) => e.stopPropagation()}>
                    <MoreVertical className="h-3.5 w-3.5 text-[#596065]" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-white/90 backdrop-blur-xl rounded-xl shadow-[0_16px_48px_rgba(45,51,56,0.12)]">
                  <ItemActionsContent item={item} onPreview={onPreview} onDownload={onDownload} onCopyLink={onCopyLink} onShare={onShare} onRename={onRename} onMove={onMove} onDelete={onDelete} />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <p className="text-[11px] text-[#596065] mt-1 truncate">
              {isFolderItem ? (
                <>{item.itemCount !== undefined ? `${item.itemCount} items` : "Folder"}</>
              ) : (
                <>{formatFileSize((item as FileItem).size)}</>
              )}
            </p>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="bg-white/90 backdrop-blur-xl rounded-xl shadow-[0_16px_48px_rgba(45,51,56,0.12)]">
        <ContextActionsContent item={item} onPreview={onPreview} onDownload={onDownload} onCopyLink={onCopyLink} onShare={onShare} onRename={onRename} onMove={onMove} onDelete={onDelete} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ---------- Mobile Swipe Row ----------

function MobileSwipeRow({
  item,
  onOpen,
  onDelete,
  onRename,
  onMove,
  onPreview,
  onDownload,
  onCopyLink,
  onShare,
  selectionMode,
  selected,
  onToggleSelect,
}: {
  item: ListItem
  onOpen: () => void
  onDelete: () => void
  onRename: () => void
  onMove: () => void
  onPreview: () => void
  onDownload: () => void
  onCopyLink: () => void
  onShare: () => void
  selectionMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef({ startX: 0, startY: 0, currentX: 0, dragging: false, open: false, time: 0, dirLocked: false })

  useEffect(() => {
    const el = containerRef.current
    const content = contentRef.current
    if (!el || !content) return

    const onStart = (e: TouchEvent) => {
      const s = stateRef.current
      // If open, close on any touch on this row
      if (s.open) {
        content.style.transition = "transform 0.35s cubic-bezier(0.32,0.72,0,1)"
        content.style.transform = "translate3d(0,0,0)"
        s.open = false
        setTimeout(() => setShowAction(false), 350)
        s.dirLocked = true
        return
      }
      s.startX = e.touches[0].clientX
      s.startY = e.touches[0].clientY
      s.time = Date.now()
      s.dragging = false
      s.dirLocked = false
      content.style.transition = "none"
    }
    const onMoveHandler = (e: TouchEvent) => {
      const s = stateRef.current
      const dx = e.touches[0].clientX - s.startX
      const dy = e.touches[0].clientY - s.startY
      if (!s.dirLocked) {
        const absDx = Math.abs(dx)
        const absDy = Math.abs(dy)
        // Wait for enough movement to decide
        if (absDx < 10 && absDy < 10) return
        // ANY vertical component that's not tiny = this is a scroll, abort entirely
        if (absDy > 6) { s.dirLocked = true; return }
        // Pure horizontal with minimal vertical
        if (absDx >= 15 && dx < 0) { s.dragging = true; s.dirLocked = true; setShowAction(true) }
        else { s.dirLocked = true; return }
      }
      if (!s.dragging) return
      e.preventDefault()
      const base = s.open ? -72 : 0
      const raw = base + dx
      const clamped = Math.min(0, Math.max(-72, raw))
      s.currentX = clamped
      content.style.transform = `translate3d(${clamped}px,0,0)`
    }
    const onEnd = () => {
      const s = stateRef.current
      if (!s.dragging) return
      const dt = Date.now() - s.time
      const velocity = dt > 0 ? Math.abs(s.currentX - (s.open ? -72 : 0)) / dt * 1000 : 0
      const snap = s.currentX < -36 || (velocity > 400 && s.currentX < -8)
      content.style.transition = "transform 0.35s cubic-bezier(0.32,0.72,0,1)"
      content.style.transform = snap ? "translate3d(-72px,0,0)" : "translate3d(0,0,0)"
      s.open = snap
      s.dragging = false
      if (!snap) setTimeout(() => setShowAction(false), 350)
    }
    el.addEventListener("touchstart", onStart, { passive: true })
    el.addEventListener("touchmove", onMoveHandler, { passive: false })
    el.addEventListener("touchend", onEnd, { passive: true })
    return () => { el.removeEventListener("touchstart", onStart); el.removeEventListener("touchmove", onMoveHandler); el.removeEventListener("touchend", onEnd) }
  }, [])

  const close = () => {
    if (contentRef.current) {
      contentRef.current.style.transition = "transform 0.35s cubic-bezier(0.32,0.72,0,1)"
      contentRef.current.style.transform = "translate3d(0,0,0)"
    }
    stateRef.current.open = false
    setTimeout(() => setShowAction(false), 350)
  }

  const [showAction, setShowAction] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const menuRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside touch
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener("touchstart", handler, { passive: true })
    return () => document.removeEventListener("touchstart", handler)
  }, [menuOpen])

  // Close swipe when tapping anywhere else
  useEffect(() => {
    if (!showAction) return
    const handler = (e: TouchEvent | MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close()
      }
    }
    document.addEventListener("touchstart", handler, { passive: true })
    document.addEventListener("mousedown", handler)
    return () => {
      document.removeEventListener("touchstart", handler)
      document.removeEventListener("mousedown", handler)
    }
  }, [showAction])

  return (
    <div ref={containerRef} className="relative overflow-hidden border-b border-[#f2f4f6]/50" style={{ WebkitUserSelect: "none" }}>
      {/* Delete button behind — only rendered when swiping */}
      {showAction && (
        <div className="absolute right-0 top-0 bottom-0 w-[72px] bg-red-500 flex items-center justify-center">
          <button className="w-full h-full flex items-center justify-center text-white" onClick={() => { close(); onDelete() }}>
            <Trash2 className="h-5 w-5" />
          </button>
        </div>
      )}
      {/* Content layer */}
      <div ref={contentRef} className={cn("relative bg-[#f9f9fb] flex items-center px-3 py-3 gap-2 active:bg-[#f0f0f2] transition-colors duration-100", selected && "bg-[#e8ecf0]")} onDoubleClick={selectionMode ? undefined : onOpen}>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Only icon + name are clickable */}
          <div className="flex items-center gap-2 min-w-0" onClick={selectionMode ? onToggleSelect : onOpen}>
            {selectionMode && (
              <div className="shrink-0">
                {selected ? (
                  <CheckSquare className="h-4 w-4 text-[#5e5e5e]" />
                ) : (
                  <Square className="h-4 w-4 text-[#acb3b8]" />
                )}
              </div>
            )}
            {isFolder(item) ? (
              <div className="w-8 h-8 rounded-lg bg-[#e4e9ee] flex items-center justify-center shrink-0">
                <Folder className="h-4 w-4 text-[#5e5e5e]" />
              </div>
            ) : (
              <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0", getListFileIconBg(item.name))}>
                {getFileIcon(item.name, "h-4 w-4")}
              </div>
            )}
            <div className="min-w-0">
              <span className="block truncate font-bold text-[#2d3338] text-xs">{item.name}</span>
              <span className="text-[11px] text-[#596065]">
                {isFolder(item) ? "Folder" : formatFileSize((item as FileItem).size)}
              </span>
            </div>
          </div>
        </div>
        <div ref={menuRef} className="shrink-0">
          <button
            className="p-2 text-[#596065] hover:bg-[#e4e9ee] rounded-lg"
            onClick={(e) => {
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              setMenuPos({ x: rect.right, y: rect.bottom })
              setMenuOpen(!menuOpen)
            }}
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuOpen && ReactDOM.createPortal(
            <div
              className="fixed z-[9999] min-w-[160px] bg-white/95 backdrop-blur-xl rounded-xl shadow-[0_16px_48px_rgba(45,51,56,0.15)] border border-[#acb3b8]/10 py-1"
              style={{ top: menuPos.y + 4, right: window.innerWidth - menuPos.x }}
              ref={menuRef}
            >
              {!isFolder(item) && isPreviewable(item.name) && (
                <button className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-[#2d3338] hover:bg-[#f2f4f6]" onClick={() => { setMenuOpen(false); onPreview() }}>
                  <Eye className="h-4 w-4" /> Preview
                </button>
              )}
              <button className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-[#2d3338] hover:bg-[#f2f4f6]" onClick={() => { setMenuOpen(false); onDownload() }}>
                <Download className="h-4 w-4" /> Download
              </button>
              {!isFolder(item) && (
                <button className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-[#2d3338] hover:bg-[#f2f4f6]" onClick={() => { setMenuOpen(false); onCopyLink() }}>
                  <Copy className="h-4 w-4" /> Copy Link
                </button>
              )}
              <button className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-[#2d3338] hover:bg-[#f2f4f6]" onClick={() => { setMenuOpen(false); onShare() }}>
                <Share2 className="h-4 w-4" /> Share
              </button>
              <button className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-[#2d3338] hover:bg-[#f2f4f6]" onClick={() => { setMenuOpen(false); onRename() }}>
                <Edit3 className="h-4 w-4" /> Rename
              </button>
              <button className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-[#2d3338] hover:bg-[#f2f4f6]" onClick={() => { setMenuOpen(false); onMove() }}>
                <Move className="h-4 w-4" /> Move to...
              </button>
              <button className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-red-500 hover:bg-red-50" onClick={() => { setMenuOpen(false); onDelete() }}>
                <Trash2 className="h-4 w-4" /> Delete
              </button>
            </div>,
            document.body
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- List Row ----------

function ListRow({
  item,
  onOpen,
  onPreview,
  onDownload,
  onCopyLink,
  onShare,
  onRename,
  onMove,
  onDelete,
  selectionMode,
  selected,
  onToggleSelect,
}: {
  item: ListItem
  onOpen: () => void
  onPreview: () => void
  onDownload: () => void
  onCopyLink: () => void
  onShare: () => void
  onRename: () => void
  onMove: () => void
  onDelete: () => void
  selectionMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
}) {
  const handleRowClick = selectionMode ? onToggleSelect : onOpen

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <TableRow
          className={cn("group cursor-pointer hover:bg-[#f2f4f6]/30 transition-colors border-b border-[#f2f4f6]/50", selected && "bg-[#e8ecf0]/50")}
          onDoubleClick={selectionMode ? undefined : onOpen}
        >
          <TableCell className="px-3 py-3 sm:px-6 sm:py-4">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0" onClick={handleRowClick}>
              {selectionMode && (
                <div className="shrink-0">
                  {selected ? (
                    <CheckSquare className="h-4 w-4 text-[#5e5e5e]" />
                  ) : (
                    <Square className="h-4 w-4 text-[#acb3b8]" />
                  )}
                </div>
              )}
              {isFolder(item) ? (
                <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-[#e4e9ee] flex items-center justify-center shrink-0">
                  <Folder className="h-4 w-4 sm:h-5 sm:w-5 text-[#5e5e5e]" />
                </div>
              ) : (
                <div className={cn("w-8 h-8 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center shrink-0", getListFileIconBg(item.name))}>
                  {getFileIcon(item.name, "h-4 w-4 sm:h-5 sm:w-5")}
                </div>
              )}
              <span className="truncate font-bold text-[#2d3338] text-xs sm:text-sm tracking-tight">{item.name}</span>
              {!isFolder(item) && <span className="hidden sm:inline"><ExtBadge name={item.name} /></span>}
            </div>
          </TableCell>
          <TableCell className="text-[#596065] text-[12px] hidden sm:table-cell text-right tabular-nums px-3 py-3 sm:px-6 sm:py-4">
            {isFolder(item)
              ? item.itemCount !== undefined
                ? `${item.itemCount} items`
                : "--"
              : formatFileSize((item as FileItem).size)}
          </TableCell>
          <TableCell className="text-[#596065] text-[12px] hidden md:table-cell text-right px-3 py-3 sm:px-6 sm:py-4">
            {formatDate(item.updatedAt || item.createdAt)}
          </TableCell>
          <TableCell className="text-right px-3 py-3 sm:px-6 sm:py-4">
            <div className="flex items-center justify-end gap-0.5">
              {!isFolder(item) && (
                <>
                  <button onClick={(e) => { e.stopPropagation(); onShare() }} className="h-8 w-8 flex items-center justify-center rounded-full sm:opacity-0 sm:group-hover:opacity-100 transition-opacity text-[#596065] hover:text-[#2d3338] hover:bg-[#e4e9ee]" title="Share">
                    <Share2 className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); onDownload() }} className="h-8 w-8 flex items-center justify-center rounded-full sm:opacity-0 sm:group-hover:opacity-100 transition-opacity text-[#596065] hover:text-[#2d3338] hover:bg-[#e4e9ee]" title="Download">
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity text-[#596065] hover:text-[#2d3338] hover:bg-[#e4e9ee] rounded-full">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-white/90 backdrop-blur-xl rounded-xl shadow-[0_16px_48px_rgba(45,51,56,0.12)]">
                  <ItemActionsContent item={item} onPreview={onPreview} onDownload={onDownload} onCopyLink={onCopyLink} onShare={onShare} onRename={onRename} onMove={onMove} onDelete={onDelete} />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </TableCell>
        </TableRow>
      </ContextMenuTrigger>
      <ContextMenuContent className="bg-white/90 backdrop-blur-xl rounded-xl shadow-[0_16px_48px_rgba(45,51,56,0.12)]">
        <ContextActionsContent
          item={item}
          onPreview={onPreview}
          onDownload={onDownload}
          onCopyLink={onCopyLink}
          onShare={onShare}
          onRename={onRename}
          onMove={onMove}
          onDelete={onDelete}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ---------- Share Dialog ----------

interface ShareRecord {
  id: string
  fileId: number
  folderId?: number
  enabled: boolean
  code?: string | null
  expiresAt?: string | null
  createdAt: string
  type?: "file" | "folder"
}

function ShareDialog({
  open,
  onClose,
  file,
}: {
  open: boolean
  onClose: () => void
  file: ListItem | null
}) {
  const [loading, setLoading] = useState(false)
  const [existingShares, setExistingShares] = useState<ShareRecord[]>([])
  const [checked, setChecked] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)

  // Create form state
  const [requireCode, setRequireCode] = useState(false)
  const [accessCode, setAccessCode] = useState("")
  const [expiration, setExpiration] = useState("never")
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const isFolderShare = file ? isFolder(file) : false

  // Fetch existing shares when dialog opens
  useEffect(() => {
    if (!open || !file) {
      setExistingShares([])
      setChecked(false)
      setShowCreateForm(false)
      setRequireCode(false)
      setAccessCode("")
      setExpiration("never")
      return
    }
    setLoading(true)
    setChecked(false)
    apiFetch("/api/shares")
      .then((r) => r.json())
      .then((data) => {
        const shares: ShareRecord[] = Array.isArray(data) ? data : data.shares ?? []
        const matches = isFolder(file)
          ? shares.filter((s) => s.folderId === file.id)
          : shares.filter((s) => s.fileId === file.id)
        setExistingShares(matches)
        setShowCreateForm(matches.length === 0)
      })
      .catch(() => setExistingShares([]))
      .finally(() => {
        setLoading(false)
        setChecked(true)
      })
  }, [open, file])

  const generateCode = () => {
    const code = String(Math.floor(1000 + Math.random() * 9000))
    setAccessCode(code)
    return code
  }

  const handleCreate = async () => {
    if (!file) return
    setCreating(true)
    try {
      const body: Record<string, any> = isFolder(file)
        ? { folderId: file.id }
        : { fileId: file.id }
      if (requireCode) {
        body.code = accessCode || generateCode()
      }
      if (expiration !== "never") {
        const seconds: Record<string, number> = {
          "1h": 3600,
          "1d": 86400,
          "7d": 604800,
          "30d": 2592000,
        }
        body.expiresIn = seconds[expiration] ?? 0
      }
      const res = await apiFetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error("Failed to create share")
      const share: ShareRecord = await res.json()
      setExistingShares((prev) => [...prev, share])
      setShowCreateForm(false)
      setRequireCode(false)
      setAccessCode("")
      setExpiration("never")
      toast.success("Share link created")
    } catch {
      toast.error("Failed to create share link")
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (shareId: string) => {
    setDeleting(shareId)
    try {
      const res = await apiFetch(`/api/shares/${shareId}`, { method: "DELETE" })
      if (!res.ok) throw new Error()
      setExistingShares((prev) => prev.filter((s) => s.id !== shareId))
      toast.success("Share link deleted")
    } catch {
      toast.error("Failed to delete share link")
    } finally {
      setDeleting(null)
    }
  }

  if (!file) return null

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[95vw] sm:max-w-md rounded-2xl bg-white shadow-[0_32px_64px_-12px_rgba(45,51,56,0.15)] border border-[#acb3b8]/5 max-h-[85vh] overflow-y-auto [&::-webkit-scrollbar]:hidden">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-tight text-[#2d3338]">
            {isFolderShare ? "Share Folder" : "Share File"}
          </DialogTitle>
          <DialogDescription className="text-sm text-[#596065] truncate">
            {file.name}
            {!isFolderShare && "size" in file && (file as any).size != null && (
              <span className="ml-2 text-[#757c81]">({formatFileSize((file as any).size)})</span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 space-y-3">
          {/* Loading state */}
          {(loading || !checked) && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-[#757c81]" />
            </div>
          )}

          {/* Existing shares list */}
          {checked && existingShares.length > 0 && (
            <div className="space-y-3">
              <label className="text-xs font-bold text-[#596065] block">
                Active Shares ({existingShares.length})
              </label>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {existingShares.map((share) => {
                  const shareUrl = share.code
                    ? `${window.location.origin}/s/${share.id}?code=${share.code}`
                    : `${window.location.origin}/s/${share.id}`
                  const isDeleting = deleting === share.id

                  return (
                    <div
                      key={share.id}
                      className="p-3 bg-[#f9f9fb] rounded-xl space-y-2 border border-[#e4e9ee]"
                    >
                      {/* URL row */}
                      <div className="flex items-center gap-2">
                        <Share2 className="h-3.5 w-3.5 text-[#757c81] shrink-0" />
                        <span className="flex-1 text-xs font-mono text-[#2d3338] break-all select-all leading-tight">
                          {shareUrl}
                        </span>
                        <button
                          onClick={async () => {
                            await copyToClipboard(shareUrl)
                            toast.success("Link copied")
                          }}
                          className="p-1.5 rounded-lg hover:bg-[#e4e9ee] transition-colors shrink-0"
                          title="Copy link"
                        >
                          <Copy className="h-3.5 w-3.5 text-[#596065]" />
                        </button>
                      </div>

                      {/* Code row */}
                      {share.code && (
                        <div className="flex items-center gap-2">
                          <KeyRound className="h-3.5 w-3.5 text-[#757c81] shrink-0" />
                          <span className="flex-1 text-sm font-mono font-bold tracking-[0.2em] text-[#2d3338]">
                            {share.code}
                          </span>
                          <button
                            onClick={async () => {
                              await copyToClipboard(share.code!)
                              toast.success("Code copied")
                            }}
                            className="p-1.5 rounded-lg hover:bg-[#e4e9ee] transition-colors shrink-0"
                            title="Copy code"
                          >
                            <Copy className="h-3.5 w-3.5 text-[#596065]" />
                          </button>
                        </div>
                      )}

                      {/* Expiration info */}
                      {share.expiresAt && (
                        <div className="flex items-center gap-2">
                          <Clock className="h-3.5 w-3.5 text-[#757c81] shrink-0" />
                          <span className="text-[12px] text-[#596065]">
                            {new Date(share.expiresAt) > new Date()
                              ? `Expires ${timeAgo(share.expiresAt).replace(" ago", "").replace("just now", "soon")}`
                              : "Expired"}
                            {" \u00b7 "}
                            {formatDate(share.expiresAt)}
                          </span>
                        </div>
                      )}

                      {/* Created date */}
                      {share.createdAt && (
                        <div className="text-[11px] text-[#acb3b8]">
                          Created {timeAgo(share.createdAt)}
                        </div>
                      )}

                      {/* Action buttons */}
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          onClick={async () => {
                            let text = `${isFolderShare ? "Folder" : "File"}: ${file.name}\nLink: ${shareUrl}`
                            if (share.code) text += `\nCode: ${share.code}`
                            text += `\n\u2014 Shared via ST`
                            await copyToClipboard(text)
                            toast.success("Share info copied")
                          }}
                          className="flex-1 flex items-center justify-center gap-1.5 h-8 bg-[#5e5e5e] hover:bg-[#525252] text-[#f8f8f8] rounded-lg text-xs font-bold transition-colors"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          Copy All
                        </button>
                        <button
                          onClick={() => handleDelete(share.id)}
                          disabled={isDeleting}
                          className="flex items-center justify-center gap-1.5 h-8 px-3 text-red-500 hover:bg-red-50 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                          title="Delete share"
                        >
                          {isDeleting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Create New button (when shares exist and form is hidden) */}
          {checked && !showCreateForm && (
            <button
              onClick={() => {
                setShowCreateForm(true)
                setRequireCode(false)
                setAccessCode("")
                setExpiration("never")
              }}
              className="w-full flex items-center justify-center gap-2 h-10 border border-dashed border-[#acb3b8] hover:border-[#596065] hover:bg-[#f9f9fb] text-[#596065] rounded-xl text-sm font-medium transition-colors"
            >
              <Plus className="h-4 w-4" />
              Create New Share Link
            </button>
          )}

          {/* Create form */}
          {checked && showCreateForm && (
            <div className="space-y-4">
              {existingShares.length > 0 && (
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-[#596065]">New Share Link</label>
                  <button
                    onClick={() => setShowCreateForm(false)}
                    className="text-xs text-[#757c81] hover:text-[#2d3338] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* Require access code toggle */}
              <div className="flex items-center justify-between p-3 bg-[#f9f9fb] rounded-xl">
                <div>
                  <p className="text-sm font-bold text-[#2d3338]">Require access code</p>
                  <p className="text-[11px] text-[#757c81]">Protect with a 4-digit code</p>
                </div>
                <Switch
                  checked={requireCode}
                  onCheckedChange={(v) => {
                    setRequireCode(v)
                    if (v && !accessCode) generateCode()
                  }}
                />
              </div>

              {/* Access code input */}
              {requireCode && (
                <div>
                  <label className="text-xs font-bold text-[#596065] mb-1.5 block">Access Code</label>
                  <div className="flex items-center gap-2">
                    <Input
                      value={accessCode}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, "").slice(0, 4)
                        setAccessCode(v)
                      }}
                      placeholder="1234"
                      maxLength={4}
                      className="flex-1 bg-[#f9f9fb] !border-0 !shadow-none rounded-xl text-center text-[16px] sm:text-2xl font-black tracking-[0.3em] font-mono text-[#2d3338] placeholder:text-[#757c81] placeholder:text-sm placeholder:tracking-normal placeholder:font-normal focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!shadow-[0_0_0_1px_rgba(117,124,129,0.3)] transition-all h-12 sm:h-14"
                    />
                    <button
                      onClick={generateCode}
                      className="h-14 px-4 rounded-xl bg-[#e4e9ee] hover:bg-[#d8d8d8] text-[#596065] text-sm font-bold transition-colors shrink-0"
                    >
                      Random
                    </button>
                  </div>
                </div>
              )}

              {/* Expiration select */}
              <div>
                <label className="text-xs font-bold text-[#596065] mb-1.5 block">Expiration</label>
                <Select value={expiration} onValueChange={setExpiration}>
                  <SelectTrigger className="w-full bg-[#f9f9fb] !border-0 !shadow-none rounded-xl text-[16px] sm:text-sm text-[#2d3338] focus-visible:!ring-0 h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-white/90 backdrop-blur-xl rounded-xl shadow-[0_16px_48px_rgba(45,51,56,0.12)]">
                    <SelectItem value="never">Never</SelectItem>
                    <SelectItem value="1h">1 hour</SelectItem>
                    <SelectItem value="1d">1 day</SelectItem>
                    <SelectItem value="7d">7 days</SelectItem>
                    <SelectItem value="30d">30 days</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Create button */}
              <Button
                onClick={handleCreate}
                disabled={creating || (requireCode && accessCode.length < 4)}
                className="w-full bg-[#5e5e5e] hover:bg-[#525252] text-[#f8f8f8] rounded-xl h-11"
              >
                {creating ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Share2 className="h-4 w-4 mr-2" />
                )}
                Create Share Link
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Main Component ----------

export default function FileManager() {
  // Auth state
  const [authChecked, setAuthChecked] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)

  // Data state
  const [items, setItems] = useState<ListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // Navigation state
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null)
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbSegment[]>([])
  const [category, setCategory] = useState<CategoryFilter>("all")

  // UI state
  const [viewMode, setViewMode] = useState<ViewMode>("list")
  const [sortMode, setSortMode] = useState<SortMode>("name-asc")
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<ListItem[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showShares, setShowShares] = useState(false)
  const [allShares, setAllShares] = useState<any[]>([])
  const [sharesLoading, setSharesLoading] = useState(false)

  // Upload state
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadingFiles, setUploadingFiles] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  // Warn before closing during upload
  useEffect(() => {
    if (!uploading) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [uploading])

  // Dialog state
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [renameItem, setRenameItem] = useState<ListItem | null>(null)
  const [moveItem, setMoveItem] = useState<ListItem | null>(null)
  const [deleteItem, setDeleteItem] = useState<ListItem | null>(null)
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null)
  const [shareFile, setShareFile] = useState<ListItem | null>(null)

  // Batch selection state
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set())
  const [duplicateFile, setDuplicateFile] = useState<{ name: string; resolve: (v: "overwrite" | "rename" | "skip") => void } | null>(null)

  const searchTimerRef = useRef<NodeJS.Timeout | null>(null)
  useEffect(() => () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }, [])

  // Register global auth expired callback
  useEffect(() => {
    _onAuthExpired = () => setAuthenticated(false)
    return () => { _onAuthExpired = null }
  }, [])

  // ---------- Auth Check ----------

  useEffect(() => {
    fetch("/api/auth/check", { credentials: "include", headers: {
      ...(localStorage.getItem("session") ? { Authorization: `Bearer ${localStorage.getItem("session")}` } : {}),
    }})
      .then((r) => r.json())
      .then((data) => {
        setAuthenticated(data.authenticated === true)
      })
      .catch(() => {
        setAuthenticated(false)
      })
      .finally(() => {
        setAuthChecked(true)
      })
  }, [])

  // ---------- Data Fetching ----------

  const fetchItems = useCallback(async (folderId: number | null) => {
    try {
      setLoading(true)
      const url = folderId ? `/api/files?folderId=${folderId}` : "/api/files"
      const res = await apiFetch(url)
      if (!res.ok) throw new Error("Failed to fetch")
      const data = await res.json()
      const folders: ListItem[] = (data.folders ?? []).map((f: any) => ({
        ...f,
        type: "folder" as const,
      }))
      const files: ListItem[] = (data.files ?? []).map((f: any) => ({
        ...f,
        name: f.originalName || f.name || f.fileName,
        type: "file" as const,
      }))
      setItems([...folders, ...files])
    } catch {
      toast.error("Failed to load files")
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchBreadcrumb = useCallback(async (folderId: number | null) => {
    if (folderId === null) {
      setBreadcrumb([])
      return
    }
    try {
      const res = await apiFetch(`/api/folders/${folderId}/breadcrumb`)
      if (!res.ok) throw new Error()
      const data = await res.json()
      setBreadcrumb(Array.isArray(data) ? data : data.breadcrumb ?? [])
    } catch {
      // Fallback: keep current breadcrumb
    }
  }, [])

  const fetchStats = useCallback(async () => {
    try {
      const res = await apiFetch("/api/stats")
      if (!res.ok) return
      const data = await res.json()
      setStats(data)
    } catch {
      // Stats are non-critical
    }
  }, [])

  useEffect(() => {
    if (!authenticated) return
    if (category === "all") {
      fetchItems(currentFolderId)
      fetchBreadcrumb(currentFolderId)
    }
  }, [currentFolderId, category, refreshKey, fetchItems, fetchBreadcrumb, authenticated])

  useEffect(() => {
    if (!authenticated) return
    fetchStats()
  }, [fetchStats, authenticated])

  // Fetch category / recent items (search all files across all folders)
  useEffect(() => {
    if (!authenticated) return
    if (category !== "all" && category !== "recent") {
      setLoading(true)
      // Use search with empty query to get all files, then filter by category
      apiFetch("/api/search?q=*")
        .then((r) => r.json())
        .then((data) => {
          const arr = Array.isArray(data) ? data : data.files ?? data.results ?? []
          const mapped: ListItem[] = arr
            .map((item: any) => ({
              ...item,
              name: item.originalName || item.name || item.fileName,
              type: "file" as const,
            }))
            .filter((item: ListItem) => getFileCategory(item.name) === category)
          setItems(mapped)
        })
        .catch(() => toast.error("Failed to load files"))
        .finally(() => setLoading(false))
    } else if (category === "recent") {
      setLoading(true)
      apiFetch("/api/search?q=*")
        .then((r) => r.json())
        .then((data) => {
          const arr = Array.isArray(data) ? data : data.files ?? data.results ?? []
          const mapped: ListItem[] = arr
            .map((item: any) => ({
              ...item,
              name: item.originalName || item.name || item.fileName,
              type: "file" as const,
            }))
            .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, 50)
          setItems(mapped)
        })
        .catch(() => toast.error("Failed to load files"))
        .finally(() => setLoading(false))
    }
  }, [category, refreshKey, authenticated])

  // ---------- Search ----------

  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults(null)
      return
    }
    setSearching(true)
    try {
      const res = await apiFetch(`/api/search?q=${encodeURIComponent(query.trim())}`)
      if (!res.ok) throw new Error()
      const data = await res.json()
      const folders: ListItem[] = (data.folders ?? []).map((f: any) => ({ ...f, type: "folder" as const }))
      const files: ListItem[] = (Array.isArray(data) ? data : data.files ?? []).map((item: any) => ({
        ...item,
        name: item.originalName || item.name || item.fileName,
        type: "file" as const,
      }))
      setSearchResults([...folders, ...files])
    } catch {
      toast.error("Search failed")
    } finally {
      setSearching(false)
    }
  }, [])

  const onSearchChange = (value: string) => {
    setSearchQuery(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (!value.trim()) {
      setSearchResults(null)
      return
    }
    searchTimerRef.current = setTimeout(() => handleSearch(value), 400)
  }

  // ---------- Navigation ----------

  const navigateToFolder = (folderId: number | null) => {
    setCategory("all")
    setCurrentFolderId(folderId)
    setSearchQuery("")
    setSearchResults(null)
    setShowSettings(false)
    setSelectionMode(false)
    setSelectedItems(new Set())
  }

  // Selection helpers
  const selectionKey = (item: ListItem) => `${item.type}-${item.id}`

  const toggleSelection = (item: ListItem) => {
    const key = selectionKey(item)
    setSelectedItems((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectAll = () => {
    setSelectedItems(new Set(sortedItems.map(selectionKey)))
  }

  const cancelSelection = () => {
    setSelectionMode(false)
    setSelectedItems(new Set())
  }

  const getSelectedListItems = (): ListItem[] => {
    return sortedItems.filter((item) => selectedItems.has(selectionKey(item)))
  }

  const handleBatchDelete = async () => {
    const items = getSelectedListItems()
    if (items.length === 0) return
    const confirmed = window.confirm(`Delete ${items.length} item${items.length !== 1 ? "s" : ""}? This cannot be undone.`)
    if (!confirmed) return
    let deleted = 0
    for (const item of items) {
      try {
        const endpoint = isFolder(item) ? `/api/folders/${item.id}` : `/api/files/${item.id}`
        const res = await apiFetch(endpoint, { method: "DELETE" })
        if (res.ok) deleted++
      } catch { /* skip */ }
    }
    toast.success(`Deleted ${deleted} item${deleted !== 1 ? "s" : ""}`)
    cancelSelection()
    refresh()
  }

  const handleBatchDownload = () => {
    const items = getSelectedListItems()
    if (items.length === 0) return
    if (items.length === 1 && !isFolder(items[0])) {
      handleDownload(items[0])
    } else {
      toast.info("Zip download coming soon")
    }
  }

  const handleItemOpen = async (item: ListItem) => {
    if (isFolder(item)) {
      navigateToFolder(item.id)
    } else {
      const fileItem = item as FileItem
      const previewType = getPreviewType(fileItem.name)
      if (previewType === "pdf") {
        // PDF: open in new tab, browser handles preview
        window.open(fileItem.url, "_blank")
      } else if (previewType === "office") {
        // Office: open via Google Docs Viewer in new tab
        try {
          const res = await apiFetch("/api/preview-link", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileId: fileItem.id }),
          })
          if (!res.ok) throw new Error()
          const data = await res.json()
          const publicUrl = window.location.origin + data.url
          window.open(`https://docs.google.com/gview?url=${encodeURIComponent(publicUrl)}`, "_blank")
        } catch {
          // Fallback: open raw file
          window.open(fileItem.url, "_blank")
        }
      } else if (previewType) {
        // Image/video/audio/text: preview in modal
        setPreviewFile(fileItem)
      }
      // Non-previewable files: do nothing
    }
  }

  // ---------- File Operations ----------

  const handleDownload = (item: ListItem) => {
    if (isFolder(item)) {
      const a = document.createElement("a")
      a.href = `/api/folders/${item.id}/download`
      a.download = `${item.name}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } else {
      const file = item as FileItem
      const a = document.createElement("a")
      a.href = file.url
      a.download = file.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }
  }

  const handleCopyLink = async (file: FileItem) => {
    try {
      const url = file.url.startsWith("http") ? file.url : `${window.location.origin}${file.url}`
      await copyToClipboard(url)
      toast.success("Link copied to clipboard")
    } catch {
      toast.error("Failed to copy link")
    }
  }

  const handlePreview = async (file: FileItem) => {
    const previewType = getPreviewType(file.name)
    if (previewType === "office") {
      try {
        const res = await apiFetch("/api/preview-link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId: file.id }),
        })
        if (!res.ok) throw new Error()
        const data = await res.json()
        const publicUrl = window.location.origin + data.url
        window.open(`https://docs.google.com/gview?url=${encodeURIComponent(publicUrl)}`, "_blank")
      } catch {
        window.open(file.url, "_blank")
      }
    } else if (previewType) {
      setPreviewFile(file)
    }
  }

  const refresh = () => {
    setRefreshKey((k) => k + 1)
    fetchStats()
  }

  // ---------- Logout ----------

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: {
          ...(localStorage.getItem("session") ? { Authorization: `Bearer ${localStorage.getItem("session")}` } : {}),
        },
      })
    } catch {
      // ignore
    }
    localStorage.removeItem("session")
    window.location.reload()
  }

  // ---------- Upload ----------

  const uploadFiles = async (fileList: globalThis.FileList | globalThis.File[]) => {
    const filesToUpload = Array.from(fileList)
    if (filesToUpload.length === 0) return

    setUploading(true)
    setUploadProgress(0)
    setUploadingFiles(filesToUpload.map((f) => f.name))
    let completed = 0

    for (const file of filesToUpload) {
      const formData = new FormData()
      formData.append("file", file)
      if (category === "all" && currentFolderId) {
        formData.append("folderId", String(currentFolderId))
      }
      try {
        let res = await apiFetch("/api/upload", {
          method: "POST",
          body: formData,
        })

        // Handle duplicate file
        if (res.status === 409) {
          const action = await new Promise<"overwrite" | "rename" | "skip">((resolve) => {
            setDuplicateFile({ name: file.name, resolve })
          })

          if (action === "overwrite") {
            const retryData = new FormData()
            retryData.append("file", file)
            if (category === "all" && currentFolderId) retryData.append("folderId", String(currentFolderId))
            retryData.append("overwrite", "true")
            res = await apiFetch("/api/upload", { method: "POST", body: retryData })
          } else if (action === "rename") {
            const ext = file.name.includes(".") ? "." + file.name.split(".").pop() : ""
            const base = file.name.replace(ext, "")
            const newName = `${base}(${Date.now().toString().slice(-4)})${ext}`
            const renamedFile = new File([file], newName, { type: file.type })
            const retryData = new FormData()
            retryData.append("file", renamedFile)
            if (category === "all" && currentFolderId) retryData.append("folderId", String(currentFolderId))
            res = await apiFetch("/api/upload", { method: "POST", body: retryData })
          } else {
            completed++
            setUploadProgress(Math.round((completed / filesToUpload.length) * 100))
            continue
          }
        }

        if (!res.ok) {
          const errData = await res.json().catch(() => null)
          throw new Error(errData?.error || `Upload failed for ${file.name}`)
        }
        completed++
        setUploadProgress(Math.round((completed / filesToUpload.length) * 100))
        toast.success(`Uploaded ${file.name}`)
      } catch (err: any) {
        toast.error(err?.message || `Failed to upload ${file.name}`)
      }
    }

    setUploading(false)
    setUploadProgress(0)
    setUploadingFiles([])
    refresh()
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      uploadFiles(e.target.files)
      e.target.value = ""
    }
  }

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const fileList = Array.from(files)
    e.target.value = ""
    // Extract folder structure from webkitRelativePath
    // e.g. "photos/2024/img.jpg" -> create "photos", then "photos/2024", then upload img.jpg to "photos/2024"

    setUploading(true)
    setUploadProgress(0)
    setUploadingFiles(fileList.map((f) => f.name))

    try {
      // Build a map of folder paths to their IDs
      const folderIdMap = new Map<string, number>()
      // The root for uploaded folders is the current folder
      const rootParentId = category === "all" ? currentFolderId : null

      // Collect all unique folder paths
      const folderPaths = new Set<string>()
      for (const file of fileList) {
        const relPath = (file as any).webkitRelativePath || file.name
        const parts = relPath.split("/")
        for (let i = 1; i < parts.length; i++) {
          folderPaths.add(parts.slice(0, i).join("/"))
        }
      }

      // Sort by depth so we create parents before children
      const sortedPaths = Array.from(folderPaths).sort((a, b) => a.split("/").length - b.split("/").length)

      // Create folders
      for (const folderPath of sortedPaths) {
        const parts = folderPath.split("/")
        const folderName = parts[parts.length - 1]
        const parentPath = parts.slice(0, -1).join("/")
        const parentId = parentPath ? folderIdMap.get(parentPath) ?? rootParentId : rootParentId

        try {
          const res = await apiFetch("/api/folders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: folderName, parentId: parentId }),
          })
          if (res.ok) {
            const data = await res.json()
            folderIdMap.set(folderPath, data.id)
          }
        } catch {
          // If folder creation fails, skip and try uploading files anyway
        }
      }

      // Upload files
      let completed = 0
      for (const file of fileList) {
        const relPath = (file as any).webkitRelativePath || file.name
        const parts = relPath.split("/")
        const folderPath = parts.slice(0, -1).join("/")
        const targetFolderId = folderPath ? (folderIdMap.get(folderPath) ?? rootParentId) : rootParentId

        const formData = new FormData()
        formData.append("file", file)
        if (targetFolderId) {
          formData.append("folderId", String(targetFolderId))
        }

        try {
          const res = await apiFetch("/api/upload", {
            method: "POST",
            body: formData,
          })
          if (res.ok) {
            completed++
          } else if (res.status === 409) {
            // Skip duplicates in folder upload
            completed++
          } else {
            toast.error(`Failed to upload ${file.name}`)
            completed++
          }
        } catch {
          toast.error(`Failed to upload ${file.name}`)
          completed++
        }
        setUploadProgress(Math.round((completed / fileList.length) * 100))
      }

      toast.success(`Uploaded ${completed} file${completed !== 1 ? "s" : ""}`)
    } catch (err: any) {
      toast.error(err?.message || "Failed to upload folder")
    } finally {
      setUploading(false)
      setUploadProgress(0)
      setUploadingFiles([])
      refresh()
    }
  }

  // Drag and drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files)
    }
  }

  // ---------- Derived Data ----------

  const displayItems = searchResults !== null ? searchResults : items

  const sortedItems = useMemo(() => [...displayItems].sort((a, b) => {
    // Folders always first
    if (isFolder(a) && !isFolder(b)) return -1
    if (!isFolder(a) && isFolder(b)) return 1

    // Apply sort mode
    switch (sortMode) {
      case "name-asc":
        return a.name.localeCompare(b.name)
      case "name-desc":
        return b.name.localeCompare(a.name)
      case "size-asc": {
        const sizeA = isFolder(a) ? 0 : (a as FileItem).size
        const sizeB = isFolder(b) ? 0 : (b as FileItem).size
        return sizeA - sizeB
      }
      case "size-desc": {
        const sizeA = isFolder(a) ? 0 : (a as FileItem).size
        const sizeB = isFolder(b) ? 0 : (b as FileItem).size
        return sizeB - sizeA
      }
      case "date-asc":
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      case "date-desc":
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      default:
        return a.name.localeCompare(b.name)
    }
  }), [displayItems, sortMode])

  // Stats counts
  const fileCounts = useMemo(() => ({
    all: stats?.totalFiles ?? items.filter((i) => !isFolder(i)).length,
    recent: stats?.totalFiles ?? items.filter((i) => !isFolder(i)).length,
    images: stats?.categories?.images ?? 0,
    videos: stats?.categories?.videos ?? 0,
    documents: stats?.categories?.documents ?? 0,
    audio: stats?.categories?.audio ?? 0,
    others: stats?.categories?.others ?? 0,
  }), [stats, items])

  const storageUsed = stats?.totalSize ?? items.reduce((s, i) => s + (isFolder(i) ? 0 : (i as FileItem).size), 0)

  // ---------- Item action handlers factory ----------

  const makeItemActions = (item: ListItem) => ({
    onOpen: () => handleItemOpen(item),
    onPreview: () => !isFolder(item) && handlePreview(item as FileItem),
    onDownload: () => handleDownload(item),
    onCopyLink: () => !isFolder(item) && handleCopyLink(item as FileItem),
    onShare: () => setShareFile(item),
    onRename: () => setRenameItem(item),
    onMove: () => setMoveItem(item),
    onDelete: () => setDeleteItem(item),
    selectionMode,
    selected: selectedItems.has(selectionKey(item)),
    onToggleSelect: () => toggleSelection(item),
  })

  // ---------- Sidebar category click ----------

  const handleCategoryClick = (cat: CategoryFilter) => {
    setCategory(cat)
    if (cat === "all") {
      setCurrentFolderId(null)
    }
    setSearchQuery("")
    setSearchResults(null)
    setSidebarOpen(false)
    setShowSettings(false)
    setShowShares(false)
    setSelectionMode(false)
    setSelectedItems(new Set())
  }

  // ---------- Render ----------

  // Show loading spinner while checking auth
  if (!authChecked) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#f9f9fb]">
        <Loader2 className="h-8 w-8 animate-spin text-[#757c81]" />
      </div>
    )
  }

  // Show login page if not authenticated
  if (!authenticated) {
    return <LoginPage onAuthenticated={() => setAuthenticated(true)} />
  }

  return (
    <div className="flex bg-[#f9f9fb] relative overflow-hidden" style={{ height: "100dvh" }}>
      {/* Background decoration - atmospheric blurred circles */}
      <div className="pointer-events-none absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-[#dde3e9]/30 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-[#d6d4d7]/20 blur-[150px]" />

      <Toaster position="bottom-right" richColors />
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
      <input
        ref={(el) => {
          (folderInputRef as any).current = el
          if (el) {
            el.setAttribute("webkitdirectory", "")
            el.setAttribute("directory", "")
            el.setAttribute("mozdirectory", "")
          }
        }}
        type="file"
        multiple
        className="hidden"
        onChange={handleFolderSelect}
      />

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-[#0c0e10]/40 backdrop-blur-sm md:hidden transition-opacity" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 bg-[#f2f4f6]/60 backdrop-blur-3xl shadow-[4px_0_24px_rgba(0,0,0,0.02)] flex flex-col transform transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] md:relative md:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Logo */}
        <div className="flex items-center justify-between px-5 py-5">
          <div className="flex items-center gap-3">
            <div className="bg-[#5e5e5e] rounded-xl p-2 flex items-center justify-center">
              <Cloud className="h-4 w-4 text-[#f8f8f8]" />
            </div>
            <div>
              <h1 className="text-lg font-black text-[#2d3338] tracking-tight leading-none">ST</h1>
              <p className="text-[10px] font-medium uppercase tracking-widest text-[#596065]/70 mt-0.5">Cloud Storage</p>
            </div>
          </div>
          <button className="md:hidden p-1.5 rounded-lg hover:bg-[#dde3e9]/40 transition-colors" onClick={() => setSidebarOpen(false)}>
            <X className="h-4 w-4 text-[#596065]" />
          </button>
        </div>

        <nav className="flex-1 overflow-auto px-3 py-3 space-y-1">
          <NavItem
            icon={<HardDrive className="h-4 w-4" />}
            active={category === "all" && !showSettings}
            count={fileCounts.all}
            onClick={() => handleCategoryClick("all")}
          >
            All Files
          </NavItem>
          <NavItem
            icon={<Clock className="h-4 w-4" />}
            active={category === "recent" && !showSettings}
            count={fileCounts.recent}
            onClick={() => handleCategoryClick("recent")}
          >
            Recent
          </NavItem>

          <div className="pt-6 pb-2 px-4">
            <p className="text-[10px] font-medium uppercase tracking-widest text-[#596065]/70">Categories</p>
          </div>

          <NavItem
            icon={<ImageIcon className="h-4 w-4 text-pink-500" />}
            active={category === "images" && !showSettings}
            count={fileCounts.images}
            onClick={() => handleCategoryClick("images")}
          >
            Images
          </NavItem>
          <NavItem
            icon={<Video className="h-4 w-4 text-purple-500" />}
            active={category === "videos" && !showSettings}
            count={fileCounts.videos}
            onClick={() => handleCategoryClick("videos")}
          >
            Videos
          </NavItem>
          <NavItem
            icon={<FileText className="h-4 w-4 text-blue-500" />}
            active={category === "documents" && !showSettings}
            count={fileCounts.documents}
            onClick={() => handleCategoryClick("documents")}
          >
            Documents
          </NavItem>
          <NavItem
            icon={<Music className="h-4 w-4 text-amber-600" />}
            active={category === "audio" && !showSettings}
            count={fileCounts.audio}
            onClick={() => handleCategoryClick("audio")}
          >
            Audio
          </NavItem>
          <NavItem
            icon={<FolderOpen className="h-4 w-4 text-[#757c81]" />}
            active={category === "others" && !showSettings}
            count={fileCounts.others}
            onClick={() => handleCategoryClick("others")}
          >
            Others
          </NavItem>
        </nav>

        {/* Settings + Logout + Storage stats */}
        <div className="px-3 pb-2 space-y-1">
          <NavItem
            icon={<Share2 className="h-4 w-4" />}
            active={showShares}
            count={allShares.length || undefined}
            onClick={() => {
              setShowShares(true)
              setShowSettings(false)
              setSidebarOpen(false)
              // Fetch shares
              setSharesLoading(true)
              apiFetch("/api/shares").then(r => r.json()).then(data => setAllShares(Array.isArray(data) ? data : [])).catch(() => {}).finally(() => setSharesLoading(false))
            }}
          >
            Shares
          </NavItem>
          <NavItem
            icon={<Settings className="h-4 w-4" />}
            active={showSettings}
            onClick={() => {
              setShowSettings(true)
              setShowShares(false)
              setSidebarOpen(false)
            }}
          >
            Settings
          </NavItem>
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-2.5 px-4 py-3 text-sm font-medium uppercase tracking-widest rounded-xl transition-all duration-200 text-[#596065] hover:translate-x-1 hover:bg-[#dde3e9]/40"
          >
            <LogOut className="h-4 w-4" />
            <span className="flex-1 text-left">Logout</span>
          </button>
        </div>

        {/* Storage stats */}
        <div className="px-5 py-5">
          <div className="bg-[#f2f4f6] rounded-2xl p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-tighter text-[#596065]">Storage</span>
              <span className="text-[10px] font-bold uppercase tracking-tighter text-[#2d3338] tabular-nums">
                {formatFileSize(storageUsed)}
              </span>
            </div>
            <p className="text-[10px] font-bold uppercase tracking-tighter text-[#757c81]">
              {fileCounts.all} files
              {stats?.totalFolders !== undefined && stats.totalFolders > 0 && `, ${stats.totalFolders} folders`}
            </p>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 relative z-[1] overflow-hidden">
        {/* Header — fixed, never scrolls */}
        <header className="shrink-0 z-10 flex items-center gap-2 sm:gap-3 bg-[#f9f9fb]/95 sm:bg-white/40 sm:backdrop-blur-2xl shadow-[0_1px_0_rgba(0,0,0,0.06)] sm:shadow-[0_8px_32px_0_rgba(45,51,56,0.06)] px-3 sm:px-4 md:px-6 py-2 sm:py-3">
          <button className="md:hidden p-1.5 rounded-lg hover:bg-[#f2f4f6]/50 transition-colors" onClick={() => setSidebarOpen(true)}>
            <Menu className="h-5 w-5 text-[#596065]" />
          </button>

          {!showSettings && selectionMode && (
            <>
              <div className="flex-1 flex items-center gap-3">
                <span className="text-sm font-bold text-[#2d3338]">
                  {selectedItems.size} selected
                </span>
                <button
                  onClick={selectAll}
                  className="text-xs font-medium text-[#5e5e5e] hover:text-[#2d3338] transition-colors"
                >
                  Select All
                </button>
              </div>
              <div className="flex items-center gap-2 ml-auto">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-9 bg-transparent border-none text-[#596065] rounded-lg hover:bg-[#f2f4f6]/50 text-sm"
                  onClick={handleBatchDownload}
                  disabled={selectedItems.size === 0}
                >
                  <Download className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Download</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-9 bg-transparent border-none text-red-500 rounded-lg hover:bg-red-50 text-sm"
                  onClick={handleBatchDelete}
                  disabled={selectedItems.size === 0}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Delete</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-9 bg-[#e4e9ee] border-none text-[#596065] rounded-lg hover:bg-[#dde3e9] text-sm"
                  onClick={cancelSelection}
                >
                  Cancel
                </Button>
              </div>
            </>
          )}

          {!showSettings && !selectionMode && (
            <>
              <div className="flex-1 max-w-lg">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#757c81]" />
                  <input
                    type="search"
                    placeholder="Search files and folders..."
                    className="w-full h-9 pl-10 pr-4 rounded-xl bg-white/50 backdrop-blur-sm border border-white/40 text-[16px] sm:text-sm text-[#2d3338] placeholder:text-[#757c81] focus:outline-none focus:ring-1 focus:ring-[#757c81]/30 focus:bg-white/70 transition-all"
                    value={searchQuery}
                    onChange={(e) => onSearchChange(e.target.value)}
                  />
                  {searching && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-[#757c81]" />
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 ml-auto">
                {/* Sort dropdown */}
                <div className="hidden sm:block">
                  <Select value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
                    <SelectTrigger className="h-9 w-[130px] text-sm bg-[#e4e9ee] border-none text-[#596065] rounded-lg focus:ring-[#757c81]/30">
                      <SelectValue placeholder="Sort by" />
                    </SelectTrigger>
                    <SelectContent className="bg-white/90 backdrop-blur-xl rounded-xl shadow-[0_16px_48px_rgba(45,51,56,0.12)]">
                      <SelectItem value="name-asc">Name A-Z</SelectItem>
                      <SelectItem value="name-desc">Name Z-A</SelectItem>
                      <SelectItem value="size-asc">Size (small)</SelectItem>
                      <SelectItem value="size-desc">Size (large)</SelectItem>
                      <SelectItem value="date-asc">Date (old)</SelectItem>
                      <SelectItem value="date-desc">Date (new)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* View toggle */}
                <div className="hidden sm:flex items-center bg-[#e4e9ee] rounded-lg">
                  <button
                    className={cn(
                      "p-2 rounded-l-lg transition-colors",
                      viewMode === "grid" ? "bg-white shadow-sm text-[#2d3338]" : "text-[#757c81] hover:text-[#596065]"
                    )}
                    onClick={() => setViewMode("grid")}
                    title="Grid view"
                  >
                    <LayoutGrid className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className={cn(
                      "p-2 rounded-r-lg transition-colors",
                      viewMode === "list" ? "bg-white shadow-sm text-[#2d3338]" : "text-[#757c81] hover:text-[#596065]"
                    )}
                    onClick={() => setViewMode("list")}
                    title="List view"
                  >
                    <LayoutList className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Select mode toggle */}
                <button
                  className="hidden sm:flex p-2 rounded-lg transition-colors text-[#757c81] hover:text-[#596065] hover:bg-[#e4e9ee]"
                  onClick={() => setSelectionMode(true)}
                  title="Select items"
                >
                  <CheckSquare className="h-3.5 w-3.5" />
                </button>

                {/* New folder */}
                <button
                  className="h-8 w-8 flex items-center justify-center rounded-lg bg-[#e4e9ee] text-[#596065] hover:bg-[#dde3e9] transition-colors"
                  onClick={() => setCreateFolderOpen(true)}
                  title="New Folder"
                >
                  <FolderPlus className="h-4 w-4" />
                </button>

                {/* Upload dropdown */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="h-8 w-8 flex items-center justify-center rounded-lg bg-[#5e5e5e] text-white hover:bg-[#525252] transition-colors disabled:opacity-50"
                      disabled={uploading}
                      title="Upload"
                    >
                      {uploading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="bg-white/95 backdrop-blur-xl rounded-xl shadow-[0_16px_48px_rgba(45,51,56,0.15)] border border-[#acb3b8]/10">
                    <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                      <Upload className="h-4 w-4 mr-2 text-[#596065]" />
                      Upload Files
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => folderInputRef.current?.click()}>
                      <FolderUp className="h-4 w-4 mr-2 text-[#596065]" />
                      Upload Folder
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

              </div>
            </>
          )}

          {showSettings && (
            <div className="flex-1">
              <h2 className="text-sm font-bold text-[#2d3338] tracking-tight">Settings</h2>
            </div>
          )}
        </header>

        {/* Settings / Shares panel or file manager content */}
        {showSettings ? (
          <SettingsPanel />
        ) : showShares ? (
          <div className="flex-1 overflow-auto px-4 py-6 md:px-6">
            <div className="max-w-2xl mx-auto space-y-4">
              <div>
                <h2 className="text-lg font-black text-[#2d3338] tracking-tight">Shared Links</h2>
                <p className="text-sm text-[#596065] mt-1">Manage all your shared files</p>
              </div>

              {sharesLoading && (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-[#757c81]" />
                </div>
              )}

              {!sharesLoading && allShares.length === 0 && (
                <div className="text-center py-12 text-[#757c81]">
                  <Share2 className="h-10 w-10 mx-auto mb-3 text-[#acb3b8]" />
                  <p className="text-sm font-bold">No shared links</p>
                  <p className="text-xs mt-1">Share a file to see it here</p>
                </div>
              )}

              {!sharesLoading && allShares.map((share) => (
                <div key={share.id} className="bg-white/70 backdrop-blur-sm rounded-xl shadow-[0_24px_48px_rgba(45,51,56,0.04)] border border-[#acb3b8]/5 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      {share.type === "folder" ? (
                        <div className="w-8 h-8 rounded-lg bg-[#e4e9ee] flex items-center justify-center shrink-0">
                          <Folder className="h-4 w-4 text-[#5e5e5e]" />
                        </div>
                      ) : (
                        <div className="w-8 h-8 rounded-lg bg-[#e4e9ee] flex items-center justify-center shrink-0">
                          <File className="h-4 w-4 text-[#596065]" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-[#2d3338] truncate">{share.fileName || share.folderName}</p>
                        <p className="text-[11px] text-[#757c81] mt-0.5">{share.type === "folder" ? "Folder" : formatFileSize(share.fileSize)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={async () => {
                          const url = share.code
                            ? `${window.location.origin}/s/${share.id}?code=${share.code}`
                            : `${window.location.origin}/s/${share.id}`
                          let text = `${share.type === "folder" ? "Folder" : "File"}: ${share.fileName || share.folderName}\nLink: ${url}`
                          text += `\n— Shared via ST`
                          await copyToClipboard(text)
                          toast.success("Copied")
                        }}
                        className="p-2 rounded-lg hover:bg-[#e4e9ee] transition-colors"
                        title="Copy all info"
                      >
                        <Copy className="h-4 w-4 text-[#596065]" />
                      </button>
                      <button
                        onClick={async () => {
                          const res = await apiFetch(`/api/shares/${share.id}`, { method: "DELETE" })
                          if (res.ok) {
                            setAllShares((prev) => prev.filter((s) => s.id !== share.id))
                            toast.success("Share deleted")
                          }
                        }}
                        className="p-2 rounded-lg hover:bg-red-50 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4 text-red-400" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-[#757c81]">
                    <span className="font-mono bg-[#f9f9fb] px-2 py-0.5 rounded">/s/{share.id}</span>
                    {share.code && <span className="bg-[#f9f9fb] px-2 py-0.5 rounded">Code: {share.code}</span>}
                    {share.expiresAt && <span>{new Date(share.expiresAt) > new Date() ? "Active" : "Expired"}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* Upload progress bar at top of content */}
            {uploading && (
              <div className="relative">
                <div className="h-0.5 w-full bg-[#e4e9ee]">
                  <div
                    className="h-full bg-[#5e5e5e] transition-all duration-300 ease-out"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <div className="px-4 md:px-6 py-1.5 flex items-center gap-2 text-[11px] text-[#596065] bg-[#f2f4f6]/50 backdrop-blur-sm">
                  <Loader2 className="h-3 w-3 animate-spin text-[#5e5e5e]" />
                  <span>
                    Uploading {uploadingFiles.length} file{uploadingFiles.length !== 1 ? "s" : ""} ({uploadProgress}%)
                  </span>
                </div>
              </div>
            )}

            {/* Breadcrumb / Path — fixed, never scrolls */}
            {category === "all" && (
              <div className="shrink-0 flex items-center gap-1.5 px-3 sm:px-4 md:px-6 py-2 text-sm border-b border-[#f2f4f6]/50">
                {/* Breadcrumb path */}
                <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto [&::-webkit-scrollbar]:hidden">
                  {currentFolderId !== null && (
                    <button
                      className="p-1 rounded-lg hover:bg-[#f2f4f6]/50 mr-0.5 shrink-0 transition-colors"
                      onClick={() => {
                        const parent = breadcrumb.length >= 2 ? breadcrumb[breadcrumb.length - 2] : null
                        navigateToFolder(parent?.id ?? null)
                      }}
                    >
                      <ArrowLeft className="h-4 w-4 text-[#596065]" />
                    </button>
                  )}
                  <button
                    onClick={() => navigateToFolder(null)}
                    className={cn(
                      "hover:text-[#2d3338] transition-colors whitespace-nowrap shrink-0 text-xs sm:text-sm",
                      breadcrumb.length === 0 ? "text-[#2d3338] font-bold" : "text-[#596065]"
                    )}
                  >
                    Home
                  </button>
                  {breadcrumb.map((seg, i) => (
                    <React.Fragment key={seg.id ?? i}>
                      <ChevronRight className="h-3 w-3 text-[#757c81] shrink-0" />
                      <button
                        onClick={() => navigateToFolder(seg.id)}
                        className={cn(
                          "hover:text-[#2d3338] transition-colors whitespace-nowrap shrink-0 text-xs sm:text-sm",
                          i === breadcrumb.length - 1 ? "text-[#2d3338] font-bold" : "text-[#596065]"
                        )}
                      >
                        {seg.name}
                      </button>
                    </React.Fragment>
                  ))}
                </div>
                {/* Sort + View toggle (right side) */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    className="h-7 w-7 flex items-center justify-center rounded-lg text-[#596065] hover:bg-[#e4e9ee] transition-colors"
                    onClick={() => {
                      const modes: SortMode[] = ["name-asc", "name-desc", "date-desc", "date-asc", "size-desc", "size-asc"]
                      const i = modes.indexOf(sortMode)
                      setSortMode(modes[(i + 1) % modes.length])
                      const labels: Record<SortMode, string> = { "name-asc": "A-Z", "name-desc": "Z-A", "date-desc": "New", "date-asc": "Old", "size-desc": "Big", "size-asc": "Small" }
                      toast.success(labels[modes[(i + 1) % modes.length]])
                    }}
                    title="Sort"
                  >
                    <ArrowUpDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className={cn(
                      "h-7 w-7 flex items-center justify-center rounded-lg transition-colors",
                      viewMode === "list" ? "text-[#2d3338] bg-[#e4e9ee]" : "text-[#596065] hover:bg-[#e4e9ee]"
                    )}
                    onClick={() => setViewMode(viewMode === "grid" ? "list" : "grid")}
                    title={viewMode === "grid" ? "List view" : "Grid view"}
                  >
                    {viewMode === "grid" ? <LayoutList className="h-3.5 w-3.5" /> : <LayoutGrid className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            )}

            {/* Category header — fixed */}
            {category !== "all" && (
              <div className="shrink-0 flex items-center gap-2 px-4 md:px-6 py-3 border-b border-[#f2f4f6]/50">
                <span className="text-sm font-bold uppercase tracking-widest text-[#2d3338]">{category}</span>
                <span className="text-[12px] text-[#757c81]">
                  ({fileCounts[category]} files)
                </span>
              </div>
            )}

            {/* Search results header */}
            {searchResults !== null && (
              <div className="shrink-0 flex items-center gap-2 px-4 md:px-6 py-2.5 bg-[#f2f4f6]/50 backdrop-blur-sm">
                <Search className="h-3.5 w-3.5 text-[#5e5e5e]" />
                <span className="text-sm text-[#2d3338]">
                  {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for &quot;{searchQuery}&quot;
                </span>
                <button
                  className="ml-auto text-[12px] text-[#5e5e5e] hover:text-[#2d3338] font-medium transition-colors"
                  onClick={() => { setSearchQuery(""); setSearchResults(null) }}
                >
                  Clear
                </button>
              </div>
            )}

            {/* Content area */}
            <div
              className="flex-1 overflow-auto px-0 py-2 sm:p-4 md:p-6"
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {/* Drag overlay */}
              {dragOver && (
                <div className="fixed inset-0 z-30 flex items-center justify-center pointer-events-none">
                  <div className="absolute inset-4 md:inset-8 border-2 border-dashed border-[#acb3b8]/20 rounded-2xl bg-white/90 flex items-center justify-center backdrop-blur-sm">
                    <div className="text-center">
                      <div className="bg-[#e4e9ee] rounded-2xl p-6 inline-flex items-center justify-center mb-4">
                        <Upload className="h-12 w-12 text-[#5e5e5e]" />
                      </div>
                      <p className="text-base font-bold tracking-tight text-[#2d3338]">Drop files to upload</p>
                      <p className="text-sm text-[#596065] mt-1">Files will be added to the current folder</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Loading */}
              {loading && (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="h-7 w-7 animate-spin text-[#757c81]" />
                </div>
              )}

              {/* Empty state */}
              {!loading && sortedItems.length === 0 && searchResults !== null && (
                <div className="flex flex-col items-center justify-center py-12 sm:py-20 text-center px-4">
                  <div className="max-w-md w-full">
                    <div className="bg-[#e4e9ee] rounded-2xl p-6 inline-flex items-center justify-center mx-auto mb-4">
                      <Search className="h-7 w-7 text-[#596065]" />
                    </div>
                    <p className="text-[#2d3338] font-bold text-base tracking-tight">No results found</p>
                    <p className="text-sm text-[#596065] mt-1.5">Try a different search term</p>
                  </div>
                </div>
              )}
              {!loading && sortedItems.length === 0 && searchResults === null && (
                <div className="flex flex-col items-center justify-center py-12 sm:py-20 text-center px-4">
                  <div
                    className="rounded-2xl border-2 border-dashed border-[#acb3b8]/20 p-12 cursor-pointer hover:border-[#acb3b8]/40 transition-colors duration-200 max-w-md w-full"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <div className="bg-[#e4e9ee] rounded-2xl p-6 inline-flex items-center justify-center mx-auto mb-4">
                      <Upload className="h-7 w-7 text-[#596065]" />
                    </div>
                    <p className="text-[#2d3338] font-bold text-base tracking-tight">This folder is empty</p>
                    <p className="text-sm text-[#596065] mt-1.5">Click to upload or drag and drop files here</p>
                    <div className="flex items-center justify-center gap-2 mt-5">
                      <Button size="sm" variant="outline" className="bg-[#e2e2e2] border-none text-[#525252] hover:bg-[#d8d8d8] rounded-xl text-sm" onClick={(e) => { e.stopPropagation(); setCreateFolderOpen(true) }}>
                        <FolderPlus className="h-4 w-4 mr-1.5" />
                        New Folder
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Grid view */}
              {!loading && sortedItems.length > 0 && viewMode === "grid" && (
                <div className="grid grid-cols-2 gap-2 px-3 sm:px-0 sm:gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                  {sortedItems.map((item) => (
                    <GridCard key={`${item.type}-${item.id}`} item={item} {...makeItemActions(item)} />
                  ))}
                </div>
              )}

              {/* List view - Mobile (swipeable) */}
              {!loading && sortedItems.length > 0 && viewMode === "list" && (
                <>
                  <div className="sm:hidden">
                    {sortedItems.map((item) => (
                      <MobileSwipeRow key={`m-${item.type}-${item.id}`} item={item} {...makeItemActions(item)} />
                    ))}
                  </div>
                  {/* List view - Desktop (table) */}
                  <div className="hidden sm:block bg-white/50 backdrop-blur-xl rounded-2xl overflow-hidden shadow-[0_32px_64px_-12px_rgba(45,51,56,0.08)] border border-white/40">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-b border-[#f2f4f6] hover:bg-transparent">
                          <TableHead className="w-[50%] text-[10px] font-black uppercase tracking-widest text-[#596065] px-6 py-4">Name</TableHead>
                          <TableHead className="text-[10px] font-black uppercase tracking-widest text-[#596065] text-right px-6 py-4">Size</TableHead>
                          <TableHead className="hidden md:table-cell text-[10px] font-black uppercase tracking-widest text-[#596065] text-right px-6 py-4">Modified</TableHead>
                          <TableHead className="text-right w-12 px-6 py-4"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sortedItems.map((item) => (
                          <ListRow key={`${item.type}-${item.id}`} item={item} {...makeItemActions(item)} />
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </div>

          </>
        )}
      </div>

      {/* Dialogs */}
      <CreateFolderDialog
        open={createFolderOpen}
        onClose={() => setCreateFolderOpen(false)}
        onCreated={refresh}
        parentId={currentFolderId}
      />

      <RenameDialog
        open={renameItem !== null}
        onClose={() => setRenameItem(null)}
        item={renameItem}
        onRenamed={refresh}
      />

      <MoveDialog
        open={moveItem !== null}
        onClose={() => setMoveItem(null)}
        item={moveItem}
        onMoved={refresh}
      />

      <DeleteConfirmDialog
        open={deleteItem !== null}
        onClose={() => setDeleteItem(null)}
        item={deleteItem}
        onDeleted={refresh}
      />

      <MediaPreviewModal
        file={previewFile}
        open={previewFile !== null}
        onClose={() => setPreviewFile(null)}
      />

      <ShareDialog
        open={shareFile !== null}
        onClose={() => setShareFile(null)}
        file={shareFile}
      />

      {/* Duplicate file dialog */}
      <Dialog open={duplicateFile !== null} onOpenChange={(v) => { if (!v && duplicateFile) { duplicateFile.resolve("skip"); setDuplicateFile(null) } }}>
        <DialogContent className="sm:max-w-sm rounded-2xl bg-white shadow-[0_32px_64px_-12px_rgba(45,51,56,0.15)] border border-[#acb3b8]/5">
          <DialogHeader>
            <DialogTitle className="text-base font-bold tracking-tight text-[#2d3338]">File already exists</DialogTitle>
            <DialogDescription className="text-sm text-[#596065]">
              &quot;{duplicateFile?.name}&quot; already exists in this folder.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 pt-2">
            <button
              className="w-full h-11 bg-[#5e5e5e] hover:bg-[#525252] text-[#f8f8f8] rounded-xl text-sm font-bold transition-colors"
              onClick={() => { duplicateFile?.resolve("overwrite"); setDuplicateFile(null) }}
            >
              Overwrite
            </button>
            <button
              className="w-full h-11 bg-[#e4e9ee] hover:bg-[#dde3e9] text-[#2d3338] rounded-xl text-sm font-bold transition-colors"
              onClick={() => { duplicateFile?.resolve("rename"); setDuplicateFile(null) }}
            >
              Keep both (rename)
            </button>
            <button
              className="w-full h-11 text-[#596065] hover:text-[#2d3338] text-sm font-medium transition-colors"
              onClick={() => { duplicateFile?.resolve("skip"); setDuplicateFile(null) }}
            >
              Skip
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
