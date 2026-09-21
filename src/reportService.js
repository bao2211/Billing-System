const { createGoogleClients, readSheetValues } = require('./exportService');

// Fold Vietnamese diacritics to ASCII before stripping punctuation.
// Previously headers were normalised with .replace(/[^a-z0-9]+/g, ''), which
// DELETED accented characters instead of folding them, so "Tổng" became "tng"
// and could never match the token "tong". "đ" is not decomposed by NFD.
function foldHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function inferDateColumn(headers, records) {
  const map = {};
  for (const h of headers) {
    const key = foldHeader(h);
    if (key) map[key] = h;
  }
  // A candidate is only accepted if its cells actually parse as dates, otherwise
  // a column like "Ngày đóng học phí" (values "Đầu tháng") would filter every row away.
  const usable = (header) => {
    if (!Array.isArray(records) || records.length === 0) return true;
    return records.some((r) => parseDateCell(r.data[header]) !== null);
  };
  const exact = ['date', 'ngay', 'ngaytao', 'ngaylap', 'issuedate', 'duedate', 'createdate'];
  for (const key of exact) {
    if (map[key] && usable(map[key])) return map[key];
  }
  const tokens = ['date', 'ngay', 'thang', 'issue', 'due', 'created', 'time'];
  for (const [key, header] of Object.entries(map)) {
    if (tokens.some((t) => key.includes(t)) && usable(header)) return header;
  }
  return null;
}

function inferBillColumn(headers) {
  const map = {};
  for (const h of headers) {
    const key = foldHeader(h);
    if (key) map[key] = h;
  }
  const exact = ['tong', 'tongtien', 'tongcong', 'thanhtien', 'total', 'bill', 'sotien', 'sotienphaitra', 'tienphaitra', 'canthanhtoan', 'congno'];
  for (const key of exact) if (map[key]) return map[key];
  const tokens = ['tong', 'total', 'bill', 'thanhtien', 'phaitra', 'canthanhtoan', 'congno'];
  for (const [key, header] of Object.entries(map)) {
    if (tokens.some((t) => key.includes(t))) return header;
  }
  return null;
}

function parseDateCell(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const valid = (d) => (d instanceof Date && !isNaN(d.getTime()) ? d : null);
  // dd/mm/yyyy by default (Vietnamese). Fall back to mm/dd/yyyy only when the first
  // number cannot be a day, instead of silently rolling the month over.
  let m = text.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = Number(m[3]);
    let day = a;
    let month = b;
    if (a > 12 && b <= 12) {
      day = a;
      month = b;
    } else if (b > 12 && a <= 12) {
      day = b;
      month = a;
    }
    if (month < 1 || month > 12) return null;
    return valid(new Date(year, month - 1, day));
  }
  m = text.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return valid(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // A bare number is a Google Sheets serial date (days since 1899-12-30), NOT a year.
  // V8's Date parser would otherwise read "45939" as year 45939 (a real bug we hit).
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial >= 20000 && serial <= 80000) {
      return valid(new Date(Date.UTC(1899, 11, 30) + serial * 86400000));
    }
    return null;
  }
  // Only fall back to the Date parser when the text really carries a 4-digit year,
  // otherwise fragments like "2/9" become 2001-02-09 and create a bogus bucket.
  if (!/\d{4}/.test(text)) return null;
  return valid(new Date(text));
}

// Vietnamese sheets write thousands separators as dots ("8.119.200 đ") and may use a
// comma as the decimal separator ("1234,56"). The previous logic returned NaN (-> 0)
// for dotted thousands and turned "150.000 đ" into 150, so every report total was wrong.
function extractNumber(value) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const cleaned = text.replace(/[^0-9.,\-]/g, '');
  if (!cleaned) return 0;
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');
  const groupedThousands = (sep) => {
    const parts = cleaned.split(sep);
    return parts.length > 2 || (parts.length === 2 && parts[1] !== '' && parts[1].length === 3);
  };
  let numericStr;
  if (hasComma && hasDot) {
    numericStr = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? cleaned.replace(/\./g, '').replace(/,/g, '.')
      : cleaned.replace(/,/g, '');
  } else if (hasComma) {
    numericStr = groupedThousands(',') ? cleaned.replace(/,/g, '') : cleaned.replace(/,/g, '.');
  } else if (hasDot) {
    numericStr = groupedThousands('.') ? cleaned.replace(/\./g, '') : cleaned;
  } else {
    numericStr = cleaned;
  }
  const parsed = Number(numericStr);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildRowRecords(values, headerRowIndex, dataStartRowIndex) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const headerIdx = (headerRowIndex || 1) - 1;
  const dataStartIdx = (dataStartRowIndex || 2) - 1;
  if (headerIdx >= values.length) return [];
  const headers = (values[headerIdx] || []).map((h) => String(h || '').trim());
  const records = [];
  for (let offset = dataStartIdx; offset < values.length; offset += 1) {
    const row = values[offset] || [];
    const padded = row.map((cell) => String(cell ?? ''));
    while (padded.length < headers.length) padded.push('');
    const data = {};
    headers.forEach((header, index) => {
      data[header] = padded[index] ?? '';
    });
    if (!Object.values(data).some((v) => String(v || '').trim())) continue;
    records.push({ sheet_row: offset + 1, data });
  }
  return records;
}

function computeKPI(records, billColumn) {
  const count = records.length;
  if (!billColumn || count === 0) {
    return { count, total: 0, average: 0, min: 0, max: 0 };
  }
  const amounts = records.map((r) => extractNumber(r.data[billColumn]));
  const total = amounts.reduce((a, b) => a + b, 0);
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  const average = total / count;
  return { count, total, average, min, max };
}

function monthlyRevenue(records, dateColumn, billColumn, year) {
  if (!dateColumn || !billColumn) return [];
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    label: `Month ${i + 1}`,
    total: 0,
    count: 0
  }));
  for (const r of records) {
    const d = parseDateCell(r.data[dateColumn]);
    if (!d || d.getFullYear() !== year) continue;
    const m = d.getMonth();
    const val = extractNumber(r.data[billColumn]);
    months[m].total += val;
    months[m].count += 1;
  }
  return months;
}

function yearlyRevenue(records, dateColumn, billColumn) {
  if (!dateColumn || !billColumn) return [];
  const map = {};
  for (const r of records) {
    const d = parseDateCell(r.data[dateColumn]);
    if (!d) continue;
    const y = d.getFullYear();
    if (!map[y]) map[y] = { year: y, total: 0, count: 0 };
    const val = extractNumber(r.data[billColumn]);
    map[y].total += val;
    map[y].count += 1;
  }
  return Object.values(map).sort((a, b) => a.year - b.year);
}

function dailyTrend(records, dateColumn, billColumn, year, month = null) {
  if (!dateColumn || !billColumn) return [];
  const map = {};
  for (const r of records) {
    const d = parseDateCell(r.data[dateColumn]);
    if (!d) continue;
    if (d.getFullYear() !== year) continue;
    if (month !== null && d.getMonth() !== month) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!map[key]) map[key] = { date: key, total: 0, count: 0 };
    const val = extractNumber(r.data[billColumn]);
    map[key].total += val;
    map[key].count += 1;
  }
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

function filterByDate(records, dateColumn, year, month = null) {
  return records.filter((r) => {
    const d = parseDateCell(r.data[dateColumn]);
    if (!d) return false;
    if (d.getFullYear() !== year) return false;
    if (month !== null && d.getMonth() !== month) return false;
    return true;
  });
}

async function generateReport(profile, options = {}) {
  const { sheets } = await createGoogleClients(profile);
  const values = await readSheetValues(sheets, profile);
  const records = buildRowRecords(
    values,
    profile.header_row_index,
    profile.data_start_row_index
  );

  if (!records.length) {
    return {
      type: options.type || 'report',
      headers: [],
      rows: [],
      count: 0,
      total: 0,
      bill_column: null,
      date_column: null,
      kpi: { count: 0, total: 0, average: 0, min: 0, max: 0 },
      monthly: [],
      yearly: [],
      daily_trend: [],
      note: 'No data found.'
    };
  }

  const headers = Object.keys(records[0].data || {});
  const dateColumn = inferDateColumn(headers, records);
  const billColumn = inferBillColumn(headers);

  let filtered = records;
  let note = '';
  const now = new Date();

  if (options.type === 'month') {
    if (dateColumn) {
      filtered = filterByDate(records, dateColumn, now.getFullYear(), now.getMonth());
      note = `Showing rows where "${dateColumn}" is in ${now.getMonth() + 1}/${now.getFullYear()}`;
    } else {
      note = 'No date column detected. Showing all rows.';
    }
  } else if (options.type === 'year') {
    if (dateColumn) {
      filtered = filterByDate(records, dateColumn, now.getFullYear());
      note = `Showing rows where "${dateColumn}" is in ${now.getFullYear()}`;
    } else {
      note = 'No date column detected. Showing all rows.';
    }
  } else if (options.type === 'selected' && Array.isArray(options.selectedRows)) {
    const set = new Set(options.selectedRows);
    filtered = records.filter((r) => set.has(Number(r.sheet_row)));
    note = `Showing ${filtered.length} selected row(s)`;
  }

  const kpi = computeKPI(filtered, billColumn);
  const monthly = monthlyRevenue(records, dateColumn, billColumn, now.getFullYear());
  const yearly = yearlyRevenue(records, dateColumn, billColumn);
  const daily = dailyTrend(filtered, dateColumn, billColumn, now.getFullYear(),
    options.type === 'month' ? now.getMonth() : null);

  return {
    type: options.type || 'report',
    headers,
    rows: filtered.map((r) => ({ sheet_row: r.sheet_row, data: r.data })),
    count: kpi.count,
    total: kpi.total,
    bill_column: billColumn,
    date_column: dateColumn,
    kpi,
    monthly,
    yearly,
    daily_trend: daily,
    note
  };
}

module.exports = { generateReport };
