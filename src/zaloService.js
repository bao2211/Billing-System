const fs = require('fs');
const path = require('path');
const { loadZaloConfig, saveZaloConfig, appendNotification, findNotification } = require('./zaloStore');
const {
  sendBotMessage,
  sendBotPhoto,
  getBotUpdates,
  getBotMe
} = require('./zaloBotService');
const {
  findByPhone,
  findByChatId,
  upsertSubscriber,
  hasSeenUpdate,
  rememberUpdate
} = require('./zaloSubscriberStore');

// Zalo Business Solutions - send a template message by phone number (the ZNS successor).
const TEMPLATE_ENDPOINT = 'https://business.openapi.zalo.me/message/template';
const OA_MESSAGE_ENDPOINT = 'https://openapi.zalo.me/v2.0/oa/message';
const OA_TOKEN_ENDPOINT = 'https://oauth.zaloapp.com/v4/oa/access_token';

function foldKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// Vietnamese mobile numbers only - Zalo needs a real Zalo account behind the number.
// Accepts 0987654321, 0987 654 321, +84987654321, 84987654321, 987654321.
function normalizePhone(raw) {
  const original = String(raw == null ? '' : raw).trim();
  if (!original) return { ok: false, reason: 'empty' };
  let digits = original.replace(/\D/g, '');
  if (!digits) return { ok: false, reason: `no digits in "${original}"` };
  if (digits.startsWith('84')) {
    // already country coded
  } else if (digits.startsWith('0')) {
    digits = '84' + digits.slice(1);
  } else if (digits.length === 9) {
    digits = '84' + digits;
  } else {
    return { ok: false, reason: `unrecognised format "${original}"` };
  }
  if (!/^84[235789]\d{8}$/.test(digits)) {
    return { ok: false, reason: `not a valid VN mobile number "${original}"` };
  }
  return { ok: true, phone: digits, e164: `+${digits}` };
}

function maskPhone(phone) {
  const value = String(phone || '');
  if (value.length < 6) return value ? '*'.repeat(value.length) : '';
  return `${value.slice(0, 4)}****${value.slice(-2)}`;
}

function formatDateVN(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Map a sheet row onto the template placeholder names approved by Zalo.
// A value spec may be: a sheet column name, a built-in {{token}}, or a literal string.
function resolveTemplateValue(spec, context) {
  const { profile, record, headers, link, extra } = context;
  const data = record.data || {};
  const text = String(spec == null ? '' : spec);
  if (!text.trim()) return '';
  const trimmed = text.trim();

  if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
    const key = trimmed.slice(2, -2).trim().toLowerCase();
    if (key === 'link') return link || '';
    if (key === 'profile') return String(profile.name || '');
    if (key === 'date') return formatDateVN(new Date());
    if (key === 'sheet_row') return String(record.sheet_row || '');
    if (key === 'period') return String(extra.period || '');
    if (key === 'room') return String(data[extra.room_column] || '');
    if (key === 'bill') return String(data[extra.bill_column] || '');
    if (key === 'phone') return String(data[extra.phone_column] || '');
    return '';
  }

  const exact = headers.find((h) => h === trimmed);
  if (exact) return String(data[exact] ?? '');
  const folded = foldKey(trimmed);
  const match = headers.find((h) => foldKey(h) === folded);
  if (match) return String(data[match] ?? '');
  return trimmed;
}

function buildTemplateData(options = {}) {
  const { profile = {}, record = {}, link = '', extra = {} } = options;
  const headers = Object.keys(record.data || {});
  const map = profile.zalo_field_map && typeof profile.zalo_field_map === 'object' ? profile.zalo_field_map : {};
  const context = { profile, record, headers, link, extra };
  const data = {};
  for (const [key, spec] of Object.entries(map)) {
    if (!key) continue;
    data[key] = resolveTemplateValue(spec, context);
  }
  const linkField = String(profile.zalo_link_field || 'link').trim();
  if (linkField && !data[linkField]) data[linkField] = link || '';
  return data;
}

/* =========================================================================
 * Zalo Bot Platform delivery
 *
 * The Bot API cannot address a phone number - it sends to a chat_id, which only
 * exists after the tenant has messaged the bot once. So a bill is routed
 * phone -> chat_id through zaloSubscribers.json, and the message body is free
 * text (no pre-approved ZNS template to wait for).
 * ========================================================================= */

// Free-text message used when the profile does not define its own. Lines whose
// tokens resolve to nothing are dropped, so a spare sheet never shows "Khách hàng:".
const DEFAULT_BOT_MESSAGE_TEMPLATE = [
  '🧾 HÓA ĐƠN THANH TOÁN',
  'Cơ sở: {{profile}}',
  'Phòng: {{room}}',
  'Khách hàng: {{customer}}',
  'Kỳ: {{period}}',
  'Số tiền: {{total}}',
  'Ngày gửi: {{date}}',
  '',
  'Xem hóa đơn: {{link}}'
].join('\n');

// Tokens that mean something without a matching sheet column.
function resolveMessageTokenName(key) {
  return ['link', 'profile', 'date', 'period', 'sheet_row', 'room', 'bill', 'phone'].includes(key);
}

// Like resolveTemplateValue, but for a {{token}} embedded in a longer message:
// built-ins first, then a sheet column (exact, then accent-folded), else ''.
function resolveMessageToken(key, context) {
  const token = String(key || '').trim();
  if (!token) return '';
  const lower = token.toLowerCase();
  if (resolveMessageTokenName(lower)) return resolveTemplateValue(`{{${lower}}}`, context);

  const { record, headers, extra } = context;
  const data = record.data || {};
  const exact = headers.find((h) => h === token);
  if (exact) return String(data[exact] ?? '');

  const folded = foldKey(token);
  const match = headers.find((h) => foldKey(h) === folded);
  if (match) return String(data[match] ?? '');

  // Friendly aliases for the money column, which is named differently per sheet.
  if (['total', 'amount', 'sotien', 'tong', 'tongcong', 'thanhtien'].includes(folded)) {
    const totalHeader = headers.find((h) =>
      ['tongcong', 'tong', 'thanhtien', 'sotien', 'total', 'amount'].includes(foldKey(h)));
    if (totalHeader) return String(data[totalHeader] ?? '');
  }
  return '';
}

// Render the bill message. Kept dependency-free of the export pipeline so it can be
// unit-tested from a plain object.
function buildBotMessage(options = {}) {
  const { profile = {}, record = {}, link = '', extra = {} } = options;
  const headers = Object.keys(record.data || {});
  const context = { profile, record, headers, link, extra };
  const template = String(profile.zalo_bot_message_template || '').trim() || DEFAULT_BOT_MESSAGE_TEMPLATE;

  const lines = template.split(/\r?\n/).map((line) => {
    const hadToken = /\{\{[^}]+\}\}/.test(line);
    const rendered = line.replace(/\{\{([^}]+)\}\}/g, (_match, key) => resolveMessageToken(key, context)).trimEnd();
    if (!rendered.trim()) return hadToken ? null : '';
    // Drop "Nhãn:" lines whose only value resolved to empty.
    if (hadToken && /^\s*[^:]*:\s*$/.test(rendered)) return null;
    return rendered;
  }).filter((line) => line !== null);

  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text || `${profile.name || 'Hóa đơn'}${link ? `\n${link}` : ''}`;
}

// Pull the first Vietnamese mobile number out of a free-text message. Tenants type
// "0934103951", "0934 103 951", "+84 934 103 951" or paste it after other words, so
// every digit run is scanned and re-tried from each plausible start.
function extractPhoneFromText(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return { ok: false, reason: 'empty message' };
  const runs = raw.match(/\+?[\d][\d\s.\-()]{6,22}\d|\+?\d{9,12}/g) || [];
  for (const run of runs) {
    const trimmed = run.trim();
    const digits = trimmed.replace(/\D/g, '');
    const variants = new Set([trimmed, digits]);
    for (let i = 0; i < digits.length; i += 1) {
      if (digits[i] === '0' || digits.startsWith('84', i)) {
        variants.add(digits.slice(i, i + 12));
      }
    }
    for (const candidate of variants) {
      const parsed = normalizePhone(candidate);
      if (parsed.ok) return parsed;
    }
  }
  return { ok: false, reason: 'no Vietnamese mobile number in the message' };
}

// Onboarding copy. Plain text only: the Bot Platform strips unknown markup.
const BOT_GREETINGS = new Set(['start', 'help', 'menu', 'hi', 'hello', 'chao', 'xinchao', 'batdau', 'lienket', 'link', 'ketnoi', 'bot', 'bill', 'hoadon']);

function botHelpText(displayName) {
  const who = displayName ? ` ${displayName}` : '';
  return [
    `👋 Xin chào${who}!`,
    '',
    'Đây là kênh gửi hóa đơn tự động.',
    'Để nhận hóa đơn qua Zalo, bạn hãy gửi SỐ ĐIỆN THOẠI đã đăng ký với ban quản lý.',
    '',
    'Ví dụ: 0934103951'
  ].join('\n');
}

function botLinkedText(masked) {
  return [
    `✅ Đã liên kết số ${masked} với cuộc trò chuyện này.`,
    '',
    'Từ giờ hóa đơn của bạn sẽ được gửi tự động tại đây.'
  ].join('\n');
}

// Zalo Bot Platform is a chat channel, so a bill can only be delivered once the
// tenant has started the conversation. Returns the bot identity for the admin panel.
async function verifyBotToken(token, options = {}) {
  const me = await getBotMe(String(token || '').trim(), options);
  const accountName = String(me.account_name || '');
  return {
    id: String(me.id || ''),
    account_name: accountName,
    display_name: String(me.display_name || ''),
    account_type: String(me.account_type || ''),
    can_join_groups: me.can_join_groups === true,
    share_link: accountName ? `https://zalo.me/${accountName}` : ''
  };
}

function isBotConfigured(config = {}) {
  return Boolean(String(config.bot_token || '').trim());
}

// Handle one incoming bot message: bind a phone when the tenant sends one, otherwise
// answer with instructions. Never throws - the caller is usually a poller.
async function ingestBotUpdate(options = {}) {
  const { update = {}, config = loadZaloConfig(), logger = () => {} } = options;
  const autoReply = options.autoReply !== false && config.bot_auto_reply !== false;
  const outcome = {
    chat_id: update.chat_id || '',
    message_id: update.message_id || '',
    event_name: update.event_name || '',
    display_name: update.from_name || '',
    action: 'ignored',
    phone_masked: '',
    reply_sent: false,
    reply_text: ''
  };
  if (!update.chat_id) {
    outcome.action = 'no_chat_id';
    return outcome;
  }
  if (update.from_is_bot) {
    outcome.action = 'from_bot';
    return outcome;
  }
  if (hasSeenUpdate(update.chat_id, update.message_id)) {
    outcome.action = 'duplicate';
    return outcome;
  }

  const text = update.text || update.caption || '';
  const before = findByChatId(update.chat_id);
  const parsed = extractPhoneFromText(text);

  upsertSubscriber({
    chat_id: update.chat_id,
    chat_type: update.chat_type,
    user_id: update.from_id,
    display_name: update.from_name,
    last_text: text
  });

  let reply = '';
  if (parsed.ok) {
    upsertSubscriber({ chat_id: update.chat_id, phone: parsed.phone, linked_by: 'self', touch: false });
    outcome.action = before && before.phone ? 'relinked' : 'linked';
    outcome.phone_masked = maskPhone(parsed.phone);
    reply = botLinkedText(maskPhone(parsed.phone));
  } else if (BOT_GREETINGS.has(foldKey(text)) || !text.trim()) {
    outcome.action = before && before.phone ? 'greeted_linked' : 'greeted';
    reply = before && before.phone
      ? `👋 Xin chào${update.from_name ? ` ${update.from_name}` : ''}!\n\nSố ${maskPhone(before.phone)} đã được liên kết. Hóa đơn sẽ được gửi tự động tại đây.`
      : botHelpText(update.from_name);
  } else {
    outcome.action = 'needs_phone';
    reply = [
      'Mình chưa tìm thấy số điện thoại trong tin nhắn.',
      '',
      'Vui lòng gửi số điện thoại đã đăng ký với ban quản lý (ví dụ: 0934103951) để nhận hóa đơn.'
    ].join('\n');
  }

  if (reply && autoReply && isBotConfigured(config)) {
    try {
      const sent = await sendBotMessage(config.bot_token, { chatId: update.chat_id, text: reply });
      outcome.reply_sent = true;
      outcome.reply_msg_id = sent.message_id;
    } catch (error) {
      outcome.reply_error = String(error.message || error).slice(0, 200);
      logger(`Zalo bot: could not answer ${update.chat_id} - ${outcome.reply_error}`);
    }
  }
  outcome.reply_text = reply;
  rememberUpdate(update.chat_id, update.message_id);
  logger(`Zalo bot: ${outcome.action} from ${update.chat_id}${outcome.phone_masked ? ` (${outcome.phone_masked})` : ''}`);
  return outcome;
}

// One long-poll round: fetch the pending updates and process each one.
async function pollBotUpdates(options = {}) {
  const config = options.config || loadZaloConfig();
  if (!isBotConfigured(config)) throw new Error('No Zalo bot token configured.');
  const logger = options.logger || (() => {});
  const wait = options.timeout === undefined ? 10 : Number(options.timeout);
  const { updates, timedOut } = await getBotUpdates(config.bot_token, { timeout: wait });
  const results = [];
  for (const update of updates) {
    results.push(await ingestBotUpdate({ update, config, logger, autoReply: options.autoReply }));
  }
  saveZaloConfig({ bot_last_poll_at: Date.now(), bot_last_poll_error: '' });
  if (updates.length) logger(`Zalo bot: ${updates.length} update(s) handled.`);
  return { updates_seen: updates.length, timed_out: Boolean(timedOut), results };
}




function guessMimeType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

async function assertDriveFolder(drive, folderId) {
  const id = String(folderId || '').trim();
  if (!id) {
    throw new Error('zalo_drive_folder_id is not set - create a Drive folder for the bills and paste its id.');
  }
  const res = await drive.files.get({ fileId: id, fields: 'id,name,mimeType', supportsAllDrives: true });
  if (res.data.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error(`Drive id ${id} is not a folder.`);
  }
  return res.data;
}

// Upload the bill to Drive and share it "anyone with the link" so Zalo can show it to
// the customer. The Drive file id is unguessable and the link is only sent to that tenant.
async function uploadBillToDrive(drive, options = {}) {
  const { filePath, folderId, name } = options;
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Bill file not found: ${filePath}`);
  }
  const folder = await assertDriveFolder(drive, folderId);
  const created = await drive.files.create({
    requestBody: { name: name || path.basename(filePath), parents: [folder.id] },
    media: { mimeType: guessMimeType(filePath), body: fs.createReadStream(filePath) },
    fields: 'id,name,webViewLink,webContentLink,size',
    supportsAllDrives: true
  });
  const fileId = created.data.id;
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true
  });
  const meta = await drive.files.get({
    fileId,
    fields: 'id,name,webViewLink,webContentLink,size',
    supportsAllDrives: true
  });
  return {
    id: fileId,
    name: meta.data.name,
    webViewLink: meta.data.webViewLink,
    webContentLink: meta.data.webContentLink,
    size: Number(meta.data.size || 0)
  };
}

async function zaloFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 20000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (error) {
      json = null;
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

// Zalo answers { error: <code>, message: <text> }. The code table lives in Zalo's docs,
// so surface the code and Zalo's own message rather than inventing a translation.
function describeZaloError(errorCode, message) {
  return `Zalo error ${errorCode}: ${String(message || 'unknown error')}`;
}

// dryRun: build the exact payload, log it, never call Zalo.
async function sendTemplateByPhone(options = {}) {
  const { accessToken, phone, templateId, templateData, trackingId, dryRun } = options;
  const payload = {
    phone,
    template_id: templateId,
    template_data: templateData || {},
    tracking_id: trackingId
  };
  if (dryRun) {
    return { ok: true, simulated: true, payload, msg_id: `dryrun-${Date.now().toString(36)}` };
  }
  if (!accessToken) throw new Error('No Zalo OA access token configured.');
  if (!phone) throw new Error('Missing recipient phone number.');
  if (!templateId) throw new Error('Missing Zalo template id.');

  const { status, json, text } = await zaloFetch(TEMPLATE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', access_token: accessToken },
    body: JSON.stringify(payload)
  });
  if (!json) throw new Error(`Zalo returned HTTP ${status}: ${String(text).slice(0, 200)}`);
  if (Number(json.error) !== 0) throw new Error(describeZaloError(json.error, json.message));
  const data = json.data || {};
  return {
    ok: true,
    simulated: false,
    msg_id: data.msg_id,
    sent_time: data.sent_time,
    sending_mode: data.sending_mode,
    quota: data.quota
  };
}

// Optional: renew the OA access token from a refresh token.
// NOTE: confirm the request shape against Zalo's current OA OAuth v4 documentation
// before relying on it - the manual access token path is the supported default.
async function refreshAccessToken(config = {}) {
  const { app_id, secret_key, refresh_token } = config;
  if (!app_id || !secret_key || !refresh_token) {
    throw new Error('Cannot refresh: app_id, secret_key and refresh_token are all required.');
  }
  const body = new URLSearchParams({
    app_id: String(app_id),
    grant_type: 'refresh_token',
    refresh_token: String(refresh_token)
  });
  const { status, json, text } = await zaloFetch(OA_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: String(secret_key) },
    body: body.toString()
  });
  if (!json || json.error) {
    throw new Error(`Zalo token refresh failed (HTTP ${status}): ${String((json && json.error_description) || text).slice(0, 200)}`);
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || refresh_token,
    expires_at: Date.now() + Number(json.expires_in || 90000) * 1000
  };
}

// Stable idempotency key: one bill per profile+row+month (Zalo asks for <= 48 chars).
function makeTrackingId(profileName, sheetRow, period) {
  const safeProfile = foldKey(profileName).slice(0, 18) || 'profile';
  const safePeriod = String(period || '').replace(/[^0-9A-Za-z-]/g, '').slice(0, 10);
  return `bill-${safeProfile}-${sheetRow}-${safePeriod}`.slice(0, 48);
}

// Prefer the PDF (ideal for a link), otherwise the first rendered image.
function pickBillFile(rowSummary = {}) {
  const exports = rowSummary.exports || {};
  if (exports.pdf && fs.existsSync(exports.pdf)) return exports.pdf;
  const images = Array.isArray(exports.images) ? exports.images : [];
  for (const image of images) {
    if (image && fs.existsSync(image)) return image;
  }
  return '';
}

// Orchestrates one bill: phone -> Drive link -> Zalo template message -> ledger.
// Never throws: the outcome is returned (and logged) so an export can always finish.
async function notifyBill(options = {}) {
  const {
    drive,
    profile = {},
    record = {},
    rowSummary = {},
    extra = {},
    zaloConfig = null,
    now = new Date(),
    logger = () => {}
  } = options;
  const config = zaloConfig || loadZaloConfig();
  const entry = {
    profile: profile.name || '',
    sheet_row: Number(record.sheet_row) || null,
    at: new Date().toISOString(),
    status: 'skipped',
    simulated: config.dry_run !== false
  };
  const finish = (status, reason, more) => {
    entry.status = status;
    if (reason) entry.reason = reason;
    if (more) Object.assign(entry, more);
    try {
      appendNotification(entry);
    } catch (error) {
      logger(`Zalo: could not write the notification ledger (${String(error.message || error).slice(0, 120)})`);
    }
    return entry;
  };

  if (!profile.zalo_enabled) return finish('skipped', 'zalo disabled');

  // Two delivery providers: 'oa' sends a pre-approved ZNS template by phone number,
  // 'bot' sends free text to a chat the tenant has already opened with our bot.
  const isBot = config.provider === 'bot';
  entry.provider = isBot ? 'bot' : 'oa';
  if (isBot) {
    if (!isBotConfigured(config)) return finish('skipped', 'no Zalo bot token configured');
  } else if (!profile.zalo_template_id) {
    return finish('skipped', 'no template id configured');
  }
  if (!extra.phone_column) return finish('skipped', 'no phone column detected');

  const parsed = normalizePhone((record.data || {})[extra.phone_column]);
  if (!parsed.ok) return finish('skipped', `phone ${parsed.reason}`);
  entry.phone_masked = maskPhone(parsed.phone); // only the masked value is stored

  // A bot can only message a chat that exists, so the tenant has to have sent their
  // phone number to the bot once. Skip (loudly) instead of failing the export.
  let subscriber = null;
  if (isBot) {
    subscriber = findByPhone(parsed.phone);
    if (!subscriber || !subscriber.chat_id) {
      return finish(
        'skipped',
        'this phone has not linked to the Zalo bot yet - the tenant must send their phone number to the bot once',
        { needs_link: true }
      );
    }
    entry.chat_id = subscriber.chat_id;
  }

  const billFile = pickBillFile(rowSummary);
  if (!billFile) return finish('skipped', 'no bill file was produced for this row');

  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const trackingId = makeTrackingId(profile.name, record.sheet_row, period);
  entry.tracking_id = trackingId;
  entry.template_id = profile.zalo_template_id;
  entry.bill_file = path.basename(billFile);

  const previous = findNotification(trackingId);
  if (previous && previous.status === 'sent' && profile.zalo_resend_already_sent !== true) {
    return finish('skipped', `already sent at ${previous.at}`, { msg_id: previous.msg_id });
  }

  let link = '';
  if (entry.simulated) {
    link = `https://drive.google.com/file/d/DRYRUN-${trackingId}/view`;
    entry.link_simulated = true;
  } else {
    const room = String((record.data || {})[extra.room_column] || '').trim();
    const label = `HoaDon_${profile.name || 'bill'}_${room || 'row' + record.sheet_row}_${period}`
      .replace(/[\\/:*?"<>|]+/g, '-');
    try {
      const uploaded = await uploadBillToDrive(drive, {
        filePath: billFile,
        folderId: profile.zalo_drive_folder_id,
        name: label + path.extname(billFile)
      });
      link = uploaded.webViewLink;
      entry.drive_file_id = uploaded.id;
      entry.drive_content_link = uploaded.webContentLink || '';
      logger(`Zalo: uploaded ${path.basename(billFile)} to Drive (${Math.round(uploaded.size / 1024)} KB)`);
    } catch (error) {
      return finish('failed', `Drive upload failed: ${String(error.message || error).slice(0, 180)}`);
    }
  }
  entry.link = link;

  let result;
  let templateData = null;

  // ---- Provider: Zalo Bot Platform - free text to the chat the tenant opened ----
  if (isBot) {
    const message = buildBotMessage({ profile, record, link, extra: { ...extra, period } });
    entry.message_text = message;
    entry.message_chars = message.length;
    if (entry.simulated) {
      logger(`Zalo: [dry-run] would send a ${message.length}-char bot message to ${entry.phone_masked} (chat ${subscriber.chat_id})`);
      logger(`Zalo: [dry-run] preview: ${message.split('\n').join(' | ').slice(0, 300)}`);
      return finish('simulated', 'dry-run');
    }
    try {
      result = await sendBotMessage(config.bot_token, { chatId: subscriber.chat_id, text: message });
    } catch (error) {
      return finish('failed', String(error.message || error).slice(0, 200));
    }
    entry.msg_id = result.message_id;
    entry.sent_at = result.date || null;
    logger(`Zalo: bot message sent to ${entry.phone_masked} (chat ${subscriber.chat_id})`);

    // Optional attachment: only an image can go through sendPhoto, and the Drive link
    // in the text already opens the receipt, so a failure here stays non-fatal.
    const wantsPhoto = profile.zalo_bot_send_photo !== false;
    if (wantsPhoto && /\.(png|jpe?g)$/i.test(billFile) && entry.drive_content_link) {
      try {
        const photo = await sendBotPhoto(config.bot_token, {
          chatId: subscriber.chat_id,
          photo: entry.drive_content_link,
          caption: `Hóa đơn ${profile.name || ''}`.trim()
        });
        entry.photo_msg_id = photo.message_id;
        logger('Zalo: bill image attached to the message.');
      } catch (error) {
        entry.photo_error = String(error.message || error).slice(0, 160);
        logger(`Zalo: text delivered, but the image attachment failed - ${entry.photo_error}`);
      }
    }
    return finish('sent');
  }

  // ---- Provider: Zalo OA / ZNS - pre-approved template addressed by phone number ----
  templateData = buildTemplateData({ profile, record, link, extra });
  entry.template_data = templateData;

  try {
    result = await sendTemplateByPhone({
      accessToken: config.access_token,
      phone: parsed.phone,
      templateId: profile.zalo_template_id,
      templateData,
      trackingId,
      dryRun: entry.simulated
    });
  } catch (error) {
    return finish('failed', String(error.message || error).slice(0, 200));
  }

  entry.msg_id = result.msg_id;
  entry.quota = result.quota || null;
  if (result.simulated) {
    logger(`Zalo: [dry-run] would send template ${profile.zalo_template_id} to ${entry.phone_masked}`);
    return finish('simulated', 'dry-run');
  }
  return finish('sent');
}

module.exports = {
  TEMPLATE_ENDPOINT,
  OA_MESSAGE_ENDPOINT,
  OA_TOKEN_ENDPOINT,
  DEFAULT_BOT_MESSAGE_TEMPLATE,
  normalizePhone,
  maskPhone,
  // ---- Zalo Bot Platform ----
  buildBotMessage,
  resolveMessageToken,
  extractPhoneFromText,
  verifyBotToken,
  isBotConfigured,
  ingestBotUpdate,
  pollBotUpdates,
  botHelpText,
  botLinkedText,
  BOT_GREETINGS,
  buildTemplateData,
  notifyBill,
  pickBillFile,
  resolveTemplateValue,
  uploadBillToDrive,
  assertDriveFolder,
  sendTemplateByPhone,
  refreshAccessToken,
  makeTrackingId,
  describeZaloError,
  formatDateVN,
  foldKey
};
