/* --------------------------------------------------------------------------
   COMEDOR UNAB - CLIENT APPLICATION
   Multi-User, Autonomous Server-Side Reservations, Minimalist Sober Design
   Zero Emojis, Clean SVG Icons, 100% Responsive, Zero Toast Spam
   -------------------------------------------------------------------------- */

let currentAuth = null;
let serverOffset = 0;
let studentTickets = [];
let adminUsersList = [];
let todayDateStr = '';
let tomorrowDateStr = '';
let studentViewDate = ''; // Defaults to tomorrow for advance reservations

// Minimalist Toast Notifications (Clean SVGs, No Emojis)
function showToast(message, type = 'info') {
  const shelf = document.getElementById('toastShelf');
  if (!shelf) return;

  const toast = document.createElement('div');
  toast.className = `toast-msg ${type}`;

  let iconSvg = '';
  if (type === 'success') {
    iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--emerald)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
  } else if (type === 'error') {
    iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--rose)" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  } else if (type === 'warning') {
    iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  } else {
    iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--navy-primary)" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
  }

  toast.innerHTML = `
    <span style="display: flex; align-items: center; flex-shrink: 0;">${iconSvg}</span>
    <span>${message}</span>
  `;
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

// Auth Headers Generator
function authHeaders() {
  const token = localStorage.getItem('unab_session_token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };
}

// Real-Time Lima Clock
function tickClock() {
  const now = new Date(Date.now() + serverOffset);
  const timeStr = now.toLocaleTimeString('en-GB', { timeZone: 'America/Lima', hour12: false });
  const msStr = '.' + String(now.getMilliseconds()).padStart(3, '0');

  const clockEl = document.getElementById('liveClockText');
  if (clockEl) clockEl.textContent = `${timeStr}${msStr}`;
}

// Spanish Date Formatter: "Jueves, 1 De Octubre"
function formatSpanishDate(isoDateStr) {
  if (!isoDateStr) return '';
  const [y, m, d] = isoDateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const dayName = days[dt.getDay()];
  const monthName = months[dt.getMonth()];
  return `${dayName}, ${d} De ${monthName}`;
}

// Time Synchronization
async function syncTime() {
  try {
    const t0 = Date.now();
    const res = await fetch('/api/time');
    const data = await res.json();
    const latency = Date.now() - t0;
    serverOffset = (data.timestamp + latency / 2) - Date.now();

    todayDateStr = data.today;
    tomorrowDateStr = data.tomorrow;

    if (!studentViewDate) {
      studentViewDate = data.tomorrow;
    }

    const lblTom = document.getElementById('lblTomorrowDate');
    const lblTod = document.getElementById('lblTodayDate');
    if (lblTom) lblTom.textContent = data.tomorrow;
    if (lblTod) lblTod.textContent = data.today;

    updateStudentHeaderDate();
  } catch (err) {
    console.error('Error sincronizando hora:', err);
  }
}

function updateStudentHeaderDate() {
  const headerDateEl = document.getElementById('studentHeaderDate');
  if (headerDateEl) {
    headerDateEl.textContent = formatSpanishDate(studentViewDate || tomorrowDateStr);
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
    roleBadge.textContent = 'Estudiante · Sede La Florida';
    roleBadge.className = 'status-pill role';
    document.getElementById('panel-superadmin').style.display = 'none';
    document.getElementById('panel-student').style.display = 'block';
    document.getElementById('ramPill').style.display = 'none';
    initStudentPanel(user);
  }
}

// Login Submit (Transparent Auto-Registration)
document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value.trim();

  try {
    showToast('Validando credenciales con UNAB...', 'info');
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
      showToast(data.error || 'Credenciales no válidas', 'error');
    }
  } catch (err) {
    showToast(`Error de conexión: ${err.message}`, 'error');
  }
});

// Logout
document.getElementById('btnLogout')?.addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() });
  } catch {}
  localStorage.removeItem('unab_session_token');
  showLoginView();
  showToast('Sesión cerrada.', 'info');
});

// --------------------------------------------------------------------------
// SUPERADMIN PANEL CONTROLLER
// --------------------------------------------------------------------------
function initAdminPanel() {
  loadAdminUsers();
  loadAdminReservas();
  loadAdminMetrics();
  loadSentinelQueue();
  loadSniperStatus();
  setInterval(loadAdminMetrics, 10000);
  setInterval(loadSentinelQueue, 4000);
  setInterval(loadSniperStatus, 4000);
}

// Load Students
async function loadAdminUsers() {
  try {
    const res = await fetch('/api/admin/users', { headers: authHeaders() });
    const data = await res.json();
    if (res.ok && data.users) {
      adminUsersList = data.users;
      renderAdminUsersTable(data.users);
    }
  } catch (err) {
    console.error('Error cargando usuarios:', err);
  }
}

function renderAdminUsersTable(users) {
  const tbody = document.getElementById('adminUsersTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  users.forEach(u => {
    const tr = document.createElement('tr');

    let mananaHtml = '<div style="margin-bottom: 0.25rem;"><strong style="font-size: 0.76rem; color: var(--navy-primary);">Mañana:</strong> ';
    if (u.reservasManana && u.reservasManana.length > 0) {
      const pills = u.reservasManana.map(r => {
        const isConfirmada = r.status === 'CONFIRMADA';
        const isActiva = r.status === 'ACTIVA';
        const badgeClass = isConfirmada ? 'badge-success' : isActiva ? 'badge-warning' : 'badge-neutral';

        return `
          <div style="display: inline-flex; align-items: center; gap: 0.25rem; margin: 2px 4px 2px 0;">
            <span class="badge ${badgeClass}">${r.meal} (${r.status})</span>
            ${!isConfirmada ? `
              <button class="btn btn-secondary btn-sm" 
                style="padding: 1px 6px; font-size: 0.7rem; line-height: 1;" 
                onclick="adminToggleReserva('${r.id}')">
                ${isActiva ? 'Pausar' : 'Activar'}
              </button>
            ` : ''}
          </div>
        `;
      }).join(' ');
      mananaHtml += pills + '</div>';
    } else {
      mananaHtml += '<span style="color: var(--slate-500); font-size: 0.76rem;">Sin reservas</span></div>';
    }

    let hoyHtml = '<div><strong style="font-size: 0.76rem; color: var(--slate-600);">Hoy:</strong> ';
    if (u.reservasHoy && u.reservasHoy.length > 0) {
      const pills = u.reservasHoy.map(r => `
        <span class="badge badge-neutral" style="margin-right: 4px;">${r.meal} (${r.status})</span>
      `).join(' ');
      hoyHtml += pills + '</div>';
    } else {
      hoyHtml += '<span style="color: var(--slate-500); font-size: 0.76rem;">Sin tickets</span></div>';
    }

    const combinedHistory = `
      <div style="display: flex; flex-direction: column; gap: 0.15rem; min-width: 250px;">
        ${mananaHtml}
        ${hoyHtml}
      </div>
    `;

    tr.innerHTML = `
      <td>
        <strong>${u.name || u.username}</strong>
        <div style="font-size: 0.74rem; color: var(--slate-500); font-family: var(--font-mono);">${u.username}</div>
      </td>
      <td>${u.dni || '-'}</td>
      <td>${(u.campus || 'LA_FLORIDA').replace('_', ' ')}</td>
      <td>${combinedHistory}</td>
      <td>
        <label style="display: flex; align-items: center; gap: 0.35rem; cursor: pointer; font-size: 0.8rem;">
          <input type="checkbox" ${u.autoSniper ? 'checked' : ''} onchange="toggleUserSniper('${u.id}', this.checked)">
          <span>${u.autoSniper ? 'Activo' : 'Inactivo'}</span>
        </label>
      </td>
      <td>
        ${u.role !== 'superadmin' ? `
          <button class="btn btn-danger btn-sm" onclick="deleteUserPrompt('${u.id}', '${u.username}')">Eliminar</button>
        ` : '<span class="badge badge-neutral">SuperAdmin</span>'}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function adminToggleReserva(reservaId) {
  try {
    const res = await fetch(`/api/admin/reservas/${reservaId}/toggle`, {
      method: 'PUT',
      headers: authHeaders()
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Estado actualizado: ${data.item.status || data.item.estado}`, 'success');
      loadAdminUsers();
      loadAdminReservas();
    } else {
      showToast(data.error || 'No se pudo actualizar', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function toggleUserSniper(userId, state) {
  try {
    await fetch(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ autoSniper: state })
    });
    showToast('Auto-reserva actualizada', 'success');
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
      showToast('Alumno eliminado', 'success');
      loadAdminUsers();
    }
  } catch {}
}

// Add user modal listener
document.getElementById('btnOpenAddUserModal')?.addEventListener('click', () => {
  openModal('modalAddUser');
});

document.getElementById('formAddUser')?.addEventListener('submit', async (e) => {
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
      showToast(`Alumno ${userData.name} registrado.`, 'success');
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

// Admin Reservas List
async function loadAdminReservas() {
  try {
    const res = await fetch('/api/admin/reservas', { headers: authHeaders() });
    const data = await res.json();
    const tbody = document.getElementById('adminReservasTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const list = [...(data.advance || []), ...(data.reservas || [])];

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--slate-500); padding: 1.5rem;">No hay registros de citas o tickets aún.</td></tr>`;
      return;
    }

    list.forEach(r => {
      const tr = document.createElement('tr');
      const isActiva = (r.status || r.estado) === 'ACTIVA' || (r.status || r.estado) === 'CONFIRMADA';
      tr.innerHTML = `
        <td>${r.fecha}</td>
        <td>${r.horaReserva || r.createdAt?.slice(11, 16) || '17:00'}</td>
        <td><strong>${r.alumnoNombre || r.alumnoCodigo}</strong></td>
        <td>${r.alumnoDni || '-'}</td>
        <td><span class="badge badge-neutral">${r.tipoComida}</span></td>
        <td>${(r.campus || 'LA_FLORIDA').replace('_', ' ')}</td>
        <td><span class="badge ${isActiva ? 'badge-success' : 'badge-danger'}">${r.status || r.estado}</span></td>
        <td><code style="font-size: 0.74rem;">${r.id ? r.id.slice(0, 14) + '...' : '-'}</code></td>
      `;
      tbody.appendChild(tr);
    });
  } catch {}
}

document.getElementById('btnRefreshAdminReservas')?.addEventListener('click', loadAdminReservas);

// Admin Metrics (RAM)
async function loadAdminMetrics() {
  try {
    const res = await fetch('/api/admin/metrics', { headers: authHeaders() });
    const data = await res.json();
    if (res.ok && data.memory) {
      const rssEl = document.getElementById('metricRss');
      const heapEl = document.getElementById('metricHeap');
      const ramVal = document.getElementById('ramUsageVal');
      if (rssEl) rssEl.textContent = `${data.memory.rssMb} MB`;
      if (heapEl) heapEl.textContent = `${data.memory.heapUsedMb} MB`;
      if (ramVal) ramVal.textContent = data.memory.rssMb;
    }
  } catch {}
}

// Backup & Restore
document.getElementById('btnTriggerRestore')?.addEventListener('click', () => {
  document.getElementById('fileRestoreInput')?.click();
});

document.getElementById('fileRestoreInput')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    if (!confirm('¿Restaurar la base de datos con este archivo JSON?')) return;
    
    showToast('Restaurando base de datos...', 'info');
    const res = await fetch('/api/admin/restore', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(json)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('Base de datos restaurada correctamente', 'success');
      loadAdminUsers();
      loadAdminReservas();
    } else {
      showToast(data.error || 'Error al restaurar', 'error');
    }
  } catch (err) {
    showToast('Archivo no válido', 'error');
  }
  e.target.value = '';
});

// --------------------------------------------------------------------------
// FRANCOTIRADOR MASIVO & COLA CENTINELA (ADMIN)
// --------------------------------------------------------------------------
async function loadSentinelQueue() {
  try {
    const res = await fetch('/api/sniper/queue', { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) return;

    const tbody = document.getElementById('sentinelQueueTableBody');
    const badgeCount = document.getElementById('sentinelQueueCountBadge');
    if (badgeCount) badgeCount.textContent = `${data.totalPendingCount ?? (data.count || 0)} registrada(s)`;

    if (!tbody) return;
    tbody.innerHTML = '';

    if (!data.queue || data.queue.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--slate-500); padding: 1.5rem;">No hay alumnos con reservas anticipadas en este momento.</td></tr>`;
    } else {
      data.queue.forEach(item => {
        const tr = document.createElement('tr');
        const timeStr = item.createdAt ? new Date(item.createdAt).toLocaleTimeString('es-PE', { timeZone: 'America/Lima' }) : '--:--';
        const statusBadgeClass = item.isSentinel ? 'badge-warning' : 'badge-neutral';
        const statusText = item.statusText || (item.isSentinel ? 'En Cola Centinela (Liberados)' : 'Reserva Anticipada');

        tr.innerHTML = `
          <td><strong>${item.studentName}</strong><div style="font-size: 0.74rem; color: var(--slate-500); font-family: var(--font-mono);">${item.studentUsername}</div></td>
          <td>${item.studentDni || '-'}</td>
          <td><span class="badge badge-neutral">${item.meal}</span></td>
          <td>${item.date}</td>
          <td>${timeStr}</td>
          <td><span class="badge ${statusBadgeClass}">${statusText}</span></td>
          <td>
            <button class="btn btn-danger btn-sm" onclick="adminCancelAdvance('${item.advanceId}')">
              Cancelar
            </button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }

    const statusBadge = document.getElementById('adminSniperStatusBadge');
    const sysStatus = document.getElementById('adminSniperSystemStatus');
    if (data.sentinelActive) {
      if (statusBadge) {
        statusBadge.className = 'badge badge-warning';
        statusBadge.textContent = `CENTINELA ACTIVO (${data.targetMeal || 'ALMUERZO'})`;
      }
      if (sysStatus) {
        sysStatus.textContent = `Vigilando cupos liberados en tiempo real para ${data.sentinelQueueCount || 0} alumno(s) en cola`;
      }
    } else if (data.status === 'ARMED') {
      if (statusBadge) {
        statusBadge.className = 'badge badge-success';
        statusBadge.textContent = `PROGRAMADO PARA ${data.targetMeal || 'CENA'}`;
      }
    } else {
      if (statusBadge) {
        statusBadge.className = 'badge badge-neutral';
        statusBadge.textContent = `SISTEMA AUTÓNOMO ACTIVO`;
      }
      if (sysStatus) {
        sysStatus.textContent = `El servidor disparará automáticamente en cuanto llegue el horario de apertura`;
      }
    }
  } catch (err) {
    console.error('Error cargando cola:', err);
  }
}

async function loadSniperStatus() {
  try {
    const res = await fetch('/api/sniper/status', { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) return;

    const nextBadge = document.getElementById('railwayNextOpeningBadge');
    if (nextBadge && data.nextOpening) {
      nextBadge.textContent = `${data.nextOpening.meal} (${data.nextOpening.time})`;
    }

    const nextCount = document.getElementById('railwayNextAdvanceCount');
    if (nextCount && data.nextOpening) {
      const cnt = data.nextOpening.advanceCount || 0;
      nextCount.textContent = cnt > 0 ? `${cnt} reserva(s) en cola` : '0 reservas en cola';
      nextCount.className = cnt > 0 ? 'badge badge-success' : 'badge badge-neutral';
    }

    const sniperLive = document.getElementById('autoSniperLiveStatus');
    if (sniperLive) {
      if (data.status === 'ARMED') {
        sniperLive.textContent = `Armado (${(data.targetTime || '17:00').slice(0, 5)})`;
        sniperLive.style.color = 'var(--emerald)';
      } else if (data.status === 'RESERVING') {
        sniperLive.textContent = `Disparando ráfaga...`;
        sniperLive.style.color = 'var(--rose)';
      } else if (data.nextOpening?.advanceCount > 0) {
        sniperLive.textContent = `Programado (${data.nextOpening.meal} ${data.nextOpening.time})`;
        sniperLive.style.color = 'var(--navy-primary)';
      } else {
        sniperLive.textContent = `En Reposo (0 reservas)`;
        sniperLive.style.color = 'var(--slate-500)';
      }
    }

    const sentinelLive = document.getElementById('autoSentinelLiveStatus');
    if (sentinelLive) {
      if (data.sentinelActive) {
        sentinelLive.textContent = `Activo (Vigilando liberados)`;
        sentinelLive.style.color = 'var(--amber)';
      } else {
        sentinelLive.textContent = `En Reposo`;
        sentinelLive.style.color = 'var(--slate-500)';
      }
    }

    const queueLive = document.getElementById('autoQueueLiveCount');
    if (queueLive) {
      const sentCount = data.sentinelQueueCount || 0;
      const totalCount = data.totalPendingCount ?? (data.queue?.length || 0);
      if (sentCount > 0) {
        queueLive.textContent = `${sentCount} en Centinela`;
      } else if (totalCount > 0) {
        queueLive.textContent = `${totalCount} anticipada(s)`;
      } else {
        queueLive.textContent = `0 alumnos`;
      }
    }
  } catch (err) {
    console.error('Error cargando estado:', err);
  }
}

async function adminCancelAdvance(advId) {
  if (!confirm('¿Deseas retirar a este alumno de la cola de espera?')) return;
  try {
    const res = await fetch(`/api/student/advance-reservation/${advId}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    if (res.ok) {
      showToast('Alumno retirado de la cola.', 'info');
      loadSentinelQueue();
      loadAdminUsers();
      loadSniperStatus();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('btnRefreshSentinelQueue')?.addEventListener('click', () => {
  loadSentinelQueue();
  loadSniperStatus();
});

document.getElementById('btnAdminForceFire')?.addEventListener('click', async () => {
  if (!confirm('¿Ejecutar disparo inmediato de prueba para los alumnos en cola?')) return;
  try {
    showToast('Ejecutando disparo inmediato...', 'info');
    const res = await fetch('/api/admin/sniper/mass-fire', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (res.ok) {
      showToast('Disparo completado.', 'success');
      loadSniperStatus();
      loadSentinelQueue();
    } else {
      showToast(data.error || 'Error al ejecutar disparo', 'error');
    }
  } catch (err) {
    showToast('Error en disparo', 'error');
  }
});

// --------------------------------------------------------------------------
// STUDENT PORTAL (REPLICA EXACTA IMAGEN 2)
// --------------------------------------------------------------------------
function initStudentPanel(user) {
  const fNom = document.getElementById('fichaNombre');
  if (fNom) fNom.textContent = user.name || user.username;
  const fCod = document.getElementById('fichaCodigo');
  if (fCod) fCod.textContent = user.username;
  const fDni = document.getElementById('fichaDni');
  if (fDni) fDni.textContent = user.dni || '-';
  const fSed = document.getElementById('fichaSede');
  if (fSed) fSed.textContent = (user.campus || 'LA_FLORIDA').replace('_', ' ');

  loadStudentAttendance();
  loadStudentMealCards(studentViewDate);
  loadStudentTickets();
}

async function loadStudentAttendance() {
  try {
    const res = await fetch('/api/comedor/estado', { headers: authHeaders() });
    const data = await res.json();
    if (res.ok && data.data) {
      const el = document.getElementById('studentInasistencias');
      if (el) el.textContent = data.data.inasistencias ?? 0;
    }
  } catch {}
}

// Date Switcher Listeners
document.getElementById('btnViewTomorrow')?.addEventListener('click', () => {
  studentViewDate = tomorrowDateStr;
  document.getElementById('btnViewTomorrow').className = 'btn btn-secondary btn-sm active';
  document.getElementById('btnViewToday').className = 'btn btn-secondary btn-sm';
  updateStudentHeaderDate();
  loadStudentMealCards(studentViewDate);
});

document.getElementById('btnViewToday')?.addEventListener('click', () => {
  studentViewDate = todayDateStr;
  document.getElementById('btnViewToday').className = 'btn btn-secondary btn-sm active';
  document.getElementById('btnViewTomorrow').className = 'btn btn-secondary btn-sm';
  updateStudentHeaderDate();
  loadStudentMealCards(studentViewDate);
});

// Render 3 Meal Cards
async function loadStudentMealCards(targetDate) {
  const container = document.getElementById('studentMealCardsContainer');
  if (!container) return;

  container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--slate-500); padding: 2rem;">Consultando disponibilidad para el ${targetDate}...</div>`;

  try {
    const progPromise = fetch(`/api/comedor/programacion?date=${targetDate}`, { headers: authHeaders() })
      .then(r => r.json())
      .catch(() => ({ data: [] }));

    const ticketPromise = fetch(`/api/comedor/reservas?fecha=${targetDate}`, { headers: authHeaders() })
      .then(r => r.json())
      .catch(() => ({ data: [] }));

    const advancePromise = fetch(`/api/student/advance-reservations?fecha=${targetDate}`, { headers: authHeaders() })
      .then(r => r.json())
      .catch(() => ({ data: [] }));

    const [progData, ticketData, advanceData] = await Promise.all([progPromise, ticketPromise, advancePromise]);

    const progItems = Array.isArray(progData.data) ? progData.data : [];
    const confirmedTickets = Array.isArray(ticketData.data) ? ticketData.data.filter(t => t.estado === 'ACTIVA') : [];
    const advanceAppointments = Array.isArray(advanceData.data) ? advanceData.data.filter(a => a.status === 'ACTIVA') : [];

    container.innerHTML = '';

    const mealsConfig = [
      {
        key: 'DESAYUNO',
        name: 'Desayuno',
        schedule: '06:30:00 - 10:30:00',
        defaultTotal: 408,
        cutoffHour: 10,
        cutoffMin: 30
      },
      {
        key: 'ALMUERZO',
        name: 'Almuerzo',
        schedule: '11:00:00 - 16:00:00',
        defaultTotal: 357,
        cutoffHour: 16,
        cutoffMin: 0
      },
      {
        key: 'CENA',
        name: 'Cena',
        schedule: '17:00:00 - 19:00:00',
        defaultTotal: 521,
        cutoffHour: 19,
        cutoffMin: 0
      }
    ];

    const nowLima = new Date(Date.now() + serverOffset);
    const isToday = (targetDate === todayDateStr);
    const currentH = nowLima.getHours();
    const currentM = nowLima.getMinutes();

    mealsConfig.forEach(meal => {
      const pItem = progItems.find(i => (i.tipoComida || '').toUpperCase() === meal.key);
      const confirmedTicket = confirmedTickets.find(t => (t.tipoComida || '').toUpperCase() === meal.key);
      const advanceAppt = advanceAppointments.find(a => (a.tipoComida || '').toUpperCase() === meal.key);

      const disponibles = pItem ? (pItem.disponibleLibre !== undefined ? pItem.disponibleLibre : (pItem.cupoLibre ?? 0)) : 0;
      const total = pItem ? (pItem.cupoLibre || meal.defaultTotal) : meal.defaultTotal;
      const despachados = total - disponibles;
      const progressPercent = Math.min(100, Math.round((despachados / total) * 100));

      const isPastCutoff = isToday && (currentH > meal.cutoffHour || (currentH === meal.cutoffHour && currentM >= meal.cutoffMin));

      const card = document.createElement('div');
      card.className = 'unab-card';

      let buttonHtml = '';
      if (confirmedTicket) {
        buttonHtml = `
          <button class="btn-unab-reserved" onclick="openDigitalPass('${confirmedTicket.id}')">
            Ticket reservado
          </button>
        `;
      } else if (advanceAppt) {
        if (isToday) {
          buttonHtml = `
            <button class="btn-unab-reserved" onclick="cancelAdvancePrompt('${advanceAppt.id}', '${meal.name}')">
              En cola de espera (Buscando cupo)
            </button>
            <div style="text-align: center; margin-top: 6px;">
              <small style="color: var(--slate-500); cursor: pointer; text-decoration: underline;" onclick="cancelAdvancePrompt('${advanceAppt.id}', '${meal.name}')">Cancelar cola</small>
            </div>
          `;
        } else {
          buttonHtml = `
            <button class="btn-unab-reserved" onclick="cancelAdvancePrompt('${advanceAppt.id}', '${meal.name}')">
              Reserva anticipada activa
            </button>
            <div style="text-align: center; margin-top: 6px;">
              <small style="color: var(--slate-500); cursor: pointer; text-decoration: underline;" onclick="cancelAdvancePrompt('${advanceAppt.id}', '${meal.name}')">Cancelar reserva</small>
            </div>
          `;
        }
      } else if (isPastCutoff) {
        buttonHtml = `
          <button class="btn-unab-disabled" disabled>
            Horario cerrado
          </button>
        `;
      } else if (disponibles > 0) {
        buttonHtml = `
          <button class="btn-unab-primary" onclick="reserveAdvanceMeal('${meal.key}')">
            Reservar Cupo
          </button>
        `;
      } else {
        if (isToday) {
          buttonHtml = `
            <button class="btn-unab-primary" onclick="reserveAdvanceMeal('${meal.key}')" title="Ponerse en cola y activar centinela">
              Ponerse en cola (Cupos agotados)
            </button>
          `;
        } else {
          buttonHtml = `
            <button class="btn-unab-primary" onclick="reserveAdvanceMeal('${meal.key}')">
              Reservar Anticipadamente
            </button>
          `;
        }
      }

      card.innerHTML = `
        <div>
          <div class="unab-card-header">
            <h3 class="unab-card-title">${meal.name}</h3>
            <div style="display: flex; gap: 4px; align-items: center;">
              ${advanceAppt && isToday ? '<span class="badge badge-warning" style="font-size: 0.68rem; font-weight: 700;">EN COLA</span>' : ''}
              <span class="unab-badge-libre">LIBRE</span>
            </div>
          </div>

          <div class="unab-time-row">${meal.schedule}</div>
          <div class="unab-campus-row">La Florida</div>

          <div class="unab-pill-notice">
            Esta comida usa cupo <strong>LIBRE</strong>.
          </div>

          <div class="unab-quota-section">
            <div class="unab-disponibles-row">
              <span class="unab-disponibles-num">${disponibles}</span>
              <span class="unab-disponibles-txt">disponibles</span>
            </div>

            <div class="unab-despachados-row">
              <span>Reservados y despachados</span>
              <strong>${despachados} / ${total}</strong>
            </div>

            <div class="unab-progress-track">
              <div class="unab-progress-fill" style="width: ${progressPercent}%;"></div>
            </div>
          </div>
        </div>

        <div style="margin-top: 1rem;">
          ${buttonHtml}
        </div>
      `;

      container.appendChild(card);
    });

  } catch (err) {
    container.innerHTML = `<div style="grid-column: 1 / -1; color: var(--rose); padding: 1.5rem; text-align: center;">Error al cargar comidas: ${err.message}</div>`;
  }
}

// Student action: Reserve advance meal
async function reserveAdvanceMeal(meal) {
  try {
    showToast(`Procesando reserva de ${meal}...`, 'info');
    const res = await fetch('/api/student/advance-reservation', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ meal, date: studentViewDate })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, 'success');
      loadStudentMealCards(studentViewDate);
      loadStudentTickets();
    } else {
      showToast(data.error || 'No se pudo registrar la reserva', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Student action: Cancel advance reservation
async function cancelAdvancePrompt(advId, mealName) {
  if (!confirm(`¿Deseas anular tu reserva anticipada de ${mealName} para el ${studentViewDate}?`)) return;
  try {
    const res = await fetch(`/api/student/advance-reservation/${advId}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    if (res.ok) {
      showToast(`Reserva anticipada de ${mealName} anulada.`, 'info');
      loadStudentMealCards(studentViewDate);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Student Tickets & QR
async function loadStudentTickets() {
  const container = document.getElementById('studentTicketsHolder');
  if (!container) return;
  const dateVal = new Date(Date.now() + serverOffset).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  container.innerHTML = `<div style="text-align: center; color: var(--slate-500); padding: 1.5rem;">Cargando tus tickets...</div>`;

  try {
    const res = await fetch(`/api/comedor/reservas?fecha=${dateVal}`, { headers: authHeaders() });
    const data = await res.json();
    studentTickets = Array.isArray(data.data) ? data.data : [];

    const activeTickets = studentTickets.filter(t => t.estado === 'ACTIVA');
    const badge = document.getElementById('studentTicketsBadge');
    if (badge) badge.textContent = activeTickets.length;

    container.innerHTML = '';

    if (studentTickets.length === 0) {
      container.innerHTML = `
        <div class="card" style="text-align: center; padding: 2.5rem;">
          <p style="color: var(--slate-800); font-weight: 600;">No tienes tickets confirmados para hoy.</p>
          <p style="color: var(--slate-500); font-size: 0.84rem; margin-top: 0.25rem;">Puedes realizar tu reserva anticipada para mañana desde la pestaña "Reserva tu comida".</p>
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
          <span style="font-size: 0.72rem; color: var(--navy-primary); font-weight: 700; margin-top: 0.4rem;">QR OFICIAL</span>
        </div>

        <div style="flex: 1; min-width: 240px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
            <span class="badge badge-success">${t.tipoComida}</span>
            <span class="badge ${t.estado === 'ACTIVA' ? 'badge-success' : 'badge-danger'}">${t.estado}</span>
          </div>

          <h3 style="font-size: 1.2rem; color: var(--slate-900); font-weight: 700;">Ticket de Comedor</h3>
          <p style="font-size: 0.84rem; color: var(--slate-500);">Fecha: ${t.fecha} · Hora: ${t.horaReserva || '17:00'}</p>
          <p style="font-size: 0.84rem; color: var(--slate-600); margin-top: 0.2rem;">Alumno: <strong>${t.alumnoNombre || currentAuth.name}</strong></p>
          <p style="font-size: 0.84rem; color: var(--slate-600);">DNI: <strong>${t.alumnoDni || currentAuth.dni}</strong> · Sede: ${(t.campus || 'LA_FLORIDA').replace('_', ' ')}</p>

          <div style="display: flex; gap: 0.5rem; margin-top: 1rem; flex-wrap: wrap;">
            <button class="btn btn-primary btn-sm" onclick="openDigitalPass('${t.id}')">
              Ver Pase Completo
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

// Cancel Confirmed Reservation
async function cancelStudentReservation(id) {
  if (!confirm('¿Seguro que deseas anular esta reserva? El cupo quedará liberado.')) return;
  try {
    const res = await fetch(`/api/comedor/reservas/${id}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    if (res.ok) {
      showToast('Reserva anulada. Cupo liberado.', 'info');
      loadStudentTickets();
      loadStudentMealCards(studentViewDate);
    }
  } catch {}
}

// Digital Pass Modal
function openDigitalPass(id) {
  let t = studentTickets.find(x => x.id === id);
  if (!t && currentAuth) {
    t = {
      alumnoNombre: currentAuth.name,
      alumnoDni: currentAuth.dni,
      tipoComida: 'COMIDA',
      fecha: studentViewDate,
      qrToken: 'UNAB-' + id
    };
  }
  if (!t) return;

  document.getElementById('passStudentName').textContent = t.alumnoNombre || currentAuth.name;
  document.getElementById('passStudentDni').textContent = t.alumnoDni || currentAuth.dni;
  document.getElementById('passMealType').textContent = t.tipoComida;
  document.getElementById('passMealDate').textContent = t.fecha;

  const holder = document.getElementById('modalPassQrHolder');
  holder.innerHTML = '';
  new QRCode(holder, {
    text: t.qrToken || ('UNAB-TICKET-' + t.id),
    width: 190,
    height: 190,
    colorDark: '#07406b',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });

  openModal('modalDigitalPass');
}

// --------------------------------------------------------------------------
// SSE STREAM: SILENT UPDATES & ADMIN LOG TERMINAL (ZERO TOAST SPAM)
// --------------------------------------------------------------------------
function setupSSE() {
  const src = new EventSource('/api/events');

  // Logs are routed ONLY to the Admin Terminal, NEVER spammed as toasts to students!
  src.addEventListener('log', (e) => {
    try {
      const data = JSON.parse(e.data);
      const term = document.getElementById('adminLogTerminal');
      if (term) {
        const line = document.createElement('div');
        const colorClass = data.type === 'success' ? 'text-success' : 
                           data.type === 'error' ? 'text-danger' : 
                           data.type === 'warning' ? 'text-warning' : 
                           data.type === 'info' ? 'text-info' : 'text-muted';
        line.className = `terminal-line ${colorClass}`;
        line.textContent = `[${data.time || new Date().toLocaleTimeString('es-PE')}] [${(data.type || 'INFO').toUpperCase()}] ${data.message}`;
        term.appendChild(line);
        term.scrollTop = term.scrollHeight;
      }
    } catch {}
  });

  src.addEventListener('sniper-status', () => {
    if (currentAuth?.role === 'superadmin') {
      loadSniperStatus();
      loadSentinelQueue();
    }
  });

  src.addEventListener('sentinel-queue-updated', () => {
    if (currentAuth?.role === 'superadmin') {
      loadSentinelQueue();
      loadSniperStatus();
    } else {
      loadStudentMealCards(studentViewDate);
    }
  });

  src.addEventListener('reservation-status-changed', () => {
    if (currentAuth?.role === 'superadmin') {
      loadAdminUsers();
      loadAdminReservas();
      loadSentinelQueue();
      loadSniperStatus();
    } else {
      loadStudentMealCards(studentViewDate);
      loadStudentTickets();
    }
  });

  src.addEventListener('reservation-batch-finished', () => {
    if (currentAuth?.role === 'superadmin') {
      loadAdminReservas();
      loadAdminUsers();
      loadSentinelQueue();
      loadSniperStatus();
    } else {
      loadStudentTickets();
      loadStudentMealCards(studentViewDate);
    }
  });

  src.addEventListener('advance-reservation-created', () => {
    if (currentAuth?.role === 'superadmin') {
      loadAdminUsers();
      loadSentinelQueue();
      loadSniperStatus();
    }
  });

  src.addEventListener('advance-reservation-cancelled', () => {
    if (currentAuth?.role === 'superadmin') {
      loadAdminUsers();
      loadSentinelQueue();
      loadSniperStatus();
    } else {
      loadStudentMealCards(studentViewDate);
    }
  });
}

// Navigation Tabs Switcher
document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('.tab-link');
  if (tabBtn) {
    const parent = tabBtn.closest('.tabs-header');
    parent.querySelectorAll('.tab-link').forEach(btn => btn.classList.remove('active'));
    tabBtn.classList.add('active');

    const targetId = tabBtn.getAttribute('data-target');
    const container = tabBtn.closest('#panel-superadmin') || tabBtn.closest('#panel-student');
    container.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    document.getElementById(targetId)?.classList.add('active');
  }
});

// App Initialization
document.addEventListener('DOMContentLoaded', () => {
  syncTime();
  setInterval(syncTime, 60000);
  setInterval(tickClock, 100);
  checkAuthSession();
  setupSSE();
});
