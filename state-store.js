/**
 * state-store.js — Centralized shared state
 * Semua in-memory state yang dipakai oleh multiple modules.
 * Modules cukup require('./state-store') untuk akses shared state.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const DATA_DIR  = path.join(__dirname, 'data');
const MSG_FILE  = path.join(DATA_DIR, 'messages.json');
const SET_FILE  = path.join(DATA_DIR, 'settings.json');
const ORDER_FILE = path.join(DATA_DIR, 'orders.json');
const ESC_FILE  = path.join(DATA_DIR, 'escalations.json');
const ORDER_STATE_FILE = path.join(__dirname, 'orderStates.json');
const RAW_CAP_FILE = path.join(DATA_DIR, 'test-raw-captures.json');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const AUDIO_DIR  = path.join(DATA_DIR, 'audio');

[DATA_DIR, IMAGES_DIR, AUDIO_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const DEFAULT_COURIER_PRIORITY = (process.env.COURIER_PRIORITY || 'J&T,iDexpress,JNE')
  .split(',').map(s => s.trim()).filter(Boolean);

const DEF = {
  autoReply: true,
  channel: 'cloudapi',
  persona: 'Kamu adalah asisten CS toko online yang ramah, sopan, dan helpful.',
  language: 'Indonesia',
  tone: 'Santai',
  opHours: { enabled: false, start: '08:00', end: '17:00' },
  whitelist: [],
  knowledgeBase: '',
  followUp: '',
  modelName: 'gemini-3.1-flash-lite',
  temperature: 0.7,
  adminNumber: process.env.ADMIN_WHATSAPP_NUMBER || '',
  debounceSeconds: 10,
  replyDelayMin: 10,
  replyDelayMax: 15,
  productImages: {},
  courierPriority: DEFAULT_COURIER_PRIORITY,
  stoppedChats: [],
};

// ── Load persisted state from files ──
let settings = { ...DEF };
let messages  = [];
let orders    = [];
let pendingEscalations = [];
let escalationCounter  = 1;

try { if (fs.existsSync(SET_FILE)) settings = { ...DEF, ...JSON.parse(fs.readFileSync(SET_FILE, 'utf8')) }; } catch(e) {}
try { if (fs.existsSync(MSG_FILE)) messages  = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8')); } catch(e) {}
try { if (fs.existsSync(ORDER_FILE)) orders  = JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8')); } catch(e) {}
try {
  if (fs.existsSync(ESC_FILE)) {
    const raw = JSON.parse(fs.readFileSync(ESC_FILE, 'utf8'));
    pendingEscalations = raw.items || [];
    escalationCounter  = raw.counter || 1;
  }
} catch(e) {}

// ── In-memory Maps & state ──
const orderStates = new Map();
const activeClaims = new Map();
const pendingBuffers = new Map();
const userLocks = new Map();
const activeProcessing = new Map();
const sentProductImages = new Map();
const processedWamids = [];
const processedWamidsSet = new Set();

// ── Test mode state ──
const testRawCaptures = [];
let _rawCaptureId = 0;
try {
  if (fs.existsSync(RAW_CAP_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(RAW_CAP_FILE, 'utf8'));
    testRawCaptures.push(...loaded);
    _rawCaptureId = testRawCaptures.length ? testRawCaptures[testRawCaptures.length - 1].id : 0;
  }
} catch(e) {}
const testTurns = [];
const TEST_PHONE = 'test_internal_0000';
let _capturedGeminiRequest = null;
let _capturedGeminiResponse = null;
let _prevTestStep = null;

// ── File paths (exported for modules) ──
const PATHS = { DATA_DIR, MSG_FILE, SET_FILE, ORDER_FILE, ESC_FILE, ORDER_STATE_FILE, RAW_CAP_FILE, IMAGES_DIR, AUDIO_DIR };

// ── DB Sync Helpers ──
const db = require('./db');
async function persistMessageToDB(msg) {
  if (!msg) return;
  try {
    await db.saveMessage(msg);
    const waId = msg.wa_id || msg.from;
    if (waId) await db.upsertContact(waId, msg.sender_name || msg.senderName || 'Unknown');
  } catch(e) { console.error('DB Msg Error:', e.message); }
}
async function persistOrderToDB(order) {
  if (!order) return;
  try { await db.saveOrder(order); } catch(e) { console.error('DB Order Error:', e.message); }
}

// ── File save helper (non-blocking) ──
const save = (file, data) => {
  try {
    const json = JSON.stringify(data, null, 2);
    fs.writeFile(file, json, (err) => {
      if (err) {
        console.error(`Gagal menyimpan file ${path.basename(file)}:`, err.message);
        try { io?.emit('save_error', { file: path.basename(file), error: err.message }); } catch(e2) {}
      }
    });
  } catch(e) {
    console.error(`Gagal menyimpan file ${path.basename(file)}:`, e.message);
  }
};
const saveEscalations = () => save(ESC_FILE, { counter: escalationCounter, items: pendingEscalations });

// io will be set after server initializes Socket.io
let io = null;
function setIo(socketIo) { io = socketIo; }

module.exports = {
  // Defaults
  DEF, DEFAULT_COURIER_PRIORITY,
  // Paths
  PATHS,
  // Mutable state
  get settings() { return settings; },
  set settings(v) { settings = v; },
  get messages() { return messages; },
  set messages(v) { messages = v; },
  get orders() { return orders; },
  set orders(v) { orders = v; },
  get pendingEscalations() { return pendingEscalations; },
  set pendingEscalations(v) { pendingEscalations = v; },
  get escalationCounter() { return escalationCounter; },
  set escalationCounter(v) { escalationCounter = v; },
  // Maps
  orderStates, activeClaims, pendingBuffers, userLocks, activeProcessing, sentProductImages,
  // Dedup
  processedWamids, processedWamidsSet,
  // Test mode
  testRawCaptures, testTurns, TEST_PHONE,
  get _rawCaptureId() { return _rawCaptureId; },
  set _rawCaptureId(v) { _rawCaptureId = v; },
  get _capturedGeminiRequest() { return _capturedGeminiRequest; },
  set _capturedGeminiRequest(v) { _capturedGeminiRequest = v; },
  get _capturedGeminiResponse() { return _capturedGeminiResponse; },
  set _capturedGeminiResponse(v) { _capturedGeminiResponse = v; },
  get _prevTestStep() { return _prevTestStep; },
  set _prevTestStep(v) { _prevTestStep = v; },
  // Helpers
  save, saveEscalations, persistMessageToDB, persistOrderToDB,
  // Socket.io
  get io() { return io; },
  setIo,
};
