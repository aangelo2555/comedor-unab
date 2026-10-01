/**
 * SNIPER DE ALMUERZO UNAB - CONSOLA AUTÓNOMA (CLI)
 * Ejecución en terminal rápida para reservar cupos a las 17:00:00 con precisión de milisegundos.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error('Error al leer config.json:', e);
  process.exit(1);
}

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

async function login() {
  console.log(`\n[${getLimaTimeString()}] 🔑 Verificando credenciales para ${config.username}...`);
  try {
    const res = await fetch('https://api-login-dev.unab.edu.pe/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer' },
      body: JSON.stringify({ UserName: config.username, userspassunab: config.password })
    });
    const data = await res.json();
    if (!res.ok || !data.accessToken) {
      throw new Error(data.message || data.error || 'Credenciales inválidas');
    }
    config.accessToken = data.accessToken;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    console.log(`[${getLimaTimeString()}] ✅ Sesión activa. Token obtenido con éxito.`);
    return true;
  } catch (err) {
    console.error(`[${getLimaTimeString()}] ❌ Error de inicio de sesión: ${err.message}`);
    return false;
  }
}

async function fetchComedor(endpoint, options = {}) {
  const url = `https://comedor-api.unab.edu.pe/v1${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'Cookie': `next-login-auth=${config.accessToken}`,
    'Authorization': `Bearer ${config.accessToken}`,
    'Origin': 'https://comedor.unab.edu.pe',
    'Referer': 'https://comedor.unab.edu.pe/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0.0.0 Safari/537.36',
    ...(options.headers || {})
  };
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

async function runCliSniper() {
  console.clear();
  console.log('===========================================================');
  console.log('🎯 UNAB COMEDOR · FRANCOTIRADOR CLI A LAS 17:00:00');
  console.log('===========================================================');
  console.log(`Alumno:     ${config.student?.nombre || config.username}`);
  console.log(`DNI:        ${config.student?.dni || '76448557'}`);
  console.log(`Objetivo:   ${config.sniper?.targetMeal || 'ALMUERZO'} a las ${config.sniper?.targetTime || '17:00:00'}`);
  console.log(`Zona:       America/Lima (Hora Perú)`);
  console.log('===========================================================\n');

  const ok = await login();
  if (!ok) {
    console.log('No se pudo continuar. Revisa config.json.');
    return;
  }

  const targetTimeStr = config.sniper?.targetTime || '17:00:00';
  const targetMeal = (config.sniper?.targetMeal || 'ALMUERZO').toUpperCase();
  const targetDateStr = getTodayLimaDate();
  const leadTimeMs = config.sniper?.leadTimeMs ?? 250;

  const targetTs = new Date(`${targetDateStr}T${targetTimeStr}-05:00`).getTime();
  let remainingMs = targetTs - Date.now();

  console.log(`\n📅 Fecha objetivo: ${targetDateStr}`);
  console.log(`⏰ Hora objetivo:  ${targetTimeStr}`);
  console.log(`⚡ Offset disparo: -${leadTimeMs}ms\n`);

  if (remainingMs < -60000) {
    console.log(`⚠️ La hora ${targetTimeStr} para hoy ya pasó. Disparando sondeo inmediato de prueba...`);
    await executeBurst(targetDateStr, targetMeal);
    return;
  }

  console.log('⏳ Esperando la hora exacta de apertura. Presiona Ctrl+C para cancelar.');

  const countdownInterval = setInterval(() => {
    const now = Date.now();
    const diff = targetTs - now;

    if (diff <= leadTimeMs) {
      clearInterval(countdownInterval);
      console.log(`\n\n🚀 ¡¡DISPARO INICIADO A LAS ${getLimaTimeString()}!!`);
      executeBurst(targetDateStr, targetMeal);
      return;
    }

    const s = Math.floor(diff / 1000);
    const ms = diff % 1000;
    process.stdout.write(`\r[${getLimaTimeString()}] Cuenta regresiva: T - ${s}s ${ms}ms    `);
  }, 100);
}

async function executeBurst(targetDate, targetMeal) {
  let attempts = 0;
  let reservationDone = false;

  const timer = setInterval(async () => {
    if (attempts++ > 40 || reservationDone) {
      clearInterval(timer);
      if (!reservationDone) console.log('\n❌ Se completaron los intentos sin confirmación de reserva.');
      return;
    }

    try {
      const poll = await fetchComedor(`/programacion/me?date=${targetDate}`);
      if (poll.ok && Array.isArray(poll.data?.data) && poll.data.data.length > 0) {
        const item = poll.data.data.find(i => (i.tipoComida || '').toUpperCase() === targetMeal) || poll.data.data[0];
        if (item) {
          console.log(`\n🎯 ¡Programación encontrada! ID: ${item.id} (${item.tipoComida}). Enviando ráfaga...`);
          clearInterval(timer);

          // Concurrent burst
          const promises = [1, 2, 3].map(async (i) => {
            const shotTime = getLimaTimeString();
            const res = await fetchComedor('/reservas', {
              method: 'POST',
              body: JSON.stringify({ programacionId: item.id })
            });
            return { index: i, time: shotTime, result: res };
          });

          const results = await Promise.all(promises);
          for (const r of results) {
            if (r.result.ok && r.result.data?.success) {
              reservationDone = true;
              console.log(`\n🎉 [${r.time}] ¡¡RESERVA REGISTRADA CON ÉXITO!!`);
              console.log(`Ticket ID:   ${r.result.data.data?.id}`);
              console.log(`Mensaje:     ${r.result.data.message}`);
              console.log(`Token QR:    ${r.result.data.data?.qrToken}`);
              console.log('\n✅ Puedes abrir "iniciar_portal.bat" para ver tu código QR.');
              break;
            } else {
              console.log(`[${r.time}] Intento #${r.index}: ${r.result.data?.message || r.result.data?.error || 'Rechazado'}`);
            }
          }
        }
      } else {
        process.stdout.write(`\r[${getLimaTimeString()}] Sondeo #${attempts}: Esperando publicación de cupos...`);
      }
    } catch (err) {
      console.error(`\nError en sondeo: ${err.message}`);
    }
  }, 150);
}

runCliSniper();
