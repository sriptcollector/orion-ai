# One-shot client install

Drop Orion's AI stack onto a client's computer with a single command. Each client
gets their own deployment repo (a curated bundle of the engines/skills you're
building for them, plus a `.env.example` listing the keys they need). The
installer clones it, installs deps, seeds `.env`, and tells them what to fill in.

## The one line a client runs

**Windows (PowerShell):**
```
$env:ORION_DEPLOY_REPO="https://github.com/<you>/<client-repo>.git"; irm https://raw.githubusercontent.com/<you>/<host-repo>/main/deploy/install.ps1 | iex
```

**macOS / Linux:**
```
curl -fsSL https://raw.githubusercontent.com/<you>/<host-repo>/main/deploy/install.sh | bash -s -- https://github.com/<you>/<client-repo>.git
```

## Per-client repo layout

```
client-acme/
  package.json        # only the engines this client gets
  .env.example        # every key they must supply, blank
  scripts/            # the engines (copied from this stack)
  README.md           # what it does + how to start
```

## Setup TUI

After install the client lands in `orion-setup.mjs`, a branded terminal UI:
Telegram setup, API-key entry (masked), **Status**, **Test my setup** (pings
Telegram live + sanity-checks keys), **Start services**, and **Request Help**
(opens email/call to the support contact). Re-run anytime: `node deploy/orion-setup.mjs`.

### Per-client branding (optional)

Drop a `deploy/orion-theme.json` in a client's bundle to rebrand and route support
without editing code:

```json
{
  "subtitle": "ACME  A I",
  "watermark": "~ built for ACME by Orion Jones ~",
  "supportEmail": "help@orion-jones.com",
  "supportPhone": "424-422-5031",
  "startCommand": "npm start",
  "keys": [{ "key": "RESEND_API_KEY", "label": "Resend", "hint": "resend.com", "secret": true }]
}
```

## Guarantees

- Requires git + node; refuses clearly if either is missing.
- Never assumes or ships secrets. `.env` starts from the blank template and the
  installer lists exactly which keys are still empty.
- Idempotent: re-running updates in place (`git pull --ff-only`), never clobbers a
  filled-in `.env`.
- Nothing auto-starts; the client runs the start command themselves.
