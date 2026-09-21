# Sheet Slide Web Exporter

A Node.js web application that exports billing data from Google Sheets into formatted Google Slides presentations, then exports them as PDFs or images. Built for school/hosting billing systems.

## Features

- **Profile-based configuration** — Save/load multiple billing configurations (sheet ID, template slide, output format, etc.)
- **Role-based access control** — Admin and Client portals with per-profile permissions
- **Row selection** — Excel-like inline checkbox selection for which rows to export
- **Preview before export** — See rendered slide images before running the full export
- **Auto-detect columns** — Automatically detect date, total, room, name, phone, email columns from sheet headers
- **Auto-match placeholders** — Scan slide templates for `{{placeholder}}` tokens and map them to sheet headers
- **Skip zero/empty rows** — Automatically skip rows where the bill value is zero or blank
- **Report dashboard** — View monthly/yearly/daily revenue trends with charts and KPI cards
- **Data upload** — Upload local `users.json` and profile JSONs to restore data on a new server
- **Credential upload** — Upload Google OAuth credentials and token files directly through the admin GUI
- **Docker support** — Single-container deployment with everything included

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Run
npm start
```

App runs at `http://localhost:4310`

### Docker Deployment

```bash
# Build
docker build -t sheet-slide-web-exporter .

# Run (with port mapping)
docker run -d \
  --name billing-app \
  -p 4310:4310 \
  -e NODE_ENV=production \
  sheet-slide-web-exporter
```

### Remote Server Deployment

```bash
# On your server
git clone <repo-url>
cd sheet-slide-web-exporter
docker build -t sheet-slide-web-exporter .
docker run -d \
  --name billing-app \
  --restart unless-stopped \
  -p 4310:4310 \
  -e NODE_ENV=production \
  sheet-slide-web-exporter
```

## Default Login

| Username | Password | Role |
|----------|----------|------|
| admin | admin | Admin |

Change the admin password immediately after first login.

## Portals

- **Login** — `http://localhost:4310/`
- **Client Portal** — `http://localhost:4310/client` (operator: preview rows, run exports, view reports)
- **Admin Portal** — `http://localhost:4310/admin` (manager: profiles, accounts, uploads, row selection)

## Admin Portal Guide

### Profile Configuration

1. **Identity** — Give the profile a unique name.
2. **Data Source** — Enter the Google Spreadsheet ID, sheet name, and range.
3. **Template** — Enter the Google Slides presentation ID used as the bill template.
4. **Export Options** — Choose output format (images/PDF/both), run folder behavior, skip empty rows, etc.
5. **Advanced Settings** —
   - **Placeholder Mapping** — Map sheet columns to slide placeholders (`{{date}}`, `{{total}}`, etc.)
   - **Auto-Match** — Click *Auto-Match Headers ↔ Placeholders* to scan the slide template and suggest mappings.
   - **Detect Columns** — Click *Detect Columns* to identify bill, room, date, name, phone, email columns automatically.
6. **Row Selection** — View eligible rows and select which ones to export via checkboxes.
7. **Save / Preview / Export** — Save the profile, preview the first few bills, or run the full export.

### Account Management

- Create client accounts with restricted profile access.
- Set *Allowed Profiles* to control which billing configurations each client can see.
- Check *All profiles* to grant unrestricted access.

### Upload Database

In the admin portal, use the **Upload Database** section to:
- Select your local `users.json` file → restores all accounts
- Select multiple profile `.json` files → restores all billing profiles
- Click **Upload Database** → files are saved to the server

### Upload Google Credentials

In the admin portal, use the **Upload Google Credentials** section to:
- Select your `client_secret_*.json` OAuth credentials file
- Select your saved token JSON file
- Click **Upload Credentials** → files are saved to `/app/google_credentials.json` and `/app/google_token.json`

After uploading, update your profiles to use:
- `credentials_file`: `/app/google_credentials.json`
- `token_file`: `/app/google_token.json`

Alternatively, set the environment variable:
```bash
-e GOOGLE_OAUTH_CREDENTIALS_JSON='<paste JSON content here>'
```

## Data File Locations

The application stores all persistent data as plain JSON files next to the source code. This makes backup, migration, and version control straightforward.

### Local Development (Windows)

| File / Folder | Actual Path | Description |
|---------------|-------------|-------------|
| Account database | `C:\Users\Admin\Documents\School\Billing System\users.json` | All user accounts with hashed passwords |
| Billing profiles | `C:\Users\Admin\Documents\School\Billing System\profiles\*.json` | One JSON per billing configuration |
| Google credentials | `C:\Users\Admin\Documents\School\Billing System\.vscode\Credentials\client_secret_582093589922-3vgtla9f73n4vrcba52p8qqfp8m1g9j6.apps.googleusercontent.com.json` | OAuth client secrets |
| Google token | `C:\Users\Admin\.google_workspace_mcp\credentials\bao22112211@gmail.com.json` | OAuth refresh / access token |
| Exported files | `C:\Users\Admin\Documents\School\Billing System\downloads\` | Generated PDFs and images per export run |

### Docker / Server Deployment

| File / Folder | Path (Docker) | Description |
|---------------|---------------|-------------|
| Account database | `/app/users.json` | All user accounts with hashed passwords |
| Billing profiles | `/app/profiles/*.json` | One JSON per billing configuration |
| Google credentials | `/app/google_credentials.json` | OAuth client secrets (uploaded via admin) |
| Google token | `/app/google_token.json` | OAuth refresh / access token (uploaded via admin) |
| Exported files | `/app/downloads/` | Generated PDFs and images per export run |

> **Tip:** On the server, you can mount these paths as Docker volumes for persistence across container restarts.

### Download & Backup

The admin portal can download these files directly for backup or migration:
- **Download Users** — downloads `users.json`
- **Download Profiles** — downloads all `profiles/*.json` as `profiles.zip`
- **Download Full Database** — downloads both users + profiles as `database.zip`

This makes it easy to back up or migrate data to another server.

## Client Portal Guide

1. Select a profile from the dropdown.
2. View eligible rows in the table.
3. Check/uncheck rows to control which bills to export.
4. Click **Preview Bills** to see rendered slide images.
5. Click **Run Export** to generate all files.
6. Download individual files or a ZIP archive.
7. View **Reports** for monthly/yearly/daily revenue summaries with charts.

## File Structure

```
.
├── Dockerfile                 # Docker image definition
├── package.json               # Node.js dependencies
├── README.md                  # This file
├── src/
│   ├── server.js              # Express backend (auth, API, uploads)
│   ├── exportService.js       # Google Sheets/Slides/Drive integration
│   ├── profileStore.js        # Profile CRUD (JSON files)
│   ├── userStore.js           # User auth with scrypt hashing
│   └── reportService.js       # Revenue aggregation and KPIs
├── public/
│   ├── login.html             # Login page
│   ├── admin/
│   │   ├── index.html         # Admin portal UI
│   │   ├── app.js             # Admin portal logic
│   │   └── styles.css         # Admin styles
│   └── client/
│       ├── index.html         # Client portal UI
│       ├── app.js             # Client portal logic
│       └── styles.css         # Client styles
├── profiles/                  # Saved profile JSONs (runtime)
├── downloads/                 # Exported files (runtime)
├── users.json                 # Account database (runtime)
└── .gitignore                 # Excludes node_modules, downloads, etc.
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `4310` |
| `NODE_ENV` | Node environment | `development` |
| `GOOGLE_OAUTH_CREDENTIALS_JSON` | Inline OAuth credentials JSON | — |

## Security Notes

- Default admin password is `admin`. **Change it immediately.**
- All passwords are hashed with `scrypt` + random salt.
- Sessions use in-memory storage (sufficient for single-instance deployments).
- For production behind a reverse proxy, set `NODE_ENV=production`.

## License

MIT
