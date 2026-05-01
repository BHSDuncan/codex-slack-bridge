#!/bin/zsh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

mkdir -p .bridge-data/logs

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use --silent >/dev/null
fi

if [[ "${BRIDGE_USE_CAFFEINATE:-false}" == "true" ]]; then
  exec caffeinate -dimsu -- npm run start
fi

exec npm run start
