const { mapWithConcurrency } = require('./reservation-service');
const MEALS = ['DESAYUNO', 'ALMUERZO', 'CENA'];

function limaDate(now = Date.now()) {
  return new Date(now - 5 * 3600000).toISOString().slice(0, 10);
}

function isPremium(user, date = limaDate()) {
  return Boolean(user?.automationConsent?.enabled && user?.premium?.enabled && user.premium.endDate >= date);
}

function compareQueue(a, b) {
  return (
    String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
    String(a.id || '').localeCompare(String(b.id || ''))
  );
}

function validatePremium(value, today = limaDate()) {
  if (!value || typeof value.enabled !== 'boolean')
    throw new Error('Indica si premium está habilitado.');
  if (!value.enabled) return { enabled: false, endDate: '', meals: [] };
  const end = value.endDate;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(end || '') ||
    Number.isNaN(Date.parse(end + 'T00:00:00Z')) ||
    new Date(end + 'T00:00:00Z').toISOString().slice(0, 10) !== end ||
    end < today
  ) {
    throw new Error('Configura una fecha válida de fin de ciclo, desde hoy.');
  }
  return { enabled: true, endDate: end, meals: [] };
}

function createPremiumService({
  db,
  configs,
  getToken,
  callApi,
  log,
  requestIntervalMs = 500,
  now = Date.now
}) {
  let running = false;
  const retryAfter = new Map();

  function seed(user, today) {
    const plan = user.premium;
    for (const date of [today]) {
      const existing = db.getAdvanceReservations({
        alumnoCodigo: user.username,
        fecha: date
      });
      for (const meal of plan.meals || []) {
        if (
          !MEALS.includes(meal) ||
          date > plan.endDate ||
          existing.some((item) => item.tipoComida === meal)
        )
          continue;
        const close = Date.parse(`${date}T${configs[meal].horaFin}-05:00`);
        if (close - 40000 <= now()) continue;
        db.createAdvanceReservation({
          alumnoCodigo: user.username,
          alumnoNombre: user.name,
          alumnoDni: user.dni,
          campus: user.campus,
          tipoComida: meal,
          fecha: date,
          source: 'premium'
        });
      }
    }
  }

  async function cancelUnused(user, ticket, close) {
    const key = String(ticket.id);
    if ((retryAfter.get(key) || 0) > now()) return;
    retryAfter.set(key, now() + 5000);
    const token = await getToken(user);
    if (!token || now() >= close || user.automationConsent?.autoCancel !== true) return;
    const options = {
      priority: 10,
      timeoutMs: 5000,
      canProceed: () => now() < close && user.automationConsent?.autoCancel === true
    };
    const check = await callApi(
      `/reservas/me?fecha=${ticket.fecha}`,
      token,
      options
    );
    if (!check.ok || !Array.isArray(check.data?.data)) return;
    const remote = check.data.data.find((item) => String(item.id) === key);
    if (!remote) return;
    if (typeof remote.estado !== 'string') return;
    if (remote.estado !== 'ACTIVA') {
      db.updateReservationStatus(ticket.id, remote.estado);
      retryAfter.delete(key);
      return;
    }
    const result = await callApi(
      `/reservas/${encodeURIComponent(key)}`,
      token,
      { ...options, method: 'DELETE' }
    );
    if (result.ok && result.data?.success !== false) {
      db.updateReservationStatus(ticket.id, 'ANULADA');
      retryAfter.delete(key);
      log(
        `[PREMIUM] Ticket no consumido anulado antes del cierre (${ticket.tipoComida}, ${user.username}).`,
        'success'
      );
    } else {
      log(
        `[PREMIUM] Cancelación pendiente de confirmar (${ticket.tipoComida}, ${user.username}).`,
        'warning'
      );
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const today = limaDate(now());
      const users = db
        .getAllUsers(false)
        .filter((user) => user.role !== 'superadmin');
      for (const user of users) {
        const plan = user.premium;
        if (!plan) continue;
        const enabled = user.active && isPremium(user, today);
        const pending = db.getAdvanceReservations({
          alumnoCodigo: user.username,
          status: 'ACTIVA'
        });
        for (const item of pending) {
          const close =
            configs[item.tipoComida] &&
            Date.parse(
              `${item.fecha}T${configs[item.tipoComida].horaFin}-05:00`
            );
          const expired =
            item.fecha < today || (close && now() >= close - 40000);
          if (
            item.source === 'premium' &&
            (!enabled || expired ||
              item.fecha > plan.endDate ||
              !plan.meals?.includes(item.tipoComida))
          ) {
            db.cancelAdvanceReservation(item.id);
          }
        }
        if (enabled) seed(user, today);
      }
      const findOwner = (ticket) =>
        users.find(
          (user) =>
            user.username === ticket.alumnoCodigo ||
            (ticket.alumnoDni && user.dni === ticket.alumnoDni)
        );
      const due = [];
      const activeTickets = db
        .getAllReservations()
        .filter(
          (ticket) =>
            ticket.estado === 'ACTIVA' &&
            ticket.fecha === today &&
            isPremium(findOwner(ticket), today)
        );
      const counts = {};
      for (const ticket of activeTickets)
        counts[ticket.tipoComida] = (counts[ticket.tipoComida] || 0) + 1;
      for (const ticket of db.getAllReservations()) {
        if (
          ticket.estado !== 'ACTIVA' ||
          ticket.fecha !== today ||
          !configs[ticket.tipoComida]
        )
          continue;
        const user = findOwner(ticket);
        if (!isPremium(user, today)) continue;
        const close = Date.parse(
          `${today}T${configs[ticket.tipoComida].horaFin}-05:00`
        );
        const leadMs =
          40000 +
          counts[ticket.tipoComida] * 2 * Math.max(requestIntervalMs, 1000);
        if (now() >= close - leadMs && now() < close)
          due.push({ user, ticket, close });
        if (now() >= close && retryAfter.has(String(ticket.id))) {
          log(
            `[PREMIUM] Cierre alcanzado sin confirmar la cancelación de ${ticket.id}. Requiere revisión.`,
            'error'
          );
          retryAfter.delete(String(ticket.id));
        }
      }
      await mapWithConcurrency(due, 2, (item) =>
        cancelUnused(item.user, item.ticket, item.close)
      );
    } finally {
      running = false;
    }
  }

  return { tick };
}

module.exports = {
  MEALS,
  limaDate,
  isPremium,
  compareQueue,
  validatePremium,
  createPremiumService
};
