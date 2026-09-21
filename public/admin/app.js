const els = {
  profileSelect: document.getElementById('profileSelect'),
  refreshProfilesBtn: document.getElementById('refreshProfilesBtn'),
  saveProfileBtn: document.getElementById('saveProfileBtn'),
  newProfileBtn: document.getElementById('newProfileBtn'),
  deleteProfileBtn: document.getElementById('deleteProfileBtn'),
  previewBillsBtn: document.getElementById('previewBillsBtn'),
  runExportBtn: document.getElementById('runExportBtn'),
  logoutBtn: document.getElementById('logoutBtn'),
  userInfo: document.getElementById('userInfo'),

  tabProfiles: document.getElementById('tabProfiles'),
  tabAccounts: document.getElementById('tabAccounts'),
  profilesView: document.getElementById('profilesView'),
  accountsView: document.getElementById('accountsView'),

  loadingOverlay: document.getElementById('loadingOverlay'),
  loadingText: document.getElementById('loadingText'),

  previewModal: document.getElementById('previewModal'),
  previewSummary: document.getElementById('previewSummary'),
  previewImage: document.getElementById('previewImage'),
  previewTable: document.getElementById('previewTable'),
  galleryPrev: document.getElementById('galleryPrev'),
  galleryNext: document.getElementById('galleryNext'),
  galleryCounter: document.getElementById('galleryCounter'),
  galleryThumbs: document.getElementById('galleryThumbs'),

  exportModal: document.getElementById('exportModal'),
  exportSummary: document.getElementById('exportSummary'),
  downloadAllBtn: document.getElementById('downloadAllBtn'),

  // Account elements
  accountSelect: document.getElementById('accountSelect'),
  refreshAccountsBtn: document.getElementById('refreshAccountsBtn'),
  newAccountBtn: document.getElementById('newAccountBtn'),
  deleteAccountBtn: document.getElementById('deleteAccountBtn'),
  saveAccountBtn: document.getElementById('saveAccountBtn'),
  accUsername: document.getElementById('acc_username'),
  accPassword: document.getElementById('acc_password'),
  accRole: document.getElementById('acc_role'),
  accAllProfiles: document.getElementById('acc_all_profiles'),
  accProfileList: document.getElementById('accProfileList'),

  // Advanced toggle
  advancedToggle: document.getElementById('advancedToggle'),
  advancedBody: document.getElementById('advancedBody'),

  // Detect columns
  detectColumnsBtn: document.getElementById('detectColumnsBtn'),
  detectResult: document.getElementById('detectResult'),
  detectGrid: document.getElementById('detectGrid'),
  applyMappingBtn: document.getElementById('applyMappingBtn'),

  // Detect header ↔ placeholder mappings
  detectMappingsBtn: document.getElementById('detectMappingsBtn'),
  mappingDetectResult: document.getElementById('mappingDetectResult'),
  mappingDetectGrid: document.getElementById('mappingDetectGrid'),
  applyMappingDetectBtn: document.getElementById('applyMappingDetectBtn'),

  // Change my password
  myCurrPassword: document.getElementById('my_curr_password'),
  myNewPassword: document.getElementById('my_new_password'),
  changeMyPasswordBtn: document.getElementById('changeMyPasswordBtn'),

  // Admin row selection
  adminRowPanel: document.getElementById('adminRowPanel'),
  adminRowSummary: document.getElementById('adminRowSummary'),
  adminRowTable: document.getElementById('adminRowTable'),
  adminSelectAllBtn: document.getElementById('adminSelectAllBtn'),
  adminClearBtn: document.getElementById('adminClearBtn'),
  adminSelectionSummary: document.getElementById('adminSelectionSummary'),

  // Upload elements
  dbUsersFile: document.getElementById('dbUsersFile'),
  dbProfileFiles: document.getElementById('dbProfileFiles'),
  uploadDatabaseBtn: document.getElementById('uploadDatabaseBtn'),
  dbUploadStatus: document.getElementById('dbUploadStatus'),
  credFile: document.getElementById('credFile'),
  tokenFile: document.getElementById('tokenFile'),
  uploadCredentialsBtn: document.getElementById('uploadCredentialsBtn'),
  credUploadStatus: document.getElementById('credUploadStatus'),

  // Download elements
  downloadUsersBtn: document.getElementById('downloadUsersBtn'),
  downloadProfilesBtn: document.getElementById('downloadProfilesBtn'),
  downloadDatabaseBtn: document.getElementById('downloadDatabaseBtn')
};

const textInputs = [
  'name','spreadsheet_id','sheet_name','sheet_range','template_presentation_id',
  'destination_folder_id','copy_name_template','output_dir','run_folder_name_template',
  'output_file_name_template','credentials_file','token_file','skip_zero_or_empty_column',
  'selected_sheet_rows'
];
const numberInputs = ['header_row_index','data_start_row_index','max_rows'];
const selectInputs = ['output_format','placeholder_strategy','reference_strategy'];
const checkInputs = [
  'create_run_output_folder','split_outputs_by_row',
  'delete_generated_slides_after_export','skip_export_if_zero_or_empty',
  'export_selected_rows_only'
];

let previewImages = [];
let previewIndex = 0;
let allProfilesList = [];
let currentAccounts = [];

// Admin row selection state
let adminRowRecords = [];
let adminRowHeaders = [];
let adminSelectedSet = new Set();
let lastDetectedMapping = {};
let lastMappingDetect = {};

function log(message) {
  const line = typeof message === 'string' ? message : JSON.stringify(message);
  const out = document.getElementById('logOutput');
  if (out) {
    out.textContent += `${line}\n`;
    out.scrollTop = out.scrollHeight;
  }
}

function clearLog() {
  const out = document.getElementById('logOutput');
  if (out) out.textContent = '';
}

function showLoading(text = 'Working...') {
  els.loadingText.textContent = text;
  els.loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  els.loadingOverlay.classList.add('hidden');
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

async function checkSession() {
  try {
    const data = await api('/api/session');
    if (!data.authenticated) return window.location.href = '/';
    if (data.role !== 'admin') return window.location.href = '/client';
    els.userInfo.textContent = `${data.username} (${data.role})`;
  } catch (e) {
    window.location.href = '/';
  }
}

function getInputValue(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}
function getCheckboxValue(id) {
  const el = document.getElementById(id);
  return Boolean(el && el.checked);
}
function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value ?? '';
}
function setCheckboxValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = Boolean(value);
}
function parseJsonTextArea(id) {
  const raw = getInputValue(id).trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { throw new Error(`${id} must be valid JSON.`); }
}

function buildProfileFromForm() {
  const profile = {};
  textInputs.forEach((id) => { profile[id] = getInputValue(id).trim(); });
  numberInputs.forEach((id) => {
    const raw = getInputValue(id).trim();
    profile[id] = raw ? Number(raw) : null;
  });
  selectInputs.forEach((id) => { profile[id] = getInputValue(id).trim(); });
  checkInputs.forEach((id) => { profile[id] = getCheckboxValue(id); });
  profile.placeholder_mapping = parseJsonTextArea('placeholder_mapping');
  profile.reference_mapping = parseJsonTextArea('reference_mapping');
  profile.destination_folder_id = profile.destination_folder_id || null;
  profile.credentials_file = profile.credentials_file || null;
  profile.max_rows = Number.isInteger(profile.max_rows) ? profile.max_rows : null;
  profile.selected_sheet_rows = [];
  return profile;
}

function setFormFromProfile(profile) {
  textInputs.forEach((id) => setInputValue(id, profile[id] ?? ''));
  numberInputs.forEach((id) => setInputValue(id, profile[id] ?? ''));
  selectInputs.forEach((id) => setInputValue(id, profile[id] ?? ''));
  checkInputs.forEach((id) => setCheckboxValue(id, profile[id]));
  setInputValue('placeholder_mapping', JSON.stringify(profile.placeholder_mapping || {}, null, 2));
  setInputValue('reference_mapping', JSON.stringify(profile.reference_mapping || {}, null, 2));
}

async function refreshProfiles() {
  const body = await api('/api/profiles');
  const names = body.profiles || [];
  allProfilesList = names;
  const current = els.profileSelect.value;
  els.profileSelect.innerHTML = '';
  names.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    els.profileSelect.appendChild(opt);
  });
  if (names.includes(current)) els.profileSelect.value = current;
  else if (names.length) els.profileSelect.value = names[0];
}

async function loadSelectedProfile() {
  const name = els.profileSelect.value;
  if (!name) return;
  const body = await api(`/api/profiles/${encodeURIComponent(name)}`);
  setFormFromProfile(body.profile || {});
  log(`Loaded profile: ${name}`);
  await loadAdminRowTable();
}

/* ---------- Admin Row Selection ---------- */
function updateAdminSelectionSummary() {
  const total = adminSelectedSet.size;
  els.adminSelectionSummary.textContent = total
    ? `Selected ${total} row(s): ${[...adminSelectedSet].sort((a, b) => a - b).join(', ')}`
    : 'All eligible rows will be exported (none specifically selected).';
}

function renderAdminRowTable() {
  els.adminRowTable.innerHTML = '';
  if (!adminRowRecords.length) {
    els.adminRowPanel.style.display = 'none';
    return;
  }
  els.adminRowPanel.style.display = '';
  const columns = adminRowHeaders.slice(0, 8);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['', 'Row', ...columns].forEach((t) => {
    const th = document.createElement('th');
    th.textContent = t;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  const tbody = document.createElement('tbody');
  adminRowRecords.forEach((row) => {
    const tr = document.createElement('tr');

    const checkTd = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = adminSelectedSet.has(row.sheet_row);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) adminSelectedSet.add(row.sheet_row);
      else adminSelectedSet.delete(row.sheet_row);
      updateAdminSelectionSummary();
    });
    checkTd.appendChild(checkbox);
    tr.appendChild(checkTd);

    const rowTd = document.createElement('td');
    rowTd.textContent = String(row.sheet_row);
    tr.appendChild(rowTd);

    columns.forEach((key) => {
      const td = document.createElement('td');
      td.textContent = String((row.data || {})[key] ?? '');
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  els.adminRowTable.appendChild(thead);
  els.adminRowTable.appendChild(tbody);
}

async function loadAdminRowTable() {
  const profile = buildProfileFromForm();
  profile.export_selected_rows_only = false;
  profile.selected_sheet_rows = [];
  showLoading('Loading rows...');
  try {
    const body = await api('/api/preview/rows', {
      method: 'POST',
      body: JSON.stringify({ profile, maxItems: 1000 })
    });
    (body.logs || []).forEach(log);
    const result = body.result || {};
    adminRowHeaders = result.headers || [];
    adminRowRecords = result.rows || [];
    adminSelectedSet.clear();
    updateAdminSelectionSummary();
    els.adminRowSummary.textContent = [
      `Rows read: ${result.total_rows_read || 0}`,
      `Eligible rows: ${result.eligible_rows || 0}`,
      `Skipped rows: ${result.skipped_rows || 0}`,
      `Displayed rows: ${result.displayed_rows || 0}`
    ].join(' | ');
    renderAdminRowTable();
  } catch (error) {
    alert(error.message);
    log(`Row load error: ${error.message}`);
    els.adminRowPanel.style.display = 'none';
  } finally {
    hideLoading();
  }
}

function adminSelectAll() {
  adminRowRecords.forEach((r) => adminSelectedSet.add(Number(r.sheet_row)));
  renderAdminRowTable();
  updateAdminSelectionSummary();
}

function adminClearRows() {
  adminSelectedSet.clear();
  renderAdminRowTable();
  updateAdminSelectionSummary();
}

/* ---------- Detect Columns ---------- */
function renderDetectResult(headers, roomCol, billCol) {
  els.detectGrid.innerHTML = '';
  const items = [
    { key: 'Date Column', val: inferColumnByTokens(headers, ['date','ngay','ngày','issuedate','duedate','createdate','ngaytao','ngaylap']) },
    { key: 'Bill / Total Column', val: billCol || inferColumnByTokens(headers, ['tong','tongtien','tongcong','thanhtien','total','bill','sotien','sotienphaitra','tienphaitra','canthanhtoan','congno']) },
    { key: 'Room Column', val: roomCol || inferColumnByTokens(headers, ['room','phong','phòng','unit','canho','cănhộ',' apartment']) },
    { key: 'Name Column', val: inferColumnByTokens(headers, ['name','ten','tên','customer','khach','khách','fullname','hovaten']) },
    { key: 'Phone Column', val: inferColumnByTokens(headers, ['phone','sdt','sodienthoai','sốđiệnthoại','mobile','tel']) },
    { key: 'Email Column', val: inferColumnByTokens(headers, ['email','mail','gmail']) }
  ];

  items.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'detect-item';
    div.innerHTML = `<div class="detect-key">${item.key}</div><div class="detect-val ${item.val ? '' : 'empty'}">${item.val || 'Not detected'}</div>`;
    els.detectGrid.appendChild(div);
  });

  // Build suggested mapping
  const mapping = {};
  items.forEach((item) => {
    if (!item.val) return;
    const placeholder = item.key.toLowerCase().replace(/[^a-z]/g, '');
    if (placeholder.includes('date')) mapping['{{date}}'] = item.val;
    else if (placeholder.includes('bill') || placeholder.includes('total')) mapping['{{total}}'] = item.val;
    else if (placeholder.includes('room')) mapping['{{room}}'] = item.val;
    else if (placeholder.includes('name')) mapping['{{name}}'] = item.val;
    else if (placeholder.includes('phone')) mapping['{{phone}}'] = item.val;
    else if (placeholder.includes('email')) mapping['{{email}}'] = item.val;
  });
  lastDetectedMapping = mapping;
}

function inferColumnByTokens(headers, tokens) {
  for (const h of headers) {
    const key = String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    for (const t of tokens) {
      if (key.includes(t)) return h;
    }
  }
  return '';
}

async function detectColumns() {
  const profile = buildProfileFromForm();
  profile.export_selected_rows_only = false;
  profile.selected_sheet_rows = [];
  showLoading('Detecting columns...');
  try {
    const body = await api('/api/preview/rows', {
      method: 'POST',
      body: JSON.stringify({ profile, maxItems: 5 })
    });
    (body.logs || []).forEach(log);
    const result = body.result || {};
    const headers = result.headers || [];
    renderDetectResult(headers, result.room_column, result.bill_column);
    els.detectResult.classList.remove('hidden');
    log(`Detected columns from ${headers.length} header(s)`);
  } catch (error) {
    alert(error.message);
    log(`Detect error: ${error.message}`);
  } finally {
    hideLoading();
  }
}

function applyDetectedMapping() {
  if (!Object.keys(lastDetectedMapping).length) {
    return alert('No detected columns to apply. Run Detect Columns first.');
  }
  try {
    const current = JSON.parse(getInputValue('placeholder_mapping').trim() || '{}');
    const merged = { ...current, ...lastDetectedMapping };
    setInputValue('placeholder_mapping', JSON.stringify(merged, null, 2));
    log('Applied detected columns to Placeholder Mapping');
    els.detectResult.classList.add('hidden');
  } catch (e) {
    alert('Placeholder Mapping JSON is invalid. Please fix it before applying.');
  }
}

/* ---------- Detect Header ↔ Placeholder Mappings ---------- */
function renderMappingDetectResult(result) {
  els.mappingDetectGrid.innerHTML = '';
  const mapping = result.mapping || {};
  const entries = Object.entries(mapping);
  if (!entries.length) {
    els.mappingDetectGrid.innerHTML = '<p class="hint">No matches found.</p>';
    return;
  }
  entries.forEach(([header, placeholder]) => {
    const div = document.createElement('div');
    div.className = 'detect-item';
    div.innerHTML = `<div class="detect-key">${header}</div><div class="detect-val">→ ${placeholder}</div>`;
    els.mappingDetectGrid.appendChild(div);
  });
}

async function detectMappingsFromProfile() {
  const profile = buildProfileFromForm();
  if (!profile.template_presentation_id) {
    return alert('Slide Template ID is required to detect placeholders.');
  }
  showLoading('Scanning sheet headers and slide placeholders...');
  try {
    const body = await api('/api/detect-mappings', {
      method: 'POST',
      body: JSON.stringify({ profile })
    });
    const result = body.result || {};
    lastMappingDetect = result.mapping || {};
    renderMappingDetectResult(result);
    els.mappingDetectResult.classList.remove('hidden');
    log(result.note || 'Mapping detection complete.');
  } catch (error) {
    alert(error.message);
    log(`Mapping detect error: ${error.message}`);
  } finally {
    hideLoading();
  }
}

function applyMappingDetect() {
  if (!Object.keys(lastMappingDetect).length) {
    return alert('No mappings to apply. Run Auto-Match first.');
  }
  try {
    const current = JSON.parse(getInputValue('placeholder_mapping').trim() || '{}');
    const merged = { ...current, ...lastMappingDetect };
    setInputValue('placeholder_mapping', JSON.stringify(merged, null, 2));
    log('Applied detected mappings to Placeholder Mapping');
    els.mappingDetectResult.classList.add('hidden');
  } catch (e) {
    alert('Placeholder Mapping JSON is invalid. Please fix it before applying.');
  }
}

async function saveCurrentProfile() {
  setBusy(els.saveProfileBtn, true);
  try {
    const profile = buildProfileFromForm();
    const body = await api('/api/profiles/save', {
      method: 'POST',
      body: JSON.stringify({ profile })
    });
    await refreshProfiles();
    els.profileSelect.value = body.profile.name;
    log(`Saved profile: ${body.path}`);
  } catch (error) {
    alert(error.message);
    log(`Save error: ${error.message}`);
  } finally {
    setBusy(els.saveProfileBtn, false);
  }
}

async function deleteSelectedProfile() {
  const name = els.profileSelect.value;
  if (!name) return alert('Select a profile to delete.');
  if (!confirm(`Delete profile "${name}"?`)) return;
  try {
    await api(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await refreshProfiles();
    log(`Deleted profile: ${name}`);
  } catch (error) {
    alert(error.message);
    log(`Delete error: ${error.message}`);
  }
}

function newProfile() {
  const defaultName = 'new_profile_' + Date.now();
  setFormFromProfile({
    name: defaultName,
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
    credentials_file: null,
    token_file: './sheet_slide_export_token.json',
    placeholder_strategy: 'mapping_with_fallback',
    placeholder_prefix: '{{',
    placeholder_suffix: '}}',
    placeholder_mapping: {},
    reference_strategy: 'identity',
    reference_mapping: {},
    max_rows: null
  });
  log('New profile form prepared. Change the name and settings, then Save.');
}

function showPreviewAt(index) {
  if (!previewImages.length) return;
  previewIndex = Math.max(0, Math.min(index, previewImages.length - 1));
  const img = previewImages[previewIndex];
  els.previewImage.src = img ? `data:image/png;base64,${img.png_base64}` : '';
  resetZoom();
  els.galleryCounter.textContent = `Bill ${previewIndex + 1} of ${previewImages.length}`;
  els.galleryPrev.disabled = previewIndex === 0;
  els.galleryNext.disabled = previewIndex === previewImages.length - 1;
  Array.from(els.galleryThumbs.children).forEach((thumb, i) => {
    thumb.classList.toggle('active', i === previewIndex);
  });
}

function renderGalleryThumbs() {
  els.galleryThumbs.innerHTML = '';
  previewImages.forEach((img, i) => {
    const thumb = document.createElement('img');
    thumb.className = 'gallery-thumb';
    thumb.src = `data:image/png;base64,${img.png_base64}`;
    thumb.alt = `Row ${img.sheet_row}`;
    thumb.addEventListener('click', () => showPreviewAt(i));
    els.galleryThumbs.appendChild(thumb);
  });
}

function renderPreviewTable(rows) {
  els.previewTable.innerHTML = '';
  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  ['Sheet Row', 'Room', 'Bill Value'].forEach((t) => {
    const th = document.createElement('th');
    th.textContent = t;
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    [row.sheet_row, row.room, row.bill_value].forEach((v) => {
      const td = document.createElement('td');
      td.textContent = v == null ? '' : String(v);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  els.previewTable.appendChild(thead);
  els.previewTable.appendChild(tbody);
}

function overlayAdminSelection(profile) {
  return {
    ...profile,
    export_selected_rows_only: adminSelectedSet.size > 0,
    selected_sheet_rows: [...adminSelectedSet].sort((a, b) => a - b)
  };
}

async function showExportPreview() {
  const profile = overlayAdminSelection(buildProfileFromForm());
  showLoading('Generating preview images...');
  try {
    const body = await api('/api/preview/export', {
      method: 'POST',
      body: JSON.stringify({ profile, maxItems: 500, allowEmptySelectedRows: true })
    });
    (body.logs || []).forEach(log);
    const result = body.result || {};
    els.previewSummary.textContent = [
      `Rows read: ${result.total_rows_read || 0}`,
      `Selected to export: ${result.eligible_rows || 0}`,
      `Skipped: ${result.skipped_rows || 0}`,
      `Room column: ${result.room_column || '(not detected)'}`,
      `Bill column: ${result.bill_column || '(not detected)'}`
    ].join(' | ');

    previewImages = result.previews || [];
    previewIndex = 0;
    if (previewImages.length) {
      renderGalleryThumbs();
      showPreviewAt(0);
    } else {
      els.previewImage.removeAttribute('src');
      els.galleryCounter.textContent = 'No preview images generated';
      els.galleryThumbs.innerHTML = '';
    }
    els.galleryPrev.disabled = previewImages.length <= 1;
    els.galleryNext.disabled = previewImages.length <= 1;

    renderPreviewTable(result.rows || []);
    openModal(els.previewModal);
  } catch (error) {
    alert(error.message);
    log(`Preview error: ${error.message}`);
  } finally {
    hideLoading();
  }
}

async function runExportNow() {
  const profile = overlayAdminSelection(buildProfileFromForm());
  showLoading('Exporting bills... this may take a moment.');
  try {
    const body = await api('/api/export', {
      method: 'POST',
      body: JSON.stringify({ profile })
    });
    (body.logs || []).forEach(log);
    const result = body.result || {};
    log(`Export completed. ${result.files?.length || 0} file(s) generated.`);

    els.exportSummary.textContent = `Exported ${result.processed_rows?.length || 0} row(s). ${result.files?.length || 0} file(s) ready for download.`;
    els.downloadAllBtn.href = `/api/zip/${encodeURIComponent(result.run_id)}`;

    openModal(els.exportModal);
  } catch (error) {
    alert(error.message);
    log(`Run error: ${error.message}`);
  } finally {
    hideLoading();
  }
}

async function changeMyPassword() {
  const current = els.myCurrPassword.value;
  const next = els.myNewPassword.value;
  if (!current || !next) return alert('Enter both current and new passwords.');
  try {
    await api('/api/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password: current, new_password: next })
    });
    els.myCurrPassword.value = '';
    els.myNewPassword.value = '';
    log('Password changed successfully');
    alert('Password changed successfully.');
  } catch (error) {
    alert(error.message);
    log(`Change password error: ${error.message}`);
  }
}

/* ---------- Upload Database ---------- */
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function uploadDatabase() {
  const usersFile = els.dbUsersFile.files[0];
  const profileFiles = Array.from(els.dbProfileFiles.files || []);

  if (!usersFile && !profileFiles.length) {
    return alert('Select at least one file to upload.');
  }

  els.uploadDatabaseBtn.disabled = true;
  els.dbUploadStatus.textContent = 'Uploading...';

  try {
    const payload = {};
    if (usersFile) payload.usersContent = await readFileAsText(usersFile);

    if (profileFiles.length) {
      payload.profiles = [];
      for (const file of profileFiles) {
        const content = await readFileAsText(file);
        payload.profiles.push({ name: file.name, content });
      }
    }

    const body = await api('/api/upload-database', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    els.dbUploadStatus.textContent = `Saved: ${(body.saved || []).join(', ')}`;
    log(`Database uploaded: ${(body.saved || []).join(', ')}`);
    alert(`Database uploaded successfully.\nSaved: ${(body.saved || []).join(', ')}`);

    // Refresh UI
    await refreshProfiles();
    await refreshAccounts();
  } catch (error) {
    alert(error.message);
    log(`Database upload error: ${error.message}`);
    els.dbUploadStatus.textContent = 'Failed';
  } finally {
    els.uploadDatabaseBtn.disabled = false;
  }
}

/* ---------- Download Helpers ---------- */
function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function downloadUsers() {
  triggerDownload('/api/download/users', 'users.json');
  log('Downloaded users.json');
}

function downloadProfiles() {
  triggerDownload('/api/download/profiles', 'profiles.zip');
  log('Downloaded profiles.zip');
}

function downloadDatabase() {
  triggerDownload('/api/download/database', 'database.zip');
  log('Downloaded database.zip');
}

/* ---------- Upload Credentials ---------- */
async function uploadCredentials() {
  const credFile = els.credFile.files[0];
  const tokenFile = els.tokenFile.files[0];

  if (!credFile && !tokenFile) {
    return alert('Select at least one credential file to upload.');
  }

  els.uploadCredentialsBtn.disabled = true;
  els.credUploadStatus.textContent = 'Uploading...';

  try {
    const payload = {};
    if (credFile) payload.credentialsContent = await readFileAsText(credFile);
    if (tokenFile) payload.tokenContent = await readFileAsText(tokenFile);

    const body = await api('/api/upload-credentials', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    els.credUploadStatus.textContent = `Saved: ${(body.saved || []).join(', ')}`;
    log(`Credentials uploaded: ${(body.saved || []).join(', ')}`);
    alert(`Credentials uploaded successfully.\n${body.note || ''}`);
  } catch (error) {
    alert(error.message);
    log(`Credential upload error: ${error.message}`);
    els.credUploadStatus.textContent = 'Failed';
  } finally {
    els.uploadCredentialsBtn.disabled = false;
  }
}

function setBusy(button, busy) {
  if (button) button.disabled = Boolean(busy);
}

function openModal(modalEl) { modalEl.classList.remove('hidden'); }
function closeModal(modalEl) { modalEl.classList.add('hidden'); }

/* ---------- Zoom / Pan ---------- */
let zoomScale = 1;
let zoomX = 0;
let zoomY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panInitialX = 0;
let panInitialY = 0;

function applyZoomTransform() {
  els.previewImage.style.transform = `translate(${zoomX}px, ${zoomY}px) scale(${zoomScale})`;
}

function resetZoom() {
  zoomScale = 1;
  zoomX = 0;
  zoomY = 0;
  applyZoomTransform();
}

function initZoomPan() {
  const viewport = document.getElementById('zoomViewport');
  if (!viewport) return;

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    zoomScale = Math.min(Math.max(zoomScale + delta, 0.2), 5);
    applyZoomTransform();
  }, { passive: false });

  viewport.addEventListener('mousedown', (e) => {
    if (zoomScale <= 1) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panInitialX = zoomX;
    panInitialY = zoomY;
    viewport.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    zoomX = panInitialX + (e.clientX - panStartX);
    zoomY = panInitialY + (e.clientY - panStartY);
    applyZoomTransform();
  });

  window.addEventListener('mouseup', () => {
    if (!isPanning) return;
    isPanning = false;
    viewport.style.cursor = 'grab';
  });

  viewport.addEventListener('dblclick', resetZoom);
}

/* ---------- Tabs ---------- */
function showTab(name) {
  if (name === 'profiles') {
    els.profilesView.classList.remove('hidden');
    els.accountsView.classList.add('hidden');
    els.tabProfiles.classList.add('active');
    els.tabAccounts.classList.remove('active');
  } else {
    els.profilesView.classList.add('hidden');
    els.accountsView.classList.remove('hidden');
    els.tabProfiles.classList.remove('active');
    els.tabAccounts.classList.add('active');
  }
}

/* ---------- Account Management ---------- */
function renderAccProfileChecklist(selected = []) {
  els.accProfileList.innerHTML = '';
  if (!allProfilesList.length) {
    els.accProfileList.innerHTML = '<p class="hint">No profiles available.</p>';
    return;
  }
  const selSet = new Set(selected);
  allProfilesList.forEach((name) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = selSet.has(name);
    cb.className = 'acc-profile-cb';
    label.appendChild(cb);
    label.appendChild(document.createTextNode(name));
    els.accProfileList.appendChild(label);
  });
}

async function refreshAccounts() {
  const body = await api('/api/users');
  currentAccounts = body.users || [];
  const current = els.accountSelect.value;
  els.accountSelect.innerHTML = '';
  currentAccounts.forEach((u) => {
    const opt = document.createElement('option');
    opt.value = u.username;
    opt.textContent = `${u.username} (${u.role})`;
    els.accountSelect.appendChild(opt);
  });
  if (currentAccounts.find((u) => u.username === current)) {
    els.accountSelect.value = current;
  } else if (currentAccounts.length) {
    els.accountSelect.value = currentAccounts[0].username;
  }
}

function loadSelectedAccount() {
  const username = els.accountSelect.value;
  if (!username) return;
  const user = currentAccounts.find((u) => u.username === username);
  if (!user) return;
  setInputValue('acc_username', user.username);
  setInputValue('acc_password', '');
  setInputValue('acc_role', user.role);
  const all = user.allowed_profiles?.includes('*') || false;
  els.accAllProfiles.checked = all;
  renderAccProfileChecklist(all ? [] : (user.allowed_profiles || []));
  log(`Loaded account: ${username}`);
}

function getSelectedAccProfiles() {
  if (els.accAllProfiles.checked) return ['*'];
  const checked = [];
  els.accProfileList.querySelectorAll('.acc-profile-cb:checked').forEach((cb) => {
    checked.push(cb.value);
  });
  return checked;
}

async function saveCurrentAccount() {
  const username = els.accUsername.value.trim();
  if (!username) return alert('Username is required.');
  const existing = currentAccounts.find((u) => u.username === username);
  setBusy(els.saveAccountBtn, true);
  try {
    const updates = {
      role: els.accRole.value,
      allowed_profiles: getSelectedAccProfiles()
    };
    if (els.accPassword.value) updates.password = els.accPassword.value;

    if (existing) {
      await api(`/api/users/${encodeURIComponent(username)}`, {
        method: 'PUT',
        body: JSON.stringify(updates)
      });
      log(`Updated account: ${username}`);
    } else {
      if (!els.accPassword.value) return alert('Password is required for new accounts.');
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password: els.accPassword.value,
          role: els.accRole.value,
          allowed_profiles: updates.allowed_profiles
        })
      });
      log(`Created account: ${username}`);
    }
    await refreshAccounts();
    els.accountSelect.value = username;
  } catch (error) {
    alert(error.message);
    log(`Account save error: ${error.message}`);
  } finally {
    setBusy(els.saveAccountBtn, false);
  }
}

async function deleteSelectedAccount() {
  const username = els.accountSelect.value;
  if (!username) return alert('Select an account to delete.');
  if (!confirm(`Delete account "${username}"?`)) return;
  try {
    await api(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    await refreshAccounts();
    log(`Deleted account: ${username}`);
  } catch (error) {
    alert(error.message);
    log(`Delete account error: ${error.message}`);
  }
}

function newAccount() {
  setInputValue('acc_username', '');
  setInputValue('acc_password', '');
  setInputValue('acc_role', 'client');
  els.accAllProfiles.checked = true;
  renderAccProfileChecklist([]);
  log('New account form prepared. Fill in username and password, then Save.');
}

function bindEvents() {
  // Tabs
  els.tabProfiles.addEventListener('click', () => showTab('profiles'));
  els.tabAccounts.addEventListener('click', () => showTab('accounts'));

  // Auth
  els.logoutBtn.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    window.location.href = '/';
  });

  // Profiles
  els.refreshProfilesBtn.addEventListener('click', refreshProfiles);
  els.profileSelect.addEventListener('change', loadSelectedProfile);
  els.saveProfileBtn.addEventListener('click', saveCurrentProfile);
  els.newProfileBtn.addEventListener('click', newProfile);
  els.deleteProfileBtn.addEventListener('click', deleteSelectedProfile);
  els.previewBillsBtn.addEventListener('click', showExportPreview);
  els.runExportBtn.addEventListener('click', runExportNow);

  // Advanced toggle
  if (els.advancedToggle && els.advancedBody) {
    els.advancedToggle.addEventListener('click', () => {
      const isHidden = els.advancedBody.classList.toggle('hidden');
      els.advancedToggle.classList.toggle('open', !isHidden);
    });
  }

  // Detect columns
  if (els.detectColumnsBtn) els.detectColumnsBtn.addEventListener('click', detectColumns);
  if (els.applyMappingBtn) els.applyMappingBtn.addEventListener('click', applyDetectedMapping);

  // Detect header ↔ placeholder mappings
  if (els.detectMappingsBtn) els.detectMappingsBtn.addEventListener('click', detectMappingsFromProfile);
  if (els.applyMappingDetectBtn) els.applyMappingDetectBtn.addEventListener('click', applyMappingDetect);

  // Admin row selection
  if (els.adminSelectAllBtn) els.adminSelectAllBtn.addEventListener('click', adminSelectAll);
  if (els.adminClearBtn) els.adminClearBtn.addEventListener('click', adminClearRows);

  // Change my password
  if (els.changeMyPasswordBtn) els.changeMyPasswordBtn.addEventListener('click', changeMyPassword);

  // Uploads
  if (els.uploadDatabaseBtn) els.uploadDatabaseBtn.addEventListener('click', uploadDatabase);
  if (els.uploadCredentialsBtn) els.uploadCredentialsBtn.addEventListener('click', uploadCredentials);

  // Downloads
  if (els.downloadUsersBtn) els.downloadUsersBtn.addEventListener('click', downloadUsers);
  if (els.downloadProfilesBtn) els.downloadProfilesBtn.addEventListener('click', downloadProfiles);
  if (els.downloadDatabaseBtn) els.downloadDatabaseBtn.addEventListener('click', downloadDatabase);

  // Accounts
  els.refreshAccountsBtn.addEventListener('click', refreshAccounts);
  els.accountSelect.addEventListener('change', loadSelectedAccount);
  els.saveAccountBtn.addEventListener('click', saveCurrentAccount);
  els.newAccountBtn.addEventListener('click', newAccount);
  els.deleteAccountBtn.addEventListener('click', deleteSelectedAccount);
  els.accAllProfiles.addEventListener('change', () => {
    if (els.accAllProfiles.checked) {
      els.accProfileList.querySelectorAll('.acc-profile-cb').forEach((cb) => { cb.checked = false; });
    }
  });
  els.accProfileList.addEventListener('change', (e) => {
    if (e.target.classList.contains('acc-profile-cb') && e.target.checked) {
      els.accAllProfiles.checked = false;
    }
  });

  // Gallery
  els.galleryPrev.addEventListener('click', () => showPreviewAt(previewIndex - 1));
  els.galleryNext.addEventListener('click', () => showPreviewAt(previewIndex + 1));

  // Modals
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => {
      const modal = document.getElementById(b.getAttribute('data-close'));
      if (modal) closeModal(modal);
    });
  });
  [els.previewModal, els.exportModal].forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m) closeModal(m);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (els.previewModal.classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') showPreviewAt(previewIndex - 1);
    if (e.key === 'ArrowRight') showPreviewAt(previewIndex + 1);
    if (e.key === 'Escape') closeModal(els.previewModal);
  });
}

async function init() {
  clearLog();
  await checkSession();
  bindEvents();
  initZoomPan();
  await refreshProfiles();
  await refreshAccounts();
  if (els.profileSelect.value) await loadSelectedProfile();
  if (els.accountSelect.value) loadSelectedAccount();
  log('Admin portal ready.');
}

init();
