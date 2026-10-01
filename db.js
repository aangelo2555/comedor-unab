/**
 * DATABASE ENGINE - ULTRA LOW RAM & ATOMIC PERSISTENCE
 * Zero external database drivers. Operates completely in pure Node.js.
 * Memory footprint: < 2MB.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Credentials configured via environment variables with safe defaults (NEVER exposed to frontend)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'aangelo2555@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Dotamipasion12345';

const DEFAULT_DB = {
  users: [
    {
      id: 'admin-01',
      username: ADMIN_EMAIL,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      role: 'superadmin',
      name: 'Super Administrador Comedor',
      dni: '00000000',
      campus: 'LA_FLORIDA',
      active: true,
      autoSniper: false,
      targetMeal: 'TODAS',
      unabToken: '',
      createdAt: new Date().toISOString()
    },
    {
      id: 'usr-angelo',
      username: '222.0113.028',
      password: 'Dotamipasion12345',
      role: 'user',
      name: 'SERNA SIMEON, ANGELO THOMAS',
      dni: '76448557',
      campus: 'LA_FLORIDA',
      active: true,
      autoSniper: true,
      targetMeal: 'ALMUERZO',
      unabToken: '',
      createdAt: new Date().toISOString()
    }
  ],
  reservas: [],
  advanceReservations: [],
  settings: {
    sniperTime: '17:00:00',
    leadTimeMs: 250,
    concurrency: 3,
    soundAlert: true
  },
  auditLogs: []
};

let cache = null;

function loadDb() {
  if (cache) return cache;
  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf8');
      cache = JSON.parse(content);
    } else {
      cache = JSON.parse(JSON.stringify(DEFAULT_DB));
      saveDb(cache);
    }
  } catch (err) {
    console.error('Error al leer base de datos, usando por defecto:', err);
    cache = JSON.parse(JSON.stringify(DEFAULT_DB));
  }

  // Self-healing: Ensure arrays exist
  if (!Array.isArray(cache.users)) cache.users = [];
  if (!Array.isArray(cache.reservas)) cache.reservas = [];
  if (!Array.isArray(cache.advanceReservations)) cache.advanceReservations = [];
  if (!Array.isArray(cache.auditLogs)) cache.auditLogs = [];
  if (!cache.settings) cache.settings = { ...DEFAULT_DB.settings };

  // Self-healing: Guarantee SuperAdmin user has the requested credentials
  let admin = cache.users.find(u => u.role === 'superadmin' || u.username === 'admin' || u.username === ADMIN_EMAIL);
  if (!admin) {
    admin = {
      id: 'admin-01',
      username: ADMIN_EMAIL,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      role: 'superadmin',
      name: 'Super Administrador Comedor',
      dni: '00000000',
      campus: 'LA_FLORIDA',
      active: true,
      autoSniper: false,
      targetMeal: 'TODAS',
      unabToken: '',
      createdAt: new Date().toISOString()
    };
    cache.users.unshift(admin);
  } else {
    // Keep username and password updated according to environment/request
    admin.username = ADMIN_EMAIL;
    admin.email = ADMIN_EMAIL;
    admin.password = ADMIN_PASSWORD;
    admin.role = 'superadmin';
  }

  // Self-healing: Guarantee student Angelo account exists
  let angelo = cache.users.find(u => u.username === '222.0113.028');
  if (!angelo) {
    cache.users.push({
      id: 'usr-angelo',
      username: '222.0113.028',
      password: 'Dotamipasion12345',
      role: 'user',
      name: 'SERNA SIMEON, ANGELO THOMAS',
      dni: '76448557',
      campus: 'LA_FLORIDA',
      active: true,
      autoSniper: true,
      targetMeal: 'ALMUERZO',
      unabToken: '',
      createdAt: new Date().toISOString()
    });
  }

  return cache;
}

function saveDb(data = cache) {
  try {
    cache = data;
    const tempFile = `${DB_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error('Error guardando en base de datos:', err);
  }
}

// User Helpers
function findUserByUsername(username) {
  const db = loadDb();
  const search = (username || '').toLowerCase().trim();
  return db.users.find(u => 
    u.username.toLowerCase() === search || 
    (u.email && u.email.toLowerCase() === search)
  );
}

function findUserById(id) {
  const db = loadDb();
  return db.users.find(u => u.id === id);
}

function getAllUsers(safe = true) {
  const db = loadDb();
  return db.users.map(u => {
    if (!safe) return u;
    const { password, unabToken, ...rest } = u;
    return rest;
  });
}

function addUser(userData) {
  const db = loadDb();
  if (findUserByUsername(userData.username)) {
    throw new Error(`El usuario ${userData.username} ya se encuentra registrado.`);
  }

  const newUser = {
    id: `usr-${crypto.randomBytes(4).toString('hex')}`,
    username: userData.username.trim(),
    password: userData.password.trim(),
    role: userData.role || 'user',
    name: userData.name || userData.username,
    dni: userData.dni || '',
    campus: userData.campus || 'LA_FLORIDA',
    active: userData.active !== undefined ? userData.active : true,
    autoSniper: !!userData.autoSniper,
    targetMeal: userData.targetMeal || 'ALMUERZO',
    unabToken: '',
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  saveDb(db);
  addAuditLog(`Usuario ${newUser.username} (${newUser.name}) creado por el administrador.`, 'info');
  const { password, unabToken, ...safeUser } = newUser;
  return safeUser;
}

function updateUser(id, updateData) {
  const db = loadDb();
  const idx = db.users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('Usuario no encontrado');

  const u = db.users[idx];
  if (updateData.name !== undefined) u.name = updateData.name;
  if (updateData.dni !== undefined) u.dni = updateData.dni;
  if (updateData.campus !== undefined) u.campus = updateData.campus;
  if (updateData.password) u.password = updateData.password;
  if (updateData.active !== undefined) u.active = updateData.active;
  if (updateData.autoSniper !== undefined) u.autoSniper = updateData.autoSniper;
  if (updateData.targetMeal) u.targetMeal = updateData.targetMeal;
  if (updateData.unabToken !== undefined) u.unabToken = updateData.unabToken;
  if (updateData.lastLogin) u.lastLogin = updateData.lastLogin;

  saveDb(db);
  const { password, unabToken, ...safeUser } = u;
  return safeUser;
}

function deleteUser(id) {
  const db = loadDb();
  const idx = db.users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('Usuario no encontrado');
  if (db.users[idx].role === 'superadmin' && db.users.filter(x => x.role === 'superadmin').length <= 1) {
    throw new Error('No puedes eliminar al único SuperAdministrador del sistema.');
  }

  const deleted = db.users.splice(idx, 1)[0];
  saveDb(db);
  addAuditLog(`Usuario ${deleted.username} eliminado.`, 'warning');
  return true;
}

// Reservations & History
function recordReservation(reserva) {
  const db = loadDb();
  const existing = db.reservas.find(r => r.id === reserva.id);
  if (!existing) {
    db.reservas.unshift({
      ...reserva,
      recordedAt: new Date().toISOString()
    });
    // Keep max 250 items in memory/disk
    if (db.reservas.length > 250) db.reservas.pop();
    saveDb(db);
  } else {
    Object.assign(existing, reserva);
    saveDb(db);
  }
}

function updateReservationStatus(id, newStatus) {
  const db = loadDb();
  const r = db.reservas.find(x => x.id === id);
  if (r) {
    r.estado = newStatus;
    saveDb(db);
  }
  // Also check advance reservations
  const adv = (db.advanceReservations || []).find(x => x.id === id);
  if (adv) {
    adv.status = newStatus;
    saveDb(db);
  }
}

function getAllReservations() {
  const db = loadDb();
  return db.reservas || [];
}

// --------------------------------------------------------------------------
// ADVANCE RESERVATION (RESERVA ANTICIPADA PARA MAÑANA) ENGINE
// --------------------------------------------------------------------------
function createAdvanceReservation(data) {
  const db = loadDb();
  if (!Array.isArray(db.advanceReservations)) db.advanceReservations = [];

  const existingIdx = db.advanceReservations.findIndex(r => 
    r.alumnoCodigo === data.alumnoCodigo && 
    r.tipoComida.toUpperCase() === data.tipoComida.toUpperCase() && 
    r.fecha === data.fecha
  );

  const reservationObj = {
    id: `adv-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    alumnoCodigo: data.alumnoCodigo,
    alumnoNombre: data.alumnoNombre,
    alumnoDni: data.alumnoDni,
    tipoComida: data.tipoComida.toUpperCase(),
    fecha: data.fecha,
    campus: data.campus || 'LA_FLORIDA',
    status: 'ACTIVA', // ACTIVA, PAUSADA, CONFIRMADA, ANULADA
    programacionId: data.programacionId || null,
    qrToken: data.qrToken || null,
    ticketId: data.ticketId || null,
    autoSniper: true,
    createdAt: new Date().toISOString()
  };

  if (existingIdx !== -1) {
    // If it was cancelled or paused, reactivate
    db.advanceReservations[existingIdx] = {
      ...db.advanceReservations[existingIdx],
      ...reservationObj,
      id: db.advanceReservations[existingIdx].id
    };
    saveDb(db);
    addAuditLog(`Cita anticipada actualizada: ${data.tipoComida} para ${data.alumnoNombre} (${data.fecha}).`, 'info');
    return db.advanceReservations[existingIdx];
  }

  db.advanceReservations.unshift(reservationObj);
  if (db.advanceReservations.length > 300) db.advanceReservations.pop();
  saveDb(db);
  addAuditLog(`Cita anticipada registrada: ${data.tipoComida} para ${data.alumnoNombre} (${data.fecha}).`, 'info');
  return reservationObj;
}

function getAdvanceReservations(filter = {}) {
  const db = loadDb();
  let list = db.advanceReservations || [];
  if (filter.fecha) {
    list = list.filter(r => r.fecha === filter.fecha);
  }
  if (filter.alumnoCodigo) {
    list = list.filter(r => r.alumnoCodigo === filter.alumnoCodigo);
  }
  if (filter.status) {
    list = list.filter(r => r.status === filter.status);
  }
  return list;
}

function toggleAdvanceReservation(id, newStatus) {
  const db = loadDb();
  const item = (db.advanceReservations || []).find(r => r.id === id);
  if (!item) {
    // Check if it's in standard reservations
    const res = (db.reservas || []).find(r => r.id === id);
    if (res) {
      res.estado = newStatus || (res.estado === 'ACTIVA' ? 'PAUSADA' : 'ACTIVA');
      saveDb(db);
      return res;
    }
    throw new Error('Cita o reserva no encontrada.');
  }

  item.status = newStatus || (item.status === 'ACTIVA' ? 'PAUSADA' : 'ACTIVA');
  saveDb(db);
  addAuditLog(`Estado de cita ${item.tipoComida} (${item.alumnoNombre}) cambiado a: ${item.status}`, 'info');
  return item;
}

function cancelAdvanceReservation(id) {
  const db = loadDb();
  const idx = (db.advanceReservations || []).findIndex(r => r.id === id);
  if (idx !== -1) {
    const cancelled = db.advanceReservations[idx];
    cancelled.status = 'ANULADA';
    saveDb(db);
    addAuditLog(`Cita anticipada anulada: ${cancelled.tipoComida} (${cancelled.alumnoNombre}).`, 'warning');
    return true;
  }
  return false;
}

function markAdvanceReservationConfirmed(id, ticketData) {
  const db = loadDb();
  const item = (db.advanceReservations || []).find(r => r.id === id);
  if (item) {
    item.status = 'CONFIRMADA';
    item.ticketId = ticketData.id;
    item.qrToken = ticketData.qrToken;
    saveDb(db);
  }
}

// Backup & Restore
function backupDatabase() {
  return loadDb();
}

function restoreDatabase(importedData) {
  if (!importedData || !Array.isArray(importedData.users)) {
    throw new Error('Estructura de respaldo inválida.');
  }
  saveDb(importedData);
  loadDb(); // Trigger self-healing
  addAuditLog('Base de datos restaurada desde respaldo JSON.', 'warning');
  return true;
}

// Audit logs
function addAuditLog(message, type = 'info') {
  const db = loadDb();
  const entry = {
    id: `log-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    time: new Date().toLocaleTimeString('es-PE', { timeZone: 'America/Lima' }),
    date: new Date().toISOString().slice(0, 10),
    message,
    type,
    timestamp: Date.now()
  };
  db.auditLogs.unshift(entry);
  if (db.auditLogs.length > 150) db.auditLogs.pop();
  saveDb(db);
  return entry;
}

function getAuditLogs() {
  const db = loadDb();
  return db.auditLogs || [];
}

function getSettings() {
  const db = loadDb();
  return db.settings || DEFAULT_DB.settings;
}

function updateSettings(newSettings) {
  const db = loadDb();
  db.settings = { ...db.settings, ...newSettings };
  saveDb(db);
  return db.settings;
}

module.exports = {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  loadDb,
  findUserByUsername,
  findUserById,
  getAllUsers,
  addUser,
  updateUser,
  deleteUser,
  recordReservation,
  updateReservationStatus,
  getAllReservations,
  createAdvanceReservation,
  getAdvanceReservations,
  toggleAdvanceReservation,
  cancelAdvanceReservation,
  markAdvanceReservationConfirmed,
  backupDatabase,
  restoreDatabase,
  addAuditLog,
  getAuditLogs,
  getSettings,
  updateSettings
};
