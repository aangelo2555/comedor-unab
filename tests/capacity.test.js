const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { RequestGate, retryDelay } = require('../upstream-control');
const { createReservationService } = require('../reservation-service');

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

test('shared gate limits 100 concurrent callers and honors a global pause', async () => {
  const gate = new RequestGate({ concurrency: 2, intervalMs: 2 });
  let active = 0;
  let peak = 0;
  const starts = [];
  await Promise.all(
    Array.from({ length: 100 }, () =>
      gate.run(async () => {
        starts.push(Date.now());
        peak = Math.max(peak, ++active);
        if (starts.length === 1) gate.pause(30);
        await wait(5);
        active--;
      })
    )
  );
  assert.ok(peak <= 2);
  assert.ok(starts[1] - starts[0] >= 29);
  assert.equal(starts.length, 100);
  assert.equal(retryDelay('3', 0), 3000);
  assert.equal(
    retryDelay(
      'Thu, 19 Nov 2026 22:00:05 GMT',
      0,
      Date.parse('2026-11-19T22:00:00Z')
    ),
    5000
  );
});

test('concurrent reservation attempts reconcile a lost response and share a single write', async () => {
  let ticket = null;
  let posts = 0;
  const reserve = createReservationService(async (url, token, options) => {
    if (!options) return { ok: true, data: { data: ticket ? [ticket] : [] } };
    posts++;
    await wait(5);
    ticket = {
      id: 'ticket',
      tipoComida: 'CENA',
      fecha: '2026-11-19',
      estado: 'ACTIVA'
    };
    return { ok: false, status: 503, error: 'response lost' };
  });
  const results = await Promise.all(
    Array.from({ length: 100 }, () =>
      reserve('student', 'token', 'dinner', '2026-11-19', 'CENA')
    )
  );
  assert.equal(posts, 1);
  assert.ok(
    results.every((result) => result.ok && result.data.data.id === 'ticket')
  );
  assert.equal(
    (await reserve('student', 'token', 'dinner', '2026-11-19', 'CENA')).ok,
    true
  );
  assert.equal(posts, 1);
});

test('100 students across three services and two dates keep queues separate under upstream failures', async () => {
  const students = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    username: String(index),
    name: 'Test ' + index,
    dni: index % 25 === 0 ? '' : 'dni' + index,
    password: 'test',
    active: true,
    autoSniper: true,
    role: 'user'
  }));
  const dates = ['2026-11-19', '2026-11-20'];
  const meals = ['DESAYUNO', 'ALMUERZO', 'CENA'];
  const advances = dates.flatMap((fecha) =>
    meals.flatMap((tipoComida) =>
      students.map((user) => ({
        id: [fecha, tipoComida, user.id].join('|'),
        alumnoCodigo: user.username,
        alumnoDni: user.dni,
        tipoComida,
        fecha,
        status: 'ACTIVA',
        createdAt: user.id.padStart(3, '0')
      }))
    )
  );
  const reservations = [];
  const db = {
    getAllUsers: () => students,
    findUserById: (id) => students.find((user) => user.id === id),
    findUserByUsername: (name) =>
      students.find((user) => user.username === name),
    updateUser: (id, update) =>
      Object.assign(
        students.find((user) => user.id === id),
        update
      ),
    getAdvanceReservations: (filter) =>
      advances.filter((item) =>
        Object.entries(filter).every(([key, value]) => item[key] === value)
      ),
    getAllReservations: () => reservations,
    recordReservation: (ticket) => {
      if (!reservations.some((item) => item.id === ticket.id))
        reservations.push(ticket);
    },
    markAdvanceReservationConfirmed: (id, ticket) =>
      Object.assign(
        advances.find((item) => item.id === id),
        { status: 'CONFIRMADA', ticketId: ticket.id }
      )
  };
  const intervals = [];
  const remoteTickets = new Map();
  const posts = new Map();
  const quotas = { DESAYUNO: 100, ALMUERZO: 70, CENA: 40 };
  let unavailableAuth = true;
  let active = 0;
  let peak = 0;
  let requestCount = 0;
  let saturated = false;
  let duplicateWrites = 0;
  let currentDate;
  let currentMeal;
  let menusReady = false;
  const context = vm.createContext({
    require: (name) =>
      name === './db'
        ? db
        : name === 'http'
          ? { createServer: () => ({ listen() {} }) }
          : require(
              name.startsWith('./') ? path.resolve(__dirname, '..', name) : name
            ),
    __dirname: path.resolve(__dirname, '..'),
    process: {
      ...process,
      once() {},
      env: { ...process.env, UNAB_REQUEST_INTERVAL_MS: '1' }
    },
    console,
    setInterval: (callback) => {
      intervals.push(callback);
      return intervals.length;
    },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    Buffer,
    URL,
    AbortSignal,
    fetch: async (url, options) => {
      peak = Math.max(peak, ++active);
      requestCount++;
      try {
        await wait(requestCount % 9 === 0 ? 8 : 1);
        if (url.includes('/auth/login')) {
          const user = JSON.parse(options.body).UserName;
          if (unavailableAuth && Number(user) >= 98)
            return Response.json(
              { message: 'temporary login failure' },
              { status: 401 }
            );
          const token =
            'e30.' +
            Buffer.from(
              JSON.stringify({
                exp: Math.floor(Date.now() / 1000) + 3600,
                sub: user
              })
            ).toString('base64url') +
            '.signature';
          return Response.json({ accessToken: token });
        }
        const token = options.headers.Authorization.slice(7);
        const user = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64url')
        ).sub;
        if (url.endsWith('/auth/me'))
          return Response.json({ data: { nombre: 'Test ' + user } });
        if (url.includes('/programacion/')) {
          const date = new URL(url).searchParams.get('date');
          assert.equal(date, currentDate);
          if (!saturated) {
            saturated = true;
            return Response.json(
              { message: 'busy' },
              { status: 429, headers: { 'Retry-After': '0.02' } }
            );
          }
          return Response.json({
            data: meals
              .filter((meal) => menusReady || meal !== currentMeal)
              .map((meal) => ({
                id: date + '|' + meal,
                tipoComida: meal,
                disponibleLibre: quotas[meal]
              }))
          });
        }
        if (url.includes('/reservas/me')) {
          const date = new URL(url).searchParams.get('fecha');
          return Response.json({
            data: [...remoteTickets.values()].filter(
              (ticket) => ticket.alumnoCodigo === user && ticket.fecha === date
            )
          });
        }
        if (url.endsWith('/reservas') && options.method === 'POST') {
          const [date, meal] = JSON.parse(options.body).programacionId.split(
            '|'
          );
          assert.equal(date, currentDate);
          assert.equal(meal, currentMeal);
          const key = [user, date, meal].join('|');
          posts.set(key, (posts.get(key) || 0) + 1);
          if (remoteTickets.has(key)) {
            duplicateWrites++;
            throw new Error('Duplicate write ' + key);
          }
          if (Number(user) >= quotas[meal])
            return Response.json({ message: 'Sin cupos' }, { status: 409 });
          remoteTickets.set(key, {
            id: key,
            fecha: date,
            tipoComida: meal,
            alumnoCodigo: user,
            estado: 'ACTIVA',
            qrToken: 'test'
          });
          if (Number(user) % 17 === 0)
            throw new TypeError('response lost after commit');
          return Response.json({ success: true, data: remoteTickets.get(key) });
        }
        throw new Error('Unexpected request ' + url);
      } finally {
        active--;
      }
    }
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'),
    context
  );
  vm.runInContext(
    'emitLog=()=>{};broadcastSSE=()=>{};isMealInServiceWindow=()=>true;',
    context
  );
  for (const date of dates)
    for (const meal of meals) {
      currentDate = date;
      currentMeal = meal;
      menusReady = false;
      context.runDate = date;
      context.runMeal = meal;
      vm.runInContext(
        'stopGlobalSniper(true);globalSniper.targetDate=runDate;globalSniper.targetMeal=runMeal;globalSniper.running=true;',
        context
      );
      await vm.runInContext('executeMultiUserBurst()', context);
      const poll = intervals.at(-1);
      await poll();
      assert.equal(
        advances.filter(
          (item) =>
            item.fecha === date &&
            item.tipoComida === meal &&
            item.status === 'CONFIRMADA'
        ).length,
        0
      );
      menusReady = true;
      await poll();
      const beforeRecovery = advances.filter(
        (item) =>
          item.fecha === date &&
          item.tipoComida === meal &&
          item.status === 'CONFIRMADA'
      ).length;
      assert.equal(
        beforeRecovery,
        Math.min(quotas[meal], unavailableAuth ? 98 : 100)
      );
      assert.ok(
        advances
          .filter((item) => item.fecha !== date || item.tipoComida !== meal)
          .every(
            (item) =>
              item.status === 'ACTIVA' ||
              remoteTickets.has(
                [item.alumnoCodigo, item.fecha, item.tipoComida].join('|')
              )
          )
      );
      if (beforeRecovery < 100) {
        unavailableAuth = false;
        quotas[meal] = 100;
        await intervals.at(-1)();
      }
      assert.equal(
        advances.filter(
          (item) =>
            item.fecha === date &&
            item.tipoComida === meal &&
            item.status === 'CONFIRMADA'
        ).length,
        100
      );
    }
  assert.equal(duplicateWrites, 0);
  assert.equal(remoteTickets.size, 600);
  assert.equal(reservations.length, 600);
  assert.ok(peak <= 2, `peak upstream concurrency ${peak}`);
  // Rejected writes may be retried after capacity changes. Committed writes must occur once.
  for (const [key, ticket] of remoteTickets)
    assert.ok(posts.get(key) <= 2, key);
  console.log(
    `Simulated 600 confirmed tickets, ${requestCount} upstream requests, peak concurrency ${peak}`
  );
});

test('cancellation during ticket verification prevents a queued reservation write', async () => {
  let active = true;
  let releaseCheck;
  let writes = 0;
  const checking = new Promise((resolve) => {
    releaseCheck = resolve;
  });
  const reserve = createReservationService(async (url, token, options) => {
    if (options) {
      writes++;
      return { ok: true, data: { success: true, data: { id: 'unexpected' } } };
    }
    await checking;
    return { ok: true, data: { data: [] } };
  });
  const operation = reserve(
    'student',
    'token',
    'dinner',
    '2026-11-19',
    'CENA',
    () => active
  );
  active = false;
  releaseCheck();
  const result = await operation;
  assert.equal(result.status, 409);
  assert.equal(writes, 0);
});

test('a failed ticket lookup keeps the request pending without submitting a reservation', async () => {
  let writes = 0;
  const reserve = createReservationService(async (url, token, options) => {
    if (options) writes++;
    return { ok: false, status: 503, data: { error: 'Upstream unavailable' } };
  });
  const result = await reserve(
    'student',
    'token',
    'dinner',
    '2026-11-19',
    'CENA'
  );
  assert.equal(result.status, 503);
  assert.equal(writes, 0);
});

test('shared request queue rejects overload and continues serving existing work', async () => {
  const gate = new RequestGate({ concurrency: 1, intervalMs: 1, maxQueue: 1 });
  let release;
  const blocked = gate.run(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const queued = gate.run(() => 'served');
  await assert.rejects(
    gate.run(() => 'overflow'),
    /cola/
  );
  await wait(1);
  release();
  await blocked;
  assert.equal(await queued, 'served');
});
