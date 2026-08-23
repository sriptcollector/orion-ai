# Orion AI

Custom AI systems for your business, installed in one line and run from a clean,
branded terminal. Built by Orion Jones — orion-jones.com.

## Install

**Windows (PowerShell):**
```
$env:ORION_DEPLOY_REPO="<your-client-repo>.git"; irm https://raw.githubusercontent.com/sriptcollector/orion-ai/main/deploy/install.ps1 | iex
```

**macOS / Linux:**
```
curl -fsSL https://raw.githubusercontent.com/sriptcollector/orion-ai/main/deploy/install.sh | bash -s -- <your-client-repo>.git
```

You'll land in the setup terminal: connect Telegram, add your keys, test, and
start. See `deploy/README.md` for per-client branding.
