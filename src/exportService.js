const fs = require('fs');
const path = require('path');
const os = require('os');
const { google } = require('googleapis');

const APP_ROOT = path.resolve(__dirname, '..');

const SUPPORTED_OUTPUT_FORMATS = new Set(['pdf', 'images', 'both']);
const SUPPORTED_PLACEHOLDER_STRATEGIES = new Set([
  'header_braces',
  'mapping_only',
  'mapping_with_fallback'
]);
const SUPPORTED_REFERENCE_STRATEGIES = new Set([
  'identity',
  'strip_whitespace',
  'strip_currency',
  'template_map'
]);

function defaultProfile() {
  return {
    name: 'default',
    spreadsheet_id: '',
    sheet_name: '',
    sheet_range: 'A1:ZZ',
    header_row_index: 1,
    data_start_row_index: 2,
    template_presentation_id: '',
    destination_folder_id: null,
    copy_name_template: '{profile_name}_{sheet_name}_row_{sheet_row}',
    output_format: 'both',
    output_dir: './generated_slide_exports',
    create_run_output_folder: true,
    run_folder_name_template: '{date}_{profile_name}',
    output_file_name_template: '{date}_{row_slug}',
    split_outputs_by_row: false,
    delete_generated_slides_after_export: false,
    skip_export_if_zero_or_empty: false,
    skip_zero_or_empty_column: '',
    export_selected_rows_only: false,
    selected_sheet_rows: [],
    include_rows_without_room: false,
    credentials_file: null,
    token_file: './sheet_slide_export_token.json',
    placeholder_strategy: 'mapping_with_fallback',
    placeholder_prefix: '{{',
    placeholder_suffix: '}}',
    placeholder_mapping: {},
    reference_strategy: 'identity',
    reference_mapping: {},
    max_rows: null
  };
}

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return fallback;
}

function normalizeProfile(raw) {
  const base = defaultProfile();
  const profile = { ...base, ...(raw || {}) };

  profile.name = String(profile.name || '').trim();
  profile.spreadsheet_id = String(profile.spreadsheet_id || '').trim();
  profile.sheet_name = String(profile.sheet_name || '').trim();
  profile.sheet_range = String(profile.sheet_range || 'A1:ZZ').trim() || 'A1:ZZ';
  profile.header_row_index = Number(profile.header_row_index || 1);
  profile.data_start_row_index = Number(profile.data_start_row_index || 2);
  profile.template_presentation_id = String(profile.template_presentation_id || '').trim();
  profile.destination_folder_id = profile.destination_folder_id ? String(profile.destination_folder_id).trim() : null;
  profile.copy_name_template = String(profile.copy_name_template || base.copy_name_template);

  profile.output_format = String(profile.output_format || base.output_format).trim();
  profile.output_dir = String(profile.output_dir || base.output_dir).trim() || base.output_dir;
  profile.create_run_output_folder = toBool(profile.create_run_output_folder, true);
  profile.run_folder_name_template = String(profile.run_folder_name_template || base.run_folder_name_template).trim();
  profile.output_file_name_template = String(profile.output_file_name_template || base.output_file_name_template).trim();
  profile.split_outputs_by_row = toBool(profile.split_outputs_by_row, false);
  profile.delete_generated_slides_after_export = toBool(profile.delete_generated_slides_after_export, false);
  profile.skip_export_if_zero_or_empty = toBool(profile.skip_export_if_zero_or_empty, false);
  profile.skip_zero_or_empty_column = String(profile.skip_zero_or_empty_column || '').trim();
  profile.export_selected_rows_only = toBool(profile.export_selected_rows_only, false);
  profile.include_rows_without_room = toBool(profile.include_rows_without_room, false);

  profile.selected_sheet_rows = Array.isArray(profile.selected_sheet_rows)
    ? profile.selected_sheet_rows.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 1)
    : [];
  profile.selected_sheet_rows = [...new Set(profile.selected_sheet_rows)];

  profile.credentials_file = profile.credentials_file ? String(profile.credentials_file).trim() : null;
  profile.token_file = String(profile.token_file || base.token_file).trim();

  profile.placeholder_strategy = String(profile.placeholder_strategy || base.placeholder_strategy).trim();
  profile.placeholder_prefix = String(profile.placeholder_prefix || base.placeholder_prefix);
  profile.placeholder_suffix = String(profile.placeholder_suffix || base.placeholder_suffix);
  profile.placeholder_mapping = profile.placeholder_mapping && typeof profile.placeholder_mapping === 'object'
    ? profile.placeholder_mapping
    : {};

  profile.reference_strategy = String(profile.reference_strategy || base.reference_strategy).trim();
  profile.reference_mapping = profile.reference_mapping && typeof profile.reference_mapping === 'object'
    ? profile.reference_mapping
    : {};

  if (profile.max_rows === '' || profile.max_rows === null || profile.max_rows === undefined) {
    profile.max_rows = null;
  } else {
    const parsedMax = Number(profile.max_rows);
    profile.max_rows = Number.isInteger(parsedMax) ? parsedMax : null;
  }

  return profile;
}

function validateProfile(raw) {
  const profile = normalizeProfile(raw);

  if (!profile.name) throw new Error('Profile name is required.');
  if (!profile.spreadsheet_id) throw new Error('Spreadsheet ID is required.');
  if (!profile.sheet_name) throw new Error('Sheet name is required.');
  if (!profile.template_presentation_id) throw new Error('Template presentation ID is required.');

  if (!SUPPORTED_OUTPUT_FORMATS.has(profile.output_format)) {
    throw new Error(`Unsupported output format: ${profile.output_format}`);
  }
  if (!SUPPORTED_PLACEHOLDER_STRATEGIES.has(profile.placeholder_strategy)) {
    throw new Error(`Unsupported placeholder strategy: ${profile.placeholder_strategy}`);
  }
  if (!SUPPORTED_REFERENCE_STRATEGIES.has(profile.reference_strategy)) {
    throw new Error(`Unsupported reference strategy: ${profile.reference_strategy}`);
  }

  if (!Number.isInteger(profile.header_row_index) || profile.header_row_index < 1) {
    throw new Error('Header row index must be >= 1.');
  }
  if (!Number.isInteger(profile.data_start_row_index) || profile.data_start_row_index < 1) {
    throw new Error('Data start row index must be >= 1.');
  }

  if (profile.max_rows !== null && profile.max_rows < 1) {
    throw new Error('max_rows must be >= 1 when provided.');
  }

  if (profile.create_run_output_folder && !profile.run_folder_name_template) {
    throw new Error('run_folder_name_template is required when create_run_output_folder is enabled.');
  }
  if (!profile.output_file_name_template) {
    throw new Error('output_file_name_template is required.');
  }

  if (profile.export_selected_rows_only && profile.selected_sheet_rows.length === 0) {
    throw new Error('selected_sheet_rows is required when export_selected_rows_only is enabled.');
  }

  return profile;
}

function defaultTokenPath() {
  return path.join(os.homedir(), '.google_workspace_mcp', 'credentials', 'sheet_slide_export_token.json');
}

function resolveFsPath(candidate, fallback = null) {
  const value = (candidate || fallback || '').trim();
  if (!value) return '';
  if (path.isAbsolute(value)) return value;
  return path.resolve(APP_ROOT, value);
}

function stripAccents(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeTemplateKey(value) {
  return stripAccents(String(value || '').trim().toLowerCase())
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sanitizeFilename(value) {
  const cleaned = String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'item';
}

function parseRangeStartRow(sheetRange) {
  const base = String(sheetRange || '').split(':', 1)[0];
  const match = base.match(/(\d+)$/);
  return match ? Number(match[1]) : 1;
}

function buildTemplateContext(profile, sheetRow, rowSlug, rowData = null, now = new Date()) {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');

  const ctx = {
    date: `${yyyy}-${mm}-${dd}`,
    date_compact: `${yyyy}${mm}${dd}`,
    datetime: `${yyyy}${mm}${dd}_${hh}${mi}${ss}`,
    profile_name: profile.name,
    sheet_name: profile.sheet_name,
    sheet_row: String(sheetRow),
    row_slug: rowSlug
  };

  if (rowData && typeof rowData === 'object') {
    for (const [header, rawValue] of Object.entries(rowData)) {
      if (!header) continue;
      const value = String(rawValue ?? '');
      const headerRaw = String(header).trim();
      const lower = headerRaw.toLowerCase();
      const ascii = stripAccents(lower);
      const norm = normalizeTemplateKey(headerRaw);

      ctx[headerRaw] = value;
      ctx[lower] = value;
      ctx[ascii] = value;
      if (norm) ctx[norm] = value;
    }
  }

  return ctx;
}

function applyTemplate(template, context) {
  const source = String(template || '').trim();
  if (!source) return '';

  const withDoubleBraces = source.replace(/\{\{([^{}]+)\}\}/g, (_, keyRaw) => {
    const key = String(keyRaw || '').trim();
    if (Object.prototype.hasOwnProperty.call(context, key)) return String(context[key]);
    const norm = normalizeTemplateKey(key);
    return String(context[norm] ?? '');
  });

  return withDoubleBraces.replace(/\{([^{}]+)\}/g, (_, keyRaw) => {
    const key = String(keyRaw || '').trim();
    return String(context[key] ?? '');
  });
}

function ensureUniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const dir = path.dirname(filePath);
  let counter = 2;
  while (true) {
    const candidate = path.join(dir, `${base}_${counter}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    counter += 1;
  }
}

function ensureUniqueDir(dirPath) {
  if (!fs.existsSync(dirPath)) return dirPath;
  const parent = path.dirname(dirPath);
  const name = path.basename(dirPath);
  let counter = 2;
  while (true) {
    const candidate = path.join(parent, `${name}_${counter}`);
    if (!fs.existsSync(candidate)) return candidate;
    counter += 1;
  }
}

function isZeroOrEmptyValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return true;
  let compact = stripAccents(text).toLowerCase().replace(/\s+/g, '').replace(/₫/g, '');
  let numericCandidate = compact.replace(/[^0-9,.-]/g, '');
  if (!numericCandidate) return false;
  numericCandidate = numericCandidate.replace(/,/g, '');
  const parsed = Number(numericCandidate);
  return Number.isFinite(parsed) && parsed === 0;
}

function resolveColumnName(headers, requested) {
  const candidate = String(requested || '').trim();
  if (!candidate) return null;

  for (const h of headers) if (h === candidate) return h;
  const folded = candidate.toLowerCase();
  for (const h of headers) if (String(h).toLowerCase() === folded) return h;

  const norm = normalizeTemplateKey(candidate);
  const map = {};
  for (const h of headers) {
    const key = normalizeTemplateKey(h);
    if (key && !map[key]) map[key] = h;
  }

  return map[norm] || null;
}

function inferSkipColumn(headers) {
  const map = {};
  for (const h of headers) {
    const key = normalizeTemplateKey(h);
    if (key && !map[key]) map[key] = h;
  }

  const exact = [
    'tong',
    'tong_tien',
    'tong_cong',
    'thanh_tien',
    'total',
    'bill',
    'so_tien',
    'so_tien_phai_tra',
    'tien_phai_tra',
    'can_thanh_toan',
    'cong_no',
    'congno'
  ];
  for (const key of exact) {
    if (map[key]) return map[key];
  }

  const tokens = ['tong', 'total', 'bill', 'thanh_tien', 'phai_tra', 'can_thanh_toan', 'cong_no', 'congno'];
  for (const [key, header] of Object.entries(map)) {
    if (tokens.some((token) => key.includes(token))) return header;
  }

  return null;
}

function inferRoomColumn(headers) {
  const map = {};
  for (const h of headers) {
    const key = normalizeTemplateKey(h);
    if (key && !map[key]) map[key] = h;
  }
  const exact = ['room', 'phong', 'so_phong', 'ma_phong'];
  for (const key of exact) if (map[key]) return map[key];
  for (const [key, header] of Object.entries(map)) {
    if (key.includes('room') || key.includes('phong')) return header;
  }
  return null;
}

function resolvePlaceholder(header, profile) {
  const mapping = profile.placeholder_mapping || {};
  if (profile.placeholder_strategy === 'mapping_only') {
    return mapping[header] || '';
  }
  if (profile.placeholder_strategy === 'mapping_with_fallback') {
    return mapping[header] || `{{${header}}}`;
  }
  return `${profile.placeholder_prefix}${header}${profile.placeholder_suffix}`;
}

function transformReferenceValue(header, value, profile) {
  const text = String(value ?? '');
  switch (profile.reference_strategy) {
    case 'strip_whitespace':
      return text.trim();
    case 'strip_currency':
      return text.replace(/[^0-9.,-]/g, '');
    case 'template_map': {
      const template = profile.reference_mapping?.[header];
      if (!template) return text;
      return String(template).replace(/\{value\}/g, text);
    }
    case 'identity':
    default:
      return text;
  }
}

function buildReplaceRequests(profile, data, sheetRow) {
  const requests = [];
  for (const [header, rawValue] of Object.entries(data || {})) {
    if (!header) continue;
    const placeholder = resolvePlaceholder(header, profile);
    if (!placeholder) continue;
    const replaceText = transformReferenceValue(header, String(rawValue ?? ''), profile);
    requests.push({
      replaceAllText: {
        containsText: { text: placeholder, matchCase: true },
        replaceText
      }
    });
  }

  requests.push({
    replaceAllText: {
      containsText: { text: '{{SHEET_ROW}}', matchCase: true },
      replaceText: String(sheetRow)
    }
  });
  requests.push({
    replaceAllText: {
      containsText: { text: '{{PROFILE_NAME}}', matchCase: true },
      replaceText: profile.name
    }
  });

  return requests;
}

function loadCredentials(profile) {
  const envJson = process.env.GOOGLE_OAUTH_CREDENTIALS_JSON;
  if (envJson) {
    try {
      return JSON.parse(envJson);
    } catch {
      throw new Error('GOOGLE_OAUTH_CREDENTIALS_JSON environment variable contains invalid JSON.');
    }
  }
  const credentialsPath = resolveFsPath(profile.credentials_file, process.env.GOOGLE_OAUTH_CREDENTIALS);
  if (!credentialsPath || !fs.existsSync(credentialsPath)) {
    throw new Error('Credentials not found. Set GOOGLE_OAUTH_CREDENTIALS_JSON, profile.credentials_file, or GOOGLE_OAUTH_CREDENTIALS environment variable.');
  }
  return JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
}

async function createGoogleClients(profile) {
  const credentialsRaw = loadCredentials(profile);
  const oauthInfo = credentialsRaw.installed || credentialsRaw.web;
  if (!oauthInfo) throw new Error('Invalid OAuth credentials. Missing installed/web section.');

  const tokenPath = resolveFsPath(profile.token_file, defaultTokenPath());
  if (!tokenPath || !fs.existsSync(tokenPath)) {
    throw new Error(`Token file not found: ${tokenPath}`);
  }

  const oauth2 = new google.auth.OAuth2(
    oauthInfo.client_id,
    oauthInfo.client_secret,
    Array.isArray(oauthInfo.redirect_uris) ? oauthInfo.redirect_uris[0] : undefined
  );

  const tokenRaw = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
  oauth2.setCredentials(tokenRaw);

  const sheets = google.sheets({ version: 'v4', auth: oauth2 });
  const slides = google.slides({ version: 'v1', auth: oauth2 });
  const drive = google.drive({ version: 'v3', auth: oauth2 });

  return { oauth2, sheets, slides, drive };
}

async function ensureAccessToken(oauth2) {
  const result = await oauth2.getAccessToken();
  if (typeof result === 'string') return result;
  if (result && typeof result.token === 'string') return result.token;
  if (oauth2.credentials && oauth2.credentials.access_token) return oauth2.credentials.access_token;
  throw new Error('Failed to get access token for Google API calls.');
}

async function readSheetValues(sheets, profile) {
  const range = `'${profile.sheet_name}'!${profile.sheet_range}`;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: profile.spreadsheet_id,
    range
  });
  return response.data.values || [];
}

function buildRowRecords(values, profile) {
  if (!Array.isArray(values) || values.length === 0) return [];

  const headerIdx = profile.header_row_index - 1;
  const dataStartIdx = profile.data_start_row_index - 1;
  if (headerIdx >= values.length) {
    throw new Error('Header row index is outside the selected sheet range.');
  }
  if (dataStartIdx >= values.length) {
    return [];
  }

  const headers = (values[headerIdx] || []).map((h) => String(h || '').trim());
  const startRow = parseRangeStartRow(profile.sheet_range);

  const records = [];
  for (let offset = dataStartIdx; offset < values.length; offset += 1) {
    const row = values[offset] || [];
    const padded = row.map((cell) => String(cell ?? ''));
    while (padded.length < headers.length) padded.push('');

    const data = {};
    headers.forEach((header, index) => {
      data[header] = padded[index] ?? '';
    });

    if (!Object.values(data).some((v) => String(v || '').trim())) {
      continue;
    }

    records.push({ sheet_row: startRow + offset, data });
  }

  if (profile.max_rows !== null) {
    return records.slice(0, profile.max_rows);
  }

  return records;
}

function selectRecordsForExport(records, profile, logger = () => {}) {
  if (!records.length) return { selectedRecords: [], skippedRows: [], selectionMeta: { skip_column: '' } };

  const headers = Object.keys(records[0].data || {});
  let skipColumn = '';
  const skippedRows = [];
  const rowsWithoutRoom = [];

  if (profile.skip_export_if_zero_or_empty) {
    const requested = profile.skip_zero_or_empty_column;
    if (requested) {
      const resolved = resolveColumnName(headers, requested);
      if (!resolved) {
        throw new Error(`Skip column '${requested}' was not found in sheet headers.`);
      }
      skipColumn = resolved;
      if (requested !== resolved) {
        logger(`Skip column '${requested}' matched to sheet header '${resolved}'.`);
      }
    } else {
      const inferred = inferSkipColumn(headers);
      if (inferred) {
        skipColumn = inferred;
        logger(`Skip column not set. Auto-selected '${skipColumn}' for zero/empty filtering.`);
      } else {
        logger('Skip enabled but no bill/total-like column detected; using whole-row zero/empty fallback.');
      }
    }
  }

  // A billable row must have a room/identifier. Rows without one are the sheet's
  // totals/subtotal rows (e.g. the SUM row at the bottom) and must not be exported
  // as if they were a tenant. Set profile.include_rows_without_room = true to opt out.
  let roomColumn = '';
  if (profile.include_rows_without_room !== true) {
    const requestedRoom = String(profile.room_column || '').trim();
    if (requestedRoom) {
      roomColumn = resolveColumnName(headers, requestedRoom) || '';
      if (!roomColumn) {
        throw new Error(`Room column '${requestedRoom}' was not found in sheet headers.`);
      }
    } else {
      roomColumn = inferRoomColumn(headers) || '';
    }
    if (roomColumn) {
      logger(`Room column '${roomColumn}' is required; rows without it will be skipped.`);
    }
  }

  let selectedRecords = [];
  records.forEach((record, index) => {
    const sheetRow = Number(record.sheet_row);
    const data = record.data || {};

    if (profile.skip_export_if_zero_or_empty) {
      if (skipColumn) {
        const value = String(data[skipColumn] ?? '');
        if (isZeroOrEmptyValue(value)) {
          skippedRows.push({
            sheet_row: sheetRow,
            reason: `column '${skipColumn}' is zero/empty`,
            value
          });
          logger(`[${index + 1}/${records.length}] Skipped sheet row ${sheetRow} (column '${skipColumn}' is zero/empty).`);
          return;
        }
      } else {
        const allZero = Object.values(data).every((v) => isZeroOrEmptyValue(v));
        if (allZero) {
          skippedRows.push({
            sheet_row: sheetRow,
            reason: 'all row values are zero/empty'
          });
          logger(`[${index + 1}/${records.length}] Skipped sheet row ${sheetRow} (all values are zero/empty).`);
          return;
        }
      }
    }

    if (roomColumn) {
      const roomValue = String(data[roomColumn] ?? '').trim();
      if (!roomValue) {
        rowsWithoutRoom.push({ sheet_row: sheetRow, reason: `column '${roomColumn}' is empty` });
        logger(`[${index + 1}/${records.length}] Skipped sheet row ${sheetRow} (column '${roomColumn}' is empty - totals row?).`);
        return;
      }
    }

    selectedRecords.push(record);
  });

  let selectedRowsRequested = [];
  let selectedRowsMatched = [];
  if (profile.export_selected_rows_only) {
    selectedRowsRequested = [...profile.selected_sheet_rows];
    const req = new Set(selectedRowsRequested);
    selectedRecords = selectedRecords.filter((record) => req.has(Number(record.sheet_row)));
    selectedRowsMatched = selectedRecords.map((record) => Number(record.sheet_row));
    const missing = selectedRowsRequested.filter((row) => !selectedRowsMatched.includes(row));
    logger(`Selected-row export enabled. Matched ${selectedRowsMatched.length}/${selectedRowsRequested.length} requested rows.`);
    if (missing.length) logger(`Requested rows not found or filtered out: ${JSON.stringify(missing)}`);
  }

  return {
    selectedRecords,
    skippedRows,
    selectionMeta: {
      skip_column: skipColumn,
      room_column: roomColumn,
      rows_without_room: rowsWithoutRoom,
      selected_rows_requested: selectedRowsRequested,
      selected_rows_matched: selectedRowsMatched
    }
  };
}

async function copyTemplate(drive, profile, copyName) {
  const body = { name: copyName };
  if (profile.destination_folder_id) {
    body.parents = [profile.destination_folder_id];
  }

  const response = await drive.files.copy({
    fileId: profile.template_presentation_id,
    requestBody: body,
    fields: 'id,name'
  });

  return response.data;
}

async function batchReplace(slides, presentationId, requests) {
  await slides.presentations.batchUpdate({
    presentationId,
    requestBody: { requests }
  });
}

async function exportPdf(drive, presentationId, outputPath) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const targetPath = ensureUniquePath(outputPath);

  const response = await drive.files.export(
    { fileId: presentationId, mimeType: 'application/pdf' },
    { responseType: 'stream' }
  );

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(targetPath);
    response.data.pipe(stream);
    response.data.on('error', reject);
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return targetPath;
}

async function getSlideIds(slides, presentationId) {
  const response = await slides.presentations.get({
    presentationId,
    fields: 'slides/objectId'
  });
  const slidesData = response.data.slides || [];
  return slidesData.map((s) => s.objectId).filter(Boolean);
}

async function fetchThumbnailBytes(slides, oauth2, presentationId, slideId) {
  const thumbResponse = await slides.presentations.pages.getThumbnail({
    presentationId,
    pageObjectId: slideId,
    'thumbnailProperties.mimeType': 'PNG',
    'thumbnailProperties.thumbnailSize': 'LARGE'
  });

  const contentUrl = thumbResponse.data.contentUrl;
  if (!contentUrl) return null;

  const accessToken = await ensureAccessToken(oauth2);
  const res = await fetch(contentUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Failed to fetch thumbnail: ${res.status}`);

  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

async function exportImages(slides, oauth2, presentationId, outputDir, baseName) {
  const ids = await getSlideIds(slides, presentationId);
  if (!ids.length) return [];

  await fs.promises.mkdir(outputDir, { recursive: true });
  const saved = [];
  for (let i = 0; i < ids.length; i += 1) {
    const bytes = await fetchThumbnailBytes(slides, oauth2, presentationId, ids[i]);
    if (!bytes) continue;
    const target = ensureUniquePath(path.join(outputDir, `${baseName}_slide_${String(i + 1).padStart(2, '0')}.png`));
    await fs.promises.writeFile(target, bytes);
    saved.push(target);
  }
  return saved;
}

async function getFirstSlidePngBytes(slides, oauth2, presentationId) {
  const ids = await getSlideIds(slides, presentationId);
  if (!ids.length) return null;
  return fetchThumbnailBytes(slides, oauth2, presentationId, ids[0]);
}

function getRowSlug(data, sheetRow) {
  const room = String(data.Room || data.Phong || data['Phòng'] || '').trim();
  let slug = `row_${sheetRow}`;
  if (room) slug = `${slug}_${sanitizeFilename(room)}`;
  return slug;
}

function resolveOutputRoot(profile) {
  const outputRoot = resolveFsPath(profile.output_dir, './generated_slide_exports');
  fs.mkdirSync(outputRoot, { recursive: true });
  return outputRoot;
}

function buildRunRoot(profile, outputRoot) {
  if (!profile.create_run_output_folder) {
    return outputRoot;
  }
  const runContext = buildTemplateContext(profile, 0, 'run');
  const runName = sanitizeFilename(applyTemplate(profile.run_folder_name_template, runContext));
  const runRoot = ensureUniqueDir(path.join(outputRoot, runName));
  fs.mkdirSync(runRoot, { recursive: true });
  return runRoot;
}

function normalizePreviewRows(records, roomColumn, billColumn, maxItems) {
  return records.slice(0, maxItems).map((record) => {
    const data = record.data || {};
    return {
      sheet_row: Number(record.sheet_row),
      room: roomColumn ? String(data[roomColumn] || '') : '',
      bill_value: billColumn ? String(data[billColumn] || '') : '',
      data
    };
  });
}

async function getSheetRowSelectionPreview(rawProfile, options = {}) {
  const logger = typeof options.log === 'function' ? options.log : () => {};
  const profile = validateProfile(rawProfile);

  const selectorProfile = normalizeProfile({
    ...profile,
    export_selected_rows_only: false,
    selected_sheet_rows: []
  });

  logger('Loading credentials and Google services for row selection preview...');
  const { sheets } = await createGoogleClients(selectorProfile);

  logger('Reading sheet data for row selection preview...');
  const values = await readSheetValues(sheets, selectorProfile);
  const records = buildRowRecords(values, selectorProfile);

  if (!records.length) {
    return {
      headers: [],
      rows: [],
      displayed_rows: 0,
      total_rows_read: 0,
      eligible_rows: 0,
      skipped_rows: 0,
      skip_column: ''
    };
  }

  const { selectedRecords, skippedRows, selectionMeta } = selectRecordsForExport(records, selectorProfile, logger);

  return {
    headers: Object.keys(records[0].data || {}),
    rows: selectedRecords.slice(0, options.maxItems || 1000).map((record) => ({
      sheet_row: Number(record.sheet_row),
      data: record.data
    })),
    displayed_rows: Math.min(selectedRecords.length, options.maxItems || 1000),
    total_rows_read: records.length,
    eligible_rows: selectedRecords.length,
    skipped_rows: skippedRows.length + (selectionMeta.rows_without_room || []).length,
    skip_column: selectionMeta.skip_column || '',
    room_column: selectionMeta.room_column || '',
    skipped_detail: [...skippedRows, ...(selectionMeta.rows_without_room || [])].slice(0, 20)
  };
}

async function generateSinglePreview(drive, slides, oauth2, profile, record, logger) {
  const sheetRow = Number(record.sheet_row);
  const data = record.data || {};
  const rowSlug = getRowSlug(data, sheetRow);
  const rowContext = buildTemplateContext(profile, sheetRow, rowSlug, data);
  let copyName = applyTemplate(profile.copy_name_template, rowContext);
  if (!copyName) copyName = `preview_${profile.name}_${profile.sheet_name}_row_${sheetRow}`;

  let previewPresentationId = null;
  let pngBase64 = '';
  try {
    const copy = await copyTemplate(drive, profile, copyName);
    previewPresentationId = copy.id;

    const requests = buildReplaceRequests(profile, data, sheetRow);
    await batchReplace(slides, previewPresentationId, requests);

    const bytes = await getFirstSlidePngBytes(slides, oauth2, previewPresentationId);
    if (bytes) {
      pngBase64 = bytes.toString('base64');
    }
  } catch (err) {
    logger(`Preview image generation failed for row ${sheetRow}: ${err.message || err}`);
  } finally {
    if (previewPresentationId) {
      try {
        await drive.files.delete({ fileId: previewPresentationId });
      } catch (err) {
        logger(`Warning: failed to delete preview presentation ${previewPresentationId}: ${err.message || err}`);
      }
    }
  }
  return { sheet_row: sheetRow, png_base64: pngBase64 };
}

async function getExportPreview(rawProfile, options = {}) {
  const logger = typeof options.log === 'function' ? options.log : () => {};
  const profile = validateProfile(rawProfile);

  logger('Loading credentials and Google services for preview...');
  const { oauth2, sheets, slides, drive } = await createGoogleClients(profile);

  logger('Reading sheet data for preview...');
  const values = await readSheetValues(sheets, profile);
  const records = buildRowRecords(values, profile);

  if (!records.length) {
    return {
      rows: [],
      displayed_rows: 0,
      total_rows_read: 0,
      eligible_rows: 0,
      skipped_rows: 0,
      skip_column: '',
      room_column: '',
      bill_column: '',
      selected_rows_requested: [],
      selected_rows_matched: [],
      previews: []
    };
  }

  const { selectedRecords, skippedRows, selectionMeta } = selectRecordsForExport(records, profile, logger);
  const headers = Object.keys(records[0].data || {});
  const roomColumn = inferRoomColumn(headers) || '';
  const billColumn = selectionMeta.skip_column || inferSkipColumn(headers) || '';

  const rows = normalizePreviewRows(selectedRecords, roomColumn, billColumn, options.maxItems || 500);

  const previewLimit = Math.min(selectedRecords.length, options.previewLimit || 20);
  const previews = [];
  if (selectedRecords.length) {
    logger(`Generating ${previewLimit} preview image(s)...`);
    for (let i = 0; i < previewLimit; i += 1) {
      const preview = await generateSinglePreview(drive, slides, oauth2, profile, selectedRecords[i], logger);
      if (preview.png_base64) previews.push(preview);
    }
  }

  return {
    rows: rows.map((row) => ({
      sheet_row: row.sheet_row,
      room: row.room,
      bill_value: row.bill_value
    })),
    displayed_rows: rows.length,
    total_rows_read: records.length,
    eligible_rows: selectedRecords.length,
    skipped_rows: skippedRows.length + (selectionMeta.rows_without_room || []).length,
    skip_column: selectionMeta.skip_column || '',
    room_column: roomColumn,
    bill_column: billColumn,
    selected_rows_requested: selectionMeta.selected_rows_requested || [],
    selected_rows_matched: selectionMeta.selected_rows_matched || [],
    previews
  };
}

async function runExport(rawProfile, options = {}) {
  const logger = typeof options.log === 'function' ? options.log : () => {};
  const profile = validateProfile(rawProfile);

  logger('Loading credentials and Google services...');
  const { oauth2, sheets, slides, drive } = await createGoogleClients(profile);

  logger('Reading sheet data...');
  const values = await readSheetValues(sheets, profile);
  const records = buildRowRecords(values, profile);
  if (!records.length) {
    throw new Error('No non-empty rows found with the current profile settings.');
  }

  const outputRoot = resolveOutputRoot(profile);
  const runRoot = buildRunRoot(profile, outputRoot);

  const summary = {
    profile,
    run_output_dir: runRoot,
    processed_rows: [],
    skipped_rows: []
  };

  const { selectedRecords, skippedRows, selectionMeta } = selectRecordsForExport(records, profile, logger);
  summary.skipped_rows = skippedRows;
  summary.selection = {
    total_rows_read: records.length,
    eligible_rows: selectedRecords.length,
    skipped_rows: skippedRows.length + (selectionMeta.rows_without_room || []).length,
    skip_column: selectionMeta.skip_column || '',
    room_column: selectionMeta.room_column || '',
    rows_without_room: selectionMeta.rows_without_room || [],
    selected_rows_requested: selectionMeta.selected_rows_requested || [],
    selected_rows_matched: selectionMeta.selected_rows_matched || []
  };

  if (!selectedRecords.length) {
    throw new Error('No rows matched current export filters. Nothing to export.');
  }

  logger(`Processing ${selectedRecords.length} row(s)...`);

  for (let index = 0; index < selectedRecords.length; index += 1) {
    const record = selectedRecords[index];
    const sheetRow = Number(record.sheet_row);
    const data = record.data || {};
    const rowSlug = getRowSlug(data, sheetRow);

    const rowContext = buildTemplateContext(profile, sheetRow, rowSlug, data);
    let copyName = applyTemplate(profile.copy_name_template, rowContext);
    if (!copyName) copyName = `${profile.name}_${profile.sheet_name}_row_${sheetRow}`;

    const copy = await copyTemplate(drive, profile, copyName);
    const presentationId = copy.id;

    const requests = buildReplaceRequests(profile, data, sheetRow);
    await batchReplace(slides, presentationId, requests);

    const rowOutputDir = profile.split_outputs_by_row
      ? path.join(runRoot, rowSlug)
      : runRoot;
    fs.mkdirSync(rowOutputDir, { recursive: true });

    let baseName = sanitizeFilename(applyTemplate(profile.output_file_name_template, rowContext));
    if (!baseName) baseName = sanitizeFilename(rowSlug);

    const rowSummary = {
      sheet_row: sheetRow,
      presentation_id: presentationId,
      presentation_url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
      output_dir: rowOutputDir,
      exports: {}
    };

    if (profile.output_format === 'pdf' || profile.output_format === 'both') {
      const pdfTarget = path.join(rowOutputDir, `${baseName}.pdf`);
      const pdfPath = await exportPdf(drive, presentationId, pdfTarget);
      rowSummary.exports.pdf = pdfPath;
    }

    if (profile.output_format === 'images' || profile.output_format === 'both') {
      const images = await exportImages(slides, oauth2, presentationId, rowOutputDir, baseName);
      rowSummary.exports.images = images;
    }

    if (profile.delete_generated_slides_after_export) {
      try {
        await drive.files.delete({ fileId: presentationId });
        rowSummary.deleted_from_drive = true;
      } catch (err) {
        rowSummary.deleted_from_drive = false;
        rowSummary.delete_error = String(err.message || err);
      }
    }

    summary.processed_rows.push(rowSummary);
    logger(`[${index + 1}/${selectedRecords.length}] Completed sheet row ${sheetRow} -> ${presentationId}`);
  }

  const summaryPath = path.join(runRoot, 'run_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
  logger(`Finished. Summary written to ${summaryPath}`);

  return summary;
}

async function getBillPreview(rawProfile, options = {}) {
  const logger = typeof options.log === 'function' ? options.log : () => {};
  const profile = validateProfile(rawProfile);

  logger('Loading credentials and Google services for preview...');
  const { sheets } = await createGoogleClients(profile);

  logger('Reading sheet data for preview...');
  const values = await readSheetValues(sheets, profile);
  const records = buildRowRecords(values, profile);

  if (!records.length) {
    return {
      headers: [],
      rows: [],
      displayed_rows: 0,
      total_rows_read: 0,
      eligible_rows: 0,
      skipped_rows: 0,
      skip_column: '',
      room_column: '',
      bill_column: ''
    };
  }

  const { selectedRecords, skippedRows, selectionMeta } = selectRecordsForExport(records, profile, logger);
  const headers = Object.keys(records[0].data || {});
  const roomColumn = inferRoomColumn(headers) || '';
  const billColumn = selectionMeta.skip_column || inferSkipColumn(headers) || '';

  const rows = normalizePreviewRows(selectedRecords, roomColumn, billColumn, options.maxItems || 500);

  return {
    headers,
    rows,
    displayed_rows: rows.length,
    total_rows_read: records.length,
    eligible_rows: selectedRecords.length,
    skipped_rows: skippedRows.length + (selectionMeta.rows_without_room || []).length,
    skip_column: selectionMeta.skip_column || '',
    room_column: roomColumn,
    bill_column: billColumn,
    skipped_detail: [...skippedRows, ...(selectionMeta.rows_without_room || [])].slice(0, 20)
  };
}

async function extractPlaceholdersFromSlides(slides, presentationId, prefix = '{{', suffix = '}}') {
  const response = await slides.presentations.get({
    presentationId,
    fields: 'slides(pageElements(shape(text(textElements(textRun/content)))))'
  });

  const found = new Set();
  const escPre = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escSuf = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escPre}(.*?)${escSuf}`, 'g');

  const slidesData = response.data.slides || [];
  for (const slide of slidesData) {
    const pageElements = slide.pageElements || [];
    for (const element of pageElements) {
      const textElements = element?.shape?.text?.textElements || [];
      for (const te of textElements) {
        const content = te?.textRun?.content || '';
        let match;
        while ((match = regex.exec(content)) !== null) {
          const inner = match[1].trim();
          if (inner) found.add(inner);
        }
      }
    }
  }
  return [...found];
}

async function detectMappings(profile) {
  const { sheets, slides, oauth2 } = await createGoogleClients(profile);
  const values = await readSheetValues(sheets, profile);
  const records = buildRowRecords(values, profile);

  if (!records.length) {
    return { headers: [], placeholders: [], mapping: {}, note: 'No data found in sheet.' };
  }

  const headers = Object.keys(records[0].data || {});
  const prefix = profile.placeholder_prefix || '{{';
  const suffix = profile.placeholder_suffix || '}}';
  const placeholderInners = await extractPlaceholdersFromSlides(slides, profile.template_presentation_id, prefix, suffix);

  const mapping = {};
  const normalizedPlaceholders = placeholderInners.map((ph) => ({
    original: ph,
    norm: normalizeTemplateKey(ph)
  }));

  for (const header of headers) {
    const headerNorm = normalizeTemplateKey(header);
    // Exact normalized match
    const exact = normalizedPlaceholders.find((p) => p.norm === headerNorm);
    if (exact) {
      mapping[header] = `${prefix}${exact.original}${suffix}`;
      continue;
    }
    // Fuzzy: header contains placeholder word or vice versa
    const fuzzy = normalizedPlaceholders.find((p) => {
      return headerNorm.includes(p.norm) || p.norm.includes(headerNorm);
    });
    if (fuzzy) {
      mapping[header] = `${prefix}${fuzzy.original}${suffix}`;
    }
  }

  return {
    headers,
    placeholders: placeholderInners.map((ph) => `${prefix}${ph}${suffix}`),
    mapping,
    note: `Matched ${Object.keys(mapping).length} of ${headers.length} header(s) to ${placeholderInners.length} slide placeholder(s).`
  };
}

module.exports = {
  normalizeProfile,
  validateProfile,
  getSheetRowSelectionPreview,
  getExportPreview,
  getBillPreview,
  runExport,
  createGoogleClients,
  readSheetValues,
  detectMappings
};
