# Billing System — Sheet → Slides Invoice Exporter

A Node.js/Express web application that turns **Google Sheets billing rows** into **formatted
Google Slides invoices**, exports them as **PDF or images**, archives them per run, and delivers
them to tenants through **Zalo** (Bot Platform, Official Account and ZNS).

Built for the "Đất Thành" room-rental billing operation (`Quản Lý Phòng Trọ` sheet +
`Hóa Đơn Đất Thành` Slide template) and written up as a graduation internship report.

---

## Table of contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Tech stack](#tech-stack)
4. [Quick start](#quick-start)
5. [Default accounts](#default-accounts)
6. [Portals](#portals)
7. [Admin portal guide](#admin-portal-guide)
8. [Client portal guide](#client-portal-guide)
9. [Zalo notification subsystem](#zalo-notification-subsystem)
10. [Export pipeline](#export-pipeline)
11. [Data & file locations](#data--file-locations)
12. [API reference](#api-reference)
13. [Environment variables](#environment-variables)
14. [Project structure](#project-structure)
15. [Security notes](#security-notes)
16. [Troubleshooting](#troubleshooting)
17. [Known limitations](#known-limitations)
18. [License](#license)

---

## Features

**Export pipeline**
- Profile-based configuration — sheet ID/range, slide template ID, output format, naming, run folders
- Excel-like inline row selection (checkbox per row) with select-all / clear
- Preview bill images before committing to a full export
- Auto-detect columns (date, total, room, name, phone) from sheet headers
- Auto-match `{{placeholder}}` tokens in the slide template to sheet columns
- Skip zero/empty rows automatically
- Batch replace placeholders through the Slides `batchUpdate` API
- Output as PDF, PNG images, or both; ZIP per run

**Google Workspace integration**
- OAuth 2.0 (installed-app flow) with token refresh and re-consent handling
- Sheets read, Slides copy + batch update + thumbnail rendering, Drive export
- Credentials and tokens can be uploaded through the admin GUI (no server shell needed)

**Zalo notifications** (three delivery channels, one dispatcher)
- **Zalo Bot Platform** — free chat delivery to tenants who linked their phone
- **Zalo Official Account (OA)** — direct OA messages
- **ZNS** — paid template messages, used as fallback when a tenant is not linked
- Automatic channel selection with feature flags, fallback, and a per-message audit ledger
- Message template editor with token picker, auto-discovered tokens and live preview
- Phone ↔ chat linking (subscriber store), webhook **and** long-polling ingestion modes
- Test send, token refresh, webhook registration/diagnostics from the admin UI

**Reporting**
- Monthly / yearly revenue aggregation computed directly from the sheet
- KPI cards + Chart.js trends
- On-demand refresh (no stale cached reports)

**Operations**
- Role-based access (admin / client) with per-client profile scoping
- Session expiry handled explicitly — the UI returns to the login page with a clear message
  instead of a bare "Unauthorized"
- Database download/upload (users + profiles) for backup and migration
- Docker single-container deployment (non-root user, `zip` included)

---

## Architecture

```
        ┌──────────────────────┐        ┌──────────────────────┐
        │   Admin Portal       │        │   Client Portal      │
        │  profiles, users,    │        │  pick profile,       │
        │  Zalo config, ops    │        │  select rows, export │
        └──────────┬───────────┘        └──────────┬───────────┘
                   │  REST + session cookie         │
                   └───────────────┬────────────────┘
                                   ▼
                        ┌─────────────────────┐
                        │  Express (server.js)│
                        │  auth · routing     │
                        └───┬────┬────┬────┬──┘
          ┌─────────────────┘    │    │    └──────────────────┐
          ▼                      ▼    ▼                       ▼
  exportService.js        reportService  profileStore     userStore
  (Sheets/Slides/Drive)   (KPI, charts)  (profiles/*.json) (scrypt auth)
          │                                        │
          ▼                                        ▼
  ┌───────────────────┐                  ┌──────────────────────┐
  │ Google Workspace  │                  │ Zalo platform        │
  │ Sheets · Slides   │                  │ Bot API · OA · ZNS   │
  │ Drive · OAuth 2.0 │                  └──────────┬───────────┘
  └───────────────────┘                             │
          ▲                          zaloService · zaloBotService
          │                          zaloStore · zaloSubscriberStore
          └────────── notifyBill() dispatcher ◄──────┘
                    (channel matrix + notifications.json ledger)
```

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ (developed on Node 24) |
| Server | Express 4 |
| Google APIs | `googleapis` (Sheets v4, Slides v1, Drive v3, OAuth2) |
| Frontend | Vanilla JS + hand-written CSS design system, Chart.js for reports |
| Storage | JSON files on disk (`users.json`, `profiles/*.json`, `notifications.json`, `zalo_subscribers.json`) |
| Auth | HttpOnly + SameSite=Strict session cookie, `scrypt` password hashing |
| Deployment | Docker (`node:20-alpine`), port `4310` |

---

## Quick start

### Local development

```bash
git clone https://github.com/bao2211/Billing-System.git
cd Billing-System
npm install
npm start          # http://localhost:4310
```

`npm run dev` starts the same server under `node --watch`.

### Docker

```bash
docker build -t billing-system .
docker run -d --name billing-app \
  --restart unless-stopped \
  -p 4310:4310 \
  -e NODE_ENV=production \
  billing-system
```

Mount the runtime JSON files as volumes if you want data to survive container rebuilds:

```bash
docker run -d --name billing-app -p 4310:4310 \
  -v "$PWD/users.json:/app/users.json" \
  -v "$PWD/profiles:/app/profiles" \
  -v "$PWD/downloads:/app/downloads" \
  billing-system
```

### First run

1. Open `http://localhost:4310` and sign in as `admin`.
2. **Upload credentials** — Google OAuth client JSON (and token, if you already have one).
3. Create a **profile**: spreadsheet ID + sheet name/range + slide template ID.
4. Click **Detect Columns** and **Auto-Match placeholders**.
5. **Preview bills** → **Run export**.
6. Optional: configure **Zalo** in the profile (bot token / OA / ZNS template) and send a test message.

---

## Default accounts

| Username | Password | Role | Notes |
|---|---|---|---|
| `admin` | `admin` | admin | Full access: profiles, users, Zalo config, backups |
| `client` | `client` | client | Only the profiles explicitly allowed for that account |

**Change these passwords immediately after the first login** (Admin → Accounts).

---

## Portals

| Route | Who | Purpose |
|---|---|---|
| `/` | everyone | Login page |
| `/admin` | admin | Profiles, accounts, Zalo settings, uploads, backups, logs |
| `/client` | client | Pick an allowed profile, select rows, preview, export, download, reports |

Both portals share the same REST API; the server enforces the role on every route.

---

## Admin portal guide

### Profile configuration

1. **Identity** — unique profile name (used as folder name for exports).
2. **Data source** — spreadsheet ID, sheet name, range (e.g. `Quản Lý Phòng Trọ!A1:P200`).
3. **Template** — Google Slides presentation ID used as the invoice template.
4. **Export options** — PDF / images / both, run-folder behaviour, skip zero rows, filename pattern.
5. **Mapping** — map sheet columns to slide placeholders (`{{Phòng}}`, `{{Tiền Điện}}`, `{{Tổng}}`, …).
   *Auto-Match* scans the template and proposes mappings; *Detect Columns* fills the rest.
6. **Zalo** — choose channels for this profile (bot / OA / ZNS), edit the message template,
   pick tokens, preview the rendered message, enable ZNS fallback.
7. **Save / Preview / Export**.

### Accounts

- Create client accounts and restrict each to a subset of profiles. The restriction is enforced
  server-side (`filterProfilesForSession`), so a client cannot open another tenant's profile even
  by guessing its name.

### Backups

- **Download users** → `users.json`
- **Download profiles** → `profiles.zip`
- **Download database** → both, as `database.zip`
- **Upload database** restores them on a new server.

---

## Client portal guide

1. Choose one of the profiles you are allowed to use.
2. Review the eligible rows (inline checkboxes control what gets exported).
3. **Preview bills** to sanity-check the rendered slides.
4. **Run export** → files are written to a per-run folder and zipped.
5. Download individual files or the ZIP.
6. Open **Reports** for monthly / yearly revenue and KPIs.
7. Optionally tick **Send via Zalo** for the rows that have a phone number.

---

## Zalo notification subsystem

| Module | Responsibility |
|---|---|
| `src/zaloService.js` | OA + ZNS transport, message templating, token refresh, phone normalisation |
| `src/zaloBotService.js` | Bot Platform API (getMe, getUpdates, sendMessage, webhook helpers) |
| `src/zaloStore.js` | Global OA config (`zalo_config.json`), token lifecycle, notification ledger (`notifications.json`) |
| `src/zaloSubscriberStore.js` | Phone ↔ chat bindings (`zalo_subscribers.json`, PII — never commit) |

**Channel selection (per row)** — implemented by `notifyBill()`:

```
row → extract & normalise phone
    ├─ no / invalid phone        → skip + log
    ├─ channel disabled          → skip (no log)
    ├─ phone linked to a chat    → send via Bot Platform (free)  + log
    └─ not linked
        ├─ ZNS fallback enabled  → send via ZNS (paid)           + log
        └─ otherwise             → skip + log
```

**Ingestion modes**
- **Long-polling** (`ZALO_BOT_POLL=true` or the admin "Start polling" action) — no public URL needed.
- **Webhook** — `POST /api/zalo/bot/webhook`; register it with *Set webhook* and inspect it with
  *Webhook info*. Use webhooks in production and polling only for local testing.

**Tokens**
- OA access tokens expire; `zaloStore.isTokenExpired()` drives the admin warning and the
  manual **Refresh token** action. A real ZNS send additionally needs an approved
  `template_id` from the Zalo OA console.

---

## Export pipeline

`exportService.runExport()` processes a profile in ordered stages:

| # | Stage | Function |
|---|---|---|
| 1 | Load + normalise profile (defaults, validation) | `loadProfile` → `normalizeProfile` → `validateProfile` |
| 2 | Build Google clients and refresh the OAuth token | `createGoogleClients` → `ensureAccessToken` |
| 3 | Read the configured sheet range | `readSheetValues` |
| 4 | Turn rows into records (header folding, slug, phone) | `buildRowRecords` |
| 5 | Filter rows (selection, skip zero/empty, month) | `selectRecordsForExport` |
| 6 | Resolve the template context per row | `buildTemplateContext` |
| 7 | Build `batchUpdate` replace requests | `buildReplaceRequests` |
| 8 | Copy the slide template to a run folder | `copyTemplate` (Drive) |
| 9 | Apply placeholder replacements | `batchReplace` (Slides) |
| 10 | Export artefacts | `exportPdf` / `exportImages` |
| 11 | Archive + notify | ZIP per run, `notifyBill()` per row, ledger entry |

Output layout:

```
downloads/<profile>/<run>-<timestamp>/
  ├── <room>-<name>.pdf
  └── images/<room>-<name>.png
```

---

## Data & file locations

| File / folder | Purpose |
|---|---|
| `users.json` | Accounts (scrypt hashes, roles, allowed profiles) |
| `profiles/*.json` | One JSON per billing profile (sheet, template, mapping, Zalo) |
| `downloads/` | Exported PDFs / images, one subfolder per run |
| `notifications.json` | Audit ledger of every notification attempt |
| `zalo_config.json` | Global OA configuration + tokens (**never commit**) |
| `zalo_subscribers.json` | Phone ↔ chat bindings (**PII — never commit**) |
| `google_credentials.json` / `google_token.json` | OAuth client + token (Docker paths, uploaded via admin) |
| `client_secret_*.apps.googleusercontent.com.json` | OAuth client JSON in the repo root |
| `sheet_slide_export_token.json` | OAuth token file used by this deployment |

---

## API reference

All routes are JSON over HTTP; authentication is the session cookie set by `/api/login`.
Admin routes additionally require the admin role.

| Group | Endpoints |
|---|---|
| Auth | `POST /api/login` · `POST /api/logout` · `GET /api/session` · `GET /api/health` |
| Users | `GET/POST /api/users` · `PUT/DELETE /api/users/:username` |
| Profiles | `GET /api/profiles` · `GET /api/profiles/:name` · `POST /api/profiles/save` · `DELETE /api/profiles/:name` |
| Preview / export | `POST /api/preview/rows` · `POST /api/preview/export` · `POST /api/export` · `GET /api/zip/:runId` · `POST /api/open-output-folder` |
| Reports | `POST /api/report/month` · `POST /api/report/year` · `POST /api/report/selected` |
| Backup | `GET /api/download/users` · `GET /api/download/profiles` · `GET /api/download/database` · `POST /api/upload-database` · `POST /api/upload-credentials` |
| Zalo config | `GET /api/zalo/status` · `GET/POST /api/zalo/config` · `POST /api/zalo/refresh` · `POST /api/zalo/test` · `POST /api/zalo/verify-drive` |
| Zalo bot | `POST /api/zalo/bot/verify` · `POST /api/zalo/bot/poll` · `POST /api/zalo/bot/send-test` · `POST /api/zalo/bot/webhook` · `POST /api/zalo/bot/set-webhook` · `GET /api/zalo/bot/webhook-info` |
| Zalo messages | `POST /api/zalo/message-preview` · `GET /api/notifications` |
| Subscribers | `GET/POST /api/zalo/subscribers` · `POST /api/zalo/subscribers/:chatId/unlink` · `DELETE /api/zalo/subscribers/:chatId` |

---

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port | `4310` |
| `NODE_ENV` | `production` enables production behaviour | `development` |
| `GOOGLE_OAUTH_CREDENTIALS_JSON` | Inline OAuth client JSON (alternative to uploading a file) | — |
| `GOOGLE_OAUTH_CREDENTIALS` | Path to an OAuth client JSON file | — |
| `ZALO_BOT_POLL` | Set to `true` to start bot long-polling on boot | off |

---

## Project structure

```
.
├── Dockerfile                  # node:20-alpine image, port 4310, non-root user
├── package.json                # express + googleapis
├── src/
│   ├── server.js               # Express app: auth, routing, uploads, backups
│   ├── exportService.js        # Sheets → Slides → PDF/PNG pipeline, OAuth, Drive
│   ├── reportService.js        # KPI / monthly / yearly / daily aggregation
│   ├── profileStore.js         # Profile CRUD + per-session scoping
│   ├── userStore.js            # scrypt password hashing, account CRUD
│   ├── zaloService.js          # OA + ZNS transport, templating, token refresh
│   ├── zaloBotService.js       # Zalo Bot Platform API client
│   ├── zaloStore.js            # Global Zalo config + notification ledger
│   └── zaloSubscriberStore.js  # Phone ↔ chat bindings
├── public/
│   ├── login.html              # Login page (shows session-expired notice)
│   ├── admin/                  # Admin portal: index.html, app.js, styles.css
│   ├── client/                 # Client portal: index.html, app.js, styles.css
│   └── app.js, index.html, styles.css
├── profiles/                   # Runtime: profile JSONs
├── downloads/                  # Runtime: exported files
├── users.json                  # Runtime: accounts
└── Document/                   # Internship report sources + final PDF (git-ignored)
```

---

## Security notes

- Default passwords are `admin` / `client` — **rotate them on first login**.
- Passwords are hashed with `scrypt` + per-user salt; hashes never leave the server.
- Sessions: HttpOnly cookie, `SameSite=Strict`, `Max-Age=86400` (24 h). Expired or missing
  sessions return `401` with a reason the UI turns into "session expired, please sign in again".
- Client accounts are limited to their allowed profiles **server-side**, not just in the UI.
- ⚠️ This repository is **private** and intentionally tracks Google OAuth client secrets and a
  token file (see `.gitignore`). If it ever becomes public, revoke and re-issue those credentials
  in Google Cloud Console first.
- Zalo tokens live in `zalo_config.json` (git-ignored). Rotate the OA token if it leaks.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Redirected to login with "session expired" | Cookie expired (24 h) or the server restarted (sessions are in memory) — sign in again |
| `Unauthorized` on an API call | Not signed in, or signed in as `client` while calling an admin route |
| Placeholders left as `{{...}}` in the PDF | Slide token and mapping key differ — run **Auto-Match placeholders**, then preview |
| `invalid_grant` / token expired | Upload a fresh token, or use **Refresh token** |
| Drive export fails | The account must be able to copy the template — share it explicitly |
| ZNS send fails | Needs an approved OA `template_id`; check the ledger in `notifications.json` |
| Bot receives nothing | Polling off and no webhook registered (or the webhook URL is unreachable) |
| Export folder empty | Every row was filtered out — zero/empty bill or nothing selected |

---

## Known limitations

- Sessions are stored **in memory** — restarting the process signs everyone out (fine for a single
  instance; add a session store if you scale out).
- State lives in JSON files — no concurrent-writer protection beyond Node's single thread.
- ZNS delivery needs Zalo OA approval (template + token) before it can reach real tenants.
- Reports are recomputed from the sheet on demand (correct, but not cached for large ranges).
- No rate limiting, and no admin-action audit trail beyond the notification ledger.

---

## License

MIT



