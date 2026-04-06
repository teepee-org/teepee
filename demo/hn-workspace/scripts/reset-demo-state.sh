#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Resetting demo state in ${ROOT_DIR}"

rm -f "${ROOT_DIR}/.teepee/db.sqlite" \
      "${ROOT_DIR}/.teepee/db.sqlite-shm" \
      "${ROOT_DIR}/.teepee/db.sqlite-wal" \
      "${ROOT_DIR}/.teepee/pid"

find "${ROOT_DIR}" -maxdepth 1 -type f \
  \( -name 'AGENT_*.md' -o -name 'TMP_*.md' -o -name 'TEMP_*.md' \) \
  -print -delete

echo "Demo state reset."
echo "Next steps:"
echo "  cd ${ROOT_DIR}"
echo "  npm test"
echo "  npx teepee-cli start"
