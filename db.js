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

const DEFAULT_DB = {
  users: [
    {
      id: 'admin-01',
      username: 'admin',
      password: 'admin12345',
      role: 'superadmin',
      name: 'Super Administrador Comedor',
      dni: '00000000',
      campus: 'LA_FLORIDA',
      active: true,
      autoSniper: false,
      targetMeal: 'ALMUERZO',
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
      cache = { ...DEFAULT_DB };
      saveDb(cache);
    }
  } catch (err) {
    console.error('Error al leer base de datos, usando por defecto:', err);
    cache = { ...DEFAULT_DB };
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
  return db.users.find(u => u.username.toLowerCase() === (username || '').toLowerCase());
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
    // Keep max 200 items in memory/disk
    if (db.reservas.length > 200) db.reservas.pop();
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
}

function getAllReservations() {
  const db = loadDb();
  return db.reservas || [];
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
  addAuditLog,
  getAuditLogs,
  getSettings,
  updateSettings
};
