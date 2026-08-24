#!/usr/bin/env bash
# One-shot installer for a client's Mac.
#
#   curl -fsSL https://raw.githubusercontent.com/sriptcollector/orion-ai/main/deploy/mac/install-mac.sh | bash
#
# Gets a bare Mac from nothing to a working, licensed, always-on assistant:
# Homebrew, Node, the bundle, Playwright's browser, then the setup terminal.
# Idempotent - re-running updates in place and never clobbers a filled-in .env.
set -euo pipefail

REPO="${ORION_DEPLOY_REPO:-https://github.com/sriptcollector/orion-ai.git}"
DIR="${ORION_DEPLOY_DIR:-$HOME/orion-ai}"
SUB="${ORION_DEPLOY_SUBDIR:-deploy/mac}"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
dim()  { printf "\033[2m%s\033[0m\n" "$1"; }
ok()   { printf "\033[32m  ok\033[0m %s\n" "$1"; }
warn() { printf "\033[33m  !\033[0m %s\n" "$1"; }
die()  { printf "\033[31mERROR:\033[0m %s\n" "$1" >&2; exit 1; }

echo
bold "Orion AI - Mac install"
echo

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Windows use deploy/install.ps1."

# --- license gate ----------------------------------------------------------
# Only key HASHES ship here; Orion issues the keys themselves.
# Regenerate this list any time with:  node deploy/license-tool.mjs hashes
ALLOWED_HASHES="
abd0fb08d15c821c012a6c6f0ed5385ad0adbc2c953527893b782ec1fe880ce1
9ff8e16eb660e480135fa7d9eae2533e68aefef973b0eae66a2fd6239fe52df3
"
KEY="${ORION_KEY:-}"
if [ -z "$KEY" ]; then printf "  License key: "; read -r KEY </dev/tty; fi
H=$(printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1)
case " $(echo $ALLOWED_HASHES) " in
  *" $H "*) ok "license accepted" ;;
  *) die "That key isn't valid. Contact Orion (${ORION_SUPPORT_EMAIL:-orionjones99@gmail.com})." ;;
esac

# --- prerequisites ---------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  warn "git is missing - macOS will now prompt to install the Command Line Tools."
  xcode-select --install 2>/dev/null || true
  die "Finish that install, then run this command again."
fi
ok "git"

if ! command -v node >/dev/null 2>&1; then
  warn "Node.js is not installed."
  if ! command -v brew >/dev/null 2>&1; then
    printf "  Install Homebrew (the standard macOS package manager)? [y/N] "
    read -r yn </dev/tty
    [ "$yn" = "y" ] || die "Node 20+ is required. Install it from nodejs.org and re-run."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Apple silicon puts brew outside the default PATH for this shell.
    [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
  brew install node
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 20 ] || die "Node $(node -v) is too old. Need 20+. Try: brew upgrade node"
ok "node $(node -v)"

# --- the bundle ------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  dim "  updating $DIR"
  git -C "$DIR" pull --ff-only || warn "could not fast-forward; leaving the working copy as-is"
else
  dim "  cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi
APP="$DIR/$SUB"
[ -d "$APP" ] || die "Expected the app at $APP but it isn't there."
cd "$APP"
ok "bundle at $APP"

# --- dependencies ----------------------------------------------------------
dim "  installing dependencies (a minute or two)"
npm install --no-audit --no-fund --loglevel=error
ok "npm packages"

dim "  installing the headless browser"
npx --yes playwright install chromium >/dev/null 2>&1 || warn "playwright browser install had trouble - re-run later: npx playwright install chromium"
ok "chromium"

# --- env -------------------------------------------------------------------
if [ ! -f .env ]; then cp .env.example .env; ok "created .env"; else ok ".env already exists (left alone)"; fi
mkdir -p data/logs

echo
bold "Installed."
echo
dim "Next, in the setup screen that's about to open:"
dim "  2  Keys & setup     paste the Telegram + DeepSeek keys"
dim "  3  Accounts         sign in to LinkedIn and any socials"
dim "  4  Always-on        turn on 24/7"
dim "  5  Check everything confirm it all works"
echo
dim "Reopen this screen anytime:  cd $APP && npm run setup"
echo
sleep 2
exec node tui.mjs
