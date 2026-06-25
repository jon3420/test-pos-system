#!/usr/bin/env bash
# scripts/build-release.sh — fix18-08
#
# 用途：產生正式版 ZIP，禁止包含資料庫檔案
# 用法：bash scripts/build-release.sh [版本名稱]
#   例：bash scripts/build-release.sh pos-web-fix18-10-hotfix8
#
# 規則：
#   ZIP 內不得包含 data/pos.db、*.db、*.sqlite
#   違反時立即中止，顯示 ERROR 並以 exit 1 結束

set -euo pipefail

VERSION="${1:-pos-web-release}"
OUTPUT_DIR="${2:-.}"
ZIP_NAME="${VERSION}-full.zip"
ZIP_PATH="${OUTPUT_DIR}/${ZIP_NAME}"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=================================================="
echo "  POS Web Release Builder"
echo "  Version : ${VERSION}"
echo "  Output  : ${ZIP_PATH}"
echo "=================================================="

# ── 1. 禁止 DB 檔案檢查（在打包前先掃描來源目錄）─────────────────────────
echo "[1/3] Checking for database files in source..."

DB_FOUND=0

# 檢查 data/ 目錄
if [ -d "${ROOT_DIR}/data" ]; then
  DB_FILES=$(find "${ROOT_DIR}/data" -name "*.db" -o -name "*.sqlite" 2>/dev/null || true)
  if [ -n "$DB_FILES" ]; then
    echo ""
    echo "╔══════════════════════════════════════════════════╗"
    echo "║  ERROR: Release package contains database file. ║"
    echo "╚══════════════════════════════════════════════════╝"
    echo ""
    echo "  以下資料庫檔案不得包含在正式版 ZIP 中："
    echo "$DB_FILES" | while IFS= read -r f; do echo "    → $f"; done
    echo ""
    echo "  正式版 ZIP 不得包含："
    echo "    data/"
    echo "    *.db"
    echo "    *.sqlite"
    echo ""
    echo "  請先移除或備份資料庫，再重新執行打包。"
    exit 1
  fi
fi

# 也掃描根目錄 *.db / *.sqlite
ROOT_DB=$(find "${ROOT_DIR}" -maxdepth 1 -name "*.db" -o -maxdepth 1 -name "*.sqlite" 2>/dev/null || true)
if [ -n "$ROOT_DB" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║  ERROR: Release package contains database file. ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo ""
  echo "  根目錄發現資料庫檔案："
  echo "$ROOT_DB" | while IFS= read -r f; do echo "    → $f"; done
  exit 1
fi

echo "  ✔ No database files found."

# ── 2. 打包（排除 data/ node_modules/ .git *.db *.sqlite）────────────────
echo "[2/3] Creating ZIP (excluding data/, node_modules/, .git, *.db, *.sqlite)..."

cd "$(dirname "${ROOT_DIR}")"
BASE="$(basename "${ROOT_DIR}")"

zip -r "${ZIP_PATH}" "${BASE}" \
  --exclude "${BASE}/data/*" \
  --exclude "${BASE}/.git/*" \
  --exclude "${BASE}/node_modules/*" \
  --exclude "*.db" \
  --exclude "*.sqlite" \
  --exclude "*.db-shm" \
  --exclude "*.db-wal" \
  2>/dev/null

echo "  ✔ ZIP created: ${ZIP_PATH}"

# ── 3. 最終安全檢查：驗證 ZIP 內容不含 DB ────────────────────────────────
echo "[3/3] Verifying ZIP contents..."

DB_IN_ZIP=$(unzip -l "${ZIP_PATH}" 2>/dev/null | grep -E '\.(db|sqlite)$' || true)
if [ -n "$DB_IN_ZIP" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║  ERROR: Release package contains database file. ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo ""
  echo "  ZIP 內仍包含以下資料庫："
  echo "$DB_IN_ZIP"
  echo ""
  rm -f "${ZIP_PATH}"
  echo "  已刪除問題 ZIP。請修正後重新執行。"
  exit 1
fi

NM_IN_ZIP=$(unzip -l "${ZIP_PATH}" 2>/dev/null | grep "node_modules/" | head -1 || true)
if [ -n "$NM_IN_ZIP" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║  ERROR: Release package contains node_modules.  ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo ""
  echo "  ZIP 內仍包含 node_modules："
  echo "$NM_IN_ZIP"
  echo ""
  rm -f "${ZIP_PATH}"
  echo "  已刪除問題 ZIP。請修正後重新執行。"
  exit 1
fi

echo "  ✔ ZIP verified: no database files."
echo ""
echo "=================================================="
echo "  Release build complete!"
echo "  → ${ZIP_PATH}"
echo "=================================================="
