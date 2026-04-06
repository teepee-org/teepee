#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOPIC_NAME="${1:-hn-replay}"

echo "Preparing replay topic '${TOPIC_NAME}' in ${ROOT_DIR}"

node "${ROOT_DIR}/scripts/seed-demo-topic.js" \
  --seed "seed/hn-replay-sequence.json" \
  --target "${TOPIC_NAME}"

echo "Replay topic ready: ${TOPIC_NAME}"
