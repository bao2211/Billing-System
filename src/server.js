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
  runExport,
  createGoogleClients,
  readSheetValues,
  buildRowRecords,
  inferPhoneColumn,
  inferRoomColumn,
  inferSkipColumn,
  resolveColumnName
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
  normalizePhone,
  maskPhone,
  buildTemplateData,
  sendTemplateByPhone,
  uploadBillToDrive,
  assertDriveFolder,
  refreshAccessToken,
  // Zalo Bot Platform
  verifyBotToken,
  pollBotUpdates,
  isBotConfigured,
  buildBotMessage,
  extractPhoneFromText,
  ingestBotUpdate,
  DEFAULT_BOT_MESSAGE_TEMPLATE,
  DISCOVERABLE_MESSAGE_TOKENS,
  MESSAGE_TOTAL_ALIASES
} = require('./zaloService');
const {
  maskBotToken,
  sendBotMessage,
  setBotWebhook,
  deleteBotWebhook,
  getBotWebhookInfo,
  normalizeBotUpdate
} = require('./zaloBotService');
const {
  listSubscribers,
  publicSubscriber,
  deleteSubscriber,
  setSubscriberPhone,
  unlinkSubscriberPhone,
  findByPhone
} = require('./zaloSubscriberStore');
const {
  saveZaloConfig,
  loadZaloConfig,
  publicZaloConfig,
  listNotifications
} = require('./zaloStore');
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

    // The client portal may opt in or out of Zalo delivery for this run only.
    const body = req.body || {};
    if (typeof body.notify_via_zalo === 'boolean') {
      // A Drive folder is needed either way (the bill travels as a link); delivery then
      // needs at least one working channel: the bot chat, a ZNS template, or both.
      const zaloConfig = loadZaloConfig();
      const botChannel = isBotConfigured(zaloConfig);
      const znsChannel = Boolean(profile.zalo_template_id) && Boolean(String(zaloConfig.access_token || '').trim());
      const missing = [];
      if (!profile.zalo_drive_folder_id) missing.push('Drive folder');
      if (!botChannel && !znsChannel) missing.push('a Zalo bot token or a ZNS template id');
      if (body.notify_via_zalo && missing.length) {
        profile.zalo_enabled = false;
        logger.log(`Zalo: requested but this profile has no ${missing.join(' and ')} configured - Zalo is skipped for this run.`);
      } else {
        profile.zalo_enabled = body.notify_via_zalo;
        logger.log(`Zalo: ${body.notify_via_zalo ? 'enabled' : 'disabled'} for this run by the client portal.`);
      }
    }

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
    // Google API failures surface as bare "Internal Error"; keep the code so it is diagnosable.
    const detail = error && error.code
      ? `${error.message || error} (code ${error.code})`
      : String(error.message || error);
    res.status(error.status || 400).json({ error: detail, logs: logger.dump() });
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

/* ---------- Zalo notifications (admin only) ---------- */

// Read-only Zalo status any signed-in user may see (no secrets): the client portal uses it
// to label the "send via Zalo" option.
app.get('/api/zalo/status', requireAuth, (_req, res) => {
  const config = loadZaloConfig();
  const provider = config.provider === 'bot' ? 'bot' : 'oa';
  res.json({
    ok: true,
    provider,
    dry_run: config.dry_run !== false,
    // For the bot provider the tenant has to have opened a chat first, so the client
    // portal also learns how many tenants are reachable.
    has_token: provider === 'bot' ? isBotConfigured(config) : Boolean(config.access_token),
    linked_chats: listSubscribers().filter((item) => Boolean(item.phone)).length,
    bot_share_link: config.bot_share_link || ''
  });
});

app.get('/api/zalo/config', requireRole('admin'), (_req, res) => {
  res.json({ ok: true, config: publicZaloConfig() });
});

app.post('/api/zalo/config', requireRole('admin'), (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    if (body.provider === 'oa' || body.provider === 'bot') patch.provider = body.provider;
    if (typeof body.access_token === 'string') patch.access_token = body.access_token.trim();
    if (typeof body.refresh_token === 'string') patch.refresh_token = body.refresh_token.trim();
    if (typeof body.app_id === 'string') patch.app_id = body.app_id.trim();
    if (typeof body.secret_key === 'string') patch.secret_key = body.secret_key.trim();
    if (typeof body.oa_id === 'string') patch.oa_id = body.oa_id.trim();
    if (typeof body.dry_run === 'boolean') patch.dry_run = body.dry_run;
    if (body.rate_limit_ms !== undefined) patch.rate_limit_ms = Number(body.rate_limit_ms) || 1200;
    if (body.expires_in !== undefined) patch.expires_at = Date.now() + Number(body.expires_in) * 1000;
    // ---- Zalo Bot Platform ----
    if (typeof body.bot_token === 'string' && body.bot_token.trim()) patch.bot_token = body.bot_token.trim();
    if (typeof body.bot_webhook_secret === 'string') patch.bot_webhook_secret = body.bot_webhook_secret.trim();
    if (typeof body.bot_auto_reply === 'boolean') patch.bot_auto_reply = body.bot_auto_reply;
    if (body.bot_poll_ms !== undefined) {
      patch.bot_poll_ms = Math.max(3000, Math.min(120000, Number(body.bot_poll_ms) || 15000));
    }
    if (typeof body.zns_fallback === 'boolean') patch.zns_fallback = body.zns_fallback;
    if (typeof body.prefer_free_bot === 'boolean') patch.prefer_free_bot = body.prefer_free_bot;
    saveZaloConfig(patch);
    restartBotPoller();
    res.json({ ok: true, config: publicZaloConfig() });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

/* ---------- Zalo Bot Platform ---------- */

// getUpdates (polling) and webhooks are mutually exclusive on Zalo's side, and the Bot
// Platform rejects localhost webhook URLs - so polling is the default transport here.
// Set ZALO_BOT_POLL=0 to keep the poller out of the way (tests, one-off scripts).
const BOT_POLL_DISABLED = process.env.ZALO_BOT_POLL === '0' || process.env.ZALO_BOT_POLL === 'false';
let botPollerTimer = null;
let botPollInFlight = false;

async function botPollerTick() {
  if (botPollInFlight) return;
  const config = loadZaloConfig();
  if (!isBotConfigured(config)) return;
  botPollInFlight = true;
  try {
    const outcome = await pollBotUpdates({ config, logger: (m) => console.log(m), timeout: 5 });
    for (const result of outcome.results) {
      if (result.action === 'linked' || result.action === 'relinked') {
        console.log(`Zalo bot: bound ${result.phone_masked} to chat ${result.chat_id}.`);
      }
    }
  } catch (error) {
    const message = String(error.message || error).slice(0, 200);
    try { saveZaloConfig({ bot_last_poll_error: message }); } catch (e) { /* ignore */ }
    console.log(`Zalo bot poll failed: ${message}`);
  } finally {
    botPollInFlight = false;
  }
}

function restartBotPoller() {
  if (botPollerTimer) {
    clearInterval(botPollerTimer);
    botPollerTimer = null;
  }
  const config = loadZaloConfig();
  if (BOT_POLL_DISABLED || !isBotConfigured(config)) return;
  const interval = Math.max(5000, Number(config.bot_poll_ms) || 15000);
  botPollerTimer = setInterval(botPollerTick, interval);
  if (botPollerTimer.unref) botPollerTimer.unref();
  console.log(`Zalo bot: polling getUpdates every ${Math.round(interval / 1000)}s.`);
}

// Validate the pasted bot token and remember the bot identity + share link.
app.post('/api/zalo/bot/verify', requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const config = loadZaloConfig();
    const token = String(body.bot_token || '').trim() || config.bot_token;
    if (!token) {
      return res.status(400).json({ error: 'Paste a bot token first (Zalo Bot Manager sends it as "<id>:<secret>").' });
    }
    const bot = await verifyBotToken(token);
    saveZaloConfig({
      bot_token: token,
      bot_account_name: bot.account_name,
      bot_display_name: bot.display_name,
      bot_account_type: bot.account_type,
      bot_can_join_groups: bot.can_join_groups,
      bot_share_link: bot.share_link,
      bot_verified_at: Date.now(),
      bot_last_poll_error: ''
    });
    restartBotPoller();
    res.json({ ok: true, bot, config: publicZaloConfig() });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

// One manual long-poll round so a tenant can be onboarded without waiting for the
// background poller. Auto-links any phone number the tenant sent to the bot.
app.post('/api/zalo/bot/poll', requireRole('admin'), async (req, res) => {
  const logger = collectLogger();
  try {
    const body = req.body || {};
    const config = loadZaloConfig();
    if (!isBotConfigured(config)) return res.status(400).json({ error: 'No Zalo bot token configured.' });
    const outcome = await pollBotUpdates({
      config,
      logger: (m) => logger.log(m),
      timeout: body.timeout === undefined ? 5 : Number(body.timeout),
      autoReply: body.auto_reply === undefined ? undefined : body.auto_reply === true
    });
    res.json({
      ok: true,
      ...outcome,
      subscribers: listSubscribers().map(publicSubscriber),
      logs: logger.dump()
    });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error), logs: logger.dump() });
  }
});

// Send a real message to one chat. Dry-run unless live:true, so a test can never
// surprise a tenant by accident.
app.post('/api/zalo/bot/send-test', requireRole('admin'), async (req, res) => {
  const logger = collectLogger();
  try {
    const body = req.body || {};
    const config = loadZaloConfig();
    if (!isBotConfigured(config)) return res.status(400).json({ error: 'No Zalo bot token configured.' });
    const live = body.live === true;

    let chatId = String(body.chat_id || '').trim();
    const phone = String(body.phone || '').trim();
    if (!chatId && phone) {
      const parsed = normalizePhone(phone);
      if (!parsed.ok) return res.status(400).json({ error: `phone ${parsed.reason}` });
      const subscriber = findByPhone(parsed.phone);
      if (!subscriber) {
        return res.status(400).json({
          error: `${maskPhone(parsed.phone)} has not messaged the bot yet. Open ${config.bot_share_link || 'the bot in Zalo'}, send that phone number to it, then try again.`
        });
      }
      chatId = subscriber.chat_id;
    }
    if (!chatId) {
      return res.status(400).json({ error: 'Pass chat_id, or a phone that is already linked to a chat.' });
    }

    // Prefer the profile's real message built from a sheet row over a literal string.
    let text = String(body.text || '').trim();
    if (!text) {
      const check = loadProfileForReport(req, body.profile_name || 'default');
      if (check.error) return res.status(check.status).json({ error: check.error });
      const profile = check.profile;
      const { sheets } = await createGoogleClients(profile);
      const values = await readSheetValues(sheets, profile);
      const records = buildRowRecords(values, profile);
      if (!records.length) {
        return res.status(400).json({ error: 'The sheet returned no rows to build a test message from.' });
      }
      const headers = Object.keys(records[0].data || {});
      const wanted = Number(body.sheet_row || 0);
      const record = wanted ? records.find((r) => Number(r.sheet_row) === wanted) : records[0];
      if (!record) return res.status(400).json({ error: `sheet_row ${wanted} was not found.` });
      const extra = {
        phone_column: profile.zalo_phone_column
          ? (resolveColumnName(headers, profile.zalo_phone_column) || '')
          : (inferPhoneColumn(headers) || ''),
        room_column: inferRoomColumn(headers) || '',
        bill_column: inferSkipColumn(headers) || '',
        period: new Date().toISOString().slice(0, 7)
      };
      text = buildBotMessage({
        profile,
        record,
        link: String(body.link || 'https://example.com/test-bill-link'),
        extra
      });
      logger.log(`Built the bot message from sheet row ${record.sheet_row}.`);
    }

    text = `[TEST] ${text}`;
    if (!live) {
      logger.log(`[dry-run] would POST sendMessage to chat ${chatId}`);
      return res.json({ ok: true, live: false, chat_id: chatId, text, logs: logger.dump() });
    }
    const sent = await sendBotMessage(config.bot_token, { chatId, text });
    logger.log(`Sent to chat ${chatId} (message ${sent.message_id}).`);
    res.json({ ok: true, live: true, chat_id: chatId, text, result: sent, logs: logger.dump() });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error), logs: logger.dump() });
  }
});

// Render the Zalo bot message for the profile as it currently appears in the form,
// WITHOUT saving or sending anything. This is what makes {{placeholder}} tokens
// discoverable: it returns the real header names from the sheet so the admin can pick
// them instead of guessing, plus the message exactly as a tenant would receive it.
app.post('/api/zalo/message-preview', requireRole('admin'), async (req, res) => {
  const logger = collectLogger();
  try {
    const body = req.body || {};
    const incoming = body.profile && typeof body.profile === 'object' ? body.profile : null;
    if (!incoming || !String(incoming.name || '').trim()) {
      return res.status(400).json({ error: 'A profile (with a name) is required.' });
    }
    const profile = validateProfile(normalizeProfile({ ...incoming }));

    // The sheet is read with the SAVED profile's credentials, but rendered with the
    // UNSAVED form values, so a token or template edit can be previewed before saving.
    const check = loadProfileForReport(req, profile.name);
    if (check.error) return res.status(check.status).json({ error: check.error });

    const { sheets } = await createGoogleClients(check.profile);
    const values = await readSheetValues(sheets, check.profile);
    const records = buildRowRecords(values, check.profile);
    if (!records.length) {
      return res.status(400).json({ error: 'The sheet returned no rows to preview a message from.' });
    }

    const headers = Object.keys(records[0].data || {});
    const wanted = Number(body.sheet_row || 0);
    const record = wanted ? records.find((r) => Number(r.sheet_row) === wanted) : records[0];
    if (!record) return res.status(400).json({ error: `sheet_row ${wanted} was not found.` });

    const extra = {
      phone_column: profile.zalo_phone_column
        ? (resolveColumnName(headers, profile.zalo_phone_column) || '')
        : (inferPhoneColumn(headers) || ''),
      room_column: inferRoomColumn(headers) || '',
      bill_column: inferSkipColumn(headers) || '',
      period: new Date().toISOString().slice(0, 7)
    };

    // A stand-in link, so the preview never implies a real Drive file exists.
    const sampleLink = 'https://drive.google.com/file/d/SAMPLE-BILL-ID/view';
    const text = buildBotMessage({ profile, record, link: sampleLink, extra });

    // Which tokens actually produced a value for this row, so the UI can flag dead ones.
    const used = DISCOVERABLE_MESSAGE_TOKENS.map((token) => ({
      token,
      in_template: String(profile.zalo_bot_message_template || DEFAULT_BOT_MESSAGE_TEMPLATE).includes(`{{${token}}}`)
    }));

    res.json({
      ok: true,
      text,
      chars: text.length,
      headers,
      builtin_tokens: DISCOVERABLE_MESSAGE_TOKENS,
      total_aliases: MESSAGE_TOTAL_ALIASES,
      default_template: DEFAULT_BOT_MESSAGE_TEMPLATE,
      using_default_template: !String(profile.zalo_bot_message_template || '').trim(),
      detected: {
        phone_column: extra.phone_column,
        room_column: extra.room_column,
        bill_column: extra.bill_column
      },
      row: { sheet_row: record.sheet_row, data: record.data },
      row_count: records.length,
      tokens: used,
      logs: logger.dump()
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: String(error.message || error), logs: logger.dump() });
  }
});

app.post('/api/zalo/refresh', requireRole('admin'), async (_req, res) => {
  try {
    const next = await refreshAccessToken(loadZaloConfig());
    saveZaloConfig(next);
    res.json({ ok: true, config: publicZaloConfig() });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

// A bill can only be delivered to a chat that exists, so the admin panel keeps the
// list of chats that messaged the bot and lets the phone binding be fixed by hand.
app.get('/api/zalo/subscribers', requireRole('admin'), (_req, res) => {
  res.json({ ok: true, subscribers: listSubscribers().map(publicSubscriber) });
});

app.post('/api/zalo/subscribers', requireRole('admin'), (req, res) => {
  try {
    const body = req.body || {};
    const chatId = String(body.chat_id || '').trim();
    if (!chatId) return res.status(400).json({ error: 'chat_id is required.' });
    const parsed = normalizePhone(body.phone);
    if (!parsed.ok) return res.status(400).json({ error: `phone ${parsed.reason}` });
    const record = setSubscriberPhone(chatId, parsed.phone, 'admin');
    res.json({ ok: true, subscriber: publicSubscriber(record) });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

app.post('/api/zalo/subscribers/:chatId/unlink', requireRole('admin'), (req, res) => {
  try {
    const record = unlinkSubscriberPhone(req.params.chatId);
    if (!record) return res.status(404).json({ error: 'That chat is not in the list.' });
    res.json({ ok: true, subscriber: publicSubscriber(record) });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

app.delete('/api/zalo/subscribers/:chatId', requireRole('admin'), (req, res) => {
  try {
    if (!deleteSubscriber(req.params.chatId)) {
      return res.status(404).json({ error: 'That chat is not in the list.' });
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

// Zalo calls this when a public HTTPS URL is registered (see /api/zalo/bot/set-webhook).
// No requireAuth: Zalo cannot log in, so the shared secret header IS the authentication.
app.post('/api/zalo/bot/webhook', async (req, res) => {
  try {
    const config = loadZaloConfig();
    const secret = String(config.bot_webhook_secret || '');
    const provided = String(req.headers['x-bot-api-secret-token'] || '');
    if (!secret || provided !== secret) {
      return res.status(403).json({ ok: false, message: 'Unauthorized' });
    }
    const result = (req.body && req.body.result) || {};
    const update = normalizeBotUpdate({ event_name: result.event_name, message: result.message });
    const outcome = await ingestBotUpdate({ update, config });
    res.json({ ok: true, outcome });
  } catch (error) {
    res.status(400).json({ ok: false, message: String(error.message || error) });
  }
});

app.post('/api/zalo/bot/set-webhook', requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const config = loadZaloConfig();
    if (!isBotConfigured(config)) return res.status(400).json({ error: 'No Zalo bot token configured.' });
    if (body.remove === true) {
      const info = await deleteBotWebhook(config.bot_token);
      return res.json({ ok: true, removed: true, info });
    }
    const secret = String(body.secret_token || config.bot_webhook_secret || '').trim();
    const webhook = await setBotWebhook(config.bot_token, { url: body.url, secretToken: secret });
    saveZaloConfig({ bot_webhook_secret: secret });
    res.json({ ok: true, webhook });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

app.get('/api/zalo/bot/webhook-info', requireRole('admin'), async (_req, res) => {
  try {
    const config = loadZaloConfig();
    if (!isBotConfigured(config)) return res.status(400).json({ error: 'No Zalo bot token configured.' });
    const info = await getBotWebhookInfo(config.bot_token);
    res.json({ ok: true, registered: true, info });
  } catch (error) {
    // Zalo answers 404 Not Found when no webhook has ever been registered. That is the
    // normal state for this app (it polls with getUpdates), so report it, do not fail.
    if (error && Number(error.error_code) === 404) {
      return res.json({
        ok: true,
        registered: false,
        info: null,
        message: 'No webhook is registered. This deployment receives messages with getUpdates polling instead.'
      });
    }
    res.status(400).json({ error: String(error.message || error) });
  }
});

app.get('/api/notifications', requireRole('admin'), (req, res) => {
  try {
    res.json({
      ok: true,
      entries: listNotifications({ profile: req.query.profile || '', limit: Number(req.query.limit || 50) })
    });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

// Dry-run unless live:true is passed, so a test can never surprise a customer.
app.post('/api/zalo/test', requireRole('admin'), async (req, res) => {
  const logger = collectLogger();
  try {
    const body = req.body || {};
    const live = body.live === true;
    const config = loadZaloConfig();
    const parsed = normalizePhone(body.phone);
    if (!parsed.ok) return res.status(400).json({ error: `phone ${parsed.reason}` });

    let templateId = String(body.template_id || '').trim();
    let templateData = body.template_data && typeof body.template_data === 'object' ? { ...body.template_data } : null;

    if (!templateData) {
      const check = loadProfileForReport(req, body.profile_name || 'default');
      if (check.error) return res.status(check.status).json({ error: check.error });
      const profile = check.profile;
      templateId = templateId || profile.zalo_template_id;
      const { sheets } = await createGoogleClients(profile);
      const values = await readSheetValues(sheets, profile);
      const records = buildRowRecords(values, profile);
      if (!records.length) {
        return res.status(400).json({ error: 'The sheet returned no rows to build a test message from.' });
      }
      const headers = Object.keys(records[0].data || {});
      const wanted = Number(body.sheet_row || 0);
      const record = wanted ? records.find((r) => Number(r.sheet_row) === wanted) : records[0];
      if (!record) return res.status(400).json({ error: `sheet_row ${wanted} was not found.` });
      const extra = {
        phone_column: profile.zalo_phone_column
          ? (resolveColumnName(headers, profile.zalo_phone_column) || '')
          : (inferPhoneColumn(headers) || ''),
        room_column: inferRoomColumn(headers) || '',
        bill_column: inferSkipColumn(headers) || ''
      };
      const fieldMap = body.field_map && typeof body.field_map === 'object' ? body.field_map : profile.zalo_field_map;
      templateData = buildTemplateData({
        profile: { ...profile, zalo_field_map: fieldMap || {} },
        record,
        link: String(body.link || 'https://example.com/test-bill-link'),
        extra
      });
      logger.log(`Built template_data from sheet row ${record.sheet_row}.`);
    }

    if (!templateId) {
      return res.status(400).json({ error: 'template_id is required (pass it, or set zalo_template_id on the profile).' });
    }
    const result = await sendTemplateByPhone({
      accessToken: config.access_token,
      phone: parsed.phone,
      templateId,
      templateData,
      trackingId: String(body.tracking_id || `test-${Date.now().toString(36)}`).slice(0, 48),
      dryRun: !live
    });
    res.json({
      ok: true,
      live,
      phone_masked: maskPhone(parsed.phone),
      template_id: templateId,
      template_data: templateData,
      result,
      logs: logger.dump()
    });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error), logs: logger.dump() });
  }
});

// Upload a harmless file to the configured Drive folder, confirm link sharing works,
// then delete it - proves the hosting path before any real bill is sent.
app.post('/api/zalo/verify-drive', requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const check = loadProfileForReport(req, body.profile_name || 'default');
    if (check.error) return res.status(check.status).json({ error: check.error });
    const profile = check.profile;
    const folderId = String(body.folder_id || profile.zalo_drive_folder_id || '').trim();
    const { drive } = await createGoogleClients(profile);
    const folder = await assertDriveFolder(drive, folderId);

    const tmpPath = path.join(DOWNLOADS_DIR, `zalo-check-${Date.now()}.txt`);
    fs.writeFileSync(tmpPath, 'Zalo Drive check from the billing system - safe to delete.\n');
    let uploaded = null;
    try {
      uploaded = await uploadBillToDrive(drive, {
        filePath: tmpPath,
        folderId: folder.id,
        name: path.basename(tmpPath)
      });
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
    let removed = false;
    try {
      await drive.files.delete({ fileId: uploaded.id });
      removed = true;
    } catch (error) {
      removed = false;
    }
    res.json({
      ok: true,
      folder: { id: folder.id, name: folder.name },
      link: uploaded.webViewLink,
      link_sharing: Boolean(uploaded.webViewLink),
      cleaned_up: removed
    });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
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

  // Start the Zalo Bot poller when a bot token is configured (no-op otherwise).
  const zalo = loadZaloConfig();
  if (isBotConfigured(zalo)) {
    console.log(`Zalo delivery:    ${zalo.provider === 'bot' ? 'Zalo Bot Platform' : 'Zalo OA/ZNS'}${zalo.dry_run !== false ? ' (DRY-RUN)' : ''}`);
    restartBotPoller();
  }
});
