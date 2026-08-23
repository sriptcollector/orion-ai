#!/usr/bin/env bash
# Orion AI — one-shot client installer (macOS / Linux).
# A client runs ONE line and gets the stack set up:
#
#   curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/deploy/install.sh | bash -s -- https://github.com/<you>/<client-repo>.git
#
# It clones the deployment repo, installs deps, seeds .env from the template, and
# prints what still needs filling in. No secrets assumed, nothing destructive.
set -euo pipefail
REPO="${1:-${ORION_DEPLOY_REPO:-}}"
DIR="${ORION_DEPLOY_DIR:-$HOME/orion-ai}"

echo "== Orion AI installer =="

# License gate: no key, no install. Only key HASHES ship here; Orion issues keys.
ALLOWED_HASHES="abd0fb08d15c821c012a6c6f0ed5385ad0adbc2c953527893b782ec1fe880ce1"
KEY="${ORION_KEY:-}"
if [ -z "$KEY" ]; then printf "Enter your Orion license key: "; read -r KEY </dev/tty; fi
if command -v sha256sum >/dev/null 2>&1; then H=$(printf '%s' "$KEY" | sha256sum | cut -d' ' -f1)
else H=$(printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1); fi
case " $ALLOWED_HASHES " in *" $H "*) echo "License OK";; *) echo "Invalid or missing license key. Contact Orion (${ORION_SUPPORT_EMAIL:-orionjones99@gmail.com}) to get one."; exit 1;; esac

[ -n "$REPO" ] || { echo "ERROR: pass the client repo URL as the first arg (or set ORION_DEPLOY_REPO)."; exit 1; }
for t in git node; do command -v "$t" >/dev/null 2>&1 || { echo "ERROR: $t is required. Install it, then re-run."; exit 1; }; done

if [ -d "$DIR/.git" ]; then echo "Updating $DIR"; git -C "$DIR" pull --ff-only
else echo "Cloning into $DIR"; git clone --depth 1 "$REPO" "$DIR"; fi

cd "$DIR"
[ -f package.json ] && { echo "Installing dependencies..."; npm ci --no-audit --no-fund; }

if [ -f .env.example ] && [ ! -f .env ]; then cp .env.example .env; echo "Seeded .env from .env.example"; fi

if [ -f .env ]; then
  missing=$(grep -E '^\s*[A-Z0-9_]+=\s*$' .env | sed -E 's/=.*//; s/^\s+//' || true)
  [ -n "$missing" ] && { echo; echo "Fill these in .env before starting:"; echo "$missing" | sed 's/^/  - /'; }
fi

echo
echo "Installed. Launching setup..."
if [ -f deploy/orion-setup.mjs ]; then node deploy/orion-setup.mjs
else
  echo "Next:"
  echo "  1. Edit $DIR/.env with the keys above"
  echo "  2. Run:  npm start   (or the command in the repo README)"
fi
