const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createPremiumService,
  compareQueue,
  isPremium,
  validatePremium
} = require('../premium-service');

function fixture({ count = 1, clock = '2026-11-19T18:00:00-05:00' } = {}) {
  let time = Date.parse(clock);
  const users = Array.from({ length: count }, (_, id) => ({
    id: String(id),
    username: String(id),
    name: 'Student ' + id,
    active: true,
    role: 'user',
    automationConsent: { enabled: true, autoCancel: true },
    premium: { enabled: true, endDate: '2026-11-20', meals: ['CENA'] }
  }));
  const advances = [];
  const tickets = [];
  const calls = [];
  const remoteStates = new Map();
  const db = {
    getAllUsers: () => users,
    getAdvanceReservations: (filter) =>
      advances.filter((item) =>
        Object.entries(filter).every(([key, value]) => item[key] === value)
      ),
    createAdvanceReservation: (data) =>
      advances.push({ ...data, id: String(advances.length), status: 'ACTIVA' }),
    cancelAdvanceReservation: (id) => {
      advances.find((item) => item.id === id).status = 'ANULADA';
    },
    getAllReservations: () => tickets,
    updateReservationStatus: (id, state) => {
      tickets.find((item) => item.id === id).estado = state;
    }
  };
  const service = createPremiumService({
    db,
    configs: {
      DESAYUNO: { horaFin: '10:30:00' },
      ALMUERZO: { horaFin: '16:00:00' },
      CENA: { horaFin: '19:00:00' }
    },
    getToken: async (user) => user.username,
    callApi: async (url, token, options) => {
      calls.push({ url, token, options });
      if (options.method === 'DELETE')
        return { ok: true, data: { success: true } };
      return {
        ok: true,
        data: {
          data: tickets
            .filter((ticket) => ticket.alumnoCodigo === token)
            .map((ticket) => ({
              ...ticket,
              estado: remoteStates.get(ticket.id) || ticket.estado
            }))
        }
      };
    },
    log() {},
    now: () => time
  });
  return {
    service,
    users,
    advances,
    tickets,
    calls,
    remoteStates,
    setTime: (value) => {
      time = Date.parse(value);
    }
  };
}

test('contributions and legacy premium status do not change FIFO order', () => {
  const queue = [
    { id: 'first-standard', createdAt: '2026-11-19T10:00:00Z' },
    { id: 'second-premium', premium: true, createdAt: '2026-11-19T12:00:00Z' },
    { id: 'first-premium', premium: true, createdAt: '2026-11-19T11:00:00Z' }
  ];
  assert.deepEqual(
    queue.sort(compareQueue).map((item) => item.id),
    ['first-standard', 'first-premium', 'second-premium']
  );
  assert.equal(
    isPremium(
      { premium: { enabled: true, endDate: '2026-11-19' } },
      '2026-11-20'
    ),
    false
  );
  assert.throws(
    () =>
      validatePremium({ enabled: true, endDate: '2027-02-30' }, '2026-11-19'),
    /fecha/
  );
});

test('recurrence is idempotent, respects cancellations and stops at the cycle end', async () => {
  const f = fixture();
  f.users[0].premium.meals = ['DESAYUNO', 'CENA'];
  await f.service.tick();
  assert.equal(f.advances.length, 1);
  f.advances[0].status = 'ANULADA';
  await f.service.tick();
  assert.equal(f.advances.length, 1);
  assert.equal(f.advances[0].status, 'ANULADA');
  f.setTime('2026-11-20T09:00:00-05:00');
  await f.service.tick();
  assert.ok(f.advances.every((item) => item.fecha <= '2026-11-20'));
  assert.equal(
    f.advances.filter((item) => item.fecha === '2026-11-20').length,
    2
  );
  f.setTime('2026-11-21T09:00:00-05:00');
  await f.service.tick();
  assert.equal(f.advances.filter((item) => item.status === 'ACTIVA').length, 0);
});

test('deselecting meals stops generated pending requests while keeping confirmed tickets', async () => {
  const f = fixture();
  await f.service.tick();
  f.users[0].premium.meals = [];
  f.tickets.push({
    id: 'confirmed',
    alumnoCodigo: '0',
    tipoComida: 'CENA',
    fecha: '2026-11-19',
    estado: 'ACTIVA'
  });
  await f.service.tick();
  assert.ok(f.advances.every((item) => item.status === 'ANULADA'));
  assert.equal(f.tickets[0].estado, 'ACTIVA');
});

test('100 cancellation candidates start early and consumed tickets are excluded after fresh verification', async () => {
  const f = fixture({ count: 100, clock: '2026-11-19T18:55:59-05:00' });
  f.users.forEach((user) => {
    f.tickets.push({
      id: user.id,
      alumnoCodigo: user.username,
      tipoComida: 'CENA',
      fecha: '2026-11-19',
      estado: 'ACTIVA'
    });
    if (Number(user.id) % 3 === 0) f.remoteStates.set(user.id, 'CONSUMIDA');
  });
  await f.service.tick();
  assert.equal(f.calls.length, 0);
  f.setTime('2026-11-19T18:56:00-05:00');
  await f.service.tick();
  const deletes = f.calls.filter((call) => call.options.method === 'DELETE');
  assert.equal(deletes.length, 66);
  assert.ok(deletes.every((call) => call.options.priority === 10));
  assert.equal(
    f.tickets.filter((ticket) => ticket.estado === 'ANULADA').length,
    66
  );
  assert.equal(
    f.tickets.filter((ticket) => ticket.estado === 'CONSUMIDA').length,
    34
  );
  await f.service.tick();
  assert.equal(
    f.calls.filter((call) => call.options.method === 'DELETE').length,
    66
  );
});

test('automatic cancellation requires a separate affirmative choice', async () => {
  const f = fixture({ clock: '2026-11-19T18:59:25-05:00' });
  f.users[0].automationConsent.autoCancel = false;
  f.tickets.push({ id: 'keep-ticket', alumnoCodigo: '0', tipoComida: 'CENA', fecha: '2026-11-19', estado: 'ACTIVA' });
  await f.service.tick();
  assert.equal(f.calls.filter(call => call.options?.method === 'DELETE').length, 0);
  assert.equal(f.tickets[0].estado, 'ACTIVA');
});

test('maintenance restores recurrence on restart and avoids cancellation after service closure', async () => {
  const f = fixture({ clock: '2026-11-19T19:00:01-05:00' });
  f.tickets.push({
    id: 'late',
    alumnoCodigo: '0',
    tipoComida: 'CENA',
    fecha: '2026-11-19',
    estado: 'ACTIVA'
  });
  await f.service.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.advances.length, 0);
  f.setTime('2026-11-20T09:00:00-05:00');
  await f.service.tick();
  assert.equal(f.advances.length, 1);
  assert.equal(f.advances[0].fecha, '2026-11-20');
});
