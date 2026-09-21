const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');
const crypto = require('crypto');

const {
  normalizeProfile,
  validateProfile,
  getSheetRowSelectionPreview,
  getExportPreview,
  runExport
} = require('./exportService');
const {
  ensureDefaultProfile,
  listProfiles,
  loadProfile,
  saveProfile,
  deleteProfile,
  assertSafeProfileName
} = require('./profileStore');
const {
  verifyPassword,
  createUser,
  updateUser,
  deleteUser,
  listUsers
} = require('./userStore');
const { generateReport } = require('./reportService');

const app = express();
const PORT = Number(process.env.PORT || 4310);

app.use(express.json({ limit: '20mb' }));

// ---------- Public download directory ----------
const DOWNLOADS_DIR = path.resolve(__dirname, '..', 'downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
app.use('/downloads', express.static(DOWNLOADS_DIR));

function cleanupOldDownloads() {
  const maxAgeMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  try {
    fs.readdirSync(DOWNLOADS_DIR).forEach((name) => {
      const dirPath = path.join(DOWNLOADS_DIR, name);
      const stat = fs.statSync(dirPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    });
  } catch (e) { /* ignore cleanup errors */ }
}

cleanupOldDownloads();
setInterval(cleanupOldDownloads, 60 * 60 * 1000);

// ---------- Simple in-memory session/auth ----------
const sessions = new Map();

// Run ownership: only the account that started an export (or an admin) may fetch its ZIP.
const runOwners = new Map();

const SEVEN_ZIP_CANDIDATES = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe'
];

function findSevenZip() {
  return SEVEN_ZIP_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
}

// Spawn a tool with an argument array. Never build a shell command out of request
// data: exec() lets a crafted path/id break out of its own quotes.
function runTool(command, args, cwd) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: 'pipe' });
    } catch (error) {
      reject(error);
      return;
    }
    let errOut = '';
    child.stderr.on('data', (chunk) => { errOut += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exit ${code}: ${errOut.slice(0, 400)}`));
    });
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(
    raw
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
  );
}

function setCookie(res, name, value, maxAge = 86400) {
  res.setHeader(
    'Set-Cookie',
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
  );
}

function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const sid = cookies.sid;
  const session = sessions.get(sid);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.session = session;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    const cookies = parseCookies(req);
    const sid = cookies.sid;
    const session = sessions.get(sid);
    if (!session || session.role !== role) {
      if (req.headers.accept && req.headers.accept.includes('text/html')) {
        return res.redirect('/');
      }
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.session = session;
    next();
  };
}

function filterProfilesForSession(allProfiles, session) {
  if (!session || session.role === 'admin') return allProfiles;
  const allowed = session.allowed_profiles || [];
  if (allowed.includes('*')) return allProfiles;
  return allProfiles.filter((name) => allowed.includes(name));
}

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// ---------- Auth endpoints ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (!verifyPassword(username, password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const userStore = require('./userStore');
  const user = userStore.findUser(username);
  const sid = crypto.randomUUID();
  sessions.set(sid, {
    username,
    role: user.role,
    allowed_profiles: user.allowed_profiles || []
  });
  setCookie(res, 'sid', sid);
  res.json({ ok: true, role: user.role });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.sid) sessions.delete(cookies.sid);
  clearCookie(res, 'sid');
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  const cookies = parseCookies(req);
  const sid = cookies.sid;
  const session = sessions.get(sid);
  if (!session) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    username: session.username,
    role: session.role,
    allowed_profiles: session.allowed_profiles
  });
});

// ---------- User management (admin only) ----------
app.get('/api/users', requireRole('admin'), (_req, res) => {
  try {
    res.json({ users: listUsers() });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post('/api/users', requireRole('admin'), (req, res) => {
  try {
    const { username, password, role, allowed_profiles } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const user = createUser({ username, password, role, allowed_profiles });
    res.json({ ok: true, user });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

app.put('/api/users/:username', requireRole('admin'), (req, res) => {
  try {
    const username = req.params.username;
    const updates = req.body || {};
    const user = updateUser(username, updates);
    sessions.forEach((session, sid) => {
      if (session.username === username) {
        session.role = user.role;
        session.allowed_profiles = user.allowed_profiles;
      }
    });
    res.json({ ok: true, user });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

app.delete('/api/users/:username', requireRole('admin'), (req, res) => {
  try {
    deleteUser(req.params.username);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

// ---------- Portal pages (protected) ----------
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.use('/client', requireRole('client'), express.static(path.join(PUBLIC_DIR, 'client')));
app.get('/client', requireRole('client'), (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'client', 'index.html'));
});

app.use('/admin', requireRole('admin'), express.static(path.join(PUBLIC_DIR, 'admin')));
app.get('/admin', requireRole('admin'), (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'));
});

// ---------- API routes ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'sheet-slide-web-exporter' });
});

app.get('/api/profiles', requireAuth, (req, res) => {
  try {
    ensureDefaultProfile();
    const all = listProfiles();
    const filtered = filterProfilesForSession(all, req.session);
    res.json({ profiles: filtered });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get('/api/profiles/:name', requireAuth, (req, res) => {
  try {
    const all = listProfiles();
    const filtered = filterProfilesForSession(all, req.session);
    if (!filtered.includes(req.params.name)) {
      return res.status(403).json({ error: 'Profile not accessible' });
    }
    const profile = loadProfile(req.params.name);
    res.json({ profile });
  } catch (error) {
    res.status(404).json({ error: String(error.message || error) });
  }
});

app.post('/api/profiles/save', requireRole('admin'), (req, res) => {
  try {
    const profile = validateProfile(req.body.profile || req.body || {});
    const savedPath = saveProfile(profile);
    res.json({ ok: true, profile, path: savedPath });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

app.delete('/api/profiles/:name', requireRole('admin'), (req, res) => {
  try {
    const name = req.params.name;
    if (name === 'default') {
      return res.status(400).json({ error: 'Cannot delete the default profile.' });
    }
    // deleteProfile() validates the name, so "..\users" can no longer delete users.json.
    deleteProfile(name);
    res.json({ ok: true });
  } catch (error) {
    const message = String(error.message || error);
    res.status(/not found/i.test(message) ? 404 : 400).json({ error: message });
  }
});

function collectLogger() {
  const lines = [];
  return {
    log: (message) => lines.push(String(message)),
    dump: () => lines
  };
}

// Resolve the profile for a preview/export request.
//  - an admin may post an inline profile (they preview unsaved form edits)
//  - a client must reference a profile they are allowed to use: the stored profile is
//    loaded server-side and only the row-selection fields may be overridden, so a client
//    can no longer point the request at another profile's spreadsheet/template.
const CLIENT_OVERRIDABLE_FIELDS = ['export_selected_rows_only', 'selected_sheet_rows'];

function resolveProfileForRequest(req) {
  const body = req.body || {};
  const inline = body.profile && typeof body.profile === 'object' ? body.profile : null;

  if (req.session.role === 'admin') {
    return validateProfile(inline || body || {});
  }

  const name = String(body.profile_name || (inline && inline.name) || '').trim();
  if (!name) {
    const error = new Error('profile_name is required.');
    error.status = 400;
    throw error;
  }
  const check = loadProfileForReport(req, name);
  if (check.error) {
    const error = new Error(check.error);
    error.status = check.status;
    throw error;
  }
  const merged = { ...check.profile };
  if (inline) {
    for (const field of CLIENT_OVERRIDABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(inline, field)) merged[field] = inline[field];
    }
  }
  return validateProfile(merged);
}

app.post('/api/preview/rows', requireAuth, async (req, res) => {
  const logger = collectLogger();
  try {
    const profile = resolveProfileForRequest(req);
    const result = await getSheetRowSelectionPreview(profile, {
      maxItems: Number(req.body.maxItems || 1000),
      log: logger.log
    });
    res.json({ ok: true, result, logs: logger.dump() });
  } catch (error) {
    res.status(error.status || 400).json({ error: String(error.message || error), logs: logger.dump() });
  }
});

app.post('/api/preview/export', requireAuth, async (req, res) => {
  const logger = collectLogger();
  try {
    let profile = normalizeProfile(resolveProfileForRequest(req));
    if (req.body.allowEmptySelectedRows && profile.export_selected_rows_only && profile.selected_sheet_rows.length === 0) {
      profile.export_selected_rows_only = false;
    }
    profile = validateProfile(profile);

    const result = await getExportPreview(profile, {
      maxItems: Number(req.body.maxItems || 500),
      log: logger.log
    });

    res.json({ ok: true, result, logs: logger.dump() });
  } catch (error) {
    res.status(error.status || 400).json({ error: String(error.message || error), logs: logger.dump() });
  }
});

app.post('/api/export', requireAuth, async (req, res) => {
  const logger = collectLogger();
  try {
    const profile = resolveProfileForRequest(req);

    const runId = crypto.randomUUID();
    const runDir = path.join(DOWNLOADS_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
    runOwners.set(runId, req.session.username);

    const exportProfile = {
      ...profile,
      output_dir: runDir,
      create_run_output_folder: false,
      split_outputs_by_row: false
    };

    const result = await runExport(exportProfile, { log: logger.log });

    const files = [];
    (result.processed_rows || []).forEach((row) => {
      if (row.exports?.pdf) {
        const filename = path.basename(row.exports.pdf);
        files.push({ type: 'pdf', sheet_row: row.sheet_row, filename, url: `/downloads/${runId}/${filename}` });
      }
      if (row.exports?.images) {
        row.exports.images.forEach((imgPath) => {
          const filename = path.basename(imgPath);
          files.push({ type: 'image', sheet_row: row.sheet_row, filename, url: `/downloads/${runId}/${filename}` });
        });
      }
    });

    res.json({ ok: true, result: { ...result, run_id: runId, files }, logs: logger.dump() });
  } catch (error) {
    res.status(error.status || 400).json({ error: String(error.message || error), logs: logger.dump() });
  }
});

app.post('/api/open-output-folder', requireRole('admin'), async (req, res) => {
  try {
    const outputPath = resolveOutputPath(req.body.output_dir);
    fs.mkdirSync(outputPath, { recursive: true });
    await openFolder(outputPath);
    res.json({ ok: true, output_dir: outputPath });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

function resolveOutputPath(outputDir) {
  const value = String(outputDir || './generated_slide_exports').trim();
  if (path.isAbsolute(value)) return value;
  return path.resolve(path.join(__dirname, '..'), value);
}

// Open a folder with the OS file manager. spawn + args (no shell) so a path holding
// quotes or & can never become a command.
function openFolder(folderPath) {
  if (process.platform === 'win32') return runTool('explorer.exe', [folderPath]);
  if (process.platform === 'darwin') return runTool('open', [folderPath]);
  return runTool('xdg-open', [folderPath]);
}

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get('/api/zip/:runId', requireAuth, async (req, res) => {
  try {
    const runId = String(req.params.runId || '');
    if (!RUN_ID_RE.test(runId)) {
      return res.status(400).json({ error: 'Invalid run id' });
    }
    const downloadsRoot = path.resolve(DOWNLOADS_DIR);
    const runDir = path.join(downloadsRoot, runId);
    // Defence in depth: the resolved path must stay inside the downloads directory.
    if (path.resolve(runDir) !== runDir) {
      return res.status(400).json({ error: 'Invalid run id' });
    }
    if (!fs.existsSync(runDir)) {
      return res.status(404).json({ error: 'Run not found' });
    }
    const owner = runOwners.get(runId);
    if (req.session.role !== 'admin' && owner !== req.session.username) {
      return res.status(403).json({ error: 'Forbidden: this export belongs to another account.' });
    }

    const sevenZip = findSevenZip();
    let archivePath = path.join(DOWNLOADS_DIR, `${runId}.zip`);
    let archiveName = `export_${runId}.zip`;

    if (sevenZip) {
      await runTool(sevenZip, ['a', '-tzip', archivePath, runDir]);
    } else {
      archivePath = path.join(DOWNLOADS_DIR, `${runId}.tar.gz`);
      archiveName = `export_${runId}.tar.gz`;
      await runTool('tar', ['-czf', archivePath, runId], DOWNLOADS_DIR);
    }

    res.download(archivePath, archiveName, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'Failed to send archive file' });
      }
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

// Report endpoints
function loadProfileForReport(req, profileName) {
  const all = listProfiles();
  const allowed = filterProfilesForSession(all, req.session);
  if (!allowed.includes(profileName)) {
    return { error: 'Forbidden: profile not allowed.', status: 403 };
  }
  const profile = normalizeProfile(loadProfile(profileName) || {});
  return { profile };
}

app.post('/api/report/month', requireAuth, async (req, res) => {
  try {
    const profileName = req.body.profile_name || 'default';
    const check = loadProfileForReport(req, profileName);
    if (check.error) return res.status(check.status).json({ error: check.error });
    const result = await generateReport(check.profile, { type: 'month' });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

app.post('/api/report/year', requireAuth, async (req, res) => {
  try {
    const profileName = req.body.profile_name || 'default';
    const check = loadProfileForReport(req, profileName);
    if (check.error) return res.status(check.status).json({ error: check.error });
    const result = await generateReport(check.profile, { type: 'year' });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

app.post('/api/report/selected', requireAuth, async (req, res) => {
  try {
    const profileName = req.body.profile_name || 'default';
    const selectedRows = req.body.selected_rows || [];
    const check = loadProfileForReport(req, profileName);
    if (check.error) return res.status(check.status).json({ error: check.error });
    const result = await generateReport(check.profile, { type: 'selected', selectedRows });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

app.post('/api/upload-database', requireRole('admin'), (req, res) => {
  try {
    const { usersContent, profiles } = req.body || {};
    let saved = [];

    if (typeof usersContent === 'string' && usersContent.trim()) {
      const usersPath = path.resolve(__dirname, '..', 'users.json');
      fs.writeFileSync(usersPath, usersContent, 'utf-8');
      saved.push('users.json');
    }

    if (Array.isArray(profiles)) {
      const profilesDir = path.resolve(__dirname, '..', 'profiles');
      fs.mkdirSync(profilesDir, { recursive: true });
      profiles.forEach((p) => {
        if (p.name && typeof p.content === 'string') {
          const safeName = path.basename(p.name, '.json');
          fs.writeFileSync(path.join(profilesDir, `${safeName}.json`), p.content, 'utf-8');
          saved.push(`profiles/${safeName}.json`);
        }
      });
    }

    res.json({ ok: true, saved });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

app.post('/api/upload-credentials', requireRole('admin'), (req, res) => {
  try {
    const { credentialsContent, tokenContent } = req.body || {};
    let saved = [];

    if (typeof credentialsContent === 'string' && credentialsContent.trim()) {
      const credPath = path.resolve(__dirname, '..', 'google_credentials.json');
      fs.writeFileSync(credPath, credentialsContent, 'utf-8');
      saved.push('google_credentials.json');
    }

    if (typeof tokenContent === 'string' && tokenContent.trim()) {
      const tokenPath = path.resolve(__dirname, '..', 'google_token.json');
      fs.writeFileSync(tokenPath, tokenContent, 'utf-8');
      saved.push('google_token.json');
    }

    res.json({ ok: true, saved, note: 'In your profiles, set credentials_file to "/app/google_credentials.json" and token_file to "/app/google_token.json".' });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

/* ---------- Download endpoints (admin only) ---------- */

function zipFiles(baseDir, entries, outPath) {
  const sevenZip = findSevenZip();
  const args = entries.map((e) => path.join(baseDir, e));
  if (sevenZip) {
    return runTool(sevenZip, ['a', '-tzip', outPath, ...args]);
  }
  return runTool('zip', ['-j', outPath, ...args]);
}

app.get('/api/download/users', requireRole('admin'), (req, res) => {
  const usersPath = path.resolve(__dirname, '..', 'users.json');
  if (!fs.existsSync(usersPath)) {
    return res.status(404).json({ error: 'users.json not found.' });
  }
  res.download(usersPath, 'users.json');
});

app.get('/api/download/profiles', requireRole('admin'), async (req, res) => {
  const profilesDir = path.resolve(__dirname, '..', 'profiles');
  if (!fs.existsSync(profilesDir)) {
    return res.status(404).json({ error: 'No profiles directory found.' });
  }
  const files = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.json'));
  if (!files.length) {
    return res.status(404).json({ error: 'No profile files found.' });
  }

  const tmpDir = path.resolve(__dirname, '..', 'downloads');
  fs.mkdirSync(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, `profiles_${Date.now()}.zip`);

  try {
    await zipFiles(profilesDir, files, zipPath);
    res.download(zipPath, 'profiles.zip', (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'Failed to send profiles archive.' });
      }
      try { fs.unlinkSync(zipPath); } catch (e) {}
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get('/api/download/database', requireRole('admin'), async (req, res) => {
  const baseDir = path.resolve(__dirname, '..');
  const profilesDir = path.join(baseDir, 'profiles');
  const usersPath = path.join(baseDir, 'users.json');
  const tmpDir = path.join(baseDir, 'downloads');
  fs.mkdirSync(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, `database_${Date.now()}.zip`);

  const entries = [];
  if (fs.existsSync(usersPath)) entries.push(usersPath);
  if (fs.existsSync(profilesDir)) {
    fs.readdirSync(profilesDir).filter((f) => f.endsWith('.json')).forEach((f) => {
      entries.push(path.join(profilesDir, f));
    });
  }
  if (!entries.length) {
    return res.status(404).json({ error: 'No database files found.' });
  }

  try {
    const sevenZip = findSevenZip();
    if (sevenZip) {
      await runTool(sevenZip, ['a', '-tzip', zipPath, ...entries]);
    } else {
      await runTool('zip', ['-j', zipPath, ...entries]);
    }
    res.download(zipPath, 'database.zip', (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'Failed to send database archive.' });
      }
      try { fs.unlinkSync(zipPath); } catch (e) {}
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.listen(PORT, () => {
  ensureDefaultProfile();
  console.log(`Sheet/Slide web exporter running at http://localhost:${PORT}`);
  console.log(`Login page:       http://localhost:${PORT}/`);
  console.log(`Client portal:    http://localhost:${PORT}/client`);
  console.log(`Admin portal:     http://localhost:${PORT}/admin`);
  console.log(`Downloads dir:    ${DOWNLOADS_DIR}`);
  console.log(`Default token path: ${path.join(os.homedir(), '.google_workspace_mcp', 'credentials', 'sheet_slide_export_token.json')}`);
});
