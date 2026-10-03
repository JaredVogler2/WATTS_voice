#!/usr/bin/env bash
# Deploy WATTS Voice to Posit Connect as a Flask API (serves the web app too).
#
#   pip install rsconnect-python
#   rsconnect add --server https://connect.example.com --name posit --api-key "$CONNECT_API_KEY"
#   scripts/deploy_posit.sh            # first deploy
#   scripts/deploy_posit.sh --app-id <guid>   # redeploy to the same content item
#
# Then set ANTHROPIC_API_KEY / BCAI_PAT / APP_ACCESS_CODE in the content's
# "Vars" panel. For git-backed publishing, run
#   rsconnect write-manifest flask --entrypoint app:app --overwrite .
# and commit the generated manifest.json.
set -euo pipefail
cd "$(dirname "$0")/.."
rsconnect deploy flask \
  --name "${POSIT_SERVER_NAME:-posit}" \
  --entrypoint app:app \
  --title "WATTS Voice" \
  --exclude "tests/**" --exclude "docs/**" --exclude ".github/**" --exclude "Task1" \
  "$@" .
