# otp-web

A small web app that displays TOTP (Google Authenticator–style) one-time codes.

The **secrets never reach the browser**. All codes are computed on the server (Node.js) or in a Cloudflare Worker, and only the resulting 6-digit code plus a countdown are sent to the frontend. The UI shows one account card at a time with tabs to switch between accounts.

- Zero npm dependencies — TOTP is implemented with the built-in crypto / Web Crypto APIs.
- Supports `otpauth://` URIs or manual `secret` / `issuer` / `digits` / `period` / `algorithm` fields.
- Optional OIDC login for the Node/Docker deployment, including per-account group checks.
- Click a code to copy it; a progress bar counts down to the next refresh.

## Project layout

```
.
├── server.js            # Node HTTP server (holds secrets, computes codes)
├── auth.js              # OIDC login/session support for Node/Docker
├── totp.js              # TOTP + otpauth URI parsing (Node crypto)
├── config.js            # Reads accounts from env OTP_ACCOUNTS, else a Demo fallback
├── public/              # Frontend (shared by the Node server and the Worker)
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── _worker.js       # Self-contained Cloudflare Worker (TOTP via Web Crypto)
├── Dockerfile           # Container build
├── docker-compose.yml   # Runs the container, secret injected via otp.env
├── .dockerignore
├── otp.env.example      # Template for the Docker secret env file
└── .dev.vars.example    # Template for local Cloudflare (wrangler) dev
```

## Configuration

Accounts are provided as a JSON array via the `OTP_ACCOUNTS` environment variable. Each entry is either an `otpauth` URI or explicit fields:

```json
[
  { "uri": "otpauth://totp/Google%3Ayou%40gmail.com?secret=YOURBASE32SECRET&issuer=Google", "allowedGroups": ["otp-admins"] },
  { "label": "Example", "issuer": "Example", "secret": "GEZDGNBVGY3TQOJQ", "digits": 6, "period": 30, "algorithm": "SHA1" }
]
```

`secret` is Base32 (the usual A–Z, 2–7). If `OTP_ACCOUNTS` is not set, the server falls back to a built-in Demo account so you can try it immediately.

When OIDC is enabled, `allowedGroups` can be set per account. If it is omitted or empty, any logged-in user can view that account. The server also accepts `allowed_groups`, `group`, or `groups` as aliases in `OTP_ACCOUNTS`.

## OIDC login for Docker / Node

OIDC is disabled by default. It is enabled when `OIDC_ENABLED=true` is set, or automatically when `OIDC_CLIENT_ID`, `OIDC_AUTHORIZATION_ENDPOINT`, and `OIDC_TOKEN_ENDPOINT` are present.

Add these variables to `otp.env`:

```env
PUBLIC_URL=https://otp.example.com
OIDC_ENABLED=true
OIDC_AUTHORIZATION_ENDPOINT=https://idp.example.com/oauth2/authorize
OIDC_TOKEN_ENDPOINT=https://idp.example.com/oauth2/token
OIDC_USERINFO_ENDPOINT=https://idp.example.com/oauth2/userinfo
OIDC_CLIENT_ID=otp-web
OIDC_CLIENT_SECRET=change-me
OIDC_SESSION_SECRET=change-this-to-a-long-random-string
OIDC_GROUPS_CLAIM=groups
```

Register `https://otp.example.com/auth/callback` as the redirect URI in your OIDC provider. If you do not set `PUBLIC_URL`, set `OIDC_REDIRECT_URI` directly.

Useful optional variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OIDC_SCOPE` / `OIDC_SCOPES` | `openid profile email groups` | OIDC scopes requested at login |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim path used for group matching, e.g. `realm_access.roles` |
| `OIDC_USERNAME_CLAIM` | `preferred_username` | Display name claim stored in the session |
| `OIDC_TOKEN_AUTH_METHOD` | `client_secret_basic` | Use `client_secret_post` or `none` if your provider requires it |
| `OIDC_SESSION_TTL_SECONDS` | `28800` | Login session lifetime |
| `OIDC_COOKIE_SECURE` | auto from `X-Forwarded-Proto` | Set `true` when HTTPS terminates before the app |

## Run with Docker (recommended for a server)

The secret is injected at runtime and is **not** baked into the image. The container is published only to the host loopback, so put nginx (or another reverse proxy) in front of it.

```bash
cp otp.env.example otp.env        # then edit otp.env with your real accounts
docker compose up -d --build
```

A prebuilt image is published to GitHub Container Registry by CI on every push to `main`:

```bash
docker run -d -p 127.0.0.1:3000:3000 --env-file otp.env ghcr.io/cnyoki/otp-web:latest
```

The app is now reachable at `http://127.0.0.1:3000`. Point your reverse proxy at it, for example:

```nginx
server {
    listen 80;
    server_name otp.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Use HTTPS in production (e.g. `certbot --nginx`) — the generated codes are sensitive.

## Run with Node directly

```bash
export OTP_ACCOUNTS='[{"uri":"otpauth://totp/Demo:demo@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Demo"}]'
node server.js              # listens on 127.0.0.1:3000 by default
```

Environment variables: `HOST` (default `127.0.0.1`), `PORT` (default `3000`), `OTP_ACCOUNTS`, plus the OIDC variables above when login is enabled.

## Deploy as a Cloudflare Worker / Pages

`public/_worker.js` is a self-contained Worker: it serves the static frontend and computes codes via Web Crypto. The secret lives in the Worker/Pages environment variable `OTP_ACCOUNTS`.

```bash
npm i -g wrangler
cp .dev.vars.example .dev.vars     # local dev secret
wrangler pages dev public          # local
wrangler pages deploy public --project-name=otp   # deploy
wrangler pages secret put OTP_ACCOUNTS --project-name=otp
```

Or connect this repo in the Cloudflare dashboard (output directory `public`) and set `OTP_ACCOUNTS` as an encrypted environment variable.

OIDC login is implemented for the Node/Docker server. The Cloudflare Worker remains a simple no-login deployment target.

## Security notes

- Real secrets belong only in `otp.env` (Docker) or the Worker/Pages environment — never in tracked files. `otp.env` and `.dev.vars` are gitignored.
- If OIDC is disabled, anyone who can open the URL can read your codes. Add OIDC, nginx Basic Auth, IP allowlist, or an auth proxy if it is internet-facing.
- Use a long random `OIDC_SESSION_SECRET`; changing it logs out all users.
- `config.js` ships only a Demo placeholder secret and is safe to commit.

## API

| Endpoint         | Returns                                                        |
|------------------|---------------------------------------------------------------|
| `GET /api/accounts` | Account labels only (no secrets)                           |
| `GET /api/codes`    | Current code + seconds remaining for every account         |
| `GET /api/code?id=` | Current code for a single account                          |
| `GET /api/me`       | Current login status when OIDC is enabled                  |
| `GET /healthz`      | Container health check                                     |
