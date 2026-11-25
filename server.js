/**
 * COMEDOR UNAB - PRODUCTION SERVER FOR RAILWAY & LOCAL
 * Multi-user Architecture, SuperAdmin Control, Ultra-Low RAM Footprint (< 40MB)
 * Zero external npm dependencies. Native Node.js HTTP & Fetch.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./db');
const { loginInstitution } = require('./institution-login');
const { requestView } = require('./reservation-view');
const { enrollment, admittedStudents, capacityError } = require('./student-capacity');
const { WARMUP_LEAD_MS, REFRESH_LEAD_MS, PUBLICATION_POLL_MS, prepareSessions } = require('./session-preparation');
const { TERMS_VERSION, servicePolicy } = require('./service-policy');
const { MEALS, isPremium, compareQueue, validatePremium, createPremiumService } = require('./premium-service');
const { RequestGate, retryDelay } = require('./upstream-control');
const { createReservationService, mapWithConcurrency } = require('./reservation-service');

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}
const upstreamGate = new RequestGate({
  concurrency: positiveInteger(process.env.UNAB_MAX_CONCURRENCY, 2, 10),
  intervalMs: positiveInteger(process.env.UNAB_REQUEST_INTERVAL_MS, 500, 60000),
  openingConcurrency: positiveInteger(process.env.UNAB_OPENING_CONCURRENCY, 50, 50)
});
const reserveOnce = createReservationService(fetchComedorApi);
const upstreamFailures = new Map();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_VERSION = require('./app-version').applicationVersion(__dirname);

// Active in-memory session tokens: { [token]: { userId, username, role, expiresAt } }
const sessions = new Map();
const sessionKey = token => crypto.createHash('sha256').update(token).digest('hex');

// Server Sent Events (SSE) connections
const sseClients = new Set();

// Clean up expired sessions periodically (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [token, sess] of sessions.entries()) {
    if (sess.expiresAt < now) {
      sessions.delete(token);
    }
  }
  db.saveSessions?.([...sessions]);
}, 10 * 60 * 1000);

// Global Sniper State (Keep timer IDs outside the object to prevent circular JSON serialization errors)
let engineGeneration = 0;
let sentinelGeneration = 0;
let warmupTimerId = null;
let warmupRefreshTimerId = null;
let sniperTimerId = null;
let sniperPollIntervalId = null;
let sentinelIntervalId = null;
let isSniperBurstRunning = false;
let isSentinelRunningTick = false;

const MEAL_CONFIGS = {
  DESAYUNO: {
    nombre: 'Desayuno',
    defaultTargetTime: '06:30:00',
    horaInicio: '06:30:00',
    horaFin: '10:30:00',
    horaReservaInicio: '06:30',
    horaReservaFin: '10:30',
    cutoffH: 10,
    cutoffM: 30
  },
  ALMUERZO: {
    nombre: 'Almuerzo',
    defaultTargetTime: '11:00:00',
    horaInicio: '11:00:00',
    horaFin: '16:00:00',
    horaReservaInicio: '11:00',
    horaReservaFin: '16:00',
    cutoffH: 16,
    cutoffM: 0
  },
  CENA: {
    nombre: 'Cena',
    defaultTargetTime: '17:00:00',
    horaInicio: '17:00:00',
    horaFin: '19:00:00',
    horaReservaInicio: '17:00',
    horaReservaFin: '19:00',
    cutoffH: 19,
    cutoffM: 0
  }
};

const globalSniper = {
  running: false,
  status: 'IDLE', // IDLE, ARMED, RESERVING, SENTINEL, FINISHED
  targetTime: '11:00:00',
  targetDate: getTodayLimaDate(0),
  targetMeal: 'ALMUERZO',
  mode: 'SCHEDULED', // SCHEDULED, SENTINEL
  leadTimeMs: 250,
  lastRunResults: []
};

// Date & Time Helpers (America/Lima UTC-5)
function getLimaDateObj() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
}

function getTodayLimaDate(offsetDays = 0) {
  const d = getLimaDateObj();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getLimaTimeString() {
  const d = getLimaDateObj();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(new Date().getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

function broadcastSSE(event, data) {
  const personal = ['reservation-status-changed', 'advance-reservation-created', 'advance-reservation-cancelled', 'institutional-session-required'].includes(event);
  let owner = data?.student || data?.alumnoCodigo;
  if (personal && !owner && data?.id) {
    const record = db.getAllReservations().find(item => item.id === data.id) ||
      db.getAdvanceReservations().find(item => item.id === data.id);
    owner = record?.alumnoCodigo;
  }
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      if (!client.viewer || !sessions.has(sessionKey(client.viewer.token))) { client.end(); sseClients.delete(client); continue; }
      if (client.viewer.role !== 'superadmin') {
        if (event === 'log' || event === 'sentinel-queue-updated') continue;
        if (personal && owner !== client.viewer.username) continue;
        if (event === 'reservation-batch-finished' && (!Array.isArray(data) || !data.some(item => item.user === client.viewer.username))) continue;
      }
      client.write(client.viewer.role === 'superadmin' ? payload : `event: ${event}\ndata: {}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

function emitLog(message, type = 'info') {
  message = message.replace(/\bUNAB\b/g, 'la institución');
  const entry = db.addAuditLog(message, type);
  console.log(`[${entry.time}] [${type.toUpperCase()}] ${message}`);
  broadcastSSE('log', entry);
}

// Bound slow upstream responses, including their bodies. Retry only reads and login.
async function fetchUnabResponse(url, options = {}, retryable = true) {
  const queuedAt = Date.now();
  try { await db.flush?.(); }
  catch { return { ok: false, status: 503, data: { error: 'No se pudo confirmar la persistencia local.' } }; }
  const attempts = retryable ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await upstreamGate.run(async () => {
        if (options.canProceed && !options.canProceed()) {
          return { ok: false, status: 409, data: { message: 'Solicitud cancelada o fuera de horario.' } };
        }
        if (options.validatePreflight && !options.validatePreflight()) return { ok: false, status: 409, data: { code: 'PREFLIGHT_STALE', message: 'Se requiere verificar nuevamente el ticket antes de enviar.' } };
        const { canProceed, priority, timeoutMs, skipProfile, validatePreflight, onRequestStart, openingBurst, ...fetchOptions } = options;
        const request = fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(timeoutMs || 20000) });
        try { onRequestStart?.({ startedAt: Date.now(), queuedMs: Date.now() - queuedAt }); } catch {}
        const res = await request;
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        const saturation = /muchas reservas simult[aá]neas|demasiadas solicitudes|too many requests/i.test(typeof data?.message === 'string' ? data.message : '');
        if (res.status === 429 || res.status >= 500 || saturation) {
          const host = new URL(url).hostname;
          const failures = upstreamFailures.get(host) || 0;
          upstreamFailures.set(host, Math.min(failures + 1, 5));
          upstreamGate.pause(retryDelay(res.headers.get('retry-after'), failures));
        } else if (res.status === 403) {
          upstreamGate.pause(60000);
        } else if (res.ok) {
          upstreamFailures.delete(new URL(url).hostname);
        }
        return { ok: res.ok, status: res.status, data };
      }, options.priority || 0, () => options.validatePreflight && !options.validatePreflight()
        ? { ok: false, status: 409, data: { code: 'PREFLIGHT_STALE', message: 'Se requiere verificar nuevamente el ticket antes de enviar.' } } : undefined,
        options.method === 'POST' && url === 'https://comedor-api.unab.edu.pe/v1/reservas' ? options.openingBurst : undefined);
      if (attempt + 1 < attempts && (response.status === 429 || response.status >= 500)) continue;
      return response;
    } catch (err) {
      const host = new URL(url).hostname;
      const failures = upstreamFailures.get(host) || 0;
      upstreamFailures.set(host, Math.min(failures + 1, 5));
      upstreamGate.pause(retryDelay(null, failures));
      if (attempt + 1 === attempts) {
        return { ok: false, status: 503, error: 'UNAB tarda en responder o no está disponible. Vuelve a intentarlo.', data: { error: 'UNAB tarda en responder o no está disponible. Vuelve a intentarlo.' } };
      }
    }
  }
}

// Authentication Service for UNAB
async function authenticateUserWithUnab(userRecord, requestOptions = {}) {
  try {
    const auth = await loginInstitution(fetchUnabResponse, userRecord.username, userRecord.password, requestOptions);
    if (!auth.success) return auth;
    const token = auth.token;

    if (db.findUserById(userRecord.id)?.legalConsent?.version !== TERMS_VERSION) return { success: false, status: 403, error: 'La autorización fue retirada.' };

    db.updateUser(userRecord.id, {
      unabToken: token,
      lastLogin: new Date().toISOString()
    });

    // Profile refresh must not delay a valid reservation session.
    if (!requestOptions.skipProfile) fetchComedorApi('/auth/me', token).then(profileRes => {
      if (!profileRes.ok || !profileRes.data?.data || db.findUserById(userRecord.id)?.legalConsent?.version !== TERMS_VERSION) return;
      const profile = profileRes.data.data;
      db.updateUser(userRecord.id, {
        name: profile.nombre || userRecord.name,
        dni: profile.dni || userRecord.dni,
        campus: profile.campus || userRecord.campus
      });
    }).catch(() => {});

    return { success: true, token };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Direct Authentication & Profile Sync against UNAB for Auto-Registration
async function authenticateStudentDirect(username, password) {
  try {
    const auth = await loginInstitution(fetchUnabResponse, username, password);
    if (!auth.success) return auth;
    const token = auth.token;
    let profile = { name: username, dni: '', campus: 'LA_FLORIDA' };

    try {
      const profileRes = await fetchComedorApi('/auth/me', token);
      if (profileRes.ok && profileRes.data?.data) {
        const p = profileRes.data.data;
        profile = {
          name: p.nombre || p.name || username,
          dni: p.dni || '',
          campus: p.campus || 'LA_FLORIDA'
        };
      }
    } catch (_) {}

    return { success: true, token, profile };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Comedor API Proxy Helper
async function fetchComedorApi(endpoint, token, options = {}, renewed = false) {
  const owner = db.getAllUsers(false).find(user => user.unabToken === token);
  const url = `https://comedor-api.unab.edu.pe/v1${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'Cookie': `next-login-auth=${token}`,
    'Authorization': `Bearer ${token}`,
    'Origin': 'https://comedor.unab.edu.pe',
    'Referer': 'https://comedor.unab.edu.pe/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    ...(options.headers || {})
  };

  const result = await fetchUnabResponse(url, { ...options, headers }, !options.method || options.method === 'GET');
  if (result.status === 401) {
    const user = owner || db.getAllUsers(false).find(user => user.unabToken === token);
    if (user) {
      if (user.unabToken === token) db.updateUser(user.id, { unabToken: '' });
      // Only a rejected read is replayed; writes retain reconciliation semantics.
      // Warmup verification passes renewed=true to avoid awaiting its own auth promise.
      if (!renewed && (!options.method || options.method === 'GET') && (!options.canProceed || options.canProceed())) {
        const replacement = await getValidUnabToken(user, false, options);
        if (replacement) return fetchComedorApi(endpoint, replacement, options, true);
      }
    }
  }
  return result;
}

function isJwtExpired(token, minimumValidityMs = 120000) {
  if (!token) return true;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    if (!payload.exp) return false;
    // Require validity through the requested preparation window
    return (payload.exp * 1000) < (Date.now() + minimumValidityMs);
  } catch {
    return true;
  }
}

// Helper: Ensure user has valid UNAB token (instant in-memory check during burst, verified during warmup)
const pendingUnabAuth = new Map();
const authWarnings = new Map();
const authRetryState = new Map();
const authIssues = new Map();
function noteAuthIssue(user, code, status) {
  const previous = authIssues.get(user.id);
  const requiresLogin = ['LOGIN_REQUIRED', 'CONSENT_REQUIRED', 'CREDENTIALS_REJECTED'].includes(code);
  authIssues.set(user.id, { code, requiresLogin });
  const last = authWarnings.get(user.id) || 0;
  if (previous?.code === code && (requiresLogin || Date.now() - last <= 60000)) return;
  authWarnings.set(user.id, Date.now());
  const reason = code === 'LOGIN_REQUIRED' ? 'sesión institucional ausente o vencida y sin credenciales en memoria; el alumno debe volver a ingresar'
    : code === 'CONSENT_REQUIRED' ? 'el alumno debe volver a ingresar y revisar la autorización'
    : code === 'CREDENTIALS_REJECTED' ? 'la institución rechazó las credenciales; el alumno debe volver a ingresar'
    : code === 'MISSING_SESSION_TOKEN' ? `HTTP ${status} sin token de sesión; se reintentará con pausa`
    : status ? `la institución respondió HTTP ${status}; se reintentará con pausa`
    : 'fallo interno al preparar la sesión; requiere revisión';
  emitLog(`[AUTENTICACIÓN] ${user.username}: ${reason}. La solicitud y su prioridad se conservan.`, 'warning');
  if (requiresLogin) broadcastSSE('institutional-session-required', { student: user.username });
}
function clearAuthIssue(id) {
  authWarnings.delete(id);
  authIssues.delete(id);
  authRetryState.delete(id);
}
function institutionalSessionState(user) {
  if (user.legalConsent?.version !== TERMS_VERSION) return 'ACTION_REQUIRED';
  if (user.unabToken && !isJwtExpired(user.unabToken)) return 'READY';
  if (!user.password || authIssues.get(user.id)?.code === 'CREDENTIALS_REJECTED') return 'ACTION_REQUIRED';
  return 'RECOVERING';
}

async function getValidUnabToken(userRecord, forceVerify = false, requestOptions = {}, minimumValidityMs = 120000) {
  if (userRecord.legalConsent?.version !== TERMS_VERSION) { noteAuthIssue(userRecord, 'CONSENT_REQUIRED'); return null; }
  const key = userRecord.id;
  const current = db.findUserById(key) || userRecord;
  if (!forceVerify && current.unabToken && !isJwtExpired(current.unabToken, minimumValidityMs)) { clearAuthIssue(key); return current.unabToken; }
  if (pendingUnabAuth.has(key)) {
    const preparation = pendingUnabAuth.get(key);
    const token = await preparation.promise;
    if (preparation.minimumValidityMs >= minimumValidityMs || !token || !isJwtExpired(token, minimumValidityMs)) return token;
    return getValidUnabToken(userRecord, forceVerify, requestOptions, minimumValidityMs);
  }
  const retry = authRetryState.get(key);
  if (retry?.credentialFingerprint && retry.credentialFingerprint !== crypto.createHash('sha256').update(current.password || '').digest('hex')) clearAuthIssue(key);
  else if ((retry?.until || 0) > Date.now()) return null;
  const pending = resolveUnabToken(userRecord, forceVerify, requestOptions, minimumValidityMs);
  pendingUnabAuth.set(key, { promise: pending, minimumValidityMs });
  try {
    const token = await pending;
    if (token) clearAuthIssue(key);
    return token;
  } finally { pendingUnabAuth.delete(key); }
}

async function resolveUnabToken(userRecord, forceVerify, requestOptions, minimumValidityMs) {
  userRecord = db.findUserById(userRecord.id) || userRecord;
  if (userRecord.unabToken && !isJwtExpired(userRecord.unabToken, minimumValidityMs)) {
    if (!forceVerify) return userRecord.unabToken;
    const verifiedToken = userRecord.unabToken;
    const test = await fetchComedorApi('/alumnos/me/elegibilidad', verifiedToken, requestOptions, true);
    const current = db.findUserById(userRecord.id) || userRecord;
    if (current.unabToken && current.unabToken !== verifiedToken && !isJwtExpired(current.unabToken, minimumValidityMs)) return current.unabToken;
    if (test.ok || ![401, 403].includes(test.status)) return verifiedToken;
    if (current.unabToken === verifiedToken) db.updateUser(userRecord.id, { unabToken: '' });
  }
  if (!userRecord.password) {
    noteAuthIssue(userRecord, 'LOGIN_REQUIRED');
    return null;
  }
  const auth = await authenticateUserWithUnab(userRecord, requestOptions);
  if (auth.success) { clearAuthIssue(userRecord.id); return auth.token; }
  const failures = Math.min((authRetryState.get(userRecord.id)?.failures || 0) + 1, 4);
  authRetryState.set(userRecord.id, auth.code === 'CREDENTIALS_REJECTED'
    ? { failures, until: Infinity, credentialFingerprint: crypto.createHash('sha256').update(userRecord.password).digest('hex') }
    : { failures, until: Date.now() + (auth.status === 401 && failures >= 3 ? 300000 : Math.min(30000, 5000 * 2 ** (failures - 1))) });
  noteAuthIssue(userRecord, auth.code || 'AUTHENTICATION_FAILED', auth.status);
  return null;
}

function automationEnabled(userId) {
  const current = db.findUserById(userId);
  return Boolean(current?.active && current.autoSniper);
}

function canReserveService(user, meal, date) {
  if (!isMealInServiceWindow(meal, date)) return false;
  if (!isPremium(user, date) || !user.automationConsent?.autoCancel) return true;
  const close = Date.parse(`${date}T${MEAL_CONFIGS[meal].horaFin}-05:00`);
  return Date.now() < close - 40000;
}

// Check if current time in Lima is strictly within the official active service window for a meal today
function isMealInServiceWindow(mealKey, dateStr) {
  const today = getTodayLimaDate(0);
  if (dateStr !== today) return false;
  const cfg = MEAL_CONFIGS[mealKey];
  if (!cfg) return false;

  const now = getLimaDateObj();
  const curH = now.getHours();
  const curM = now.getMinutes();

  const [openH, openM] = cfg.horaInicio.split(':').map(Number);
  const isOpen = (curH > openH || (curH === openH && curM >= openM));
  const isPastCutoff = (curH > cfg.cutoffH || (curH === cfg.cutoffH && curM >= cfg.cutoffM));

  return isOpen && !isPastCutoff;
}

// Check if official opening time has already passed for a meal today
function hasMealOpened(mealKey, dateStr) {
  const today = getTodayLimaDate(0);
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  const cfg = MEAL_CONFIGS[mealKey];
  if (!cfg) return false;

  const now = getLimaDateObj();
  const curH = now.getHours();
  const curM = now.getMinutes();
  const [openH, openM] = cfg.horaInicio.split(':').map(Number);

  return (curH > openH || (curH === openH && curM >= openM));
}

// Master Railway 24/7 Scheduler Daemon (Autopilot for Desayuno, Almuerzo, and Cena)
let masterSchedulerIntervalId = null;
let lastSchedulerLogTime = 0;
let lastSchedulerEvaluatedMeal = '';

function getNextMealOpening() {
  const todayLima = getTodayLimaDate(0);
  const tomorrowLima = getTodayLimaDate(1);
  const nowMs = Date.now();

  const candidates = [
    { meal: 'DESAYUNO', date: todayLima, time: '06:30:00', iso: `${todayLima}T06:30:00-05:00` },
    { meal: 'ALMUERZO', date: todayLima, time: '11:00:00', iso: `${todayLima}T11:00:00-05:00` },
    { meal: 'CENA', date: todayLima, time: '17:00:00', iso: `${todayLima}T17:00:00-05:00` },
    { meal: 'DESAYUNO', date: tomorrowLima, time: '06:30:00', iso: `${tomorrowLima}T06:30:00-05:00` },
    { meal: 'ALMUERZO', date: tomorrowLima, time: '11:00:00', iso: `${tomorrowLima}T11:00:00-05:00` },
    { meal: 'CENA', date: tomorrowLima, time: '17:00:00', iso: `${tomorrowLima}T17:00:00-05:00` }
  ];

  for (const c of candidates) {
    const ts = new Date(c.iso).getTime();
    if (ts > nowMs - 2000) {
      return { ...c, targetTs: ts, msUntil: ts - nowMs };
    }
  }

  const defTs = new Date(`${tomorrowLima}T06:30:00-05:00`).getTime();
  return { meal: 'DESAYUNO', date: tomorrowLima, time: '06:30:00', iso: `${tomorrowLima}T06:30:00-05:00`, targetTs: defTs, msUntil: defTs - nowMs };
}

function tickRailwayMasterScheduler() {
  if (!globalSniper.running) {
    const queue = getAllPendingAdvanceReservations().filter(item => item.isSentinel && item.admitted);
    if (queue.length) startSentinelWatch({ targetMeal: queue[0].meal, targetDate: queue[0].date });
  }
  // Guard: If Sentinel is running outside its active service window, stop it automatically!
  if (sentinelIntervalId || globalSniper.status === 'SENTINEL') {
    if (!isMealInServiceWindow(globalSniper.targetMeal, globalSniper.targetDate)) {
      stopSentinelWatch(true);
      emitLog(`[CENTINELA] Horario fuera de ventana de atención de ${globalSniper.targetMeal}. Centinela apagado automáticamente.`, 'info');
    }
  }

  // If sniper is currently executing burst (RESERVING), do not interfere
  if (globalSniper.status === 'RESERVING') {
    return;
  }

  const next = getNextMealOpening();
  const msUntil = next.msUntil;

  // Find active advance reservations for this upcoming meal and date
  const eligible = new Set(admittedStudents(db.getAllUsers(false)).filter(user => user.active && user.autoSniper).map(user => user.username));
  const activeAdvance = db.getAdvanceReservations({ fecha: next.date, status: 'ACTIVA' })
    .filter(a => a.tipoComida.toUpperCase() === next.meal.toUpperCase() && eligible.has(a.alumnoCodigo));

  const hasAdvance = activeAdvance.length > 0;
  // Pre-arming window: 5 minutes before opening
  const inArmingWindow = msUntil <= WARMUP_LEAD_MS + 60000 && msUntil > 0;

  // USER RULE:
  // "el francotirador debe ser automático, en base si hay una reserva anticipada.
  // Pero si no hay una reserva anticipada, el francotirador no se va a activar."
  if (!hasAdvance) {
    // If it was automatically armed, disarm it
    if (globalSniper.status === 'ARMED' && globalSniper.isAutoScheduled) {
      stopGlobalSniper(true);
      emitLog(`[AUTOPILOT] Francotirador desarmado: 0 reservas anticipadas para ${next.meal} del ${next.date}.`, 'info');
    }

    const nowMs = Date.now();
    if (inArmingWindow && msUntil <= 3 * 60 * 1000 && (nowMs - lastSchedulerLogTime > 60000 || lastSchedulerEvaluatedMeal !== next.meal)) {
      lastSchedulerLogTime = nowMs;
      lastSchedulerEvaluatedMeal = next.meal;
      emitLog(`[AUTOPILOT] Próxima apertura de ${next.meal} (${next.time}): 0 reservas anticipadas. Francotirador en reposo (inactivo).`, 'info');
    }
    return;
  }

  // If there ARE advance reservations and we are in the arming window:
  if (inArmingWindow) {
    const isAlreadyArmed = globalSniper.running && 
      globalSniper.status === 'ARMED' && 
      globalSniper.targetMeal === next.meal && 
      globalSniper.targetDate === next.date;

    if (!isAlreadyArmed) {
      emitLog(`[FRANCOTIRADOR] ${activeAdvance.length} reserva(s) anticipada(s) detectada(s). Francotirador AUTOMÁTICO armado para ${next.meal} (${next.date} a las ${next.time}).`, 'success');
      startGlobalSniper({
        targetMeal: next.meal,
        targetDate: next.date,
        targetTime: next.time,
        leadTimeMs: 250,
        isAutoScheduled: true
      });
    }
  }
}

// Multi-User Sniper & Sentinel Engine (Schedule-aware, Multi-Meal Intelligent, Liberation Watchdog)
function startGlobalSniper(options = {}) {
  stopGlobalSniper(true);

  globalSniper.targetMeal = (options.targetMeal || 'ALMUERZO').toUpperCase();
  globalSniper.targetDate = options.targetDate || getTodayLimaDate(0);
  globalSniper.leadTimeMs = Number(options.leadTimeMs || 250);
  globalSniper.mode = options.mode || 'SCHEDULED';
  globalSniper.isAutoScheduled = !!options.isAutoScheduled;
  globalSniper.running = true;
  globalSniper.lastRunResults = [];

  // Determine correct target opening time:
  const mealConfig = MEAL_CONFIGS[globalSniper.targetMeal];
  if (options.targetTime) {
    globalSniper.targetTime = options.targetTime;
  } else if (mealConfig) {
    globalSniper.targetTime = mealConfig.defaultTargetTime;
  } else {
    globalSniper.targetTime = '11:00:00'; // Default Almuerzo
  }

  // If user requested sentinel mode directly:
  if (options.mode === 'SENTINEL') {
    startSentinelWatch(options);
    return;
  }

  globalSniper.status = 'ARMED';

  const [h, m, s] = globalSniper.targetTime.split(':').map(Number);
  const todayLima = getTodayLimaDate(0);
  const triggerIso = `${globalSniper.targetDate}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}-05:00`;
  let targetTs = new Date(triggerIso).getTime();

  let msUntilTarget = targetTs - Date.now();
  // If target time today has passed by more than 1 minute:
  if (msUntilTarget < -60000) {
    const nowLima = getLimaDateObj();
    const curH = nowLima.getHours();
    const curM = nowLima.getMinutes();
    if (globalSniper.targetDate === todayLima && mealConfig) {
      const isPastCutoff = (curH > mealConfig.cutoffH || (curH === mealConfig.cutoffH && curM >= mealConfig.cutoffM));
      if (!isPastCutoff) {
        emitLog(`[CENTINELA] Horario actual dentro de la ventana de ${globalSniper.targetMeal}. Activando Centinela de captura inmediata...`, 'info');
        startSentinelWatch({ targetMeal: globalSniper.targetMeal, targetDate: globalSniper.targetDate });
        return;
      }
    }
    // If cutoff passed for today, target tomorrow's opening
    targetTs += 24 * 60 * 60 * 1000;
    msUntilTarget = targetTs - Date.now();
  }

  emitLog(`[FRANCOTIRADOR] Francotirador armado para ${globalSniper.targetMeal} del ${globalSniper.targetDate}. Hora programada: ${globalSniper.targetTime}.`, 'info');
  broadcastSSE('sniper-status', { ...globalSniper, sentinelActive: !!sentinelIntervalId });

  // Prepare sessions before opening and recheck late arrivals one minute before it.
  const warmupGeneration = engineGeneration;
  const warmupDate = globalSniper.targetDate;
  const warmupMeal = globalSniper.targetMeal;
  const isCurrentWarmup = () => engineGeneration === warmupGeneration && globalSniper.running && globalSniper.status === 'ARMED';
  async function warmSessions(verifyRemote) {
    if (!isCurrentWarmup()) return;
    const queue = db.getAdvanceReservations({ fecha: warmupDate, status: 'ACTIVA' })
      .filter(item => ['TODAS', 'INTELIGENTE'].includes(warmupMeal) || item.tipoComida.toUpperCase() === warmupMeal);
    const usernames = new Set(queue.map(item => item.alumnoCodigo));
    const users = admittedStudents(db.getAllUsers(false)).filter(user => user.active && user.autoSniper && usernames.has(user.username));
    emitLog(`[WARMUP] Preparando ${users.length} sesiones antes de ${warmupMeal}...`, 'info');
    try {
      let checked = 0;
      const prepareReservations = verifyRemote ? undefined : async (user, token) => {
        for (const advance of queue.filter(item => item.alumnoCodigo === user.username)) {
          const openingTs = Date.parse(`${advance.fecha}T${MEAL_CONFIGS[advance.tipoComida]?.horaInicio}-05:00`);
          if (Math.abs(openingTs - targetTs) > 1000) continue;
          if (await reserveOnce.prepare(user.id, token, advance.fecha, advance.tipoComida, openingTs, { priority: 1, timeoutMs: 5000, canProceed: isCurrentWarmup })) checked++;
        }
      };
      const result = await prepareSessions(users, { getToken: getValidUnabToken, canProceed: isCurrentWarmup, targetTs, isExpired: isJwtExpired, verifyRemote, prepareReservations });
      if (isCurrentWarmup() && !verifyRemote) emitLog(`[WARMUP] ${checked} comprobaciones de tickets listas para el primer envío de apertura.`, 'info');
      if (isCurrentWarmup()) emitLog(`[WARMUP] ${result.ready}/${result.total} sesiones preparadas con vigencia para la apertura.`, result.ready === result.total ? 'success' : 'warning');
    } catch (error) { emitLog('[WARMUP] Preparación pendiente. Se volverá a comprobar la sesión al abrir.', 'warning'); }
  }
  warmupTimerId = setTimeout(() => warmSessions(msUntilTarget > REFRESH_LEAD_MS), Math.max(0, msUntilTarget - WARMUP_LEAD_MS));
  if (msUntilTarget > REFRESH_LEAD_MS) {
    warmupRefreshTimerId = setTimeout(() => warmSessions(false), msUntilTarget - REFRESH_LEAD_MS);
  }

  // Trigger burst at target - leadTimeMs
  const triggerDelay = Math.max(0, msUntilTarget - globalSniper.leadTimeMs);
  sniperTimerId = setTimeout(() => {
    executeMultiUserBurst();
  }, triggerDelay);
}

function stopGlobalSniper(quiet = false) {
  reserveOnce.clearPrepared?.();
  engineGeneration++;
  sentinelGeneration++;
  if (warmupTimerId) clearTimeout(warmupTimerId);
  if (warmupRefreshTimerId) clearTimeout(warmupRefreshTimerId);
  warmupTimerId = null;
  warmupRefreshTimerId = null;
  if (sniperTimerId) clearTimeout(sniperTimerId);
  if (sniperPollIntervalId) clearInterval(sniperPollIntervalId);
  if (sentinelIntervalId) clearInterval(sentinelIntervalId);
  sniperTimerId = null;
  sniperPollIntervalId = null;
  sentinelIntervalId = null;
  isSniperBurstRunning = false;
  isSentinelRunningTick = false;
  globalSniper.running = false;
  globalSniper.status = 'IDLE';
  globalSniper.isAutoScheduled = false;
  if (!quiet) emitLog('Francotirador y centinela detenidos.', 'info');
  broadcastSSE('sniper-status', { ...globalSniper, sentinelActive: false });
}

// Sentinel Queue: ONLY students whose meal has ALREADY opened and is currently inside the active service window!
function getStudentsInSentinelQueue(filterDate = null, filterMeal = null) {
  const targetDate = filterDate || globalSniper.targetDate || getTodayLimaDate(0);
  return getAllPendingAdvanceReservations().filter(item => item.eligible && item.isSentinel && item.date === targetDate &&
    (!filterMeal || ['TODAS', 'INTELIGENTE'].includes(filterMeal) || item.meal === filterMeal.toUpperCase()));
}

// Consolidated Advance Reservations & Sentinel Queue for Admin View
function getAllPendingAdvanceReservations() {
  const allRes = db.getAllReservations();
  const allAdvance = db.getAdvanceReservations({ status: 'ACTIVA' });
  const allUsers = db.getAllUsers(false);

  const list = [];
  for (const adv of allAdvance) {
    const student = allUsers.find(u => u.username === adv.alumnoCodigo || (adv.alumnoDni && u.dni === adv.alumnoDni));
    if (adv.source === 'premium' && !isPremium(student, adv.fecha)) continue;
    const alreadyConfirmed = allRes.some(r => 
      (r.alumnoCodigo === adv.alumnoCodigo || (adv.alumnoDni && r.alumnoDni === adv.alumnoDni)) &&
      r.fecha === adv.fecha &&
      r.tipoComida.toUpperCase() === adv.tipoComida.toUpperCase() &&
      ['ACTIVA', 'CONSUMIDA'].includes(r.estado)
    );
    if (!alreadyConfirmed) {
      const inWindow = isMealInServiceWindow(adv.tipoComida, adv.fecha);
      const cfg = MEAL_CONFIGS[adv.tipoComida];
      const membership = enrollment(allUsers, student?.id);
      const eligible = Boolean(student?.active && student.autoSniper && membership.admitted);
      const sessionNeedsLogin = Boolean(student && institutionalSessionState(student) === 'ACTION_REQUIRED');
      list.push({
        advanceId: adv.id,
        studentUsername: adv.alumnoCodigo,
        studentName: adv.alumnoNombre || student?.name || adv.alumnoCodigo,
        studentDni: adv.alumnoDni || student?.dni || '',
        campus: adv.campus || student?.campus || 'LA_FLORIDA',
        meal: adv.tipoComida.toUpperCase(),
        date: adv.fecha,
        createdAt: adv.createdAt,
        registrationOrder: student?.registrationOrder || membership.position,
        premium: isPremium(student, adv.fecha),
        admitted: membership.admitted,
        eligible,
        authPending: sessionNeedsLogin || authWarnings.has(student?.id),
        sessionNeedsLogin,
        sessionState: student ? institutionalSessionState(student) : 'ACTION_REQUIRED',
        isSentinel: eligible && inWindow,
        statusText: !membership.admitted ? 'Fuera del cupo de alumnos' : !student?.active ? 'Cuenta inactiva' : !student.autoSniper ? 'Automatización pausada' : inWindow
          ? 'En Cola Centinela (Buscando Liberados)' 
          : `Reserva Anticipada (Disparo a las ${cfg?.horaInicio || '17:00'})`
      });
    } else {
      db.markAdvanceReservationConfirmed(adv.id, { id: 'SYNCED', qrToken: '' });
    }
  }
  return list.sort(compareQueue);
}

// Counts and table rows are built from one snapshot; authentication failures stay pending.
function getPendingQueueSnapshot(date = globalSniper.targetDate, meal = globalSniper.targetMeal) {
  const queue = getAllPendingAdvanceReservations();
  const current = queue.filter(item => item.eligible && item.isSentinel && item.date === (date || getTodayLimaDate(0)) &&
    (!meal || ['TODAS', 'INTELIGENTE'].includes(meal) || item.meal === meal.toUpperCase()));
  const students = items => new Set(items.map(item => item.studentUsername)).size;
  return {
    queue, count: queue.length, totalPendingCount: queue.length,
    pendingStudentCount: students(queue), sentinelQueueCount: current.length,
    sentinelStudentCount: students(current),
    authPendingStudentCount: students(queue.filter(item => item.eligible && item.authPending))
  };
}

function checkAndManageSentinelQueue() {
  const queue = getStudentsInSentinelQueue(globalSniper.targetDate, globalSniper.targetMeal);
  if (queue.length === 0) {
    if (sentinelIntervalId || globalSniper.status === 'SENTINEL') {
      stopSentinelWatch(true);
      emitLog('[CENTINELA] No quedan alumnos en cola de espera. Centinela apagado automáticamente.', 'info');
      broadcastSSE('sentinel-queue-updated', { queue: [] });
      broadcastSSE('sniper-status', { ...globalSniper, sentinelActive: false });
    }
    return false;
  }
  return true;
}

// Sentinel Engine: Intelligently monitors for liberated cupos and turns off automatically when fulfilled or cancelled
function startSentinelWatch(options = {}) {
  stopSentinelWatch(true);

  const meal = (options.targetMeal || globalSniper.targetMeal || 'ALMUERZO').toUpperCase();
  const date = options.targetDate || globalSniper.targetDate || getTodayLimaDate(0);
  const generation = sentinelGeneration;
  const isCurrentRun = () => generation === sentinelGeneration && globalSniper.running &&
    globalSniper.targetDate === date && globalSniper.targetMeal === meal;

  // USER RULE: Centinela ONLY activates when the opening time has passed and we are within the active service window!
  if (!isMealInServiceWindow(meal, date)) {
    emitLog(`[CENTINELA] No iniciado: ${meal} del ${date} no se encuentra en ventana de servicio activa (Apertura: ${MEAL_CONFIGS[meal]?.horaInicio || '--'}).`, 'info');
    globalSniper.status = 'IDLE';
    globalSniper.running = false;
    broadcastSSE('sniper-status', { ...globalSniper, sentinelActive: false });
    return;
  }

  globalSniper.targetMeal = meal;
  globalSniper.targetDate = date;
  globalSniper.mode = 'SENTINEL';
  globalSniper.status = 'SENTINEL';
  globalSniper.running = true;

  const initialQueue = getStudentsInSentinelQueue(globalSniper.targetDate, globalSniper.targetMeal);
  if (initialQueue.length === 0) {
    emitLog(`[CENTINELA] Centinela no iniciado: No hay alumnos en cola de espera para ${globalSniper.targetMeal} del ${globalSniper.targetDate}.`, 'info');
    globalSniper.status = 'IDLE';
    globalSniper.running = false;
    broadcastSSE('sniper-status', { ...globalSniper, sentinelActive: false });
    broadcastSSE('sentinel-queue-updated', { queue: [] });
    return;
  }

  emitLog(`[CENTINELA] Vigilando cupos liberados para ${initialQueue.length} alumno(s) en cola (${globalSniper.targetMeal} del ${globalSniper.targetDate})...`, 'warning');
  broadcastSSE('sniper-status', { ...globalSniper, sentinelActive: true });
  broadcastSSE('sentinel-queue-updated', { queue: initialQueue });

  let probeIndex = 0;
  sentinelIntervalId = setInterval(async () => {
    if (generation !== sentinelGeneration) return;
    if (!globalSniper.running || globalSniper.status !== 'SENTINEL') {
      stopSentinelWatch(true);
      return;
    }

    if (isSentinelRunningTick) return; // Prevent concurrent overlapping ticks
    isSentinelRunningTick = true;

    // Auto-stop if meal service window has ended
    if (!isMealInServiceWindow(meal, date)) {
      emitLog(`[CENTINELA] Horario oficial de servicio de ${meal} finalizó. Centinela apagado automáticamente.`, 'info');
      stopSentinelWatch(true);
      globalSniper.status = 'IDLE';
      globalSniper.running = false;
      broadcastSSE('sniper-status', { ...globalSniper, sentinelActive: false });
      isSentinelRunningTick = false;
      return;
    }

    try {
      const currentQueue = getStudentsInSentinelQueue(date, meal);
      if (currentQueue.length === 0) {
        emitLog('[CENTINELA] Todos los alumnos en cola recibieron su ticket o se canceló la solicitud. Centinela apagado automáticamente.', 'success');
        stopSentinelWatch(true);
        globalSniper.status = 'FINISHED';
        globalSniper.running = false;
        broadcastSSE('sniper-status', { ...globalSniper, sentinelActive: false });
        broadcastSSE('sentinel-queue-updated', { queue: [] });
        return;
      }

      // Probe menu
      const candidateItem = currentQueue[probeIndex % currentQueue.length];
      probeIndex++;
      const candidateStudent = db.findUserByUsername(candidateItem.studentUsername);
      if (!candidateStudent) return;
      const probeToken = await getValidUnabToken(candidateStudent, false, { priority: 1, skipProfile: true });
      if (!probeToken) return;

      const prog = await fetchComedorApi(`/programacion/me?date=${date}`, probeToken, { priority: 1 });
      if (!prog.ok || !Array.isArray(prog.data?.data) || prog.data.data.length === 0) return;

      const menuFound = prog.data.data;

      for (const item of currentQueue) {
        if (!isCurrentRun() || globalSniper.status !== 'SENTINEL') break;

        const studentUser = db.findUserByUsername(item.studentUsername);
        if (!studentUser) continue;

        // Verify if student already has a confirmed ticket recorded
        const allRes = db.getAllReservations();
        const alreadyDone = allRes.some(r => 
          (r.alumnoCodigo === item.studentUsername || (item.studentDni && r.alumnoDni === item.studentDni)) &&
          r.fecha === date &&
          r.tipoComida.toUpperCase() === item.meal.toUpperCase() &&
          ['ACTIVA', 'CONSUMIDA'].includes(r.estado)
        );
        if (alreadyDone) {
          db.markAdvanceReservationConfirmed(item.advanceId, { id: 'SYNCED', qrToken: '' });
          continue;
        }

        const sToken = await getValidUnabToken(studentUser, false, { priority: 1, skipProfile: true });
        if (!sToken) continue;

        const targetItem = menuFound.find(i => (i.tipoComida || '').toUpperCase() === item.meal.toUpperCase());
        if (!targetItem) continue;

        const disponibles = targetItem.disponibleLibre ?? (targetItem.cupoLibre - (targetItem.usadoLibre ?? 0));
        if (disponibles > 0) {
          emitLog(`[CENTINELA] Cupo liberado detectado (${disponibles} libre(s) en ${item.meal}). Capturando para ${item.studentName}...`, 'warning');

          const result = await reserveOnce(studentUser.id, sToken, targetItem.id, date, item.meal,
            () => isCurrentRun() && automationEnabled(studentUser.id) && canReserveService(studentUser, item.meal, date) &&
              db.getAdvanceReservations({ alumnoCodigo: item.studentUsername, fecha: date, status: 'ACTIVA' })
                .some(advance => advance.id === item.advanceId), { priority: 1 });
          if (result.ok && result.data?.success) {
            const ticket = result.data.data;
            db.recordReservation({
              id: ticket.id,
              alumnoCodigo: item.studentUsername,
              alumnoNombre: item.studentName,
              alumnoDni: item.studentDni,
              tipoComida: targetItem.tipoComida,
              fecha: date,
              horaReserva: getLimaTimeString().slice(0, 8),
              qrToken: ticket.qrToken,
              estado: ticket.estado || 'ACTIVA',
              campus: item.campus
            });

            db.markAdvanceReservationConfirmed(item.advanceId, ticket);
            emitLog(`[CENTINELA] Ticket liberado capturado con éxito para ${item.studentName} (${item.meal} del ${date}).`, 'success');
            broadcastSSE('reservation-status-changed', { student: item.studentUsername, meal: item.meal, ticket });

            if (!isCurrentRun()) return;
            // Re-evaluate remaining queue
            const remainingQueue = getStudentsInSentinelQueue(date, meal);
            broadcastSSE('sentinel-queue-updated', { queue: remainingQueue });
            if (remainingQueue.length === 0) {
              emitLog('[CENTINELA] Todos los alumnos en cola recibieron su ticket. Centinela apagado automáticamente.', 'success');
              stopSentinelWatch(true);
              globalSniper.status = 'FINISHED';
              globalSniper.running = false;
              broadcastSSE('sniper-status', { ...globalSniper, sentinelActive: false });
              return;
            }
          } else {
            emitLog(`[CENTINELA] Reserva pendiente para ${item.studentName}: ${result.data?.message || 'UNAB no confirmó el ticket.'}`, 'warning');
          }
        }
      }
    } catch (err) {
      console.error('Error en ciclo centinela:', err);
    } finally {
      if (generation === sentinelGeneration) isSentinelRunningTick = false;
    }
  }, 1000);
}

function stopSentinelWatch(quiet = false) {
  sentinelGeneration++;
  if (sentinelIntervalId) clearInterval(sentinelIntervalId);
  sentinelIntervalId = null;
  isSentinelRunningTick = false;
  if (globalSniper.status === 'SENTINEL') {
    globalSniper.status = 'IDLE';
    globalSniper.running = false;
    if (!quiet) emitLog('Centinela detenido.', 'info');
    broadcastSSE('sniper-status', { ...globalSniper, sentinelActive: false });
  }
}

async function executeMultiUserBurst() {
  if (isSniperBurstRunning) return;
  if (!globalSniper.running && globalSniper.status === 'RESERVING') return;
  const runDate = globalSniper.targetDate;
  const runMeal = globalSniper.targetMeal;
  const generation = engineGeneration;
  const isCurrentRun = () => generation === engineGeneration && globalSniper.running &&
    globalSniper.targetDate === runDate && globalSniper.targetMeal === runMeal;
  isSniperBurstRunning = true;
  globalSniper.status = 'RESERVING';
  broadcastSSE('sniper-status', { ...globalSniper });

  // USER RULE:
  // "El francotirador debe ser automático en base si hay una reserva anticipada.
  // Pero si no hay una reserva anticipada, el francotirador no se va a activar."
  const allAdvance = db.getAdvanceReservations({ fecha: runDate, status: 'ACTIVA' });
  let candidateAdvance = allAdvance.filter(item => item.source !== 'premium' || isPremium(db.findUserByUsername(item.alumnoCodigo), runDate));
  if (runMeal && !['TODAS', 'INTELIGENTE'].includes(runMeal)) {
    candidateAdvance = candidateAdvance.filter(a => a.tipoComida.toUpperCase() === runMeal.toUpperCase());
  }

  if (candidateAdvance.length === 0) {
    emitLog(`ℹ️ Francotirador NO activado: No existen reservas anticipadas activas para ${runMeal} del ${runDate}.`, 'info');
    globalSniper.status = 'IDLE';
    globalSniper.running = false;
    isSniperBurstRunning = false;
    broadcastSSE('sniper-status', { ...globalSniper });
    return;
  }

  candidateAdvance.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const advanceUsernames = new Set(candidateAdvance.map(a => a.alumnoCodigo));
  const activeCandidates = admittedStudents(db.getAllUsers(false)).filter(u =>
    u.active && u.autoSniper && advanceUsernames.has(u.username) && u.role !== 'superadmin'
  ).sort((a, b) => compareQueue(
    { premium: isPremium(a, runDate), registrationOrder: a.registrationOrder },
    { premium: isPremium(b, runDate), registrationOrder: b.registrationOrder }
  ));

  if (activeCandidates.length === 0) {
    emitLog('No hay alumnos activos vinculados a las reservas anticipadas encontradas.', 'warning');
    globalSniper.status = 'IDLE';
    globalSniper.running = false;
    isSniperBurstRunning = false;
    broadcastSSE('sniper-status', { ...globalSniper });
    return;
  }

  emitLog(`[DISPARO] Iniciado: Sondeando cupos para ${activeCandidates.length} alumno(s) con reserva anticipada [Modo: ${runMeal}]...`, 'warning');

  let attempts = 0;
  const maxAttempts = 60; // Short opening polling, then sentinel recovery
  let burstDispatched = false;
  let isPolling = false;

  let waitingForMealLogged = false;
  let publicationChecks = 0;
  let publicationErrors = 0;
  const openingTs = Date.parse(`${runDate}T${MEAL_CONFIGS[runMeal]?.horaInicio}-05:00`);

  sniperPollIntervalId = setInterval(async () => {
    if (generation !== engineGeneration) return;
    if (burstDispatched) {
      clearInterval(sniperPollIntervalId);
      sniperPollIntervalId = null;
      return;
    }

    if (isPolling) return; // Guard against overlapping in-flight async requests
    isPolling = true;

    attempts++;
    if (attempts > maxAttempts || (!globalSniper.running && globalSniper.status !== 'RESERVING')) {
      clearInterval(sniperPollIntervalId);
      sniperPollIntervalId = null;
      isSniperBurstRunning = false;
      isPolling = false;
      if (globalSniper.status === 'RESERVING' && !burstDispatched) {
        if (isMealInServiceWindow(runMeal, runDate)) {
          emitLog(publicationChecks === 0
            ? (publicationErrors === 0 ? '[DISPARO] No se pudo consultar la programación: ninguna sesión institucional estuvo lista. Las solicitudes siguen pendientes; Centinela continuará comprobando las sesiones.' : '[DISPARO] La institución no permitió verificar la programación. Las solicitudes siguen pendientes; Centinela volverá a consultar.')
            : '[DISPARO] La programación consultada aún no contiene el servicio solicitado. Las solicitudes siguen pendientes en Centinela.', 'info');
          startSentinelWatch({ targetMeal: runMeal, targetDate: runDate });
        } else {
          stopGlobalSniper(true);
        }
      }
      return;
    }

    try {
      // Rotate the probe so one unavailable account cannot block the whole queue.
      const probeUser = activeCandidates[(attempts - 1) % activeCandidates.length];
      const probeToken = await getValidUnabToken(probeUser, false, { priority: 1, skipProfile: true });
      if (!probeToken) {
        if (activeCandidates.every(user => authIssues.get(user.id)?.requiresLogin)) attempts = maxAttempts;
        return;
      }
      const prog = await fetchComedorApi(`/programacion/me?date=${runDate}`, probeToken, { priority: 1 });
      if (!isCurrentRun()) return;
      if (prog.ok && Array.isArray(prog.data?.data)) publicationChecks++; else publicationErrors++;
      if (prog.ok && Array.isArray(prog.data?.data) && prog.data.data.length > 0) {
        const targetMeal = runMeal?.toUpperCase();
        const needsSpecificMeal = targetMeal && !['TODAS', 'INTELIGENTE'].includes(targetMeal);
        if (needsSpecificMeal && !prog.data.data.some(item => (item.tipoComida || '').toUpperCase() === targetMeal)) {
          if (!waitingForMealLogged) {
            emitLog(`[DISPARO] UNAB respondió, pero todavía no publicó ${targetMeal}. Las reservas siguen pendientes; se volverá a consultar.`, 'info');
            waitingForMealLogged = true;
          }
          return;
        }
        if (Number.isFinite(openingTs) && Date.now() < openingTs) return;
        if (burstDispatched) {
          isPolling = false;
          return;
        }
        burstDispatched = true;
        clearInterval(sniperPollIntervalId);
        sniperPollIntervalId = null;
        const menuFound = prog.data.data;
        const detectedAt = Date.now();
        emitLog(`[DISPARO] Programación detectada con ${menuFound.length} servicios para ${runDate}. Procesando reservas...`, 'success');

        const openingBurst = Number.isFinite(openingTs) && detectedAt - openingTs <= 60000
          ? upstreamGate.openBurst({ maxStarts: activeCandidates.length }) : undefined;
        globalSniper.lastDispatchTiming = { detectedAt: new Date(detectedAt).toISOString(), firstPostDelayMs: null, lastPostDelayMs: null, dispatched: 0 };
        if (openingBurst) emitLog(`[DISPARO] Lote de apertura paralelo: hasta ${activeCandidates.length} envíos, sin separación artificial para las sesiones preparadas.`, 'info');
        // Queue ready students without waiting for earlier confirmations. The shared gate still controls network concurrency/rate.
        const finalResults = await mapWithConcurrency(activeCandidates, activeCandidates.length, async (student) => {
          if (!isCurrentRun()) return { user: student.username, results: [{ success: false, message: 'Ejecución cancelada' }] };
          const sToken = await getValidUnabToken(student, false, { priority: 1, skipProfile: true });
          if (!sToken) {
            emitLog(`[DISPARO] Autenticación UNAB pendiente para ${student.name} (${student.username}). La reserva seguirá en cola para reintentar.`, 'warning');
            return { user: student.username, results: [{ success: false, message: 'Autenticación UNAB pendiente. Se volverá a intentar desde la cola.' }] };
          }

          // Fetch student's advance reservations for this target date
          const studentAdvance = db.getAdvanceReservations({
            alumnoCodigo: student.username,
            fecha: runDate,
            status: 'ACTIVA'
          });

          let mealsToReserve = [];
          if (runMeal && !['TODAS', 'INTELIGENTE'].includes(runMeal)) {
            mealsToReserve = [runMeal.toUpperCase()];
          } else if (studentAdvance.length > 0) {
            mealsToReserve = studentAdvance.map(a => a.tipoComida.toUpperCase());
          } else if (student.targetMeal && !['TODAS', 'INTELIGENTE'].includes(student.targetMeal)) {
            mealsToReserve = [student.targetMeal.toUpperCase()];
          } else {
            mealsToReserve = ['ALMUERZO'];
          }

          const studentResults = [];

          for (const meal of mealsToReserve) {
            let targetItem = menuFound.find(i => (i.tipoComida || '').toUpperCase() === meal.toUpperCase());
            if (!targetItem) {
              studentResults.push({ meal, success: false, message: `Menú de ${meal} no disponible en la programación.` });
              continue;
            }

            // Quick burst request
            const result = await reserveOnce(student.id, sToken, targetItem.id, runDate, meal,
              () => isCurrentRun() && automationEnabled(student.id) && canReserveService(student, meal, runDate) &&
                db.getAdvanceReservations({ alumnoCodigo: student.username, fecha: runDate, status: 'ACTIVA' })
                  .some(item => item.tipoComida.toUpperCase() === meal), {
                  priority: isPremium(student, runDate) ? 3 : 1,
                  preparedOpeningTs: openingTs,
                  openingBurst,
                  onWriteStart: ({ startedAt, queuedMs }) => {
                    globalSniper.lastDispatchTiming.dispatched++;
                    globalSniper.lastDispatchTiming.lastPostDelayMs = startedAt - detectedAt;
                    if (globalSniper.lastDispatchTiming.firstPostDelayMs === null) {
                      globalSniper.lastDispatchTiming.firstPostDelayMs = startedAt - detectedAt;
                      emitLog(`[LATENCIA] Primer POST iniciado ${startedAt - detectedAt} ms después de detectar programación; espera interna ${queuedMs} ms.`, 'info');
                    }
                  }
                });
            if (result.ok && result.data?.success) {
              const ticket = result.data.data;
              db.recordReservation({
                id: ticket.id,
                alumnoCodigo: student.username,
                alumnoNombre: student.name,
                alumnoDni: student.dni,
                tipoComida: targetItem.tipoComida,
                fecha: runDate,
                horaReserva: getLimaTimeString().slice(0, 8),
                qrToken: ticket.qrToken,
                estado: ticket.estado || 'ACTIVA',
                campus: student.campus
              });

              // Mark advance reservation as confirmed if matched
              const matchAdv = studentAdvance.find(a => a.tipoComida.toUpperCase() === meal.toUpperCase());
              if (matchAdv) {
                db.markAdvanceReservationConfirmed(matchAdv.id, ticket);
              }

              emitLog(`[DISPARO] Reserva confirmada para ${student.name} (${targetItem.tipoComida}).`, 'success');
              studentResults.push({ meal, success: true, ticket });
            } else {
              const msg = result.data?.message || result.error || 'UNAB no confirmó la reserva; permanece pendiente';
              emitLog(`Resultado para ${student.name} (${meal}): ${msg}`, 'warning');
              studentResults.push({ meal, success: false, message: msg });
            }
          }

          return { user: student.username, results: studentResults };
        });

        if (!isCurrentRun()) return;
        globalSniper.lastRunResults = finalResults;
        const timing = globalSniper.lastDispatchTiming;
        emitLog(`[LATENCIA] ${timing.dispatched} POST iniciados: primero a ${timing.firstPostDelayMs ?? 'sin envío'} ms y último a ${timing.lastPostDelayMs ?? 'sin envío'} ms desde la detección.`, 'info');
        broadcastSSE('reservation-batch-finished', finalResults);

        // Check if any student truly failed to get tickets; if so, keep Sentinel running
        const anyPending = finalResults.some(r => r.results?.some(res => !res.success));
        if (anyPending) {
          emitLog('Hay reservas pendientes de confirmar. Centinela volverá a consultar la sesión, disponibilidad y resultado de UNAB...', 'warning');
          startSentinelWatch({ targetMeal: runMeal, targetDate: runDate });
        } else {
          globalSniper.status = 'FINISHED';
          globalSniper.running = false;
          broadcastSSE('sniper-status', { ...globalSniper });
        }
      }
    } catch (err) {
      console.error('Error en sondeo de francotirador:', err);
    } finally {
      isPolling = false;
      if (burstDispatched && generation === engineGeneration) {
        isSniperBurstRunning = false;
      }
    }
  }, PUBLICATION_POLL_MS);
}

// Request Body Parser (safe and low memory)
async function parseJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 512) { // 512 KB max limit
        req.destroy();
        resolve({});
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const str = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(str ? JSON.parse(str) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

// Auth Helper
function getSessionFromReq(req) {
  const authHeader = req.headers['authorization'];
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    const cookie = req.headers['cookie'];
    if (cookie) {
      const match = cookie.match(/app-session=([^;]+)/);
      if (match) token = match[1];
    }
  }

  if (!token || !sessions.has(sessionKey(token))) return null;
  const sess = sessions.get(sessionKey(token));
  if (sess.expiresAt < Date.now()) {
    sessions.delete(sessionKey(token));
    db.saveSessions?.([...sessions]);
    return null;
  }
  return { token, ...sess };
}

// MIME Types
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

// HTTP Server
const server = http.createServer(async (req, res) => {
  // Use WHATWG URL standard (eliminates url.parse deprecation warning)
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);
  const pathname = reqUrl.pathname;
  const searchParams = reqUrl.searchParams;

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (pathname === '/api/version' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ version: APP_VERSION }));
  }

  const sendJson = async (status, data) => {
    try { await db.flush?.(); }
    catch { status = 503; data = { error: 'No se pudo confirmar el guardado. Vuelve a intentarlo.' }; }
    if (res.destroyed || res.writableEnded) return;
    if (typeof data?.error === 'string') data = { ...data, error: data.error.replace(/\bUNAB\b/g, 'la institución') };
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  if (pathname === '/api/service-policy' && req.method === 'GET') return sendJson(200, servicePolicy());

  try { await db.flush?.(); }
  catch { return sendJson(503, { error: 'PostgreSQL no está disponible.' }); }

  if (pathname === '/healthz') {
    try { await db.health?.(); return sendJson(200, { status: 'ok', storage: db.storageMode?.() || 'unknown' }); }
    catch { return sendJson(503, { status: 'database_unavailable' }); }
  }

  // --- SSE STREAM ---
  if (pathname === '/api/events') {
    const viewer = getSessionFromReq(req);
    if (!viewer) return sendJson(401, { error: 'Autenticación requerida.' });
    res.viewer = viewer;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', time: getLimaTimeString() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // --- SERVER TIME & TIMEZONE ---
  if (pathname === '/api/time') {
    const limaDate = getLimaDateObj();
    return sendJson(200, {
      timestamp: Date.now(),
      limaTime: getLimaTimeString(),
      today: getTodayLimaDate(0),
      tomorrow: getTodayLimaDate(1),
      hours: limaDate.getHours(),
      minutes: limaDate.getMinutes(),
      seconds: limaDate.getSeconds()
    });
  }

  // --- AUTHENTICATION ROUTES ---

  // POST /api/auth/login
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const { username, password } = body;

    if (!username || !password) {
      return sendJson(400, { success: false, error: 'Usuario y contraseña requeridos.' });
    }

    const cleanUsername = String(username).trim();
    let user = db.findUserByUsername(cleanUsername);

    // 1. SuperAdmin Login
    if (user && user.role === 'superadmin') {
      if (!db.verifyPassword(user, password)) {
        return sendJson(401, { success: false, error: 'Contraseña de administrador incorrecta.' });
      }
    } else {
      if (body.termsVersion !== TERMS_VERSION || body.processingConsent !== true) return sendJson(400, { error: 'Revisa los términos y autoriza el tratamiento para iniciar sesión.' });
      if (!user && enrollment(db.getAllUsers(false)).available === 0) return sendJson(409, { success: false, error: capacityError().message });
      // 2. Student Login: Validate & self-register via official UNAB API
      const authResult = await authenticateStudentDirect(cleanUsername, password);
      if (!authResult.success) {
        // Fallback: If user already exists in DB and credentials match stored record
        if (user && ![401, 403].includes(authResult.status) && db.verifyPassword(user, password)) {
          // Allow login using stored account
        } else {
          return sendJson(authResult.code === 'MISSING_SESSION_TOKEN' || authResult.status >= 500 || authResult.status === 429 ? 503 : 401, { success: false, error: authResult.error || 'Credenciales no válidas en UNAB.' });
        }
      } else {
        // Re-read after upstream authentication, another request may have registered this user.
        user = db.findUserByUsername(cleanUsername);
        if (!user) {
          // Auto-register student immediately in database
          try { user = db.addUser({
            username: cleanUsername,
            password: password,
            role: 'user',
            name: authResult.profile.name || cleanUsername,
            dni: authResult.profile.dni || '',
            campus: authResult.profile.campus || 'LA_FLORIDA',
            active: true,
            autoSniper: true,
            targetMeal: 'ALMUERZO',
            unabToken: authResult.token
          }); } catch (error) { return sendJson(error.status || 400, { success: false, error: error.message }); }
          db.updateUser(user.id, { unabToken: authResult.token });
          user = db.findUserById(user.id);
          emitLog(`Nuevo estudiante auto-registrado con cuenta UNAB: ${user.name} (${cleanUsername}).`, 'info');
        } else {
          // Existing student: update token, password and profile data
          db.updateUser(user.id, {
            password: password,
            unabToken: authResult.token,
            name: authResult.profile.name || user.name,
            dni: authResult.profile.dni || user.dni,
            campus: authResult.profile.campus || user.campus,
            lastLogin: new Date().toISOString()
          });
          user = db.findUserById(user.id);
        }
      }
    }

    if (!user.active) {
      return sendJson(403, { success: false, error: 'Tu cuenta ha sido desactivada por el administrador.' });
    }

    if (user.role !== 'superadmin' && user.unabToken && !isJwtExpired(user.unabToken)) clearAuthIssue(user.id);
    if (user.role !== 'superadmin') db.updateUser(user.id, { legalConsent: { version: TERMS_VERSION, acceptedAt: new Date().toISOString(), processing: true } });

    // Create session token
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(sessionKey(token), {
      userId: user.id,
      username: user.username,
      role: user.role,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
    });

    db.saveSessions?.([...sessions]);
    db.addAuditLog(`Inicio de sesión de ${user.username} (${user.role}).`, 'info');

    const { password: _, unabToken: __, ...safeUser } = user;
    res.setHeader('Set-Cookie', `app-session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    return sendJson(200, {
      success: true,
      token,
      user: { ...safeUser, ...(user.role !== 'superadmin' ? { enrollment: enrollment(db.getAllUsers(false), user.id) } : {}) }
    });
  }

  // GET /api/auth/me
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const session = getSessionFromReq(req);
    if (!session) return sendJson(401, { authenticated: false });

    const user = db.findUserById(session.userId);
    if (!user) return sendJson(401, { authenticated: false });

    const { password, unabToken, ...safeUser } = user;
    return sendJson(200, { authenticated: true, user: { ...safeUser, ...(user.role !== 'superadmin' ? { enrollment: enrollment(db.getAllUsers(false), user.id) } : {}) } });
  }

  // POST /api/auth/logout
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const session = getSessionFromReq(req);
    if (session) { sessions.delete(sessionKey(session.token)); db.saveSessions?.([...sessions]); }
    res.setHeader('Set-Cookie', 'app-session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return sendJson(200, { success: true });
  }

  // --- SUPERADMIN ROUTES ---
  const session = getSessionFromReq(req);
  if (pathname.startsWith('/api/sniper/') && session?.role !== 'superadmin') return sendJson(403, { error: 'Acceso de administrador requerido.' });

  if (pathname === '/api/student/authorization' && req.method === 'DELETE') {
    if (!session || session.role === 'superadmin') return sendJson(403, { error: 'Acceso de estudiante requerido.' });
    const user = db.findUserById(session.userId);
    if (!user) return sendJson(404, { error: 'Usuario no encontrado.' });
    db.updateUser(user.id, { password: '', unabToken: '', autoSniper: false, premium: { enabled: false, meals: [], endDate: '' }, legalConsent: null, automationConsent: { enabled: false, autoCancel: false, revokedAt: new Date().toISOString() } });
    for (const item of db.getAdvanceReservations({ alumnoCodigo: user.username, status: 'ACTIVA' })) db.cancelAdvanceReservation(item.id);
    for (const [key, value] of sessions) if (value.userId === user.id) sessions.delete(key);
    db.saveSessions([...sessions]);
    res.setHeader('Set-Cookie', 'app-session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return sendJson(200, { success: true });
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!session || session.role !== 'superadmin') {
      return sendJson(403, { error: 'Acceso denegado. Se requieren permisos de SuperAdmin.' });
    }

    // Administrative queue cancellation is local and never depends on the student's institutional session.
    if (pathname.startsWith('/api/admin/advance-reservations/') && req.method === 'DELETE') {
      const advanceId = pathname.slice('/api/admin/advance-reservations/'.length);
      const advance = db.getAdvanceReservations().find(item => item.id === advanceId);
      if (!advance) return sendJson(404, { success: false, error: 'Solicitud no encontrada.' });
      const view = requestView(advance, db.getAllReservations());
      if (['CONFIRMADA', 'CONSUMIDA'].includes(view.status)) return sendJson(409, { success: false, error: 'Esta solicitud ya tiene un ticket confirmado o consumido. Retirarla de la cola no cancela el ticket institucional.' });
      if (advance.status !== 'ANULADA') {
        const student = db.findUserByUsername(advance.alumnoCodigo);
        if (student && reserveOnce.isSubmitting(student.id, advance.fecha, advance.tipoComida)) return sendJson(409, { success: false, error: 'La petición de reserva ya fue enviada a la institución. Espera su resultado antes de cancelar; retirarla de la cola no anula una reserva en proceso.' });
        if (student) reserveOnce.invalidate(student.id, advance.fecha, advance.tipoComida);
        db.cancelAdvanceReservation(advance.id);
        emitLog(`[ADMIN] ${session.username} canceló la solicitud ${advance.tipoComida} de ${advance.alumnoCodigo} para ${advance.fecha}.`, 'info');
        checkAndManageSentinelQueue();
        tickRailwayMasterScheduler();
        broadcastSSE('advance-reservation-cancelled', { id: advance.id, student: advance.alumnoCodigo });
        broadcastSSE('sentinel-queue-updated', { queue: getStudentsInSentinelQueue(globalSniper.targetDate, globalSniper.targetMeal) });
      }
      return sendJson(200, { success: true, id: advance.id, status: 'ANULADA', message: 'Solicitud cancelada y retirada de la cola. La cuenta y su plan se conservan.' });
    }

    if (pathname.startsWith('/api/admin/premium/') && req.method === 'PUT') {
      const userId = pathname.slice('/api/admin/premium/'.length);
      const user = db.findUserById(userId);
      if (!user || user.role === 'superadmin') return sendJson(404, { error: 'Estudiante no encontrado' });
      try {
        const body = await parseJsonBody(req);
        const plan = validatePremium(body);
        const membership = enrollment(db.getAllUsers(false), user.id);
        if (plan.enabled && !membership.admitted) return sendJson(409, { error: capacityError().message });
        plan.managedBy = 'admin';
        plan.updatedBy = session.userId;
        plan.updatedAt = new Date().toISOString();
        db.updateUser(user.id, {
          premium: plan,
          automationConsent: { enabled: plan.enabled, autoCancel: plan.enabled && body.autoCancel === true, source: 'admin', configuredBy: session.userId, configuredAt: plan.updatedAt }
        });
        await premiumService.tick();
        return sendJson(200, { success: true, premium: plan });
      } catch (error) { return sendJson(400, { error: error.message }); }
    }

    // GET /api/admin/users
    if (pathname === '/api/admin/users' && req.method === 'GET') {
      const users = db.getAllUsers(true);
      const allReservations = db.getAllReservations();
      const allAdvance = db.getAdvanceReservations();
      const tomorrowStr = getTodayLimaDate(1);
      const todayStr = getTodayLimaDate(0);

      // Enhance each user with their consolidated reservations activity
      const enhancedUsers = users.map(u => {
        const tomorrowRes = allReservations.filter(r => (r.alumnoCodigo === u.username || (u.dni && r.alumnoDni === u.dni)) && r.fecha === tomorrowStr);
        const tomorrowAdv = allAdvance.filter(r => (r.alumnoCodigo === u.username || (u.dni && r.alumnoDni === u.dni)) && r.fecha === tomorrowStr);

        // Merge tomorrow reservations and advance appointments
        const mapManana = new Map();
        tomorrowAdv.forEach(a => {
          mapManana.set(a.tipoComida, {
            id: a.id,
            meal: a.tipoComida,
            status: a.status,
            isAdvance: true,
            qrToken: a.qrToken
          });
        });
        tomorrowRes.forEach(r => {
          mapManana.set(r.tipoComida, {
            id: r.id,
            meal: r.tipoComida,
            status: r.estado,
            isTicket: true,
            qrToken: r.qrToken
          });
        });

        const todayRes = allReservations.filter(r => (r.alumnoCodigo === u.username || (u.dni && r.alumnoDni === u.dni)) && r.fecha === todayStr);

        return {
          ...u,
          reservasManana: Array.from(mapManana.values()),
          reservasHoy: todayRes.map(r => ({ meal: r.tipoComida, status: r.estado, id: r.id }))
        };
      });

      return sendJson(200, { users: enhancedUsers });
    }

    // POST /api/admin/users
    if (pathname === '/api/admin/users' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      try {
        const created = db.addUser(body);
        return sendJson(201, { success: true, user: created });
      } catch (e) {
        return sendJson(e.status || 400, { success: false, error: e.message });
      }
    }

    // PUT /api/admin/users/:id
    if (pathname.startsWith('/api/admin/users/') && req.method === 'PUT') {
      const userId = pathname.replace('/api/admin/users/', '');
      const body = await parseJsonBody(req);
      try {
        if (body.premium !== undefined || body.premiumRequest !== undefined || body.legalConsent !== undefined || body.automationConsent !== undefined) return sendJson(400, { error: 'Usa los controles específicos. Las autorizaciones deben registrarse por el estudiante.' });
        const updated = db.updateUser(userId, body);
        return sendJson(200, { success: true, user: updated });
      } catch (e) {
        return sendJson(e.status || 400, { success: false, error: e.message });
      }
    }

    // DELETE /api/admin/users/:id
    if (pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') {
      const userId = pathname.replace('/api/admin/users/', '');
      try {
        db.deleteUser(userId);
        return sendJson(200, { success: true });
      } catch (e) {
        return sendJson(e.status || 400, { success: false, error: e.message });
      }
    }

    // PUT /api/admin/reservas/:id/toggle - Activate/Deactivate student appointment
    if (pathname.startsWith('/api/admin/reservas/') && pathname.endsWith('/toggle') && req.method === 'PUT') {
      const parts = pathname.split('/');
      const resId = parts[parts.length - 2];
      try {
        const updated = db.toggleAdvanceReservation(resId);
        emitLog(`Administrador modificó cita ${resId} a estado: ${updated.status || updated.estado}.`, 'info');
        broadcastSSE('reservation-status-changed', { id: resId, status: updated.status || updated.estado });
        return sendJson(200, { success: true, item: updated });
      } catch (err) {
        return sendJson(400, { success: false, error: err.message });
      }
    }

    // GET /api/admin/reservas
    if (pathname === '/api/admin/reservas' && req.method === 'GET') {
      return sendJson(200, { reservas: db.getAllReservations(), advance: db.getAdvanceReservations() });
    }

    // GET /api/admin/backup
    if (pathname === '/api/admin/backup' && req.method === 'GET') {
      const backup = db.backupDatabase();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="mi_mesa_backup_${getTodayLimaDate(0)}.json"`
      });
      return res.end(JSON.stringify(backup, null, 2));
    }

    // POST /api/admin/restore
    if (pathname === '/api/admin/restore' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      try {
        db.restoreDatabase(body);
        return sendJson(200, { success: true, message: 'Base de datos restaurada correctamente.' });
      } catch (err) {
        return sendJson(400, { success: false, error: err.message });
      }
    }

    // GET /api/admin/metrics (RAM, CPU, Uptime)
    if (pathname === '/api/admin/metrics' && req.method === 'GET') {
      const mem = process.memoryUsage();
      return sendJson(200, {
        memory: {
          rssMb: (mem.rss / 1024 / 1024).toFixed(2),
          heapUsedMb: (mem.heapUsed / 1024 / 1024).toFixed(2),
          heapTotalMb: (mem.heapTotal / 1024 / 1024).toFixed(2)
        },
        uptimeSeconds: Math.floor(process.uptime()),
        activeSessions: sessions.size,
        activeUsersCount: db.getAllUsers(true).filter(u => u.active).length,
        nodeVersion: process.version,
        platform: process.platform,
        isRailway: !!process.env.RAILWAY_STATIC_URL || !!process.env.RAILWAY_ENVIRONMENT
      });
    }

    // POST /api/admin/sniper/mass-fire
    if (pathname === '/api/admin/sniper/mass-fire' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      if (body.targetMeal) globalSniper.targetMeal = body.targetMeal;
      if (body.targetDate) globalSniper.targetDate = body.targetDate;
      executeMultiUserBurst();
      return sendJson(200, { success: true, message: `Disparo lanzado para ${globalSniper.targetMeal}.` });
    }
  }

  // --- STUDENT ADVANCE RESERVATION ROUTES ---

  if (pathname === '/api/student/premium/checkout' && req.method === 'POST') {
    return sendJson(410, { error: 'La modalidad de pago por funciones fue retirada. Los aportes voluntarios no activan funciones.' });
  }

  if (pathname === '/api/student/premium' && ['GET', 'PUT'].includes(req.method)) {
    if (!session) return sendJson(401, { error: 'Autenticación requerida' });
    const user = db.findUserById(session.userId);
    if (!user || user.role === 'superadmin') return sendJson(403, { error: 'Acceso de estudiante requerido' });
    if (req.method === 'PUT') {
      return sendJson(403, { error: 'Premium y sus servicios solo pueden ser configurados por el administrador. Contacta por WhatsApp al +51 923 887 478.' });
    }
    const today = getTodayLimaDate(0);
    const appointments = db.getAdvanceReservations({ alumnoCodigo: user.username })
      .filter(item => item.fecha === today)
      .map(item => {
        const view = requestView(item, db.getAllReservations());
        const cfg = MEAL_CONFIGS[item.tipoComida];
        const beforeClose = cfg && Date.now() < Date.parse(`${today}T${cfg.horaFin}-05:00`) - (user.automationConsent?.autoCancel ? 40000 : 0);
        return { ...view, authPending: view.status === 'ACTIVA' && institutionalSessionState(user) !== 'READY',
          sessionNeedsLogin: view.status === 'ACTIVA' && institutionalSessionState(user) === 'ACTION_REQUIRED',
          canRequestAgain: Boolean(['ANULADA', 'PAUSADA'].includes(view.status) && beforeClose && enrollment(db.getAllUsers(false), user.id).admitted) };
      });
    return sendJson(200, { success: true, premium: user.premium || { enabled: false, meals: [], endDate: '' }, active: isPremium(user), appointments, automationConsent: user.automationConsent || null, paymentRequest: user.premiumRequest || null });
  }

  if (pathname === '/api/student/enrollment' && req.method === 'GET') {
    if (!session) return sendJson(401, { error: 'Autenticación requerida' });
    const user = db.findUserById(session.userId);
    if (!user || user.role === 'superadmin') return sendJson(403, { error: 'Acceso de estudiante requerido' });
    const membership = enrollment(db.getAllUsers(false), user.id);
    const state = institutionalSessionState(user);
    if (membership.admitted && state === 'RECOVERING') getValidUnabToken(user, false, { timeoutMs: 5000, skipProfile: true }).catch(() => {});
    return sendJson(200, { enrollment: membership, sessionNeedsLogin: membership.admitted && state === 'ACTION_REQUIRED', sessionState: state });
  }

  // GET /api/student/advance-reservations?fecha=YYYY-MM-DD
  if (pathname === '/api/student/advance-reservations' && req.method === 'GET') {
    if (!session) return sendJson(401, { error: 'Autenticación requerida' });
    const user = db.findUserById(session.userId);
    if (!user) return sendJson(401, { error: 'Usuario no encontrado' });

    const fecha = searchParams.get('fecha') || getTodayLimaDate(0);
    if (fecha !== getTodayLimaDate(0)) return sendJson(400, { error: 'Las solicitudes están disponibles solo para hoy.' });
    const reservations = db.getAdvanceReservations({
      alumnoCodigo: user.username,
      fecha
    });

    return sendJson(200, { success: true, data: reservations });
  }

  // POST /api/student/advance-reservation
  if (pathname === '/api/student/advance-reservation' && req.method === 'POST') {
    if (!session) return sendJson(401, { error: 'Autenticación requerida' });
    const user = db.findUserById(session.userId);
    if (!user) return sendJson(401, { error: 'Usuario no encontrado' });

    const membership = enrollment(db.getAllUsers(false), user.id);
    if (!membership.admitted) return sendJson(409, { error: capacityError().message, enrollment: membership });

    const body = await parseJsonBody(req);
    const meal = (body.meal || 'ALMUERZO').toUpperCase();
    const date = body.date || getTodayLimaDate(0);
    if (date !== getTodayLimaDate(0)) return sendJson(400, { error: 'Solo puedes reservar para hoy.' });
    if (!MEALS.includes(meal)) return sendJson(400, { error: 'Servicio inválido.' });

    // Schedule validation for today:
    const todayLima = getTodayLimaDate(0);
    const nowLima = getLimaDateObj();
    const currentH = nowLima.getHours();
    const currentM = nowLima.getMinutes();

    if (date === todayLima) {
      if (meal === 'DESAYUNO' && (currentH > 10 || (currentH === 10 && currentM >= 30))) {
        return sendJson(400, { success: false, error: 'El horario de Desayuno para hoy (06:30 - 10:30) ya finalizó.' });
      }
      if (meal === 'ALMUERZO' && currentH >= 16) {
        return sendJson(400, { success: false, error: 'El horario de Almuerzo para hoy (11:00 - 16:00) ya finalizó.' });
      }
      if (meal === 'CENA' && (currentH > 19 || (currentH === 19 && currentM >= 0))) {
        return sendJson(400, { success: false, error: 'El horario de Cena para hoy (17:00 - 19:00) ya finalizó.' });
      }
    }

    // Check if user already has an active confirmed ticket
    const existingTicket = db.getAllReservations().find(r => 
      (r.alumnoCodigo === user.username || (user.dni && r.alumnoDni === user.dni)) &&
      r.tipoComida === meal &&
      r.fecha === date &&
      ['ACTIVA', 'CONSUMIDA'].includes(r.estado)
    );
    if (existingTicket) {
      return sendJson(400, { success: false, error: existingTicket.estado === 'CONSUMIDA' ? `Ya consumiste ${meal} el ${date}. Puedes solicitar otro servicio.` : `Ya cuentas con un ticket confirmado para ${meal} el ${date}.` });
    }

    // Create the advance reservation record
    const advance = db.createAdvanceReservation({
      alumnoCodigo: user.username,
      alumnoNombre: user.name,
      alumnoDni: user.dni,
      tipoComida: meal,
      fecha: date,
      campus: user.campus || 'LA_FLORIDA'
    });

    // Check if we are currently inside the active service window (after opening time):
    const inServiceWindow = isMealInServiceWindow(meal, date);
    let confirmedTicket = null;

    if (inServiceWindow) {
      // Meal has ALREADY opened today: check UNAB API immediately for available tickets
      const token = await getValidUnabToken(user);
      if (token) {
        try {
          const progRes = await fetchComedorApi(`/programacion/me?date=${date}`, token);
          if (progRes.ok && Array.isArray(progRes.data?.data)) {
            const progItem = progRes.data.data.find(i => (i.tipoComida || '').toUpperCase() === meal);
            const disponibles = progItem ? (progItem.disponibleLibre ?? progItem.cupoLibre ?? 0) : 0;
            if (progItem && disponibles > 0) {
              const bookRes = await reserveOnce(user.id, token, progItem.id, date, meal,
                () => canReserveService(user, meal, date) &&
                  db.getAdvanceReservations({ alumnoCodigo: user.username, fecha: date, status: 'ACTIVA' })
                    .some(item => item.id === advance.id));
              if (bookRes.ok && bookRes.data?.success) {
                confirmedTicket = bookRes.data.data;
                db.recordReservation({
                  ...confirmedTicket,
                  alumnoNombre: user.name,
                  alumnoCodigo: user.username,
                  alumnoDni: user.dni,
                  tipoComida: meal,
                  fecha: date,
                  estado: confirmedTicket.estado || 'ACTIVA'
                });
                db.markAdvanceReservationConfirmed(advance.id, confirmedTicket);
                emitLog(`[RESERVA] Reserva confirmada en ventanilla para ${user.name} (${meal} del ${date}).`, 'success');
              }
            }
          }
        } catch (e) {
          console.error('Error al sondear UNAB:', e);
        }
      }

      // If tickets were exhausted (0 cupos) during active service window:
      // Activate Sentinel to catch freed/cancelled tickets!
      if (!confirmedTicket) {
        emitLog(`[CENTINELA] Horario de ${meal} en curso. Reserva pendiente de confirmación. Activando Centinela para volver a consultar UNAB...`, 'info');
        startSentinelWatch({ targetMeal: meal, targetDate: date });
      }
    } else {
      // Opening time has NOT arrived yet (e.g. at 1 AM for Cena 17:00, or tomorrow):
      // Pure advance reservation for the Francotirador opening. Centinela MUST NOT activate!
      emitLog(`[AUTOPILOT] Reserva anticipada registrada para ${user.name} (${meal} del ${date}). Francotirador disparará automáticamente a las ${MEAL_CONFIGS[meal]?.horaInicio || '17:00'}.`, 'info');
    }

    broadcastSSE('advance-reservation-created', advance);
    tickRailwayMasterScheduler();

    let clientMsg = '';
    if (confirmedTicket) {
      clientMsg = `¡Ticket oficial UNAB de ${meal} reservado con éxito!`;
    } else if (inServiceWindow) {
      clientMsg = `¡Te has puesto en cola para ${meal}! El Centinela está activo buscando cupos liberados.`;
    } else {
      clientMsg = `¡Reserva anticipada para ${meal} registrada! El Francotirador disparará automáticamente a las ${MEAL_CONFIGS[meal]?.horaInicio || '17:00'}.`;
    }

    return sendJson(200, {
      success: true,
      data: advance,
      confirmedTicket,
      inQueue: !confirmedTicket,
      message: clientMsg
    });
  }

  // DELETE /api/student/advance-reservation/:id
  if (pathname.startsWith('/api/student/advance-reservation/') && req.method === 'DELETE') {
    if (!session) return sendJson(401, { error: 'Autenticación requerida' });
    const user = db.findUserById(session.userId);
    if (!user) return sendJson(401, { error: 'Usuario no encontrado' });

    const advId = pathname.replace('/api/student/advance-reservation/', '');
    const ownRequest = db.getAdvanceReservations({ alumnoCodigo: user.username }).find(item => item.id === advId);
    if (!ownRequest) return sendJson(404, { error: 'Solicitud no encontrada.' });
    if (['CONFIRMADA', 'CONSUMIDA'].includes(requestView(ownRequest, db.getAllReservations()).status)) return sendJson(409, { error: 'La solicitud ya tiene un ticket confirmado. Cancela el ticket desde tus pases.' });
    if (reserveOnce.isSubmitting(user.id, ownRequest.fecha, ownRequest.tipoComida)) return sendJson(409, { error: 'La petición de reserva ya fue enviada. Espera su resultado para cancelar el ticket si llega a confirmarse.' });
    reserveOnce.invalidate(user.id, ownRequest.fecha, ownRequest.tipoComida);
    db.cancelAdvanceReservation(advId);

    // If student cancels their advance reservation/queue spot, check queue and auto-shutdown Sentinel if empty
    checkAndManageSentinelQueue();
    tickRailwayMasterScheduler();

    broadcastSSE('advance-reservation-cancelled', { id: advId });
    broadcastSSE('sentinel-queue-updated', { queue: getStudentsInSentinelQueue(globalSniper.targetDate, globalSniper.targetMeal) });
    return sendJson(200, { success: true, message: 'Cita anticipada anulada. Cola de centinela actualizada.' });
  }

  // --- COMEDOR API (STUDENT & GENERAL) ---

  // GET /api/comedor/programacion?date=YYYY-MM-DD
  if (pathname === '/api/comedor/programacion' && req.method === 'GET') {
    const dateParam = searchParams.get('date') || getTodayLimaDate(0);
    if (dateParam !== getTodayLimaDate(0)) return sendJson(400, { error: 'La disponibilidad se consulta solo para hoy.' });
    let token = null;

    if (session && session.userId) {
      const u = db.findUserById(session.userId);
      if (u) token = await getValidUnabToken(u);
      if (!token) return sendJson(503, { error: 'No se pudo autenticar tu sesión en UNAB. Vuelve a consultar.' });
    }

    if (!token) {
      const defaultStudent = db.getAllUsers(false).find(u => u.role !== 'superadmin');
      if (defaultStudent) token = await getValidUnabToken(defaultStudent);
    }

    if (!token) {
      return sendJson(503, { error: 'No hay credenciales válidas para consultar la API de UNAB.' });
    }

    const result = await fetchComedorApi(`/programacion/me?date=${dateParam}`, token);
    return sendJson(result.status, result.data);
  }

  // GET /api/comedor/reservas?fecha=YYYY-MM-DD
  if (pathname === '/api/comedor/reservas' && req.method === 'GET') {
    if (!session) return sendJson(401, { error: 'Autenticación requerida' });
    const user = db.findUserById(session.userId);
    if (!user || user.role === 'superadmin') {
      return sendJson(200, { success: true, data: db.getAllReservations() });
    }

    const token = await getValidUnabToken(user);
    if (!token) return sendJson(503, { error: 'UNAB no pudo preparar la sesión. Vuelve a intentarlo.' });

    const fechaParam = searchParams.get('fecha') || getTodayLimaDate(0);
    const result = await fetchComedorApi(`/reservas/me?fecha=${fechaParam}`, token);

    if (result.ok && Array.isArray(result.data?.data)) {
      if (typeof db.recordReservations === 'function') {
        db.recordReservations(result.data.data.map(ticket => ({ ...ticket, alumnoCodigo: user.username, alumnoDni: user.dni, alumnoNombre: user.name })));
      } else {
        result.data.data.forEach(t => db.recordReservation({ ...t, alumnoCodigo: user.username, alumnoDni: user.dni, alumnoNombre: user.name }));
      }
    }

    return sendJson(result.status, result.data);
  }

  // POST /api/comedor/reservar
  if (pathname === '/api/comedor/reservar' && req.method === 'POST') {
    if (!session) return sendJson(401, { error: 'Autenticación requerida' });
    const user = db.findUserById(session.userId);
    if (!user) return sendJson(401, { error: 'Usuario no encontrado' });

    const membership = enrollment(db.getAllUsers(false), user.id);
    if (!membership.admitted) return sendJson(409, { error: capacityError().message, enrollment: membership });

    const token = await getValidUnabToken(user);
    if (!token) return sendJson(401, { error: 'No se pudo conectar a UNAB' });

    const body = await parseJsonBody(req);
    const progId = body.programacionId;
    if (!progId) return sendJson(400, { error: 'programacionId es obligatorio' });

    emitLog(`Intento de reserva manual para ${user.name} (ID: ${progId})...`, 'info');
    const date = body.fecha || getTodayLimaDate(0);
    if (date !== getTodayLimaDate(0)) return sendJson(400, { error: 'Solo puedes reservar para hoy.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(400, { error: 'Fecha inválida' });
    const programming = await fetchComedorApi(`/programacion/me?date=${date}`, token);
    const item = programming.ok && Array.isArray(programming.data?.data) &&
      programming.data.data.find(item => String(item.id) === String(progId));
    if (!item?.tipoComida) return sendJson(503, { error: 'No se pudo verificar el servicio solicitado en UNAB.' });
    const result = await reserveOnce(user.id, token, progId, date, item.tipoComida);

    if (result.ok && result.data?.success) {
      emitLog(`[RESERVA] Confirmada para ${user.name}: ${result.data.message}`, 'success');
      if (result.data.data) {
        db.recordReservation({
          ...result.data.data,
          alumnoNombre: user.name,
          alumnoCodigo: user.username,
          alumnoDni: user.dni,
          estado: result.data.data.estado || 'ACTIVA'
        });
      }
    } else {
      emitLog(`[ERROR] Fallo en reserva para ${user.name}: ${result.data?.message || result.error}`, 'error');
    }

    return sendJson(result.status, result.data);
  }

  // DELETE /api/comedor/reservas/:id
  if (pathname.startsWith('/api/comedor/reservas/') && req.method === 'DELETE') {
    if (!session) return sendJson(401, { error: 'Autenticación requerida' });
    const user = db.findUserById(session.userId);
    if (!user) return sendJson(401, { error: 'Usuario no encontrado' });

    const resId = pathname.replace('/api/comedor/reservas/', '');
    const knownTicket = db.getAllReservations().find(ticket => String(ticket.id) === resId);
    if (knownTicket && knownTicket.alumnoCodigo !== user.username) return sendJson(404, { error: 'Ticket no encontrado.' });
    if (knownTicket) reserveOnce.invalidate(user.id, knownTicket.fecha, knownTicket.tipoComida);
    const token = await getValidUnabToken(user);
    if (!token) return sendJson(503, { error: 'Estamos recuperando tu sesión institucional. Vuelve a consultar el estado de la cancelación.' });

    const result = await fetchComedorApi(`/reservas/${encodeURIComponent(resId)}`, token, { method: 'DELETE' });
    if (result.ok && result.data?.success !== false) {
      db.updateReservationStatus(resId, 'ANULADA');
      for (const advance of db.getAdvanceReservations({ alumnoCodigo: user.username })) {
        if ((advance.ticketId === resId || (knownTicket && advance.fecha === knownTicket.fecha && advance.tipoComida === knownTicket.tipoComida)) && ['ACTIVA', 'CONFIRMADA'].includes(advance.status)) db.cancelAdvanceReservation(advance.id);
      }
      checkAndManageSentinelQueue();
      tickRailwayMasterScheduler();
      broadcastSSE('reservation-status-changed', { student: user.username, id: resId, status: 'ANULADA' });
      emitLog(`Reserva ${resId} anulada por ${user.name}.`, 'warning');
    }
    return sendJson(result.status, result.data);
  }

  // GET /api/comedor/estado
  if (pathname === '/api/comedor/estado' && req.method === 'GET') {
    if (!session) return sendJson(401, { error: 'Autenticación requerida' });
    const user = db.findUserById(session.userId);
    if (!user) return sendJson(401, { error: 'Usuario no encontrado' });
    const token = await getValidUnabToken(user);
    if (!token) return sendJson(401, { error: 'No token' });

    const result = await fetchComedorApi('/asistencias/me/estado', token);
    return sendJson(result.status, result.data);
  }

  // --- SNIPER CONTROLS ---

  // GET /api/sniper/status
  if (pathname === '/api/sniper/status' && req.method === 'GET') {
    const nextOpening = getNextMealOpening();
    const eligible = new Set(admittedStudents(db.getAllUsers(false)).filter(user => user.active && user.autoSniper).map(user => user.username));
    const activeAdvanceForNext = db.getAdvanceReservations({ fecha: nextOpening.date, status: 'ACTIVA' })
      .filter(a => a.tipoComida.toUpperCase() === nextOpening.meal.toUpperCase() && eligible.has(a.alumnoCodigo));
    const { queue, ...snapshotCounts } = getPendingQueueSnapshot();

    return sendJson(200, {
      ...globalSniper,
      mealConfigs: MEAL_CONFIGS,
      sentinelActive: !!sentinelIntervalId,
      ...snapshotCounts,
      nextOpening: {
        meal: nextOpening.meal,
        date: nextOpening.date,
        time: nextOpening.time,
        advanceCount: activeAdvanceForNext.length,
        msUntil: nextOpening.msUntil
      },
      railwaySchedulerActive: true,
      credentialRecoveryEnabled: db.credentialRecoveryEnabled?.() || false,
      activeCandidatesCount: admittedStudents(db.getAllUsers(false)).filter(u => u.active && u.autoSniper).length,
      serverTime: getLimaTimeString()
    });
  }

  // POST /api/sniper/start
  if (pathname === '/api/sniper/start' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    startGlobalSniper(body);
    return sendJson(200, { success: true, sniper: { ...globalSniper, sentinelActive: !!sentinelIntervalId } });
  }

  // POST /api/sniper/stop
  if (pathname === '/api/sniper/stop' && req.method === 'POST') {
    stopGlobalSniper();
    return sendJson(200, { success: true, sniper: { ...globalSniper, sentinelActive: false } });
  }

  // POST /api/sniper/sentinel/start
  if (pathname === '/api/sniper/sentinel/start' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    startSentinelWatch(body);
    return sendJson(200, { success: true, sniper: { ...globalSniper, sentinelActive: !!sentinelIntervalId } });
  }

  // GET /api/sniper/queue
  if (pathname === '/api/sniper/queue' && req.method === 'GET') {
    const snapshot = getPendingQueueSnapshot();
    return sendJson(200, {
      success: true,
      ...snapshot,
      sentinelActive: !!sentinelIntervalId,
      status: globalSniper.status,
      targetMeal: globalSniper.targetMeal,
      targetDate: globalSniper.targetDate
    });
  }

  // POST /api/sniper/sentinel/stop
  if (pathname === '/api/sniper/sentinel/stop' && req.method === 'POST') {
    stopSentinelWatch();
    return sendJson(200, { success: true, sniper: { ...globalSniper, sentinelActive: false } });
  }

  // --- STATIC FILE SERVING ---
  // Keep HTML, scripts and styles in sync across deployments and restored tabs.
  res.setHeader('Cache-Control', 'no-store');
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Acceso denegado');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const indexFallback = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexFallback, (err2, content) => {
        if (err2) {
          res.writeHead(404);
          return res.end('Not Found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content.toString('utf8').replaceAll('__APP_VERSION__', APP_VERSION));
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    if (ext === '.html') {
      return fs.readFile(filePath, 'utf8', (error, content) => {
        if (error) { res.writeHead(500); return res.end('No se pudo cargar la página.'); }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content.replaceAll('__APP_VERSION__', APP_VERSION));
      });
    }
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

const premiumService = createPremiumService({ db, configs: MEAL_CONFIGS, getToken: user => getValidUnabToken(user, false, { timeoutMs: 5000 }), callApi: fetchComedorApi, log: emitLog, requestIntervalMs: upstreamGate.intervalMs });
let premiumIntervalId = null;

async function startServer() {
  await db.initialize?.();
  for (const [key, value] of db.getSessions?.() || []) {
    if (value.expiresAt > Date.now() && db.findUserById(value.userId)) sessions.set(key, value);
  }
  server.listen(PORT, '0.0.0.0', () => {
  console.log(db.credentialRecoveryEnabled?.() ? '[SESIONES] Recuperación cifrada entre reinicios habilitada.' : '[SESIONES] Recuperación entre reinicios deshabilitada: configura INSTITUTION_CREDENTIAL_KEY y vuelve a autenticar las cuentas existentes.');
  const mem = process.memoryUsage();
  console.log(`\n======================================================`);
  console.log(`[SISTEMA] MI MESA - AYUDA GRATUITA`);
  console.log(`======================================================`);
  console.log(`[HTTP] Servidor activo en puerto: ${PORT} (0.0.0.0)`);
  console.log(`[MEM] Consumo inicial de RAM: ${(mem.rss / 1024 / 1024).toFixed(2)} MB`);
  console.log(`[TIME] Hora Perú: ${getLimaTimeString()} (America/Lima)`);
  console.log(`[DEPLOY] Listo para despliegue en Railway`);
  console.log(`======================================================\n`);

  premiumIntervalId = setInterval(() => premiumService.tick().catch(error => console.error('Error en mantenimiento automático:', error)), 1000);
  premiumService.tick().catch(error => console.error('Error al iniciar automatización:', error));

  // Start the 24/7 Master Railway Scheduler
  masterSchedulerIntervalId = setInterval(tickRailwayMasterScheduler, 5000);
  tickRailwayMasterScheduler();
});

}
startServer().catch(() => {
  console.error('[INICIO] No se pudo inicializar el almacenamiento. Verifica la conexión configurada y los permisos del directorio de datos.');
  process.exitCode = 1;
  process.exit(1);
});
process.once('SIGTERM', async () => {
  server.close();
  try { await db.close?.(); process.exit(0); }
  catch { process.exit(1); }
});
