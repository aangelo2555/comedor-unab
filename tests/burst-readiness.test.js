const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function createBurstHarness() {
  const intervals = [];
  const students = ['one', 'two'].map((id) => ({
    id,
    username: id,
    name: id,
    active: true,
    role: 'user'
  }));
  const advances = students.map((u) => ({
    alumnoCodigo: u.username,
    tipoComida: 'CENA',
    status: 'ACTIVA'
  }));
  const db = {
    getAdvanceReservations: () => advances,
    getAllUsers: () => students
  };
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
    process,
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
    AbortSignal
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'),
    context
  );
  vm.runInContext(
    `
    globalSniper.running = true;
    globalSniper.targetMeal = 'CENA';
    globalSniper.targetDate = '2026-11-19';
    emitLog = () => {};
    broadcastSSE = () => {};
    const probeUsers = [];
    getValidUnabToken = async user => { probeUsers.push(user.id); return 'token'; };
    let menu = [{tipoComida:'DESAYUNO'}, {tipoComida:'ALMUERZO'}];
    fetchComedorApi = async () => ({ok:true, data:{data:menu}});
    isMealInServiceWindow = () => true;
    let sentinelStarted = false;
    startSentinelWatch = () => { sentinelStarted = true; };
  `,
    context
  );
  return { context, intervals };
}

test('partial programming keeps polling until the target meal is published', async () => {
  const { context, intervals } = createBurstHarness();
  await vm.runInContext('executeMultiUserBurst()', context);
  const poll = intervals.at(-1);
  await poll();
  assert.equal(vm.runInContext('globalSniper.status', context), 'RESERVING');
  await poll();
  assert.equal(vm.runInContext('globalSniper.status', context), 'RESERVING');
  assert.equal(vm.runInContext('sentinelStarted', context), false);
});

test('failed student authentication remains pending and starts sentinel recovery', async () => {
  const { context, intervals } = createBurstHarness();
  await vm.runInContext('executeMultiUserBurst()', context);
  const poll = intervals.at(-1);
  await poll();
  await poll();
  assert.deepEqual(Array.from(vm.runInContext('probeUsers', context)), [
    'one',
    'two'
  ]);
  vm.runInContext(
    `menu = [{tipoComida:'CENA',id:'dinner'}];
    let authCalls = 0;
    getValidUnabToken = async () => ++authCalls === 1 ? 'probe-token' : null;`,
    context
  );
  await poll();
  assert.equal(vm.runInContext('sentinelStarted', context), true);
  assert.equal(
    vm.runInContext('globalSniper.lastRunResults.length', context),
    2
  );
  assert.equal(
    vm.runInContext(
      'globalSniper.lastRunResults.every(r => r.results.some(result => !result.success))',
      context
    ),
    true
  );
});

test('changing the scheduled service during authentication leaves the new run intact', async () => {
  const { context, intervals } = createBurstHarness();
  await vm.runInContext('executeMultiUserBurst()', context);
  vm.runInContext(
    'let releaseProbe; getValidUnabToken = () => new Promise(resolve => { releaseProbe = resolve; });',
    context
  );
  const tick = intervals.at(-1)();
  vm.runInContext(
    "stopGlobalSniper(true); globalSniper.targetMeal = 'DESAYUNO'; globalSniper.targetDate = '2026-11-20'; globalSniper.status = 'ARMED'; globalSniper.running = true; releaseProbe('token');",
    context
  );
  await tick;
  assert.equal(vm.runInContext('globalSniper.status', context), 'ARMED');
  assert.equal(vm.runInContext('globalSniper.targetMeal', context), 'DESAYUNO');
  assert.equal(vm.runInContext('sentinelStarted', context), false);
});

test('failed authentication preserves FIFO position regardless of legacy premium status', () => {
  const { context } = createBurstHarness();
  vm.runInContext(
    `
    db.getAllUsers(false).forEach(user => { user.autoSniper = true; });
    db.getAllReservations = () => [];
    const appointments = db.getAdvanceReservations();
    appointments[0].createdAt = '2026-11-19T16:00:00Z';
    appointments[1].createdAt = '2026-11-19T17:00:00Z';
    authWarnings.set('one', Date.now());
  `,
    context
  );
  const getNames = () =>
    Array.from(
      vm.runInContext(
        "getStudentsInSentinelQueue('2026-11-19', 'CENA').map(item => item.studentUsername)",
        context
      )
    );
  assert.deepEqual(getNames(), ['one', 'two']);
  vm.runInContext(
    "db.getAllUsers(false)[1].premium = { enabled: true, endDate: '2026-11-20', meals: ['CENA'] };",
    context
  );
  assert.deepEqual(getNames(), ['one', 'two']);
  assert.equal(
    vm.runInContext(
      "getAllPendingAdvanceReservations().find(item => item.studentUsername === 'one').authPending",
      context
    ),
    true
  );
});
