const els = {
  profileSelect: document.getElementById('profileSelect'),
  refreshProfilesBtn: document.getElementById('refreshProfilesBtn'),
  logoutBtn: document.getElementById('logoutBtn'),
  userInfo: document.getElementById('userInfo'),
  rowSelectionPanel: document.getElementById('rowSelectionPanel'),
  rowSelectionSummary: document.getElementById('rowSelectionSummary'),
  rowSelectionTable: document.getElementById('rowSelectionTable'),
  selectAllRowsBtn: document.getElementById('selectAllRowsBtn'),
  clearRowsBtn: document.getElementById('clearRowsBtn'),
  selectionSummary: document.getElementById('selectionSummary'),
  actionsPanel: document.getElementById('actionsPanel'),

  loadingOverlay: document.getElementById('loadingOverlay'),
  loadingText: document.getElementById('loadingText'),

  previewBillsBtn: document.getElementById('previewBillsBtn'),
  runExportBtn: document.getElementById('runExportBtn'),

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

  reportsPanel: document.getElementById('reportsPanel'),
  reportDashboard: document.getElementById('reportDashboard'),
  reportMonthBtn: document.getElementById('reportMonthBtn'),
  reportYearBtn: document.getElementById('reportYearBtn'),
  reportSelectedBtn: document.getElementById('reportSelectedBtn'),
  reportSummary: document.getElementById('reportSummary'),
  reportTableWrap: document.getElementById('reportTableWrap'),
  reportTable: document.getElementById('reportTable'),

  logOutput: document.getElementById('logOutput')
};

let currentProfile = null;
let rowSelectorRows = [];
let rowSelectorHeaderKeys = [];
let rowSelectorSelectedSet = new Set();
let previewImages = [];
let previewIndex = 0;

function log(message) {
  const line = typeof message === 'string' ? message : JSON.stringify(message);
  els.logOutput.textContent += `${line}\n`;
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

function clearLog() {
  els.logOutput.textContent = '';
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
    els.userInfo.textContent = `${data.username} (${data.role})`;
  } catch (e) {
    window.location.href = '/';
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
  if (names.includes(current)) els.profileSelect.value = current;
  else if (names.length) els.profileSelect.value = names[0];
}

async function loadSelectedProfile() {
  const name = els.profileSelect.value;
  if (!name) return;
  const body = await api(`/api/profiles/${encodeURIComponent(name)}`);
  currentProfile = body.profile || {};
  els.actionsPanel.style.display = '';
  els.reportsPanel.style.display = '';
  hideReport();
  rowSelectorSelectedSet.clear();
  updateSelectionSummary();
  log(`Loaded profile: ${name}`);
  await loadRowTable();
}

function updateSelectionSummary() {
  const total = rowSelectorSelectedSet.size;
  els.selectionSummary.textContent = total
    ? `Selected ${total} row(s): ${[...rowSelectorSelectedSet].sort((a, b) => a - b).join(', ')}`
    : 'All eligible rows will be exported (none specifically selected).';
}

function renderRowTable() {
  els.rowSelectionTable.innerHTML = '';
  if (!rowSelectorRows.length) {
    els.rowSelectionPanel.style.display = 'none';
    return;
  }

  els.rowSelectionPanel.style.display = '';
  const columns = rowSelectorHeaderKeys.slice(0, 8);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['', 'Row', ...columns].forEach((t) => {
    const th = document.createElement('th');
    th.textContent = t;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  const tbody = document.createElement('tbody');
  rowSelectorRows.forEach((row) => {
    const tr = document.createElement('tr');

    const checkTd = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = rowSelectorSelectedSet.has(row.sheet_row);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) rowSelectorSelectedSet.add(row.sheet_row);
      else rowSelectorSelectedSet.delete(row.sheet_row);
      updateSelectionSummary();
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

  els.rowSelectionTable.appendChild(thead);
  els.rowSelectionTable.appendChild(tbody);
}

async function loadRowTable() {
  if (!currentProfile) return;
  const profile = { ...currentProfile, export_selected_rows_only: false, selected_sheet_rows: [] };
  showLoading('Loading rows...');
  try {
    const body = await api('/api/preview/rows', {
      method: 'POST',
      body: JSON.stringify({ profile, maxItems: 1000 })
    });
    (body.logs || []).forEach(log);
    const result = body.result || {};
    rowSelectorHeaderKeys = result.headers || [];
    rowSelectorRows = result.rows || [];
    els.rowSelectionSummary.textContent = [
      `Rows read: ${result.total_rows_read || 0}`,
      `Eligible rows: ${result.eligible_rows || 0}`,
      `Skipped rows: ${result.skipped_rows || 0}`,
      `Displayed rows: ${result.displayed_rows || 0}`
    ].join(' | ');
    renderRowTable();
  } catch (error) {
    alert(error.message);
    log(`Row load error: ${error.message}`);
  } finally {
    hideLoading();
  }
}

function selectAllRows() {
  rowSelectorRows.forEach((r) => rowSelectorSelectedSet.add(Number(r.sheet_row)));
  renderRowTable();
  updateSelectionSummary();
}

function clearRows() {
  rowSelectorSelectedSet.clear();
  renderRowTable();
  updateSelectionSummary();
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

async function showExportPreview() {
  if (!currentProfile) return alert('Load a profile first.');
  const profile = {
    ...currentProfile,
    export_selected_rows_only: rowSelectorSelectedSet.size > 0,
    selected_sheet_rows: [...rowSelectorSelectedSet].sort((a, b) => a - b)
  };
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
  if (!currentProfile) return alert('Load a profile first.');
  const profile = {
    ...currentProfile,
    export_selected_rows_only: rowSelectorSelectedSet.size > 0,
    selected_sheet_rows: [...rowSelectorSelectedSet].sort((a, b) => a - b)
  };
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

function setBusy(button, busy) {
  if (button) button.disabled = Boolean(busy);
}

function openModal(modalEl) { modalEl.classList.remove('hidden'); }
function closeModal(modalEl) { modalEl.classList.add('hidden'); }

/* ---------- Reports ---------- */
let chartInstances = {};

function destroyCharts() {
  Object.values(chartInstances).forEach((c) => { if (c) c.destroy(); });
  chartInstances = {};
}

function hideReport() {
  els.reportDashboard.classList.add('hidden');
  els.reportTableWrap.style.display = 'none';
  els.reportTable.innerHTML = '';
  destroyCharts();
}

function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function renderKPIs(kpi) {
  document.getElementById('kpiTotal').textContent = fmtMoney(kpi?.total);
  document.getElementById('kpiCount').textContent = fmtMoney(kpi?.count);
  document.getElementById('kpiAvg').textContent = fmtMoney(kpi?.average);
  document.getElementById('kpiMax').textContent = fmtMoney(kpi?.max);
  document.getElementById('kpiMin').textContent = fmtMoney(kpi?.min);
}

function renderBarChart(canvasId, labels, data, label, color) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  if (chartInstances[canvasId]) chartInstances[canvasId].destroy();
  chartInstances[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label,
        data,
        backgroundColor: color || 'rgba(15, 108, 207, 0.7)',
        borderColor: color || 'rgba(15, 108, 207, 1)',
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { callback: (v) => fmtMoney(v) } }
      }
    }
  });
}

function renderLineChart(canvasId, labels, data, label, color) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  if (chartInstances[canvasId]) chartInstances[canvasId].destroy();
  chartInstances[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label,
        data,
        fill: true,
        backgroundColor: (color || 'rgba(15, 108, 207, 0.15)'),
        borderColor: (color || 'rgba(15, 108, 207, 1)'),
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { callback: (v) => fmtMoney(v) } }
      }
    }
  });
}

function renderReportTable(result) {
  const headers = result.headers || [];
  const rows = result.rows || [];
  els.reportTable.innerHTML = '';
  if (!headers.length) return;

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  headers.forEach((h) => {
    const th = document.createElement('th');
    th.textContent = String(h);
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);

  const tbody = document.createElement('tbody');
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    headers.forEach((h) => {
      const td = document.createElement('td');
      td.textContent = String((r.data || {})[h] ?? '');
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  els.reportTable.appendChild(thead);
  els.reportTable.appendChild(tbody);
  els.reportTableWrap.style.display = '';
}

function showReportSummary(result) {
  const parts = [
    result.note || '',
    result.bill_column ? `Bill column: "${result.bill_column}"` : '',
    result.date_column ? `Date column: "${result.date_column}"` : ''
  ];
  els.reportSummary.innerHTML = parts.filter(Boolean).join(' &nbsp;|&nbsp; ');
}

async function fetchReport(endpoint, type) {
  if (!currentProfile) return alert('Load a profile first.');
  const profileName = els.profileSelect.value;
  const selectedRows = type === 'selected' ? [...rowSelectorSelectedSet].sort((a, b) => a - b) : undefined;
  if (type === 'selected' && selectedRows.length === 0) {
    return alert('Select at least one row to run a selected-rows report.');
  }
  showLoading('Generating report dashboard...');
  try {
    const body = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify({ profile_name: profileName, selected_rows: selectedRows })
    });
    const result = body.result || {};

    els.reportDashboard.classList.remove('hidden');
    showReportSummary(result);
    renderKPIs(result.kpi);

    // Monthly bar chart
    const monthly = result.monthly || [];
    const monthLabels = monthly.map((m) => `M${m.month}`);
    const monthTotals = monthly.map((m) => m.total);
    renderBarChart('monthlyChart', monthLabels, monthTotals, 'Revenue', 'rgba(15, 108, 207, 0.7)');

    // Yearly bar chart
    const yearly = result.yearly || [];
    const yearLabels = yearly.map((y) => String(y.year));
    const yearTotals = yearly.map((y) => y.total);
    renderBarChart('yearlyChart', yearLabels, yearTotals, 'Revenue', 'rgba(10, 158, 82, 0.7)');

    // Daily trend line chart
    const daily = result.daily_trend || [];
    const trendTitle = document.getElementById('trendChartTitle');
    if (type === 'month') {
      trendTitle.textContent = 'Daily Trend (This Month)';
    } else if (type === 'year') {
      trendTitle.textContent = 'Daily Trend (This Year)';
    } else {
      trendTitle.textContent = 'Daily Trend (Selected Rows)';
    }
    const trendLabels = daily.map((d) => d.date);
    const trendTotals = daily.map((d) => d.total);
    renderLineChart('trendChart', trendLabels, trendTotals, 'Revenue', 'rgba(138, 92, 246, 0.7)');

    renderReportTable(result);
    log(`Report [${type}]: ${result.count || 0} rows${result.bill_column ? ', total ' + fmtMoney(result.total) : ''}`);
  } catch (error) {
    alert(error.message);
    log(`Report error [${type}]: ${error.message}`);
  } finally {
    hideLoading();
  }
}

function bindEvents() {
  els.logoutBtn.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    window.location.href = '/';
  });
  els.refreshProfilesBtn.addEventListener('click', refreshProfiles);
  els.profileSelect.addEventListener('change', loadSelectedProfile);
  els.previewBillsBtn.addEventListener('click', showExportPreview);
  els.runExportBtn.addEventListener('click', runExportNow);
  els.selectAllRowsBtn.addEventListener('click', selectAllRows);
  els.clearRowsBtn.addEventListener('click', clearRows);

  els.reportMonthBtn.addEventListener('click', () => fetchReport('/api/report/month', 'month'));
  els.reportYearBtn.addEventListener('click', () => fetchReport('/api/report/year', 'year'));
  els.reportSelectedBtn.addEventListener('click', () => fetchReport('/api/report/selected', 'selected'));

  els.galleryPrev.addEventListener('click', () => showPreviewAt(previewIndex - 1));
  els.galleryNext.addEventListener('click', () => showPreviewAt(previewIndex + 1));

  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => {
      const modal = document.getElementById(b.getAttribute('data-close'));
      if (modal) closeModal(modal);
    });
  });
  [els.previewModal, els.exportModal].forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(m); });
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
  if (els.profileSelect.value) await loadSelectedProfile();
  log('Client portal ready.');
}

init();
