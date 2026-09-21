const fs = require('fs');
const path = require('path');

const { countLinked } = require('./zaloSubscriberStore');

// Global Zalo configuration. Lives outside profiles/*.json because the OA access
// token is company-wide, and it is NOT committed to git (see .gitignore).
const CONFIG_PATH = path.resolve(__dirname, '..', 'zalo_config.json');

const DEFAULTS = {
  // 'oa'  = Zalo Official Account / ZNS template messages addressed by phone number
  // 'bot' = Zalo Bot Platform chat messages addressed by chat_id (see zaloSubscriberStore)
  provider: 'oa',
  access_token: '',
  refresh_token: '',
  expires_at: 0,
  app_id: '',
  secret_key: '',
  oa_id: '',
  dry_run: true,
  rate_limit_ms: 1200,
  // ---- Zalo Bot Platform (https://docs.zaloplatforms.com/docs/BOT) ----
  bot_token: '',
  bot_account_name: '',
  bot_display_name: '',
  bot_account_type: '',
  bot_can_join_groups: false,
  bot_share_link: '',
  bot_verified_at: 0,
  bot_webhook_secret: '',
  bot_auto_reply: true,
  bot_poll_ms: 15000,
  bot_last_poll_at: 0,
  bot_last_poll_error: ''
};

function ensureConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), 'utf-8');
  }
}

function loadZaloConfig() {
  ensureConfig();
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (error) {
    raw = {};
  }
  return { ...DEFAULTS, ...(raw || {}) };
}

function saveZaloConfig(partial) {
  ensureConfig();
  const merged = { ...loadZaloConfig(), ...(partial || {}) };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

function maskToken(token) {
  const value = String(token || '');
  if (!value) return '';
  if (value.length <= 10) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

// Shared by both providers so the admin panel can show one status line.
function providerLabel(config) {
  return config.provider === 'bot' ? 'Zalo Bot Platform' : 'Zalo Official Account';
}

// Never return a raw token to the browser - only enough to know it is set.
function publicZaloConfig() {
  const config = loadZaloConfig();
  const provider = config.provider === 'bot' ? 'bot' : 'oa';
  return {
    provider,
    provider_label: providerLabel(config),
    dry_run: config.dry_run !== false,
    // ---- OA / ZNS ----
    has_token: Boolean(config.access_token),
    token_preview: maskToken(config.access_token),
    token_expires_at: config.expires_at || 0,
    token_expired: isTokenExpired(config),
    has_refresh: Boolean(config.refresh_token && config.app_id && config.secret_key),
    oa_id: config.oa_id || '',
    // ---- Zalo Bot Platform ----
    has_bot_token: Boolean(config.bot_token),
    bot_token_preview: maskToken(config.bot_token),
    bot_account_name: config.bot_account_name || '',
    bot_display_name: config.bot_display_name || '',
    bot_account_type: config.bot_account_type || '',
    bot_can_join_groups: config.bot_can_join_groups === true,
    bot_share_link: config.bot_share_link || '',
    bot_verified_at: Number(config.bot_verified_at) || 0,
    bot_auto_reply: config.bot_auto_reply !== false,
    bot_poll_ms: Number(config.bot_poll_ms) || DEFAULTS.bot_poll_ms,
    bot_last_poll_at: Number(config.bot_last_poll_at) || 0,
    bot_last_poll_error: config.bot_last_poll_error || '',
    linked_chats: countLinked(),
    // ---- shared ----
    rate_limit_ms: Number(config.rate_limit_ms) || DEFAULTS.rate_limit_ms
  };
}

function isTokenExpired(config) {
  const expiresAt = Number((config || {}).expires_at || 0);
  if (!expiresAt) return false; // unknown expiry: let Zalo answer
  return Date.now() > expiresAt - 60 * 1000;
}

// ---------- Notification ledger ----------
// Audit log + idempotency: one bill per profile/row/month is sent once, unless the
// profile asks for resends. Phone numbers are only stored masked (PII).
const LEDGER_PATH = path.resolve(__dirname, '..', 'notifications.json');
const LEDGER_LIMIT = 2000;

function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    return [];
  }
}

function appendNotification(entry) {
  const list = loadLedger();
  list.push(entry);
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(list.slice(-LEDGER_LIMIT), null, 2), 'utf-8');
  return entry;
}

function findNotification(trackingId) {
  if (!trackingId) return null;
  const list = loadLedger();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].tracking_id === trackingId) return list[i];
  }
  return null;
}

function listNotifications(options = {}) {
  const profile = String(options.profile || '').trim();
  const limit = Number(options.limit) || 50;
  let list = loadLedger();
  if (profile) list = list.filter((item) => item.profile === profile);
  return list.slice(-limit).reverse();
}

module.exports = {
  CONFIG_PATH,
  LEDGER_PATH: path.resolve(__dirname, '..', 'notifications.json'),
  loadZaloConfig,
  saveZaloConfig,
  publicZaloConfig,
  providerLabel,
  isTokenExpired,
  maskToken,
  loadLedger,
  appendNotification,
  findNotification,
  listNotifications,
  DEFAULTS
};
