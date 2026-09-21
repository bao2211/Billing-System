const fs = require('fs');
const path = require('path');

// Phone -> Zalo chat binding for the Zalo *Bot* provider.
//
// The Bot Platform API cannot address a recipient by phone number: it sends to a
// chat_id, which only exists once the tenant has messaged the bot at least once.
// So the bot onboarding flow collects (chat_id, phone) pairs here and every bill
// is routed phone -> chat_id through this file.
//
// This file holds REAL phone numbers (unlike notifications.json, which stores them
// masked), so it is gitignored and never leaves the machine.
const SUBSCRIBERS_PATH = path.resolve(__dirname, '..', 'zalo_subscribers.json');

const EMPTY = { last_update_seen: [], subscribers: [] };

function ensureStore() {
  if (!fs.existsSync(SUBSCRIBERS_PATH)) {
    fs.writeFileSync(SUBSCRIBERS_PATH, JSON.stringify(EMPTY, null, 2), 'utf-8');
  }
}

function loadStore() {
  ensureStore();
  try {
    const raw = JSON.parse(fs.readFileSync(SUBSCRIBERS_PATH, 'utf-8'));
    return {
      last_update_seen: Array.isArray(raw.last_update_seen) ? raw.last_update_seen : [],
      subscribers: Array.isArray(raw.subscribers) ? raw.subscribers : []
    };
  } catch (error) {
    return { last_update_seen: [], subscribers: [] };
  }
}

function saveStore(store) {
  ensureStore();
  const next = {
    last_update_seen: (store.last_update_seen || []).slice(-500),
    subscribers: store.subscribers || []
  };
  fs.writeFileSync(SUBSCRIBERS_PATH, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

function listSubscribers() {
  return loadStore().subscribers.slice().sort((a, b) =>
    String(b.linked_at || '').localeCompare(String(a.linked_at || '')));
}

function findByChatId(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  return loadStore().subscribers.find((item) => item.chat_id === id) || null;
}

// A phone may be linked from more than one chat over time (new phone, new Zalo
// account). The most recently linked chat wins.
function findByPhone(phone) {
  const value = String(phone || '').trim();
  if (!value) return null;
  const matches = loadStore().subscribers.filter((item) => item.phone === value);
  if (!matches.length) return null;
  return matches.sort((a, b) => String(b.linked_at || '').localeCompare(String(a.linked_at || '')))[0];
}

function upsertSubscriber(entry = {}) {
  const chatId = String(entry.chat_id || '').trim();
  if (!chatId) throw new Error('chat_id is required.');
  const store = loadStore();
  const now = new Date().toISOString();
  let record = store.subscribers.find((item) => item.chat_id === chatId);
  if (!record) {
    record = {
      chat_id: chatId,
      chat_type: String(entry.chat_type || 'PRIVATE'),
      user_id: String(entry.user_id || chatId),
      display_name: String(entry.display_name || ''),
      phone: '',
      linked_at: '',
      linked_by: '',
      first_seen_at: now,
      last_message_at: now,
      last_text: '',
      message_count: 0
    };
    store.subscribers.push(record);
  }
  record.chat_type = String(entry.chat_type || record.chat_type || 'PRIVATE');
  if (entry.user_id) record.user_id = String(entry.user_id);
  if (entry.display_name) record.display_name = String(entry.display_name);
  if (entry.last_text !== undefined) record.last_text = String(entry.last_text).slice(0, 200);
  if (entry.touch !== false) {
    record.last_message_at = now;
    record.message_count = Number(record.message_count || 0) + 1;
  }
  if (entry.phone) {
    record.phone = String(entry.phone).trim();
    record.linked_at = record.linked_at || now;
    record.linked_by = String(entry.linked_by || 'self');
  } else if (entry.linked_by && !record.linked_at) {
    record.linked_at = now;
    record.linked_by = String(entry.linked_by);
  }
  saveStore(store);
  return record;
}

function setSubscriberPhone(chatId, phone, linkedBy = 'admin') {
  return upsertSubscriber({ chat_id: chatId, phone, linked_by: linkedBy, touch: false });
}

function unlinkSubscriberPhone(chatId) {
  const store = loadStore();
  const record = store.subscribers.find((item) => item.chat_id === String(chatId || '').trim());
  if (!record) return null;
  record.phone = '';
  record.linked_at = '';
  record.linked_by = '';
  saveStore(store);
  return record;
}

function deleteSubscriber(chatId) {
  const id = String(chatId || '').trim();
  const store = loadStore();
  const before = store.subscribers.length;
  store.subscribers = store.subscribers.filter((item) => item.chat_id !== id);
  store.last_update_seen = store.last_update_seen.filter((key) => !String(key).startsWith(`${id}:`));
  saveStore(store);
  return store.subscribers.length < before;
}

// -- Polling dedupe -------------------------------------------------------
// getUpdates replays whatever it still holds, and the Bot Platform gives no
// update_id, so message_id is used as the identity of an already-handled event.
function makeSeenKey(chatId, messageId) {
  return `${String(chatId || '')}:${String(messageId || '')}`;
}

function hasSeenUpdate(chatId, messageId) {
  if (!messageId) return false;
  return loadStore().last_update_seen.includes(makeSeenKey(chatId, messageId));
}

function rememberUpdate(chatId, messageId) {
  if (!messageId) return;
  const store = loadStore();
  const key = makeSeenKey(chatId, messageId);
  if (!store.last_update_seen.includes(key)) store.last_update_seen.push(key);
  saveStore(store);
}

function countLinked() {
  return loadStore().subscribers.filter((item) => Boolean(item.phone)).length;
}

// Never leak a raw phone to the browser: the admin list shows a masked value.
function maskPhone(phone) {
  const value = String(phone || '');
  if (value.length < 6) return value ? '*'.repeat(value.length) : '';
  return `${value.slice(0, 4)}****${value.slice(-2)}`;
}

function publicSubscriber(record) {
  return {
    chat_id: record.chat_id,
    chat_type: record.chat_type,
    display_name: record.display_name,
    phone_masked: maskPhone(record.phone),
    linked: Boolean(record.phone),
    linked_at: record.linked_at,
    linked_by: record.linked_by,
    first_seen_at: record.first_seen_at,
    last_message_at: record.last_message_at,
    message_count: Number(record.message_count || 0)
  };
}

module.exports = {
  SUBSCRIBERS_PATH,
  loadStore,
  saveStore,
  listSubscribers,
  findByChatId,
  findByPhone,
  upsertSubscriber,
  setSubscriberPhone,
  unlinkSubscriberPhone,
  deleteSubscriber,
  makeSeenKey,
  hasSeenUpdate,
  rememberUpdate,
  countLinked,
  maskPhone,
  publicSubscriber
};
