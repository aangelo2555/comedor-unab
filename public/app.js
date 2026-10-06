/* --------------------------------------------------------------------------
   COMEDOR UNAB - CLIENT APPLICATION
   Multi-user, SuperAdmin, Student Portal, Image 2 Replica, Low Memory Profile
   -------------------------------------------------------------------------- */

let currentAuth = null;
let serverOffset = 0;
let studentTickets = [];
let adminUsersList = [];
let todayDateStr = '';
let tomorrowDateStr = '';
let studentViewDate = ''; // Defaults to tomorrow for advance reservations

// White Minimalist Toast Notifications (Point 3)
function showToast(message, type = 'info') {
  const shelf = document.getElementById('toastShelf');
  if (!shelf) return;
  const toast = document.createElement('div');
  toast.className = `toast-msg ${type}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️'}</span>
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

// Real-Time Clock (Zero tedious countdowns)
function tickClock() {
  const now = new Date(Date.now() + serverOffset);
  const timeStr = now.toLocaleTimeString('en-GB', { timeZone: 'America/Lima', hour12: false });
  const msStr = '.' + String(now.getMilliseconds()).padStart(3, '0');

  const clockEl = document.getElementById('liveClockText');
  if (clockEl) clockEl.textContent = `${timeStr}${msStr}`;
}

// Spanish Date Formatter (Matches Image 2: "Jueves, 1 De Octubre")
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

// Synchronize server time
async function syncTime() {
  try {
    const t0 = Date.now();
    const res = await fetch('/api/time');
    const data = await res.json();
    const latency = Date.now() - t0;
    serverOffset = (data.timestamp + latency / 2) - Date.now();

    todayDateStr = data.today;
    tomorrowDateStr = data.tomorrow;

    // Student view defaults to tomorrow for advance reservations
    if (!studentViewDate) {
      studentViewDate = data.tomorrow;
    }

    const lblTom = document.getElementById('lblTomorrowDate');
    const lblTod = document.getElementById('lblTodayDate');
    if (lblTom) lblTom.textContent = data.tomorrow;
    if (lblTod) lblTod.textContent = data.today;

    const adminDate = document.getElementById('adminSniperDateInput');
    if (adminDate && !adminDate.value) adminDate.value = data.tomorrow;

    updateStudentHeaderDate();
  } catch (err) {
    console.error('Error syncing time:', err);
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
  loadSentinelQueue();
  loadSniperStatus();
  setInterval(loadAdminMetrics, 10000);
  setInterval(loadSentinelQueue, 4000);
  setInterval(loadSniperStatus, 4000);
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

// Render Admin Users Table with Unified Single-Column Reservation & Appointment Controls
function renderAdminUsersTable(users) {
  const tbody = document.getElementById('adminUsersTableBody');
  tbody.innerHTML = '';

  users.forEach(u => {
    const tr = document.createElement('tr');

    // Consolidated single-column reservation management with direct Activar/Desactivar buttons
    let mananaHtml = '<div style="margin-bottom: 0.35rem;"><strong style="font-size: 0.78rem; color: var(--navy-primary);">Mañana:</strong> ';
    if (u.reservasManana && u.reservasManana.length > 0) {
      const pills = u.reservasManana.map(r => {
        const isActiva = r.status === 'ACTIVA';
        const isConfirmada = r.status === 'CONFIRMADA';
        const badgeClass = isConfirmada ? 'badge-success' : isActiva ? 'badge-success' : 'badge-warning';

        return `
          <div style="display: inline-flex; align-items: center; gap: 0.25rem; margin: 2px 4px 2px 0;">
            <span class="badge ${badgeClass}">${r.meal} (${r.status})</span>
            ${!isConfirmada ? `
              <button class="btn ${isActiva ? 'btn-secondary' : 'btn-primary'} btn-sm" 
                style="padding: 2px 6px; font-size: 0.72rem; line-height: 1;" 
                onclick="adminToggleReserva('${r.id}')" 
                title="${isActiva ? 'Desactivar esta cita' : 'Activar esta cita'}">
                ${isActiva ? 'Desactivar' : 'Activar'}
              </button>
            ` : ''}
          </div>
        `;
      }).join(' ');
      mananaHtml += pills + '</div>';
    } else {
      mananaHtml += '<span style="color: var(--slate-500); font-size: 0.78rem;">Sin citas registradas</span></div>';
    }

    let hoyHtml = '<div><strong style="font-size: 0.78rem; color: var(--slate-600);">Hoy:</strong> ';
    if (u.reservasHoy && u.reservasHoy.length > 0) {
      const pills = u.reservasHoy.map(r => `
        <span class="badge badge-neutral" style="margin-right: 4px;">${r.meal} (${r.status})</span>
      `).join(' ');
      hoyHtml += pills + '</div>';
    } else {
      hoyHtml += '<span style="color: var(--slate-500); font-size: 0.78rem;">Sin tickets hoy</span></div>';
    }

    const combinedHistory = `
      <div style="display: flex; flex-direction: column; gap: 0.2rem; min-width: 260px;">
        ${mananaHtml}
        ${hoyHtml}
      </div>
    `;

    tr.innerHTML = `
      <td>
        <strong>${u.name || u.username}</strong>
        <div style="font-size: 0.75rem; color: var(--slate-500); font-family: var(--font-mono);">${u.username}</div>
      </td>
      <td>${u.dni || '-'}</td>
      <td>${(u.campus || 'LA_FLORIDA').replace('_', ' ')}</td>
      <td>${combinedHistory}</td>
      <td>
        <label style="display: flex; align-items: center; gap: 0.35rem; cursor: pointer; font-size: 0.8rem;">
          <input type="checkbox" ${u.autoSniper ? 'checked' : ''} onchange="toggleUserSniper('${u.id}', this.checked)">
          <span>${u.autoSniper ? 'Activo' : 'Pausado'}</span>
        </label>
      </td>
      <td>
        ${u.role !== 'superadmin' ? `
          <button class="btn btn-danger btn-sm" onclick="deleteUserPrompt('${u.id}', '${u.username}')">Eliminar</button>
        ` : '<span style="color: #94a3b8; font-size: 0.75rem; font-weight: 600;">SuperAdmin</span>'}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Admin toggle of student advance reservation or appointment
async function adminToggleReserva(reservaId) {
  try {
    const res = await fetch(`/api/admin/reservas/${reservaId}/toggle`, {
      method: 'PUT',
      headers: authHeaders()
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Cita modificada a: ${data.item.status || data.item.estado}`, 'success');
      loadAdminUsers();
      loadAdminReservas();
    } else {
      showToast(data.error || 'No se pudo cambiar el estado de la cita', 'error');
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
    showToast('Auto-reserva del alumno actualizada', 'success');
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

// Admin Reservas List
async function loadAdminReservas() {
  try {
    const res = await fetch('/api/admin/reservas', { headers: authHeaders() });
    const data = await res.json();
    const tbody = document.getElementById('adminReservasTableBody');
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
        <td><code style="font-size: 0.75rem;">${r.id ? r.id.slice(0, 14) + '...' : '-'}</code></td>
      `;
      tbody.appendChild(tr);
    });
  } catch {}
}

document.getElementById('btnRefreshAdminReservas')?.addEventListener('click', loadAdminReservas);

// Admin Metrics (RAM & Railway)
async function loadAdminMetrics() {
  try {
    const res = await fetch('/api/admin/metrics', { headers: authHeaders() });
    const data = await res.json();
    if (res.ok && data.memory) {
      document.getElementById('metricRss').textContent = `${data.memory.rssMb} MB`;
      document.getElementById('metricHeap').textContent = `${data.memory.heapUsedMb} MB`;
      document.getElementById('ramUsageVal').textContent = data.memory.rssMb;
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
    if (!confirm('¿Restaurar la base de datos con este archivo JSON? Se actualizarán los usuarios y reservas.')) return;
    
    showToast('Restaurando datos...', 'info');
    const res = await fetch('/api/admin/restore', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(json)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('¡Base de datos restaurada correctamente!', 'success');
      loadAdminUsers();
      loadAdminReservas();
    } else {
      showToast(data.error || 'Error al restaurar', 'error');
    }
  } catch (err) {
    showToast('Archivo de respaldo no válido', 'error');
  }
  e.target.value = '';
});

// Official Opening Times Mapping
const OFFICIAL_MEAL_TIMES = {
  DESAYUNO: '06:30:00',
  ALMUERZO: '11:00:00',
  CENA: '17:00:00',
  INTELIGENTE: '11:00:00',
  TODAS: '06:30:00'
};

// Update button and time input when meal select changes
const sniperMealSelect = document.getElementById('adminSniperMealSelect');
const sniperTimeInput = document.getElementById('adminSniperTimeInput');
const btnAdminArmSniper = document.getElementById('btnAdminArmSniper');

sniperMealSelect?.addEventListener('change', () => {
  const meal = sniperMealSelect.value;
  const defaultTime = OFFICIAL_MEAL_TIMES[meal] || '11:00:00';
  if (sniperTimeInput) sniperTimeInput.value = defaultTime;

  if (btnAdminArmSniper) {
    if (meal === 'DESAYUNO') {
      btnAdminArmSniper.textContent = '🚀 Armar Francotirador a las 06:30';
    } else if (meal === 'ALMUERZO') {
      btnAdminArmSniper.textContent = '🚀 Armar Francotirador a las 11:00';
    } else if (meal === 'CENA') {
      btnAdminArmSniper.textContent = '🚀 Armar Francotirador a las 17:00';
    } else {
      btnAdminArmSniper.textContent = '🚀 Armar Centinela Multi-Horario';
    }
  }
});

// Intelligent Multi-Meal Sniper Controls
btnAdminArmSniper?.addEventListener('click', async () => {
  const meal = sniperMealSelect?.value || 'ALMUERZO';
  const date = document.getElementById('adminSniperDateInput')?.value || tomorrowDateStr;
  const targetTime = sniperTimeInput?.value || OFFICIAL_MEAL_TIMES[meal] || '11:00:00';

  try {
    const res = await fetch('/api/sniper/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ targetTime, targetMeal: meal, targetDate: date })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Francotirador armado para ${meal} del ${date} a las ${targetTime}`, 'success');
      const badge = document.getElementById('adminSniperStatusBadge');
      if (badge) {
        badge.className = 'badge badge-success';
        badge.textContent = `ARMADO PARA ${meal} (${targetTime.slice(0, 5)})`;
      }
    } else {
      showToast(data.error || 'No se pudo armar el francotirador', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

// Sentinel Button: Continuous Watchdog for Liberated Cupos
document.getElementById('btnAdminStartSentinel')?.addEventListener('click', async () => {
  const meal = sniperMealSelect?.value || 'ALMUERZO';
  const date = document.getElementById('adminSniperDateInput')?.value || todayDateStr;

  try {
    showToast(`Activando Centinela continuo para ${meal}...`, 'info');
    const res = await fetch('/api/sniper/sentinel/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ targetMeal: meal, targetDate: date })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`🛡️ Centinela activo para ${meal}. Capturando cancelaciones y cupos liberados.`, 'success');
      const badge = document.getElementById('adminSniperStatusBadge');
      if (badge) {
        badge.className = 'badge badge-warning';
        badge.textContent = `🛡️ CENTINELA ACTIVO (${meal})`;
      }
      const sysStatus = document.getElementById('adminSniperSystemStatus');
      if (sysStatus) {
        sysStatus.textContent = `Centinela vigilando ${meal} en tiempo real`;
      }
    }
  } catch (err) {
    showToast(`Error al iniciar centinela: ${err.message}`, 'error');
  }
});

// Stop button: halts both sniper and sentinel
document.getElementById('btnAdminStopAll')?.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/sniper/stop', {
      method: 'POST',
      headers: authHeaders()
    });
    const data = await res.json();
    if (res.ok) {
      showToast('Francotirador y centinela detenidos.', 'info');
      loadSniperStatus();
      loadSentinelQueue();
    }
  } catch (err) {
    showToast(`Error al detener: ${err.message}`, 'error');
  }
});

document.getElementById('btnAdminForceFire')?.addEventListener('click', async () => {
  const meal = sniperMealSelect?.value || 'ALMUERZO';
  const date = document.getElementById('adminSniperDateInput')?.value || todayDateStr;
  if (!confirm(`¿Disparar captura inmediata para ${meal} del ${date}?`)) return;

  try {
    showToast(`Ejecutando disparo para ${meal}...`, 'info');
    const res = await fetch('/api/admin/sniper/mass-fire', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ targetMeal: meal, targetDate: date })
    });
    if (res.ok) {
      showToast('Disparo ejecutado con éxito.', 'success');
    }
  } catch (err) {
    showToast('Error en disparo', 'error');
  }
});

// Live Sentinel Queue Controller (SuperAdmin)
async function loadSentinelQueue() {
  try {
    const res = await fetch('/api/sniper/queue', { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) return;

    const tbody = document.getElementById('sentinelQueueTableBody');
    const badgeCount = document.getElementById('sentinelQueueCountBadge');
    if (badgeCount) badgeCount.textContent = `${data.count || 0} en cola`;

    if (!tbody) return;
    tbody.innerHTML = '';

    if (!data.queue || data.queue.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--slate-500); padding: 1.5rem;">No hay alumnos en cola de espera en este momento.</td></tr>`;
    } else {
      data.queue.forEach(item => {
        const tr = document.createElement('tr');
        const timeStr = item.createdAt ? new Date(item.createdAt).toLocaleTimeString('es-PE', { timeZone: 'America/Lima' }) : '--:--';
        tr.innerHTML = `
          <td><strong>${item.studentName}</strong><div style="font-size: 0.75rem; color: var(--slate-500); font-family: var(--font-mono);">${item.studentUsername}</div></td>
          <td>${item.studentDni || '-'}</td>
          <td><span class="badge badge-neutral">${item.meal}</span></td>
          <td>${item.date}</td>
          <td>${timeStr}</td>
          <td><span class="badge badge-warning">🛡️ En Cola (Esperando Cupo)</span></td>
          <td>
            <button class="btn btn-danger btn-sm" style="padding: 2px 8px; font-size: 0.72rem;" onclick="adminCancelAdvance('${item.advanceId}')">
              Cancelar
            </button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }

    // Sync status indicators
    const statusBadge = document.getElementById('adminSniperStatusBadge');
    const sysStatus = document.getElementById('adminSniperSystemStatus');
    if (data.sentinelActive) {
      if (statusBadge) {
        statusBadge.className = 'badge badge-warning';
        statusBadge.textContent = `🛡️ CENTINELA ACTIVO (${data.targetMeal || 'ALMUERZO'})`;
      }
      if (sysStatus) {
        sysStatus.style.color = '#d97706';
        sysStatus.textContent = `Vigilando cupos liberados cada 1.5s para ${data.count} alumno(s) en cola`;
      }
    } else if (data.status === 'ARMED') {
      // Keep armed status
    } else {
      if (statusBadge) {
        statusBadge.className = 'badge badge-success';
        statusBadge.textContent = `PROGRAMACIÓN INTELIGENTE ACTIVA`;
      }
      if (sysStatus) {
        sysStatus.style.color = 'var(--emerald)';
        sysStatus.textContent = `Listo (se activará automáticamente cuando un alumno entre en cola)`;
      }
    }
  } catch (err) {
    console.error('Error loading sentinel queue:', err);
  }
}

// Live Sniper & Railway Autopilot Telemetry (SuperAdmin)
async function loadSniperStatus() {
  try {
    const res = await fetch('/api/sniper/status', { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) return;

    // Railway Telemetry elements
    const nextBadge = document.getElementById('railwayNextOpeningBadge');
    if (nextBadge && data.nextOpening) {
      nextBadge.textContent = `Próxima: ${data.nextOpening.meal} (${data.nextOpening.time})`;
    }

    const nextCount = document.getElementById('railwayNextAdvanceCount');
    if (nextCount && data.nextOpening) {
      const cnt = data.nextOpening.advanceCount || 0;
      nextCount.textContent = `${cnt} cita(s) registrada(s)`;
      nextCount.className = cnt > 0 ? 'badge badge-success' : 'badge badge-warning';
    }

    const sniperLive = document.getElementById('autoSniperLiveStatus');
    if (sniperLive) {
      if (data.status === 'ARMED') {
        sniperLive.textContent = `🎯 ARMADO (${(data.targetTime || '11:00').slice(0, 5)})`;
        sniperLive.style.color = 'var(--emerald)';
      } else if (data.status === 'RESERVING') {
        sniperLive.textContent = `🚀 DISPARANDO RÁFAGA...`;
        sniperLive.style.color = '#dc2626';
      } else if (data.nextOpening?.advanceCount > 0) {
        sniperLive.textContent = `Listo (Armado en T-5m)`;
        sniperLive.style.color = 'var(--navy-primary)';
      } else {
        sniperLive.textContent = `💤 En Reposo (0 citas)`;
        sniperLive.style.color = 'var(--slate-500)';
      }
    }

    const sentinelLive = document.getElementById('autoSentinelLiveStatus');
    if (sentinelLive) {
      if (data.sentinelActive) {
        sentinelLive.textContent = `🛡️ ACTIVO (Vigilando liberados)`;
        sentinelLive.style.color = '#d97706';
      } else {
        sentinelLive.textContent = `💤 En Reposo (Auto-apagado)`;
        sentinelLive.style.color = 'var(--slate-500)';
      }
    }

    const queueLive = document.getElementById('autoQueueLiveCount');
    if (queueLive) {
      queueLive.textContent = `${data.sentinelQueueCount || 0} alumno(s) en espera`;
    }
  } catch (err) {
    console.error('Error loading sniper status:', err);
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
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('btnRefreshSentinelQueue')?.addEventListener('click', loadSentinelQueue);

// --------------------------------------------------------------------------
// STUDENT FUNCTIONS (EXACT REPLICA OF IMAGEN 2)
// --------------------------------------------------------------------------
function initStudentPanel(user) {
  // Populate Ficha
  const fNom = document.getElementById('fichaNombre');
  if (fNom) fNom.textContent = user.name || user.username;
  const fCod = document.getElementById('fichaCodigo');
  if (fCod) fCod.textContent = user.username;
  const fDni = document.getElementById('fichaDni');
  if (fDni) fDni.textContent = user.dni || '76448557';
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
      document.getElementById('studentInasistencias').textContent = data.data.inasistencias ?? 0;
    }
  } catch {}
}

// Date Switcher Listeners (Mañana vs Hoy)
document.getElementById('btnViewTomorrow')?.addEventListener('click', () => {
  studentViewDate = tomorrowDateStr;
  document.getElementById('btnViewTomorrow').className = 'btn btn-primary btn-sm active';
  document.getElementById('btnViewToday').className = 'btn btn-secondary btn-sm';
  updateStudentHeaderDate();
  loadStudentMealCards(studentViewDate);
});

document.getElementById('btnViewToday')?.addEventListener('click', () => {
  studentViewDate = todayDateStr;
  document.getElementById('btnViewToday').className = 'btn btn-primary btn-sm active';
  document.getElementById('btnViewTomorrow').className = 'btn btn-secondary btn-sm';
  updateStudentHeaderDate();
  loadStudentMealCards(studentViewDate);
});

// Renders the 3 Meal Cards matching Image 2 perfectly
async function loadStudentMealCards(targetDate) {
  const container = document.getElementById('studentMealCardsContainer');
  if (!container) return;

  container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--slate-500); padding: 2rem;">Consultando disponibilidad para el ${targetDate}...</div>`;

  try {
    // 1. Fetch official UNAB programming for targetDate
    const progPromise = fetch(`/api/comedor/programacion?date=${targetDate}`, { headers: authHeaders() })
      .then(r => r.json())
      .catch(() => ({ data: [] }));

    // 2. Fetch student's confirmed tickets for targetDate
    const ticketPromise = fetch(`/api/comedor/reservas?fecha=${targetDate}`, { headers: authHeaders() })
      .then(r => r.json())
      .catch(() => ({ data: [] }));

    // 3. Fetch student's advance reservations for targetDate
    const advancePromise = fetch(`/api/student/advance-reservations?fecha=${targetDate}`, { headers: authHeaders() })
      .then(r => r.json())
      .catch(() => ({ data: [] }));

    const [progData, ticketData, advanceData] = await Promise.all([progPromise, ticketPromise, advancePromise]);

    const progItems = Array.isArray(progData.data) ? progData.data : [];
    const confirmedTickets = Array.isArray(ticketData.data) ? ticketData.data.filter(t => t.estado === 'ACTIVA') : [];
    const advanceAppointments = Array.isArray(advanceData.data) ? advanceData.data.filter(a => a.status === 'ACTIVA') : [];

    container.innerHTML = '';

    // Standard 3 Meals definition (Sincronizado con API oficial UNAB)
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

      // Quotas calculation
      const disponibles = pItem ? (pItem.disponibleLibre !== undefined ? pItem.disponibleLibre : (pItem.cupoLibre ?? 0)) : 0;
      const total = pItem ? (pItem.cupoLibre || meal.defaultTotal) : meal.defaultTotal;
      const despachados = total - disponibles;
      const progressPercent = Math.min(100, Math.round((despachados / total) * 100));

      // Timing rule check: if targetDate is TODAY and schedule passed
      const isPastCutoff = isToday && (currentH > meal.cutoffHour || (currentH === meal.cutoffHour && currentM >= meal.cutoffMin));

      const card = document.createElement('div');
      card.className = 'unab-card';

      // Determine Button Status
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
            <button class="btn-unab-primary" style="background: #d97706 !important; border-color: #b45309 !important; box-shadow: 0 0 10px rgba(217,119,6,0.35);" onclick="cancelAdvancePrompt('${advanceAppt.id}', '${meal.name}')" title="El centinela está buscando activamente un cupo liberado">
              🛡️ En Cola Centinela (Buscando cupo...)
            </button>
            <div style="text-align: center; margin-top: 6px;">
              <small style="color: var(--slate-500); cursor: pointer; text-decoration: underline;" onclick="cancelAdvancePrompt('${advanceAppt.id}', '${meal.name}')">✕ Cancelar cola</small>
            </div>
          `;
        } else {
          buttonHtml = `
            <button class="btn-unab-primary" style="background: #059669 !important;" onclick="cancelAdvancePrompt('${advanceAppt.id}', '${meal.name}')">
              ✓ Cita Anticipada (Activa)
            </button>
            <div style="text-align: center; margin-top: 6px;">
              <small style="color: var(--slate-500); cursor: pointer; text-decoration: underline;" onclick="cancelAdvancePrompt('${advanceAppt.id}', '${meal.name}')">✕ Cancelar cita</small>
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
        // Cupos = 0
        if (isToday) {
          buttonHtml = `
            <button class="btn-unab-primary" style="background: var(--navy-primary) !important;" onclick="reserveAdvanceMeal('${meal.key}')" title="Ponerse en cola y activar el centinela reactivo">
              🛡️ Ponerse en Cola (Activar Centinela)
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
          <!-- Top Row: Name + Gold LIBRE Badge -->
          <div class="unab-card-header">
            <h3 class="unab-card-title">${meal.name}</h3>
            <div style="display: flex; gap: 4px; align-items: center;">
              ${advanceAppt && isToday ? '<span class="badge badge-warning" style="font-size: 0.68rem; font-weight: 700;">EN COLA</span>' : ''}
              <span class="unab-badge-libre">LIBRE</span>
            </div>
          </div>

          <!-- Schedule & Campus -->
          <div class="unab-time-row">${meal.schedule}</div>
          <div class="unab-campus-row">La Florida</div>

          <!-- Notice Pill from Image 2 -->
          <div class="unab-pill-notice">
            Esta comida usa cupo <strong>LIBRE</strong>.
          </div>

          <!-- Quotas: Disponibles & Despachados Progress Bar -->
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

        <!-- Action Button (Matching Image 2 styles) -->
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

// Student action: Reserve advance meal for tomorrow
async function reserveAdvanceMeal(meal) {
  try {
    showToast(`Registrando reserva anticipada de ${meal}...`, 'info');
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
      showToast(data.error || 'No se pudo reservar', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Student action: Cancel advance reservation
async function cancelAdvancePrompt(advId, mealName) {
  if (!confirm(`¿Deseas cancelar tu cita anticipada de ${mealName} para el ${studentViewDate}?`)) return;
  try {
    const res = await fetch(`/api/student/advance-reservation/${advId}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    if (res.ok) {
      showToast(`Cita anticipada de ${mealName} cancelada.`, 'info');
      loadStudentMealCards(studentViewDate);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Student Tickets & QR Codes
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
    document.getElementById('studentTicketsBadge').textContent = activeTickets.length;

    container.innerHTML = '';

    if (studentTickets.length === 0) {
      container.innerHTML = `
        <div class="card" style="text-align: center; padding: 2.5rem;">
          <p style="color: var(--slate-700); font-weight: 600;">No tienes tickets confirmados para hoy.</p>
          <p style="color: var(--slate-500); font-size: 0.85rem; margin-top: 0.25rem;">Puedes realizar tu reserva anticipada para mañana desde la pestaña "Reserva tu comida".</p>
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

          <h3 style="font-size: 1.25rem; color: var(--slate-900); font-weight: 700;">Ticket de Comedor</h3>
          <p style="font-size: 0.85rem; color: var(--slate-500);">Fecha: ${t.fecha} · Hora de Reserva: ${t.horaReserva || '17:00'}</p>
          <p style="font-size: 0.85rem; color: var(--slate-600); margin-top: 0.25rem;">Alumno: <strong>${t.alumnoNombre || currentAuth.name}</strong></p>
          <p style="font-size: 0.85rem; color: var(--slate-600);">DNI: <strong>${t.alumnoDni || currentAuth.dni}</strong> · Sede: ${(t.campus || 'LA_FLORIDA').replace('_', ' ')}</p>

          <div style="display: flex; gap: 0.5rem; margin-top: 1rem; flex-wrap: wrap;">
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

      // Render clean QR
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
      showToast('Reserva anulada correctamente. Cupo liberado.', 'info');
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

// SSE Events stream
function setupSSE() {
  const src = new EventSource('/api/events');
  src.addEventListener('log', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'success') {
        showToast(data.message, 'success');
      } else if (data.type === 'error') {
        showToast(data.message, 'error');
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
    showToast('🎯 Ráfaga de capturas finalizada.', 'success');
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
  setInterval(tickClock, 100);
  checkAuthSession();
  setupSSE();
});
