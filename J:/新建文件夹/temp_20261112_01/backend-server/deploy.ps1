# =============================================================
# Circle Voice - Windows deploy script (pack + upload)
# Usage:
#   1. Edit the config section below
#   2. Run: powershell -ExecutionPolicy Bypass -File deploy.ps1
# =============================================================

# ===================== CONFIG =====================
$SERVER_HOST    = "your-server-ip"
$SERVER_PORT    = 22
$SERVER_USER    = "root"
$REMOTE_DIR     = "/opt/circle-voice"
$USE_SSH_KEY    = $true
$SSH_KEY_PATH   = "$env:USERPROFILE\.ssh\id_rsa"
# ==================================================

$ErrorActionPreference = "Stop"
$PROJECT_ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$ARCHIVE_NAME = "circle-voice-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".tar.gz"
$ARCHIVE_PATH = Join-Path $env:TEMP $ARCHIVE_NAME

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Circle Voice Deploy Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Project:  $PROJECT_ROOT"
Write-Host "Server:   ${SERVER_USER}@${SERVER_HOST}:${SERVER_PORT}"
Write-Host "Remote:   $REMOTE_DIR"
Write-Host ""

# ---------- Check tools ----------
$scpCmd = Get-Command scp -ErrorAction SilentlyContinue
$sshCmd = Get-Command ssh -ErrorAction SilentlyContinue
$tarCmd = Get-Command tar -ErrorAction SilentlyContinue
if (-not $scpCmd -or -not $sshCmd) {
    Write-Host "[ERROR] scp/ssh not found. Install Windows OpenSSH Client:" -ForegroundColor Red
    Write-Host "  Settings -> Apps -> Optional features -> Add a feature -> OpenSSH Client" -ForegroundColor Yellow
    exit 1
}
if (-not $tarCmd) {
    Write-Host "[ERROR] tar not found. Windows 10 1803+ includes it." -ForegroundColor Red
    exit 1
}

# ---------- Pack ----------
Write-Host "[1/4] Packing project..." -ForegroundColor Green
$excludeArgs = @(
    "--exclude=.git",
    "--exclude=__pycache__",
    "--exclude=*.pyc",
    "--exclude=*.db",
    "--exclude=*.db-shm",
    "--exclude=*.db-wal",
    "--exclude=*.sqlite3",
    "--exclude=node_modules",
    "--exclude=.env",
    "--exclude=*.log",
    "--exclude=venv",
    "--exclude=logs",
    "--exclude=uploads",
    "--exclude=backend/uploads/*",
    "--exclude=.vscode",
    "--exclude=.idea",
    "--exclude=deploy.ps1"
)

Push-Location $PROJECT_ROOT
try {
    & tar -czf $ARCHIVE_PATH @excludeArgs -C $PROJECT_ROOT .
    if ($LASTEXITCODE -ne 0) { throw "tar failed" }
    $sizeMB = [math]::Round((Get-Item $ARCHIVE_PATH).Length / 1MB, 2)
    Write-Host "  Packed: $ARCHIVE_NAME ($sizeMB MB)" -ForegroundColor Green
} finally {
    Pop-Location
}

# ---------- Build SSH args ----------
$sshBaseArgs = @("-p", $SERVER_PORT, "-o", "StrictHostKeyChecking=no")
if ($USE_SSH_KEY) {
    if (-not (Test-Path $SSH_KEY_PATH)) {
        Write-Host "[ERROR] SSH key not found: $SSH_KEY_PATH" -ForegroundColor Red
        Write-Host "  Set USE_SSH_KEY = false for password auth, or run ssh-keygen" -ForegroundColor Yellow
        exit 1
    }
    $sshBaseArgs += @("-i", $SSH_KEY_PATH)
}
$scpArgs = $sshBaseArgs + @("-P", $SERVER_PORT)

# ---------- Upload ----------
Write-Host "[2/4] Uploading to server..." -ForegroundColor Green
$remoteTarget = "${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}/${ARCHIVE_NAME}"

Write-Host "  Creating remote dir $REMOTE_DIR ..."
& ssh @sshBaseArgs "${SERVER_USER}@${SERVER_HOST}" "mkdir -p $REMOTE_DIR"
if ($LASTEXITCODE -ne 0) { throw "mkdir failed" }

& scp @scpArgs $ARCHIVE_PATH $remoteTarget
if ($LASTEXITCODE -ne 0) { throw "upload failed" }
Write-Host "  Upload done" -ForegroundColor Green

# ---------- Extract remotely ----------
Write-Host "[3/4] Extracting on server..." -ForegroundColor Green
$remoteCmd = "cd $REMOTE_DIR && tar -xzf $ARCHIVE_NAME && rm -f $ARCHIVE_NAME && echo OK && ls -la"
& ssh @sshBaseArgs "${SERVER_USER}@${SERVER_HOST}" $remoteCmd
if ($LASTEXITCODE -ne 0) { throw "remote extract failed" }

# ---------- Cleanup local archive ----------
Write-Host "[4/4] Cleaning up local temp file..." -ForegroundColor Green
Remove-Item $ARCHIVE_PATH -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Upload complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next: run deploy script on server:" -ForegroundColor Yellow
Write-Host "  ssh -p $SERVER_PORT ${SERVER_USER}@${SERVER_HOST}"
Write-Host "  cd $REMOTE_DIR"
Write-Host "  bash server-deploy.sh"
Write-Host ""
