/* --------------------------------------------------------------------------
   COMEDOR UNAB - MINIMALIST CLIENT APPLICATION
   Multi-user, SuperAdmin, Student Portal, Low Memory Profile
   -------------------------------------------------------------------------- */

let currentAuth = null;
let serverOffset = 0;
let studentTickets = [];
let adminUsersList = [];

// Toast Helper
function showToast(message, type = 'info') {
  const shelf = document.getElementById('toastShelf');
  const toast = document.createElement('div');
  toast.className = 'toast-msg';
  toast.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span> <span>${message}</span>`;
  shelf.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

// Modal Helpers
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('active');
}

// Quick Fill helper for testing
function fillLogin(u, p) {
  document.getElementById('loginUsername').value = u;
  document.getElementById('loginPassword').value = p;
}

// Append Terminal Line
function logLine(targetId, time, message, type = 'info') {
  const term = document.getElementById(targetId);
  if (!term) return;
  const line = document.createElement('div');
  line.className = 'terminal-line';
  line.innerHTML = `<span class="terminal-time">[${time || new Date().toLocaleTimeString('es-PE')}]</span><span class="terminal-${type}">${message}</span>`;
  term.appendChild(line);
  term.scrollTop = term.scrollHeight;
}

// Auth Headers Generator
function authHeaders() {
  const token = localStorage.getItem('unab_session_token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };
}

// Real-Time Clock & 17:00:00 Countdown
function tickClock() {
  const now = new Date(Date.now() + serverOffset);
  const timeStr = now.toLocaleTimeString('en-GB', { timeZone: 'America/Lima', hour12: false });
  const msStr = '.' + String(now.getMilliseconds()).padStart(3, '0');

  const clockEl = document.getElementById('liveClockText');
  if (clockEl) clockEl.textContent = `${timeStr}${msStr}`;

  // Countdown to 17:00:00
  const dateVal = document.getElementById('userTargetDate')?.value || now.toISOString().slice(0, 10);
  const targetTime = '17:00:00';
  const targetTs = new Date(`${dateVal}T${targetTime}-05:00`).getTime();
  const diff = targetTs - now.getTime();

  let h = '00', m = '00', s = '00', ms = '.000';
  if (diff > 0) {
    h = String(Math.floor(diff / 3600000)).padStart(2, '0');
    m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
    s = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
    ms = '.' + String(diff % 1000).padStart(3, '0');
  }

  // Update Student Countdown
  const uh = document.getElementById('userCdHours');
  if (uh) {
    uh.textContent = h;
    document.getElementById('userCdMins').textContent = m;
    document.getElementById('userCdSecs').textContent = s;
    document.getElementById('userCdMs').textContent = ms;
  }

  // Update Admin Countdown
  const ah = document.getElementById('adminCdHours');
  if (ah) {
    ah.textContent = h;
    document.getElementById('adminCdMins').textContent = m;
    document.getElementById('adminCdSecs').textContent = s;
    document.getElementById('adminCdMs').textContent = ms;
  }
}

// Synchronize server time
async function syncTime() {
  try {
    const t0 = Date.now();
    const res = await fetch('/api/time');
    const data = await res.json();
    const latency = Date.now() - t0;
    serverOffset = (data.timestamp + latency / 2) - Date.now();

    // Default dates
    const dDate = document.getElementById('userTargetDate');
    const mDate = document.getElementById('menuFilterDate');
    if (dDate && !dDate.value) dDate.value = data.today;
    if (mDate && !mDate.value) mDate.value = data.today;
  } catch (err) {
    console.error('Error syncing time:', err);
  }
}

// Authentication Controller
async function checkAuthSession() {
  const token = localStorage.getItem('unab_session_token');
  if (!token) {
    showLoginView();
    return;
  }

  try {
    const res = await fetch('/api/auth/me', { headers: authHeaders() });
    const data = await res.json();

    if (res.ok && data.authenticated && data.user) {
      currentAuth = data.user;
      showAppView(currentAuth);
    } else {
      localStorage.removeItem('unab_session_token');
      showLoginView();
    }
  } catch (err) {
    showLoginView();
  }
}

function showLoginView() {
  document.getElementById('view-login').style.display = 'flex';
  document.getElementById('view-app').style.display = 'none';
}

function showAppView(user) {
  document.getElementById('view-login').style.display = 'none';
  document.getElementById('view-app').style.display = 'block';

  document.getElementById('topUserName').textContent = user.name || user.username;
  const roleBadge = document.getElementById('userRoleBadge');

  if (user.role === 'superadmin') {
    roleBadge.textContent = 'SuperAdmin';
    roleBadge.className = 'status-pill admin';
    document.getElementById('panel-superadmin').style.display = 'block';
    document.getElementById('panel-student').style.display = 'none';
    document.getElementById('ramPill').style.display = 'inline-flex';
    initAdminPanel();
  } else {
    roleBadge.textContent = 'Alumno · Sede La Florida';
    roleBadge.className = 'status-pill';
    document.getElementById('panel-superadmin').style.display = 'none';
    document.getElementById('panel-student').style.display = 'block';
    document.getElementById('ramPill').style.display = 'none';
    initStudentPanel(user);
  }
}

// Login Submit
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value.trim();

  try {
    showToast('Iniciando sesión...', 'info');
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      localStorage.setItem('unab_session_token', data.token);
      currentAuth = data.user;
      showToast(`Bienvenido, ${data.user.name || data.user.username}`, 'success');
      showAppView(data.user);
    } else {
      showToast(data.error || 'Credenciales inválidas', 'error');
    }
  } catch (err) {
    showToast(`Error de conexión: ${err.message}`, 'error');
  }
});

// Logout
document.getElementById('btnLogout').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() });
  } catch {}
  localStorage.removeItem('unab_session_token');
  showLoginView();
  showToast('Sesión cerrada.', 'info');
});

// --------------------------------------------------------------------------
// SUPERADMIN FUNCTIONS
// --------------------------------------------------------------------------
function initAdminPanel() {
  loadAdminUsers();
  loadAdminReservas();
  loadAdminMetrics();
  setInterval(loadAdminMetrics, 10000); // Check RAM every 10s
}

async function loadAdminUsers() {
  try {
    const res = await fetch('/api/admin/users', { headers: authHeaders() });
    const data = await res.json();
    if (res.ok && data.users) {
      adminUsersList = data.users;
      renderAdminUsersTable(data.users);
    }
  } catch (err) {
    console.error('Error loading users:', err);
  }
}

function renderAdminUsersTable(users) {
  const tbody = document.getElementById('adminUsersTableBody');
  tbody.innerHTML = '';

  users.forEach(u => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${u.username}</strong></td>
      <td>${u.name}</td>
      <td>${u.dni || '-'}</td>
      <td>${(u.campus || 'LA_FLORIDA').replace('_', ' ')}</td>
      <td><span class="badge badge-neutral">${u.targetMeal || 'ALMUERZO'}</span></td>
      <td>
        <input type="checkbox" ${u.autoSniper ? 'checked' : ''} onchange="toggleUserSniper('${u.id}', this.checked)" title="Activar/desactivar francotirador 17:00">
      </td>
      <td>
        <span class="badge ${u.active ? 'badge-success' : 'badge-danger'}">
          ${u.active ? 'Activo' : 'Inactivo'}
        </span>
      </td>
      <td>
        ${u.role !== 'superadmin' ? `
          <button class="btn btn-danger btn-sm" onclick="deleteUserPrompt('${u.id}', '${u.username}')">Eliminar</button>
        ` : '<span style="color: #94a3b8; font-size: 0.75rem;">SuperAdmin</span>'}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function toggleUserSniper(userId, state) {
  try {
    await fetch(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ autoSniper: state })
    });
    showToast('Preferencia de francotirador actualizada', 'info');
  } catch {}
}

async function deleteUserPrompt(userId, username) {
  if (!confirm(`¿Eliminar al alumno ${username}?`)) return;
  try {
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    if (res.ok) {
      showToast('Alumno eliminado correctamente', 'success');
      loadAdminUsers();
    }
  } catch {}
}

// Add user modal
document.getElementById('btnOpenAddUserModal').addEventListener('click', () => {
  openModal('modalAddUser');
});

document.getElementById('formAddUser').addEventListener('submit', async (e) => {
  e.preventDefault();
  const userData = {
    username: document.getElementById('addUsername').value.trim(),
    password: document.getElementById('addPassword').value.trim(),
    name: document.getElementById('addName').value.trim(),
    dni: document.getElementById('addDni').value.trim(),
    targetMeal: document.getElementById('addTargetMeal').value,
    role: 'user',
    active: true,
    autoSniper: true
  };

  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(userData)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Alumno ${userData.name} registrado con éxito.`, 'success');
      closeModal('modalAddUser');
      document.getElementById('formAddUser').reset();
      loadAdminUsers();
    } else {
      showToast(data.error || 'Error al crear alumno', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// Admin Reservas
async function loadAdminReservas() {
  try {
    const res = await fetch('/api/admin/reservas', { headers: authHeaders() });
    const data = await res.json();
    const tbody = document.getElementById('adminReservasTableBody');
    tbody.innerHTML = '';

    if (!data.reservas || data.reservas.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--slate-500); padding: 1.5rem;">No hay reservas registradas aún.</td></tr>`;
      return;
    }

    data.reservas.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.fecha}</td>
        <td>${r.horaReserva || '-'}</td>
        <td><strong>${r.alumnoNombre || r.alumnoCodigo}</strong></td>
        <td>${r.alumnoDni || '-'}</td>
        <td><span class="badge badge-neutral">${r.tipoComida}</span></td>
        <td>${(r.campus || 'LA_FLORIDA').replace('_', ' ')}</td>
        <td><span class="badge ${r.estado === 'ACTIVA' ? 'badge-success' : 'badge-danger'}">${r.estado}</span></td>
        <td><code style="font-size: 0.75rem;">${r.id ? r.id.slice(0, 13) + '...' : '-'}</code></td>
      `;
      tbody.appendChild(tr);
    });
  } catch {}
}

document.getElementById('btnRefreshAdminReservas').addEventListener('click', loadAdminReservas);

// Admin Metrics (RAM & Railway)
async function loadAdminMetrics() {
  try {
    const res = await fetch('/api/admin/metrics', { headers: authHeaders() });
    const data = await res.json();
    if (res.ok && data.memory) {
      document.getElementById('metricRss').textContent = `${data.memory.rssMb} MB`;
      document.getElementById('metricHeap').textContent = `${data.memory.heapUsedMb} MB`;
      document.getElementById('ramUsageVal').textContent = data.memory.rssMb;
      document.getElementById('metricSessions').textContent = data.activeSessions;
      document.getElementById('metricNode').textContent = data.nodeVersion;
      document.getElementById('metricRailway').textContent = data.isRailway ? '✅ Desplegado en Railway' : 'Entorno Local / Contenedor';
      const m = Math.floor(data.uptimeSeconds / 60);
      document.getElementById('metricUptime').textContent = `${m} minutos`;
    }
  } catch {}
}

// Admin Mass Sniper Fire
document.getElementById('btnAdminForceFire').addEventListener('click', async () => {
  if (!confirm('¿Deseas disparar las solicitudes de reserva de almuerzo ahora mismo para todos los alumnos activos?')) return;
  try {
    showToast('Lanzando ráfagas de reserva...', 'info');
    const res = await fetch('/api/admin/sniper/mass-fire', { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    if (res.ok) {
      showToast('Disparo masivo ejecutado con éxito.', 'success');
    }
  } catch (err) {
    showToast('Error en disparo masivo', 'error');
  }
});

document.getElementById('btnAdminToggleSniper').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/sniper/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ targetTime: '17:00:00' })
    });
    if (res.ok) {
      showToast('Francotirador masivo ARMADO para las 17:00:00', 'success');
      document.getElementById('adminSniperStatusBadge').className = 'badge badge-success';
      document.getElementById('adminSniperStatusBadge').textContent = 'ARMADO PARA LAS 17:00';
    }
  } catch {}
});

// --------------------------------------------------------------------------
// STUDENT FUNCTIONS
// --------------------------------------------------------------------------
function initStudentPanel(user) {
  // Populate Ficha
  document.getElementById('fichaNombre').textContent = user.name || user.username;
  document.getElementById('fichaCodigo').textContent = user.username;
  document.getElementById('fichaDni').textContent = user.dni || '76448557';
  document.getElementById('fichaSede').textContent = (user.campus || 'LA_FLORIDA').replace('_', ' ');

  loadStudentAttendance();
  loadStudentMenu();
  loadStudentTickets();
}

async function loadStudentAttendance() {
  try {
    const res = await fetch('/api/comedor/estado', { headers: authHeaders() });
    const data = await res.json();
    if (res.ok && data.data) {
      document.getElementById('studentInasistencias').textContent = data.data.inasistencias ?? 0;
    }
  } catch {}
}

async function loadStudentMenu() {
  const container = document.getElementById('menuCardsHolder');
  const dateVal = document.getElementById('menuFilterDate')?.value || new Date().toISOString().slice(0, 10);
  container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--slate-500); padding: 2rem;">Consultando disponibilidad para el ${dateVal}...</div>`;

  try {
    const res = await fetch(`/api/comedor/programacion?date=${dateVal}`, { headers: authHeaders() });
    const data = await res.json();
    const items = Array.isArray(data.data) ? data.data : [];

    container.innerHTML = '';

    if (items.length === 0) {
      container.innerHTML = `
        <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 2.5rem;">
          <h3 style="color: var(--slate-800); margin-bottom: 0.5rem;">Sin platos disponibles para el ${dateVal}</h3>
          <p style="color: var(--slate-500); font-size: 0.85rem;">La programación para esta fecha aún no ha sido abierta. Los cupos se abren a las <strong>17:00:00 (5:00 PM)</strong>.</p>
        </div>
      `;
      return;
    }

    items.forEach(item => {
      const card = document.createElement('div');
      const libres = item.disponibleLibre !== undefined ? item.disponibleLibre : item.cupoLibre;
      const isExhausted = libres <= 0;

      card.className = `meal-card ${isExhausted ? 'unavailable' : ''}`;
      card.innerHTML = `
        <div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span class="badge ${item.tipoComida === 'ALMUERZO' ? 'badge-success' : 'badge-neutral'}">${item.tipoComida}</span>
            ${isExhausted ? '<span class="badge badge-danger">SIN PLATOS DISPONIBLES</span>' : '<span class="badge badge-success">DISPONIBLE</span>'}
          </div>

          <h3 style="font-size: 1.15rem; margin: 0.6rem 0 0.2rem 0; color: var(--navy-primary);">
            ${item.tipoComida === 'ALMUERZO' ? 'Almuerzo Universitario' : item.tipoComida === 'CENA' ? 'Cena Estudiantil' : 'Desayuno'}
          </h3>
          <p style="font-size: 0.8rem; color: var(--slate-500);">Horario: ${item.horaInicio?.slice(0,5)} - ${item.horaFin?.slice(0,5)}</p>

          <div class="meal-quota-row">
            <span>Cupos Libres:</span>
            <strong style="color: ${libres > 0 ? 'var(--navy-primary)' : 'var(--rose)'};">${libres}</strong>
          </div>
        </div>

        <button class="btn ${isExhausted ? 'btn-secondary' : 'btn-primary'}" style="width: 100%; margin-top: 0.5rem;" ${isExhausted ? 'disabled' : ''} onclick="reserveMeal(${item.id}, '${item.tipoComida}')">
          ${isExhausted ? 'Agotado' : `Reservar ${item.tipoComida}`}
        </button>
      `;
      container.appendChild(card);
    });
  } catch (err) {
    container.innerHTML = `<div style="grid-column: 1 / -1; color: var(--rose); padding: 1rem;">Error de conexión: ${err.message}</div>`;
  }
}

document.getElementById('btnRefreshMenu')?.addEventListener('click', loadStudentMenu);
document.getElementById('menuFilterDate')?.addEventListener('change', loadStudentMenu);

async function reserveMeal(programacionId, tipoComida) {
  if (!confirm(`¿Confirmas la reserva inmediata de tu ${tipoComida}?`)) return;
  try {
    showToast('Enviando reserva...', 'info');
    const res = await fetch('/api/comedor/reservar', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ programacionId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('¡Reserva creada exitosamente!', 'success');
      loadStudentMenu();
      loadStudentTickets();
      // Go to tickets tab
      document.querySelector('[data-target="student-tab-tickets"]').click();
    } else {
      showToast(data.message || data.error || 'Error al reservar', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Student Tickets & QR Codes
async function loadStudentTickets() {
  const container = document.getElementById('studentTicketsHolder');
  const dateVal = document.getElementById('userTargetDate')?.value || new Date().toISOString().slice(0, 10);
  container.innerHTML = `<div style="text-align: center; color: var(--slate-500); padding: 1.5rem;">Cargando tus tickets...</div>`;

  try {
    const res = await fetch(`/api/comedor/reservas?fecha=${dateVal}`, { headers: authHeaders() });
    const data = await res.json();
    studentTickets = Array.isArray(data.data) ? data.data : [];

    const activeTickets = studentTickets.filter(t => t.estado === 'ACTIVA');
    document.getElementById('studentTicketsBadge').textContent = activeTickets.length;

    container.innerHTML = '';

    if (studentTickets.length === 0) {
      container.innerHTML = `
        <div class="card" style="text-align: center; padding: 2.5rem;">
          <p style="color: var(--slate-700); font-weight: 600;">No tienes reservas registradas para hoy.</p>
          <p style="color: var(--slate-500); font-size: 0.85rem; margin-top: 0.25rem;">Usa el Francotirador a las 17:00:00 o la reserva manual.</p>
        </div>
      `;
      return;
    }

    studentTickets.forEach(t => {
      const wrap = document.createElement('div');
      wrap.className = 'ticket-wrapper';
      const qrId = `qr-ticket-${t.id}`;

      wrap.innerHTML = `
        <div class="qr-box">
          <div class="qr-canvas-holder" id="${qrId}"></div>
          <span style="font-size: 0.72rem; color: var(--navy-primary); font-weight: 700; margin-top: 0.4rem;">QR DE ATENCIÓN</span>
        </div>

        <div style="flex: 1; min-width: 240px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
            <span class="badge badge-success">${t.tipoComida}</span>
            <span class="badge ${t.estado === 'ACTIVA' ? 'badge-success' : 'badge-danger'}">${t.estado}</span>
          </div>

          <h3 style="font-size: 1.25rem; color: var(--slate-900); font-weight: 700;">Ticket de Almuerzo</h3>
          <p style="font-size: 0.85rem; color: var(--slate-500);">Fecha: ${t.fecha} · Hora: ${t.horaReserva || '17:00'}</p>
          <p style="font-size: 0.85rem; color: var(--slate-600); margin-top: 0.25rem;">Alumno: <strong>${t.alumnoNombre || currentAuth.name}</strong></p>
          <p style="font-size: 0.85rem; color: var(--slate-600);">DNI: <strong>${t.alumnoDni || currentAuth.dni}</strong> · Sede: ${(t.campus || 'LA_FLORIDA').replace('_', ' ')}</p>

          <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
            <button class="btn btn-primary btn-sm" onclick="openDigitalPass('${t.id}')">
              📱 Ver Pase Completo
            </button>
            ${t.estado === 'ACTIVA' ? `
              <button class="btn btn-danger btn-sm" onclick="cancelStudentReservation('${t.id}')">
                Anular Reserva
              </button>
            ` : ''}
          </div>
        </div>
      `;
      container.appendChild(wrap);

      // Render clean QR (Image 3 spec)
      setTimeout(() => {
        const holder = document.getElementById(qrId);
        if (holder && t.qrToken) {
          holder.innerHTML = '';
          new QRCode(holder, {
            text: t.qrToken,
            width: 170,
            height: 170,
            colorDark: '#07406b',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
          });
        }
      }, 50);
    });
  } catch (err) {
    container.innerHTML = `<div style="color: var(--rose);">Error: ${err.message}</div>`;
  }
}

document.getElementById('btnRefreshStudentTickets')?.addEventListener('click', loadStudentTickets);

// Cancel Reservation
async function cancelStudentReservation(id) {
  if (!confirm('¿Seguro que deseas anular esta reserva? El cupo quedará liberado.')) return;
  try {
    const res = await fetch(`/api/comedor/reservas/${id}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    if (res.ok) {
      showToast('Reserva anulada correctamente', 'info');
      loadStudentTickets();
      loadStudentMenu();
    }
  } catch {}
}

// Digital Pass Modal
function openDigitalPass(id) {
  const t = studentTickets.find(x => x.id === id);
  if (!t) return;

  document.getElementById('passStudentName').textContent = t.alumnoNombre || currentAuth.name;
  document.getElementById('passStudentDni').textContent = t.alumnoDni || currentAuth.dni;
  document.getElementById('passMealType').textContent = t.tipoComida;
  document.getElementById('passMealDate').textContent = t.fecha;

  const holder = document.getElementById('modalPassQrHolder');
  holder.innerHTML = '';
  new QRCode(holder, {
    text: t.qrToken,
    width: 190,
    height: 190,
    colorDark: '#07406b',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });

  openModal('modalDigitalPass');
}

// Student save sniper preferences
document.getElementById('btnUserSaveSniper')?.addEventListener('click', async () => {
  const targetMeal = document.getElementById('userTargetMeal').value;
  try {
    await fetch(`/api/admin/users/${currentAuth.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ autoSniper: true, targetMeal })
    });
    showToast('Preferencia de auto-reserva guardada.', 'success');
  } catch {}
});

// SSE Events stream
function setupSSE() {
  const src = new EventSource('/api/events');
  src.addEventListener('log', (e) => {
    try {
      const data = JSON.parse(e.data);
      logLine('adminTerminal', data.time, data.message, data.type);
      logLine('studentTerminal', data.time, data.message, data.type);
    } catch {}
  });

  src.addEventListener('reservation-batch-finished', () => {
    showToast('🎯 Ráfaga de reservas de las 17:00 finalizada.', 'success');
    if (currentAuth?.role === 'superadmin') {
      loadAdminReservas();
    } else {
      loadStudentTickets();
      loadStudentMenu();
    }
  });
}

// Navigation Tab switcher
document.addEventListener('click', (e) => {
  if (e.target.matches('.tab-link')) {
    const parent = e.target.closest('.tabs-header');
    parent.querySelectorAll('.tab-link').forEach(btn => btn.classList.remove('active'));
    e.target.classList.add('active');

    const targetId = e.target.getAttribute('data-target');
    const container = e.target.closest('#panel-superadmin') || e.target.closest('#panel-student');
    container.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    document.getElementById(targetId)?.classList.add('active');
  }
});

// App Initialization
document.addEventListener('DOMContentLoaded', () => {
  syncTime();
  setInterval(syncTime, 60000);
  setInterval(tickClock, 45); // smooth clock ticks
  checkAuthSession();
  setupSSE();
});
