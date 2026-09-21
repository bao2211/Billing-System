const els = {
  profileSelect: document.getElementById('profileSelect'),
  refreshProfilesBtn: document.getElementById('refreshProfilesBtn'),
  loadProfileBtn: document.getElementById('loadProfileBtn'),
  saveProfileBtn: document.getElementById('saveProfileBtn'),
  previewBillsBtn: document.getElementById('previewBillsBtn'),
  runExportBtn: document.getElementById('runExportBtn'),
  hideConfigToggle: document.getElementById('hideConfigToggle'),

  configPanel: document.getElementById('configPanel'),
  appMain: document.getElementById('appMain'),

  rowSelectorBtn: document.getElementById('rowSelectorBtn'),
  showOutputFolderBtn: document.getElementById('showOutputFolderBtn'),

  previewModal: document.getElementById('previewModal'),
  previewSummary: document.getElementById('previewSummary'),
  previewImage: document.getElementById('previewImage'),
  previewTable: document.getElementById('previewTable'),

  rowSelectorModal: document.getElementById('rowSelectorModal'),
  rowSelectorSummary: document.getElementById('rowSelectorSummary'),
  rowSelectorTable: document.getElementById('rowSelectorTable'),
  selectAllRowsBtn: document.getElementById('selectAllRowsBtn'),
  clearRowsBtn: document.getElementById('clearRowsBtn'),
  applyRowsBtn: document.getElementById('applyRowsBtn'),

  logOutput: document.getElementById('logOutput')
};

const textInputs = [
  'name',
  'spreadsheet_id',
  'sheet_name',
  'sheet_range',
  'template_presentation_id',
  'destination_folder_id',
  'copy_name_template',
  'output_dir',
  'run_folder_name_template',
  'output_file_name_template',
  'credentials_file',
  'token_file',
  'skip_zero_or_empty_column',
  'selected_sheet_rows'
];

const numberInputs = ['header_row_index', 'data_start_row_index', 'max_rows'];
const selectInputs = ['output_format', 'placeholder_strategy', 'reference_strategy'];
const checkInputs = [
  'create_run_output_folder',
  'split_outputs_by_row',
  'delete_generated_slides_after_export',
  'skip_export_if_zero_or_empty',
  'export_selected_rows_only'
];

let selectedRowsCache = [];
let rowSelectorRows = [];
let rowSelectorHeaderKeys = [];
let rowSelectorSelectedSet = new Set();

function log(message) {
  const line = typeof message === 'string' ? message : JSON.stringify(message);
  els.logOutput.textContent += `${line}\n`;
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

function clearLog() {
  els.logOutput.textContent = '';
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
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${id} must be valid JSON.`);
  }
}

function updateSelectedRowsDisplay() {
  setInputValue('selected_sheet_rows', selectedRowsCache.join(','));
}

function buildProfileFromForm({ allowEmptySelectedRows = false } = {}) {
  const profile = {};

  textInputs.forEach((id) => {
    profile[id] = getInputValue(id).trim();
  });

  numberInputs.forEach((id) => {
    const raw = getInputValue(id).trim();
    profile[id] = raw ? Number(raw) : null;
  });

  selectInputs.forEach((id) => {
    profile[id] = getInputValue(id).trim();
  });

  checkInputs.forEach((id) => {
    profile[id] = getCheckboxValue(id);
  });

  profile.placeholder_mapping = parseJsonTextArea('placeholder_mapping');
  profile.reference_mapping = parseJsonTextArea('reference_mapping');

  profile.destination_folder_id = profile.destination_folder_id || null;
  profile.credentials_file = profile.credentials_file || null;
  profile.max_rows = Number.isInteger(profile.max_rows) ? profile.max_rows : null;

  profile.selected_sheet_rows = [...selectedRowsCache];

  if (allowEmptySelectedRows && profile.export_selected_rows_only && profile.selected_sheet_rows.length === 0) {
    profile.export_selected_rows_only = false;
  }

  return profile;
}

function setFormFromProfile(profile) {
  textInputs.forEach((id) => setInputValue(id, profile[id] ?? ''));
  numberInputs.forEach((id) => setInputValue(id, profile[id] ?? ''));
  selectInputs.forEach((id) => setInputValue(id, profile[id] ?? ''));
  checkInputs.forEach((id) => setCheckboxValue(id, profile[id]));

  setInputValue('placeholder_mapping', JSON.stringify(profile.placeholder_mapping || {}, null, 2));
  setInputValue('reference_mapping', JSON.stringify(profile.reference_mapping || {}, null, 2));

  selectedRowsCache = Array.isArray(profile.selected_sheet_rows)
    ? [...new Set(profile.selected_sheet_rows.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 1))]
    : [];
  updateSelectedRowsDisplay();
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = Boolean(busy);
}

function openModal(modalEl) {
  modalEl.classList.remove('hidden');
}

function closeModal(modalEl) {
  modalEl.classList.add('hidden');
}

function applyCompactMode() {
  const compact = els.hideConfigToggle.checked;
  if (compact) {
    els.appMain.classList.add('hidden');
  } else {
    els.appMain.classList.remove('hidden');
  }
}

async function refreshProfiles() {
  const body = await api('/api/profiles');
  const names = body.profiles || [];

  const current = els.profileSelect.value;
  els.profileSelect.innerHTML = '';
  names.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    els.profileSelect.appendChild(opt);
  });

  if (names.includes(current)) {
    els.profileSelect.value = current;
  } else if (names.length) {
    els.profileSelect.value = names[0];
  }
}

async function loadSelectedProfile() {
  const name = els.profileSelect.value;
  if (!name) return;
  const body = await api(`/api/profiles/${encodeURIComponent(name)}`);
  setFormFromProfile(body.profile || {});
  log(`Loaded profile: ${name}`);
}

async function saveCurrentProfile() {
  const profile = buildProfileFromForm();
  const body = await api('/api/profiles/save', {
    method: 'POST',
    body: JSON.stringify({ profile })
  });
  await refreshProfiles();
  els.profileSelect.value = body.profile.name;
  log(`Saved profile: ${body.path}`);
}

function renderPreviewTable(rows) {
  els.previewTable.innerHTML = '';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  ['Sheet Row', 'Room', 'Bill Value'].forEach((title) => {
    const th = document.createElement('th');
    th.textContent = title;
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);

  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    [row.sheet_row, row.room, row.bill_value].forEach((value) => {
      const td = document.createElement('td');
      td.textContent = value == null ? '' : String(value);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  els.previewTable.appendChild(thead);
  els.previewTable.appendChild(tbody);
}

async function showExportPreview() {
  const profile = buildProfileFromForm({ allowEmptySelectedRows: true });
  const body = await api('/api/preview/export', {
    method: 'POST',
    body: JSON.stringify({ profile, maxItems: 500, allowEmptySelectedRows: true })
  });

  (body.logs || []).forEach(log);

  const result = body.result || {};
  els.previewSummary.textContent = [
    `Rows read: ${result.total_rows_read || 0}`,
    `Rows selected to export: ${result.eligible_rows || 0}`,
    `Rows skipped: ${result.skipped_rows || 0}`,
    `Room column: ${result.room_column || '(not detected)'}`,
    `Bill column: ${result.bill_column || '(not detected)'}`,
    `Rows displayed: ${result.displayed_rows || 0}`
  ].join(' | ');

  if (result.first_bill_preview_png_base64) {
    els.previewImage.src = `data:image/png;base64,${result.first_bill_preview_png_base64}`;
    els.previewImage.style.display = 'block';
  } else {
    els.previewImage.removeAttribute('src');
    els.previewImage.style.display = 'none';
  }

  renderPreviewTable(result.rows || []);
  openModal(els.previewModal);
}

function renderRowSelectorTable() {
  els.rowSelectorTable.innerHTML = '';

  const columns = rowSelectorHeaderKeys.slice(0, 6);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Select', 'Sheet Row', ...columns].forEach((title) => {
    const th = document.createElement('th');
    th.textContent = title;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  const tbody = document.createElement('tbody');
  rowSelectorRows.forEach((row) => {
    const tr = document.createElement('tr');
    tr.dataset.sheetRow = String(row.sheet_row);

    const checkTd = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = rowSelectorSelectedSet.has(row.sheet_row);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) rowSelectorSelectedSet.add(row.sheet_row);
      else rowSelectorSelectedSet.delete(row.sheet_row);
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

  els.rowSelectorTable.appendChild(thead);
  els.rowSelectorTable.appendChild(tbody);
}

async function openRowSelector() {
  const profile = buildProfileFromForm({ allowEmptySelectedRows: true });
  profile.export_selected_rows_only = false;
  profile.selected_sheet_rows = [];

  const body = await api('/api/preview/rows', {
    method: 'POST',
    body: JSON.stringify({ profile, maxItems: 1000 })
  });

  (body.logs || []).forEach(log);

  const result = body.result || {};
  rowSelectorHeaderKeys = result.headers || [];
  rowSelectorRows = result.rows || [];
  rowSelectorSelectedSet = new Set(selectedRowsCache);

  els.rowSelectorSummary.textContent = [
    `Rows read: ${result.total_rows_read || 0}`,
    `Eligible rows: ${result.eligible_rows || 0}`,
    `Skipped rows: ${result.skipped_rows || 0}`,
    `Displayed rows: ${result.displayed_rows || 0}`
  ].join(' | ');

  renderRowSelectorTable();
  openModal(els.rowSelectorModal);
}

function applyRowSelection() {
  selectedRowsCache = rowSelectorRows
    .map((row) => Number(row.sheet_row))
    .filter((rowNum) => rowSelectorSelectedSet.has(rowNum));
  updateSelectedRowsDisplay();
  setCheckboxValue('export_selected_rows_only', selectedRowsCache.length > 0);
  log(`Selected sheet rows from Excel preview: [${selectedRowsCache.join(', ')}]`);
  closeModal(els.rowSelectorModal);
}

async function runExportNow() {
  const profile = buildProfileFromForm();
  const body = await api('/api/export', {
    method: 'POST',
    body: JSON.stringify({ profile })
  });

  (body.logs || []).forEach(log);
  log(`Export completed. Output: ${body.result?.run_output_dir || '(unknown)'}`);
}

async function openOutputFolder() {
  const output_dir = getInputValue('output_dir') || './generated_slide_exports';
  await api('/api/open-output-folder', {
    method: 'POST',
    body: JSON.stringify({ output_dir })
  });
  log(`Opened output folder: ${output_dir}`);
}

function bindEvents() {
  els.refreshProfilesBtn.addEventListener('click', async () => {
    try {
      await refreshProfiles();
    } catch (error) {
      alert(error.message);
    }
  });

  els.loadProfileBtn.addEventListener('click', async () => {
    try {
      await loadSelectedProfile();
    } catch (error) {
      alert(error.message);
    }
  });

  els.saveProfileBtn.addEventListener('click', async () => {
    setBusy(els.saveProfileBtn, true);
    try {
      await saveCurrentProfile();
    } catch (error) {
      alert(error.message);
      log(`Save error: ${error.message}`);
    } finally {
      setBusy(els.saveProfileBtn, false);
    }
  });

  els.previewBillsBtn.addEventListener('click', async () => {
    setBusy(els.previewBillsBtn, true);
    try {
      await showExportPreview();
    } catch (error) {
      alert(error.message);
      log(`Preview error: ${error.message}`);
    } finally {
      setBusy(els.previewBillsBtn, false);
    }
  });

  els.runExportBtn.addEventListener('click', async () => {
    setBusy(els.runExportBtn, true);
    try {
      await runExportNow();
      alert('Export run completed.');
    } catch (error) {
      alert(error.message);
      log(`Run error: ${error.message}`);
    } finally {
      setBusy(els.runExportBtn, false);
    }
  });

  els.rowSelectorBtn.addEventListener('click', async () => {
    setBusy(els.rowSelectorBtn, true);
    try {
      await openRowSelector();
    } catch (error) {
      alert(error.message);
      log(`Row selector error: ${error.message}`);
    } finally {
      setBusy(els.rowSelectorBtn, false);
    }
  });

  els.showOutputFolderBtn.addEventListener('click', async () => {
    try {
      await openOutputFolder();
    } catch (error) {
      alert(error.message);
      log(`Open folder error: ${error.message}`);
    }
  });

  els.selectAllRowsBtn.addEventListener('click', () => {
    rowSelectorRows.forEach((row) => rowSelectorSelectedSet.add(Number(row.sheet_row)));
    renderRowSelectorTable();
  });

  els.clearRowsBtn.addEventListener('click', () => {
    rowSelectorSelectedSet.clear();
    renderRowSelectorTable();
  });

  els.applyRowsBtn.addEventListener('click', () => {
    applyRowSelection();
  });

  els.hideConfigToggle.addEventListener('change', applyCompactMode);

  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const modalId = button.getAttribute('data-close');
      const modal = document.getElementById(modalId);
      if (modal) closeModal(modal);
    });
  });

  [els.previewModal, els.rowSelectorModal].forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal(modal);
    });
  });
}

async function init() {
  clearLog();
  bindEvents();
  applyCompactMode();

  try {
    await refreshProfiles();
    if (els.profileSelect.value) {
      await loadSelectedProfile();
    }
    log('Web exporter ready.');
  } catch (error) {
    log(`Startup error: ${error.message}`);
    alert(error.message);
  }
}

init();
