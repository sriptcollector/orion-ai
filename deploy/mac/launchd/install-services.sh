#!/usr/bin/env bash
# Installs the bot + scheduler as launchd user agents so they start at login,
# restart on crash, and survive a reboot. Run once, on the Mac, as the user who
# will own the machine (NOT with sudo - these are per-user agents by design, so
# they run inside a real login session where Messages.app is available).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "ERROR: node is not on PATH. Install Node 20+ first."; exit 1; }

AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS" "$DIR/data/logs"

make_plist () {
  local label="$1" script="$2"
  cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/$script</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DIR/data/logs/$label.out.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/logs/$label.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ORION_VERBOSE</key><string>0</string>
    <key>STATUS_BIND</key><string>${STATUS_BIND:-0.0.0.0}</string>
  </dict>
</dict>
</plist>
PLIST
  # bootout first so re-running this script is an update, not an error.
  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$AGENTS/$label.plist"
  launchctl enable "gui/$UID/$label"
  echo "  installed $label"
}

echo "Installing launchd services from $DIR"
make_plist "com.orion.assistant.bot" "bot.mjs"
make_plist "com.orion.assistant.scheduler" "scheduler.mjs"
make_plist "com.orion.assistant.status" "statusweb.mjs"

echo
echo "Done. Both services are running and will come back after a reboot."
echo
echo "  status page:  http://$(hostname):${STATUS_PORT:-8791}/   (token is in .env as STATUS_TOKEN)"
echo "  status:   launchctl list | grep com.orion.assistant"
echo "  logs:     tail -f $DIR/data/logs/bot.log"
echo "  stop:     bash $DIR/launchd/uninstall-services.sh"
echo
echo "NOTE: these are LOGIN agents. After a reboot the Mac must reach a logged-in"
echo "desktop for them to start - Messages.app and the browser sessions need one."
echo "Turn on automatic login: System Settings > Users & Groups > Automatically log in as."
