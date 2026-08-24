#!/usr/bin/env bash
# Stops and removes both launchd services. Leaves all data and logins intact.
set -euo pipefail
for label in com.orion.assistant.bot com.orion.assistant.scheduler com.orion.assistant.status; do
  launchctl bootout "gui/$UID/$label" 2>/dev/null && echo "  stopped $label" || echo "  $label was not running"
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
echo "Removed. Data, leads and saved logins are untouched."
