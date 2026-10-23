# Deploying Sara

Two separate things can be deployed, and they are not interchangeable:

1. **The web frontend** (`dist/`) — static files. Any static host works.
2. **The Sara backend** (`dist/server.cjs`) — Node.js + WebSocket + Gemini Live
   + local files, cognition and the Windows desktop agent. It must run on the
   computer that owns the account (or a persistent Node host that can reach that
   computer). It is **not** a serverless function.

The Android APK is a third artifact: a static bundle plus a configurable
backend URL (see [ANDROID.md](./ANDROID.md)).

## 1. Build commands (taken from package.json)

| Task | Command | Output |
| --- | --- | --- |
| Frontend only | `npm run build:web` | `dist/` |
| Frontend + backend bundle | `npm run build` | `dist/` + `dist/server.cjs` |
| Run backend | `npm start` (`node dist/server.cjs`) | serves `dist/` + API |
| Android assets | `npx cap sync android` | `android/…/assets/public` |

Node 22 is what CI uses. `npm ci` installs from `package-lock.json`.

## 2. Frontend on Vercel

`vercel.json` is included:

- Framework preset: Vite
- Build: `npm run build:web` → `dist`
- SPA rewrite so refreshing `/anything` still serves `index.html`
- Immutable caching for `/assets/*`, no-store for `index.html`
- Security headers, `Permissions-Policy: microphone=(self), camera=()`

```bash
npx vercel --prod        # or connect the repository in the Vercel dashboard
```

Netlify: `netlify.toml` provides the same build, rewrite and headers.

**Point the deployed site at a backend.** Three options, in order of preference:

1. In the app: phone → **Connect to Sara** → address + token (stored on device).
2. Build-time: `VITE_SARA_API_BASE=https://sara.example.com npm run build:web`.
3. After deploy, edit `runtime-config.js` on the host:

   ```js
   window.__SARA_CONFIG__ = { apiBase: "https://sara.example.com" };
   ```

Never put the token in 2 or 3: both are public. Environment variables documented
in `.env.mobile.example`.

If you do not deploy, nothing breaks: the desktop app serves the same build from
`localhost:3000`.

## 3. Backend

### On the PC (default, recommended)

```bash
npm run build
npm start                 # http://localhost:3000, local-only
```

### Reachable from the phone

```bash
export SARA_REMOTE_ACCESS=1
export SARA_ACCESS_TOKEN="$(openssl rand -hex 32)"
export SARA_ALLOWED_ORIGINS="https://your-app.vercel.app"
export SARA_TRUST_PROXY=1          # if a proxy terminates TLS
npm start                          # binds 0.0.0.0:3000
```

Then expose it over HTTPS with Cloudflare Tunnel, Tailscale Funnel, or nginx:

```nginx
server {
  listen 443 ssl;
  server_name sara.example.com;
  # ssl_certificate ...;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # WebSockets: /live and /events
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
  }
}
```

Notes:

- The desktop app keeps working while remote mode is on: requests from the
  machine itself bypass the token (TCP peer check).
- Do **not** put the port on the open internet without the token; the server
  refuses to start remote mode without one.
- `SARA_REMOTE_ALLOW_DESKTOP=1` lets a phone start PC tasks/messages. Leave it
  off unless you accept that risk; risky actions still require approval.
- The Python desktop agent must stay on the PC. It is not deployed.

### On a hosting platform

A persistent Node host (Railway, Render, Fly.io, a VPS) can run
`node dist/server.cjs`, but it will not have your PC's files, apps or desktop
agent. Sara's memory would live on that host. This is a valid "cloud Sara", not
a replacement for controlling your PC, and it needs a persistent volume for
`.myraa-data`. Serverless platforms are unsuitable (WebSockets + local files).

## 4. Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | backend only | alternative to entering the key in the UI |
| `MYRAA_PORT` / `PORT` | backend | listen port (default 3000) |
| `SARA_REMOTE_ACCESS` | backend | enable token-protected remote access |
| `SARA_ACCESS_TOKEN` | backend | shared secret for phone/web clients |
| `SARA_ALLOWED_ORIGINS` | backend | comma-separated CORS allow-list |
| `SARA_HOST` | backend | bind address (defaults to 0.0.0.0 in remote mode) |
| `SARA_TRUST_PROXY` | backend | trust `X-Forwarded-*` from a proxy |
| `SARA_REMOTE_ALLOW_DESKTOP` | backend | allow remote PC control (default off) |
| `VITE_SARA_API_BASE` | frontend build | default backend URL (public) |

See `.env.example` (backend) and `.env.mobile.example` (frontend).

## 5. Verifying a deployment

```bash
curl -s https://your-backend/api/health
# {"ok":true,"name":"Sara","version":"…","remoteAccess":true,"authRequired":true}

curl -s -o /dev/null -w "%{http_code}\n" https://your-backend/api/config
# 401 without a token

curl -s -H "Authorization: Bearer $TOKEN" https://your-backend/api/config
# {"hasApiKey":true}

npm run check:bundle-secrets   # after building: no keys in the bundle
```

Open the deployed site, connect with the token, start a voice session, send a
message, open Memory, and confirm the desktop app still works on the PC.
