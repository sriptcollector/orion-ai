#!/usr/bin/env bash
# One-shot installer for a client's Mac.
#
# Interactive (client types the key, then fills things in via the terminal):
#   curl -fsSL https://raw.githubusercontent.com/sriptcollector/orion-ai/main/deploy/mac/install-mac.sh | bash
#
# One-shot (Orion pastes one line with every key already in it — the client
# never types a token, and the box is configured before the terminal opens):
#   ORION_KEY=... CLIENT_NAME="Acme" TELEGRAM_BOT_TOKEN=... DEEPSEEK_API_KEY=... \
#   ORION_AUTO=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/sriptcollector/orion-ai/main/deploy/mac/install-mac.sh)"
#
# Idempotent: re-running updates in place and never clobbers a filled-in .env.
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
# Regenerate this list with:  node deploy/license-tool.mjs hashes
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
    if [ "${ORION_AUTO:-0}" = "1" ]; then
      yn=y
    else
      printf "  Install Homebrew (the standard macOS package manager)? [y/N] "
      read -r yn </dev/tty
    fi
    [ "$yn" = "y" ] || die "Node 20+ is required. Install it from nodejs.org and re-run."
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
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
npx --yes playwright install chromium >/dev/null 2>&1 || warn "browser install had trouble - re-run later: npx playwright install chromium"
ok "chromium"

# --- env -------------------------------------------------------------------
if [ ! -f .env ]; then cp .env.example .env; ok "created .env"; else ok ".env already exists"; fi
mkdir -p data/logs

# Seed any key passed in as an environment variable. This is what makes the
# install one-shot. A value already filled in is left alone unless
# ORION_FORCE_ENV=1, so re-running never destroys a working config.
SEEDED=0
seed () {
  key="$1"; val="$2"
  [ -n "$val" ] || return 0
  cur=$(grep -E "^${key}=" .env 2>/dev/null | head -1 | cut -d= -f2-)
  if [ -n "$cur" ] && [ "${ORION_FORCE_ENV:-0}" != "1" ]; then return 0; fi
  # awk, not sed: a token containing / or & would corrupt a sed replacement.
  awk -v k="$key" -v v="$val" -F= '
    BEGIN { done = 0 }
    $1 == k { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' .env > .env.tmp && mv .env.tmp .env
  SEEDED=$((SEEDED + 1))
}

for k in CLIENT_NAME TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USER_IDS \
         DEEPSEEK_API_KEY DEEPSEEK_MODEL \
         REDDIT_CLIENT_ID REDDIT_CLIENT_SECRET REDDIT_USERNAME REDDIT_PASSWORD REDDIT_USER_AGENT \
         ORION_RELAY_BOT_TOKEN ORION_TELEGRAM_CHAT_ID ORION_ADMIN_TELEGRAM_IDS \
         ORION_SUPPORT_EMAIL ORION_SUPPORT_PHONE ORION_SLOTS_URL ORION_BOOK_URL \
         ORION_TZ ORION_HEADFUL STATUS_PORT STATUS_BIND STATUS_TOKEN; do
  eval "v=\${$k:-}"
  seed "$k" "$v"
done
[ "$SEEDED" -gt 0 ] && ok "$SEEDED keys pre-filled from the install command"

# The status page needs a token before it is exposed on the tailnet.
if ! grep -qE '^STATUS_TOKEN=.+' .env 2>/dev/null; then
  TOK=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  ORION_FORCE_ENV=1 seed STATUS_TOKEN "$TOK"
  ok "generated a status page token"
fi

echo
bold "Installed."
echo

# ORION_AUTO=1 finishes without anyone touching the keyboard: installs the
# always-on services and runs the full preflight. Browser logins and the macOS
# permission prompts still need a human — they cannot be automated, and the
# preflight names each one precisely.
if [ "${ORION_AUTO:-0}" = "1" ]; then
  bold "Turning on 24/7 mode..."
  bash launchd/install-services.sh || warn "service install had trouble"
  echo
  bold "Running preflight..."
  node selftest.mjs || true
  echo
  dim "Anything still listed above needs a human: browser logins under 'Accounts',"
  dim "and the macOS Full Disk Access / Automation prompts."
else
  dim "Next, in the setup screen that's about to open:"
  dim "  2  Keys & setup     paste the Telegram + DeepSeek keys"
  dim "  3  Accounts         sign in to LinkedIn and any socials"
  dim "  4  Always-on        turn on 24/7"
  dim "  5  Check everything confirm it all works"
fi
echo
TOKV=$(grep -E "^STATUS_TOKEN=" .env | cut -d= -f2-)
bold "Finish setup from any device:"
echo "  http://$(hostname):${STATUS_PORT:-8791}/setup?t=$TOKV"
echo
dim "That page connects your accounts by pasting cookies from a browser you are"
dim "already logged in on - no passwords, and nothing to install on this Mac."
echo
dim "Reopen this screen anytime:  cd $APP && npm run setup"
echo
sleep 2
# Piped through `curl | bash`, stdin is the pipe, not the keyboard — the TUI
# would read EOF and quit instantly. Hand it the real terminal.
exec node tui.mjs </dev/tty
