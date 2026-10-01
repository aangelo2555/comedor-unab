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

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Active in-memory session tokens: { [token]: { userId, username, role, expiresAt } }
const sessions = new Map();

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
}, 10 * 60 * 1000);

// Global Sniper State (Keep timer IDs outside the object to prevent circular JSON serialization errors)
let sniperTimerId = null;
let sniperPollIntervalId = null;

const globalSniper = {
  running: false,
  status: 'IDLE', // IDLE, ARMED, RESERVING, FINISHED
  targetTime: '17:00:00',
  targetDate: getTodayLimaDate(1), // Default: Mañana
  targetMeal: 'ALMUERZO',
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
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function emitLog(message, type = 'info') {
  const entry = db.addAuditLog(message, type);
  console.log(`[${entry.time}] [${type.toUpperCase()}] ${message}`);
  broadcastSSE('log', entry);
}

// Authentication Service for UNAB
async function authenticateUserWithUnab(userRecord) {
  try {
    const res = await fetch('https://api-login-dev.unab.edu.pe/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer',
        'Origin': 'https://login-dev.unab.edu.pe',
        'Referer': 'https://login-dev.unab.edu.pe/'
      },
      body: JSON.stringify({ UserName: userRecord.username, userspassunab: userRecord.password })
    });

    const data = await res.json();
    if (!res.ok || !data.accessToken) {
      throw new Error(data.message || data.error || `HTTP ${res.status}`);
    }

    db.updateUser(userRecord.id, {
      unabToken: data.accessToken,
      lastLogin: new Date().toISOString()
    });

    // Fetch and update profile details
    const profileRes = await fetchComedorApi('/auth/me', data.accessToken);
    if (profileRes.ok && profileRes.data?.data) {
      const p = profileRes.data.data;
      db.updateUser(userRecord.id, {
        name: p.nombre || userRecord.name,
        dni: p.dni || userRecord.dni,
        campus: p.campus || userRecord.campus
      });
    }

    return { success: true, token: data.accessToken };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Comedor API Proxy Helper
async function fetchComedorApi(endpoint, token, options = {}) {
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

  try {
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 500, error: err.message };
  }
}

// Helper: Ensure user has valid UNAB token
async function getValidUnabToken(userRecord) {
  if (userRecord.unabToken) {
    const test = await fetchComedorApi('/alumnos/me/elegibilidad', userRecord.unabToken);
    if (test.ok) return userRecord.unabToken;
  }
  const auth = await authenticateUserWithUnab(userRecord);
  if (auth.success) return auth.token;
  return null;
}

// Multi-User Sniper Engine (Non-invasive, Schedule-aware, Multi-Meal Intelligent)
function startGlobalSniper(options = {}) {
  stopGlobalSniper();

  globalSniper.targetTime = options.targetTime || '17:00:00';
  globalSniper.targetDate = options.targetDate || getTodayLimaDate(1);
  globalSniper.targetMeal = (options.targetMeal || 'INTELIGENTE').toUpperCase();
  globalSniper.leadTimeMs = Number(options.leadTimeMs || 250);
  globalSniper.running = true;
  globalSniper.status = 'ARMED';
  globalSniper.lastRunResults = [];

  const [h, m, s] = globalSniper.targetTime.split(':').map(Number);
  const todayLima = getTodayLimaDate(0);
  const triggerIso = `${todayLima}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}-05:00`;
  let targetTs = new Date(triggerIso).getTime();

  let msUntilTarget = targetTs - Date.now();
  // If target time today has passed, trigger targets tomorrow
  if (msUntilTarget < -60000) {
    targetTs += 24 * 60 * 60 * 1000;
    msUntilTarget = targetTs - Date.now();
  }

  emitLog(`🎯 Francotirador armado para ${globalSniper.targetMeal} del ${globalSniper.targetDate}. Hora: ${globalSniper.targetTime}.`, 'info');
  broadcastSSE('sniper-status', { ...globalSniper });

  // Pre-warmup 30s before target
  const warmupMs = Math.max(0, msUntilTarget - 30000);
  setTimeout(async () => {
    if (!globalSniper.running) return;
    emitLog('🔥 Calentamiento de sesiones para alumnos activos...', 'info');
    const users = db.getAllUsers(false).filter(u => u.active && u.autoSniper && u.role !== 'superadmin');
    for (const u of users) {
      await getValidUnabToken(u);
    }
  }, warmupMs);

  // Trigger burst at target - leadTimeMs
  const triggerDelay = Math.max(0, msUntilTarget - globalSniper.leadTimeMs);
  sniperTimerId = setTimeout(() => {
    executeMultiUserBurst();
  }, triggerDelay);
}

function stopGlobalSniper() {
  if (sniperTimerId) clearTimeout(sniperTimerId);
  if (sniperPollIntervalId) clearInterval(sniperPollIntervalId);
  sniperTimerId = null;
  sniperPollIntervalId = null;
  globalSniper.running = false;
  globalSniper.status = 'IDLE';
  emitLog('Francotirador detenido.', 'info');
  broadcastSSE('sniper-status', { ...globalSniper });
}

async function executeMultiUserBurst() {
  if (!globalSniper.running && globalSniper.status === 'RESERVING') return;
  globalSniper.status = 'RESERVING';
  broadcastSSE('sniper-status', { ...globalSniper });

  const activeCandidates = db.getAllUsers(false).filter(u => u.active && u.autoSniper && u.role !== 'superadmin');
  if (activeCandidates.length === 0) {
    emitLog('No hay alumnos activos con auto-reserva o citas programadas.', 'warning');
    globalSniper.status = 'IDLE';
    globalSniper.running = false;
    broadcastSSE('sniper-status', { ...globalSniper });
    return;
  }

  emitLog(`🚀 ¡DISPARO INICIADO! Sondeando cupos para ${activeCandidates.length} alumno(s) [Modo: ${globalSniper.targetMeal}]...`, 'warning');

  let attempts = 0;
  const maxAttempts = 40;
  let menuFound = null;

  const probeUser = activeCandidates[0];
  const probeToken = await getValidUnabToken(probeUser);

  sniperPollIntervalId = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts || (!globalSniper.running && globalSniper.status !== 'RESERVING')) {
      clearInterval(sniperPollIntervalId);
      sniperPollIntervalId = null;
      if (globalSniper.status === 'RESERVING') {
        globalSniper.status = 'FINISHED';
        globalSniper.running = false;
        emitLog('Fin del ciclo de sondeo de francotirador.', 'warning');
        broadcastSSE('sniper-status', { ...globalSniper });
      }
      return;
    }

    try {
      const prog = await fetchComedorApi(`/programacion/me?date=${globalSniper.targetDate}`, probeToken);
      if (prog.ok && Array.isArray(prog.data?.data) && prog.data.data.length > 0) {
        clearInterval(sniperPollIntervalId);
        sniperPollIntervalId = null;
        menuFound = prog.data.data;
        emitLog(`✅ ¡Programación detectada con ${menuFound.length} servicios para ${globalSniper.targetDate}! Procesando reservas...`, 'success');

        // Multi-Meal Intelligent Dispatch per Student
        const userPromises = activeCandidates.map(async (student) => {
          const sToken = await getValidUnabToken(student);
          if (!sToken) {
            emitLog(`No se pudo autenticar a ${student.name} (${student.username})`, 'error');
            return { user: student.username, success: false, error: 'Auth failed' };
          }

          // Fetch student's advance reservations for this target date
          const studentAdvance = db.getAdvanceReservations({
            alumnoCodigo: student.username,
            fecha: globalSniper.targetDate,
            status: 'ACTIVA'
          });

          let mealsToReserve = [];
          if (globalSniper.targetMeal && !['TODAS', 'INTELIGENTE'].includes(globalSniper.targetMeal)) {
            mealsToReserve = [globalSniper.targetMeal.toUpperCase()];
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
            const burstReqs = [1, 2].map(async () => {
              return await fetchComedorApi('/reservas', sToken, {
                method: 'POST',
                body: JSON.stringify({ programacionId: targetItem.id })
              });
            });

            const results = await Promise.all(burstReqs);
            const okRes = results.find(r => r.ok && r.data?.success);

            if (okRes) {
              const ticket = okRes.data.data;
              db.recordReservation({
                id: ticket.id,
                alumnoCodigo: student.username,
                alumnoNombre: student.name,
                alumnoDni: student.dni,
                tipoComida: targetItem.tipoComida,
                fecha: globalSniper.targetDate,
                horaReserva: getLimaTimeString().slice(0, 8),
                qrToken: ticket.qrToken,
                estado: 'ACTIVA',
                campus: student.campus
              });

              // Mark advance reservation as confirmed if matched
              const matchAdv = studentAdvance.find(a => a.tipoComida.toUpperCase() === meal.toUpperCase());
              if (matchAdv) {
                db.markAdvanceReservationConfirmed(matchAdv.id, ticket);
              }

              emitLog(`🎉 ¡¡RESERVA CONFIRMADA para ${student.name}!! (${targetItem.tipoComida})`, 'success');
              studentResults.push({ meal, success: true, ticket });
            } else {
              const msg = results[0]?.data?.message || 'Cupos no disponibles';
              emitLog(`Resultado para ${student.name} (${meal}): ${msg}`, 'warning');
              studentResults.push({ meal, success: false, message: msg });
            }
          }

          return { user: student.username, results: studentResults };
        });

        const finalResults = await Promise.all(userPromises);
        globalSniper.lastRunResults = finalResults;
        globalSniper.status = 'FINISHED';
        globalSniper.running = false;
        broadcastSSE('sniper-status', { ...globalSniper });
        broadcastSSE('reservation-batch-finished', finalResults);
      }
    } catch (err) {
      console.error('Error en sondeo de francotirador:', err);
    }
  }, 140);
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

  if (!token || !sessions.has(token)) return null;
  const sess = sessions.get(token);
  if (sess.expiresAt < Date.now()) {
    sessions.delete(token);
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

  const sendJson = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  // --- SSE STREAM ---
  if (pathname === '/api/events') {
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

    let user = db.findUserByUsername(username);

    // If student not found locally, attempt UNAB API authentication to auto-enroll
    if (!user) {
      const tempUser = { username, password };
      const auth = await authenticateUserWithUnab(tempUser);
      if (auth.success) {
        user = db.addUser({
          username,
          password,
          role: 'user',
          name: username,
          active: true,
          autoSniper: true,
          targetMeal: 'ALMUERZO'
        });
      } else {
        return sendJson(401, { success: false, error: 'Credenciales inválidas en UNAB o sistema.' });
      }
    } else {
      if (user.password !== password) {
        return sendJson(401, { success: false, error: 'Contraseña incorrecta.' });
      }
    }

    if (!user.active) {
      return sendJson(403, { success: false, error: 'Tu cuenta ha sido desactivada por el administrador.' });
    }

    if (user.role !== 'superadmin') {
      authenticateUserWithUnab(user).catch(console.error);
    }

    // Create session token
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, {
      userId: user.id,
      username: user.username,
      role: user.role,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
    });

    db.addAuditLog(`Inicio de sesión de ${user.username} (${user.role}).`, 'info');

    const { password: _, unabToken: __, ...safeUser } = user;
    return sendJson(200, {
      success: true,
      token,
      user: safeUser
    });
  }

  // GET /api/auth/me
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const session = getSessionFromReq(req);
    if (!session) return sendJson(401, { authenticated: false });

    const user = db.findUserById(session.userId);
    if (!user) return sendJson(401, { authenticated: false });

    const { password, unabToken, ...safeUser } = user;
    return sendJson(200, { authenticated: true, user: safeUser });
  }

  // POST /api/auth/logout
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const session = getSessionFromReq(req);
    if (session) sessions.delete(session.token);
    return sendJson(200, { success: true });
  }

  // --- SUPERADMIN ROUTES ---
  const session = getSessionFromReq(req);

  if (pathname.startsWith('/api/admin/')) {
    if (!session || session.role !== 'superadmin') {
      return sendJson(403, { error: 'Acceso denegado. Se requieren permisos de SuperAdmin.' });
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
        const tomorrowRes = allReservations.filter(r => (r.alumnoCodigo === u.username || r.alumnoDni === u.dni) && r.fecha === tomorrowStr);
        const tomorrowAdv = allAdvance.filter(r => (r.alumnoCodigo === u.username || r.alumnoDni === u.dni) && r.fecha === tomorrowStr);

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

        const todayRes = allReservations.filter(r => (r.alumnoCodigo === u.username || r.alumnoDni === u.dni) && r.fecha === todayStr);

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
        return sendJson(400, { success: false, error: e.message });
      }
    }

    // PUT /api/admin/users/:id
    if (pathname.startsWith('/api/admin/users/') && req.method === 'PUT') {
      const userId = pathname.replace('/api/admin/users/', '');
      const body = await parseJsonBody(req);
      try {
        const updated = db.updateUser(userId, body);
        return sendJson(200, { success: true, user: updated });
      } catch (e) {
        return sendJson(400, { success: false, error: e.message });
      }
    }

    // DELETE /api/admin/users/:id
    if (pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') {
      const userId = pathname.replace('/api/admin/users/', '');
      try {
        db.deleteUser(userId);
        return sendJson(200, { success: true });
      } catch (e) {
        return sendJson(400, { success: false, error: e.message });
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
        'Content-Disposition': `attachment; filename="comedor_unab_backup_${getTodayLimaDate(0)}.json"`
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

  // GET /api/student/advance-reservations?fecha=YYYY-MM-DD
  if (pathname === '/api/student/advance-reservations' && req.method === 'GET') {
    if (!session) return sendJson(401, { error: 'Autenticación requerida' });
    const user = db.findUserById(session.userId);
    if (!user) return sendJson(401, { error: 'Usuario no encontrado' });

    const fecha = searchParams.get('fecha') || getTodayLimaDate(1);
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

    const body = await parseJsonBody(req);
    const meal = (body.meal || 'ALMUERZO').toUpperCase();
    const date = body.date || getTodayLimaDate(1);

    // Schedule validation for today:
    const todayLima = getTodayLimaDate(0);
    const nowLima = getLimaDateObj();
    const currentH = nowLima.getHours();
    const currentM = nowLima.getMinutes();

    if (date === todayLima) {
      if (meal === 'DESAYUNO' && (currentH > 10 || (currentH === 10 && currentM >= 30))) {
        return sendJson(400, { success: false, error: 'El horario de Desayuno para hoy (06:30 - 10:30) ya finalizó.' });
      }
      if (meal === 'ALMUERZO' && (currentH > 15 || (currentH === 15 && currentM >= 30))) {
        return sendJson(400, { success: false, error: 'El horario de Almuerzo para hoy (11:00 - 15:30) ya finalizó.' });
      }
      if (meal === 'CENA' && (currentH > 19 || (currentH === 19 && currentM >= 0))) {
        return sendJson(400, { success: false, error: 'El horario de Cena para hoy (17:00 - 19:00) ya finalizó.' });
      }
    }

    // Check if user already has an active confirmed ticket
    const existingTicket = db.getAllReservations().find(r => 
      (r.alumnoCodigo === user.username || r.alumnoDni === user.dni) &&
      r.tipoComida === meal &&
      r.fecha === date &&
      r.estado === 'ACTIVA'
    );
    if (existingTicket) {
      return sendJson(400, { success: false, error: `Ya cuentas con un ticket confirmado para ${meal} el ${date}.` });
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

    // Check if UNAB cupos are currently open on UNAB API:
    let confirmedTicket = null;
    const token = await getValidUnabToken(user);
    if (token) {
      try {
        const progRes = await fetchComedorApi(`/programacion/me?date=${date}`, token);
        if (progRes.ok && Array.isArray(progRes.data?.data)) {
          const progItem = progRes.data.data.find(i => (i.tipoComida || '').toUpperCase() === meal);
          const disponibles = progItem ? (progItem.disponibleLibre ?? progItem.cupoLibre ?? 0) : 0;
          if (progItem && disponibles > 0) {
            const bookRes = await fetchComedorApi('/reservas', token, {
              method: 'POST',
              body: JSON.stringify({ programacionId: progItem.id })
            });
            if (bookRes.ok && bookRes.data?.success) {
              confirmedTicket = bookRes.data.data;
              db.recordReservation({
                ...confirmedTicket,
                alumnoNombre: user.name,
                alumnoCodigo: user.username,
                alumnoDni: user.dni,
                tipoComida: meal,
                fecha: date,
                estado: 'ACTIVA'
              });
              db.markAdvanceReservationConfirmed(advance.id, confirmedTicket);
              emitLog(`🎉 ¡Reserva confirmada en ventanilla digital para ${user.name} (${meal} del ${date})!`, 'success');
            }
          }
        }
      } catch (e) {
        console.error('Error al sondear UNAB:', e);
      }
    }

    broadcastSSE('advance-reservation-created', advance);

    return sendJson(200, {
      success: true,
      data: advance,
      confirmedTicket,
      message: confirmedTicket
        ? `¡Ticket oficial UNAB de ${meal} reservado con éxito!`
        : `¡Cita anticipada registrada para ${meal} del ${date}! El sistema capturará tu cupo automáticamente.`
    });
  }

  // DELETE /api/student/advance-reservation/:id
  if (pathname.startsWith('/api/student/advance-reservation/') && req.method === 'DELETE') {
    if (!session) return sendJson(401, { error: 'Autenticación requerida' });
    const user = db.findUserById(session.userId);
    if (!user) return sendJson(401, { error: 'Usuario no encontrado' });

    const advId = pathname.replace('/api/student/advance-reservation/', '');
    db.cancelAdvanceReservation(advId);
    broadcastSSE('advance-reservation-cancelled', { id: advId });
    return sendJson(200, { success: true, message: 'Cita anticipada anulada.' });
  }

  // --- COMEDOR API (STUDENT & GENERAL) ---

  // GET /api/comedor/programacion?date=YYYY-MM-DD
  if (pathname === '/api/comedor/programacion' && req.method === 'GET') {
    const dateParam = searchParams.get('date') || getTodayLimaDate(0);
    let token = null;

    if (session && session.userId) {
      const u = db.findUserById(session.userId);
      if (u) token = await getValidUnabToken(u);
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
    if (!token) return sendJson(401, { error: 'Error de sesión en UNAB.' });

    const fechaParam = searchParams.get('fecha') || getTodayLimaDate(0);
    const result = await fetchComedorApi(`/reservas/me?fecha=${fechaParam}`, token);

    if (result.ok && Array.isArray(result.data?.data)) {
      result.data.data.forEach(t => db.recordReservation(t));
    }

    return sendJson(result.status, result.data);
  }

  // POST /api/comedor/reservar
  if (pathname === '/api/comedor/reservar' && req.method === 'POST') {
    if (!session) return sendJson(401, { error: 'Autenticación requerida' });
    const user = db.findUserById(session.userId);
    if (!user) return sendJson(401, { error: 'Usuario no encontrado' });

    const token = await getValidUnabToken(user);
    if (!token) return sendJson(401, { error: 'No se pudo conectar a UNAB' });

    const body = await parseJsonBody(req);
    const progId = body.programacionId;
    if (!progId) return sendJson(400, { error: 'programacionId es obligatorio' });

    emitLog(`Intento de reserva manual para ${user.name} (ID: ${progId})...`, 'info');
    const result = await fetchComedorApi('/reservas', token, {
      method: 'POST',
      body: JSON.stringify({ programacionId: progId })
    });

    if (result.ok && result.data?.success) {
      emitLog(`✅ Reserva confirmada para ${user.name}: ${result.data.message}`, 'success');
      if (result.data.data) {
        db.recordReservation({
          ...result.data.data,
          alumnoNombre: user.name,
          alumnoCodigo: user.username,
          alumnoDni: user.dni,
          estado: 'ACTIVA'
        });
      }
    } else {
      emitLog(`❌ Fallo en reserva para ${user.name}: ${result.data?.message || result.error}`, 'error');
    }

    return sendJson(result.status, result.data);
  }

  // DELETE /api/comedor/reservas/:id
  if (pathname.startsWith('/api/comedor/reservas/') && req.method === 'DELETE') {
    if (!session) return sendJson(401, { error: 'Autenticación requerida' });
    const user = db.findUserById(session.userId);
    if (!user) return sendJson(401, { error: 'Usuario no encontrado' });

    const resId = pathname.replace('/api/comedor/reservas/', '');
    const token = await getValidUnabToken(user);

    const result = await fetchComedorApi(`/reservas/${resId}`, token, { method: 'DELETE' });
    if (result.ok) {
      db.updateReservationStatus(resId, 'ANULADA');
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
    return sendJson(200, {
      ...globalSniper,
      activeCandidatesCount: db.getAllUsers(true).filter(u => u.active && u.autoSniper).length,
      serverTime: getLimaTimeString()
    });
  }

  // POST /api/sniper/start
  if (pathname === '/api/sniper/start' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    startGlobalSniper(body);
    return sendJson(200, { success: true, sniper: { ...globalSniper } });
  }

  // POST /api/sniper/stop
  if (pathname === '/api/sniper/stop' && req.method === 'POST') {
    stopGlobalSniper();
    return sendJson(200, { success: true, sniper: { ...globalSniper } });
  }

  // --- STATIC FILE SERVING ---
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
        res.end(content);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const mem = process.memoryUsage();
  console.log(`\n======================================================`);
  console.log(`🏛️  SISTEMA COMEDOR UNAB - SAAS & RESERVAS`);
  console.log(`======================================================`);
  console.log(`📡 Servidor activo en puerto: ${PORT} (0.0.0.0)`);
  console.log(`⚡ Consumo inicial de RAM: ${(mem.rss / 1024 / 1024).toFixed(2)} MB`);
  console.log(`🕒 Hora Perú: ${getLimaTimeString()} (America/Lima)`);
  console.log(`🚂 Listo para despliegue en Railway`);
  console.log(`======================================================\n`);
});
