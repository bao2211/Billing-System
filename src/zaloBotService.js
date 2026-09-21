// Zalo Bot Platform - httptransport for https://bot-api.zaloplatforms.com/bot<TOKEN>/<method>
//
// This module is intentionally dependency-free (no require of zaloService) so that
// zaloService can use it without a require cycle.
//
// Docs: https://docs.zaloplatforms.com/docs/BOT/call_api
// Envelope: { ok: true|false, result: ..., description: ..., error_code: n }
//
// Deliberate difference from the OA/ZNS API the app also supports: the Bot Platform
// addresses a recipient by chat_id, NOT by phone number. A chat_id only exists after
// the tenant has messaged the bot, so see zaloSubscriberStore.js for the phone map.
const BOT_API_BASE = 'https://bot-api.zaloplatforms.com';

// getUpdates long-polls and answers HTTP 200 { ok:false, error_code:408 } when nothing
// arrived inside the window. That is "no news", not a failure.
const BOT_NO_UPDATES_CODE = 408;

const BOT_METHODS = [
  'getMe',
  'getUpdates',
  'setWebhook',
  'testWebhook',
  'deleteWebhook',
  'getWebhookInfo',
  'sendMessage',
  'sendPhoto',
  'sendSticker',
  'sendVoice',
  'sendChatAction'
];

class BotApiError extends Error {
  constructor(method, errorCode, description, status) {
    super(`Zalo Bot ${method} failed (error_code ${errorCode}${status ? `, HTTP ${status}` : ''}): ${description || 'unknown error'}`);
    this.name = 'BotApiError';
    this.method = method;
    this.error_code = errorCode;
    this.status = status;
    this.description = description || '';
  }
}

function botApiUrl(token, method) {
  const clean = String(token || '').trim();
  if (!clean) throw new Error('A Zalo bot token is required.');
  if (!/^[A-Za-z0-9._:-]{8,256}$/.test(clean)) {
    throw new Error('That does not look like a Zalo bot token (expected <id>:<secret>).');
  }
  const fn = String(method || '').trim();
  if (!BOT_METHODS.includes(fn)) {
    throw new Error(`Unsupported Zalo bot method: ${fn || '(empty)'}`);
  }
  return `${BOT_API_BASE}/bot${clean}/${fn}`;
}

// Only ever shown in logs / the admin UI.
function maskBotToken(token) {
  const value = String(token || '');
  if (!value) return '';
  if (value.length <= 12) return '*'.repeat(value.length);
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

// POST JSON and unwrap the { ok, result, description, error_code } envelope.
// `tolerate` lists error codes that are returned as data instead of thrown.
async function callBotApi(token, method, params = {}, options = {}) {
  const url = botApiUrl(token, method);
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs) || 20000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = 0;
  let json = null;
  let text = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(params || {}),
      signal: controller.signal
    });
    status = res.status;
    text = await res.text();
    try {
      json = JSON.parse(text);
    } catch (error) {
      json = null;
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new BotApiError(method, 'timeout', `no answer within ${timeoutMs} ms`, 0);
    }
    throw new BotApiError(method, 'network', String(error.message || error), 0);
  } finally {
    clearTimeout(timer);
  }

  if (!json) {
    throw new BotApiError(method, 'bad_response', `HTTP ${status}: ${String(text).slice(0, 200)}`, status);
  }
  const errorCode = Number(json.error_code);
  const tolerate = Array.isArray(options.tolerate) ? options.tolerate : [];
  if (json.ok !== true && !tolerate.includes(errorCode)) {
    throw new BotApiError(method, Number.isFinite(errorCode) ? errorCode : 'unknown', json.description, status);
  }
  return { ok: json.ok === true, result: json.result, description: json.description, error_code: errorCode, status };
}

// -- Method wrappers ------------------------------------------------------

// Validates the token and returns the bot profile:
// { id, account_name, account_type, can_join_groups, display_name }
async function getBotMe(token, options = {}) {
  const res = await callBotApi(token, 'getMe', {}, options);
  return res.result || {};
}

// Flatten whatever container getUpdates uses for its list of updates.
function normalizeBotUpdates(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.updates)) return result.updates;
  if (Array.isArray(result.messages)) return result.messages;
  if (result.message || result.event_name) return [result];
  return [];
}

// One update -> a flat, well-known shape. The Bot Platform payload carries the
// message under `message` with `from` / `chat` objects (see the Webhook docs).
function normalizeBotUpdate(raw = {}) {
  const message = raw.message && typeof raw.message === 'object' ? raw.message : raw;
  const from = message.from && typeof message.from === 'object' ? message.from : {};
  const chat = message.chat && typeof message.chat === 'object' ? message.chat : {};
  const chatId = String(chat.id || from.id || '').trim();
  return {
    event_name: String(raw.event_name || ''),
    chat_id: chatId,
    chat_type: String(chat.chat_type || ''),
    from_id: String(from.id || ''),
    from_name: String(from.display_name || ''),
    from_is_bot: from.is_bot === true,
    text: String(message.text == null ? '' : message.text),
    caption: String(message.caption == null ? '' : message.caption),
    photo: String(message.photo == null ? '' : message.photo),
    voice_url: String(message.voice_url == null ? '' : message.voice_url),
    sticker: String(message.sticker == null ? '' : message.sticker),
    message_id: String(message.message_id || ''),
    date: Number(message.date) || 0
  };
}

// Returns { updates: [...], timedOut: bool }. A long-poll that found nothing is
// reported as timedOut instead of throwing, so pollers stay quiet.
async function getBotUpdates(token, options = {}) {
  const timeoutSeconds = options.timeout === undefined ? 10 : Number(options.timeout);
  const params = { timeout: String(Number.isFinite(timeoutSeconds) ? timeoutSeconds : 10) };
  const res = await callBotApi(token, 'getUpdates', params, {
    timeoutMs: options.timeoutMs || (Math.max(1, timeoutSeconds) + 15) * 1000,
    tolerate: [BOT_NO_UPDATES_CODE]
  });
  if (res.ok !== true) {
    return { updates: [], timedOut: true, description: res.description || 'Request timeout' };
  }
  return { updates: normalizeBotUpdates(res.result).map(normalizeBotUpdate), timedOut: false };
}

// chat_id + text (1..2000 chars). Returns { message_id, date }.
async function sendBotMessage(token, options = {}) {
  const { chatId, text, parseMode, textStyles } = options;
  const id = String(chatId || '').trim();
  if (!id) throw new Error('A chat_id is required to send a Zalo bot message.');
  const body = String(text == null ? '' : text);
  if (!body.trim()) throw new Error('Refusing to send an empty Zalo bot message.');
  const params = { chat_id: id, text: body.slice(0, 2000) };
  if (parseMode) params.parse_mode = String(parseMode);
  if (Array.isArray(textStyles) && textStyles.length) params.text_styles = textStyles;
  const res = await callBotApi(token, 'sendMessage', params, { timeoutMs: options.timeoutMs || 20000 });
  const result = res.result || {};
  return { message_id: result.message_id, date: result.date, text: params.text };
}

// photo must be a public image URL (the Drive webContentLink works for images).
async function sendBotPhoto(token, options = {}) {
  const { chatId, photo, caption } = options;
  const id = String(chatId || '').trim();
  const url = String(photo || '').trim();
  if (!id) throw new Error('A chat_id is required to send a Zalo bot photo.');
  if (!url) throw new Error('A photo URL is required to send a Zalo bot photo.');
  const params = { chat_id: id, photo: url };
  if (caption) params.caption = String(caption).slice(0, 2000);
  const res = await callBotApi(token, 'sendPhoto', params, { timeoutMs: options.timeoutMs || 30000 });
  const result = res.result || {};
  return { message_id: result.message_id, date: result.date };
}

// Webhooks need a publicly reachable HTTPS URL (localhost is rejected), which is why
// polling is the default transport for this app. These wrappers exist so a tunnel
// deployment can switch over without code changes.
async function setBotWebhook(token, options = {}) {
  const url = String(options.url || '').trim();
  const secretToken = String(options.secretToken || '').trim();
  if (!/^https:\/\//i.test(url)) throw new Error('The webhook URL must use HTTPS (Zalo rejects localhost and private IPs).');
  if (secretToken.length < 8 || secretToken.length > 256) {
    throw new Error('secret_token must be 8 to 256 characters long.');
  }
  const res = await callBotApi(token, 'setWebhook', { url, secret_token: secretToken }, { timeoutMs: 25000 });
  return res.result || {};
}

async function deleteBotWebhook(token, options = {}) {
  const res = await callBotApi(token, 'deleteWebhook', {}, options);
  return res.result || {};
}

async function getBotWebhookInfo(token, options = {}) {
  const res = await callBotApi(token, 'getWebhookInfo', {}, options);
  return res.result || {};
}

module.exports = {
  // constants + transport
  BOT_API_BASE,
  BOT_NO_UPDATES_CODE,
  BOT_METHODS,
  BotApiError,
  botApiUrl,
  maskBotToken,
  callBotApi,
  // method wrappers
  getBotMe,
  normalizeBotUpdates,
  normalizeBotUpdate,
  getBotUpdates,
  sendBotMessage,
  sendBotPhoto,
  setBotWebhook,
  deleteBotWebhook,
  getBotWebhookInfo
};

