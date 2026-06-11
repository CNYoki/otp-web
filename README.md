# otp-web

A small web app that displays TOTP (Google Authenticator–style) one-time codes.

The **secrets never reach the browser**. All codes are computed on the server (Node.js) or in a Cloudflare Worker, and only the resulting 6-digit code plus a countdown are sent to the frontend. The UI shows one account card at a time with tabs to switch between accounts.

- Zero npm dependencies — TOTP is implemented with the built-in crypto / Web Crypto APIs.
- Supports `otpauth://` URIs or manual `secret` / `issuer` / `digits` / `period` / `algorithm` fields.
- Click a code to copy it; a progress bar counts down to the next refresh.

## Project layout

```
.
├── server.js            # Node HTTP server (holds secrets, computes codes)
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
  { "uri": "otpauth://totp/Google%3Ayou%40gmail.com?secret=YOURBASE32SECRET&issuer=Google" },
  { "label": "Example", "issuer": "Example", "secret": "GEZDGNBVGY3TQOJQ", "digits": 6, "period": 30, "algorithm": "SHA1" }
]
```

`secret` is Base32 (the usual A–Z, 2–7). If `OTP_ACCOUNTS` is not set, the server falls back to a built-in Demo account so you can try it immediately.

## Run with Docker (recommended for a server)

The secret is injected at runtime and is **not** baked into the image. The container is published only to the host loopback, so put nginx (or another reverse proxy) in front of it.

```bash
cp otp.env.example otp.env        # then edit otp.env with your real accounts
docker compose up -d --build
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

Environment variables: `HOST` (default `127.0.0.1`), `PORT` (default `3000`), `OTP_ACCOUNTS`.

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

## Security notes

- Real secrets belong only in `otp.env` (Docker) or the Worker/Pages environment — never in tracked files. `otp.env` and `.dev.vars` are gitignored.
- Anyone who can open the URL can read your codes. Add access control (nginx Basic Auth, IP allowlist, or an auth proxy) if it is internet-facing.
- `config.js` ships only a Demo placeholder secret and is safe to commit.

## API

| Endpoint         | Returns                                                        |
|------------------|---------------------------------------------------------------|
| `GET /api/accounts` | Account labels only (no secrets)                           |
| `GET /api/codes`    | Current code + seconds remaining for every account         |
| `GET /api/code?id=` | Current code for a single account                          |
