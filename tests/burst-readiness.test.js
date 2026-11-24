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
    fecha: '2026-11-19',
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
    const tokenResolver = getValidUnabToken;
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

test('warmup and last-minute refresh use current enrollment and stop with the engine', async () => {
  const { context } = createBurstHarness();
  const timers = [];
  const cleared = [];
  context.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };
  context.clearTimeout = (id) => cleared.push(id);
  const target = new Date(Date.now() + 600000);
  context.targetDate = target.toLocaleDateString('en-CA', {
    timeZone: 'America/Lima'
  });
  context.targetTime = target.toLocaleTimeString('en-GB', {
    timeZone: 'America/Lima',
    hourCycle: 'h23'
  });
  vm.runInContext(
    `
    isJwtExpired = () => false;
    const preparationCalls = [];
    getValidUnabToken = async (user, force) => { preparationCalls.push({id:user.id, force}); return 'token'; };
    startGlobalSniper({targetMeal:'CENA', targetDate, targetTime});
  `,
    context
  );
  assert.equal(timers.length, 3);
  assert.ok(timers[0].delay >= 298000 && timers[0].delay <= 300000);
  assert.equal(timers[1].delay - timers[0].delay, 240000);
  assert.equal(timers[2].delay - timers[1].delay, 59750);
  await timers[0].callback();
  assert.equal(vm.runInContext('preparationCalls.length', context), 2);
  vm.runInContext(
    `
    db.getAllUsers(false).push({id:'late',username:'late',role:'user',active:true});
    db.getAdvanceReservations().push({alumnoCodigo:'late',tipoComida:'CENA',status:'ACTIVA'});
  `,
    context
  );
  await timers[1].callback();
  assert.equal(vm.runInContext('preparationCalls.length', context), 5);
  assert.equal(vm.runInContext('preparationCalls[4].id', context), 'late');
  assert.equal(vm.runInContext('preparationCalls[4].force', context), false);
  vm.runInContext('stopGlobalSniper(true)', context);
  assert.ok([1, 2, 3].every((id) => cleared.includes(id)));
});

test('tokens must cover opening, while a ready token does not wait for background verification', async () => {
  const { context } = createBurstHarness();
  vm.runInContext(
    `
    getValidUnabToken = tokenResolver;
    db.findUserById = id => db.getAllUsers(false).find(user => user.id === id);
    const student = db.getAllUsers(false)[0];
    student.legalConsent = {version:TERMS_VERSION};
    student.password = 'test';
    const makeToken = ttl => 'e30.' + Buffer.from(JSON.stringify({exp:Math.floor((Date.now()+ttl)/1000)})).toString('base64url') + '.test';
    const nearExpiry = makeToken(180000);
    const preparedToken = makeToken(3600000);
    student.unabToken = nearExpiry;
    let renewals = 0;
    authenticateUserWithUnab = async () => { renewals++; student.unabToken = preparedToken; return {success:true,token:preparedToken}; };
  `,
    context
  );
  assert.equal(vm.runInContext('isJwtExpired(nearExpiry)', context), false);
  assert.equal(
    vm.runInContext('isJwtExpired(nearExpiry,420000)', context),
    true
  );
  await vm.runInContext(
    'getValidUnabToken(student,true,{skipProfile:true},420000)',
    context
  );
  assert.equal(vm.runInContext('renewals', context), 1);
  vm.runInContext(
    'pendingUnabAuth.set(student.id,{promise:new Promise(()=>{}),minimumValidityMs:420000})',
    context
  );
  const token = await Promise.race([
    vm.runInContext('getValidUnabToken(student)', context),
    new Promise((resolve, reject) =>
      setTimeout(
        () =>
          reject(new Error('Ready session waited for background verification')),
        200
      )
    )
  ]);
  assert.equal(token, vm.runInContext('preparedToken', context));
  vm.runInContext('pendingUnabAuth.delete(student.id)', context);
});

test('student event refreshes are limited to the owner while administrator visibility is retained', () => {
  const { context } = createBurstHarness();
  // This harness replaces broadcasting for engine tests. Load the real declaration again.
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('function broadcastSSE(');
  const end = source.indexOf('\nfunction emitLog', start);
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext(`
    const delivered = {one:[],two:[],admin:[]};
    for (const username of ['one','two','admin']) {
      const token = 'token-'+username;
      sessions.set(sessionKey(token), {userId:username});
      sseClients.add({viewer:{token,username,role:username==='admin'?'superadmin':'user'},write:payload=>delivered[username].push(payload),end(){}});
    }
    broadcastSSE('reservation-status-changed',{student:'one',ticket:{id:'private-ticket'}});
    broadcastSSE('sentinel-queue-updated',{queue:[]});
    broadcastSSE('reservation-batch-finished',[{user:'two',results:[]}]);
  `, context);
  assert.equal(vm.runInContext('delivered.one.length', context), 1);
  assert.equal(vm.runInContext('delivered.two.length', context), 1);
  assert.equal(vm.runInContext('delivered.admin.length', context), 3);
  assert.equal(vm.runInContext("delivered.one[0].includes('private-ticket')", context), false);
});

test('Premium priority survives authentication failures in both opening and sentinel queues', async () => {
  const { context, intervals } = createBurstHarness();
  vm.runInContext(`
    db.getAllUsers(false).forEach((user, index) => {
      user.autoSniper = true;
      user.registrationOrder = index + 1;
    });
    Object.assign(db.getAllUsers(false)[1], {
      premium: { enabled: true, endDate: '2099-12-31', meals: ['CENA'] },
      automationConsent: { enabled: true }
    });
    db.getAllReservations = () => [];
    menu = [{ tipoComida: 'CENA', id: 'dinner' }];
    getValidUnabToken = async user => { probeUsers.push(user.id); return null; };
  `, context);
  await vm.runInContext('executeMultiUserBurst()', context);
  await intervals.at(-1)();
  assert.deepEqual(Array.from(vm.runInContext('probeUsers', context)), ['two']);
  assert.deepEqual(Array.from(vm.runInContext("getStudentsInSentinelQueue('2026-11-19', 'CENA').map(item => item.studentUsername)", context)), ['two', 'one']);
  vm.runInContext("authWarnings.set('two', Date.now())", context);
  assert.deepEqual(Array.from(vm.runInContext("getStudentsInSentinelQueue('2026-11-19', 'CENA').map(item => item.studentUsername)", context)), ['two', 'one']);
});

test('repeated tokenless successful logins back off without probing availability or losing the request', async () => {
  const { context } = createBurstHarness();
  vm.runInContext(`
    let failedLogins = 0;
    db.findUserById = id => ({ id, username:id, password:'test', legalConsent:{version:TERMS_VERSION} });
    authenticateUserWithUnab = async () => { failedLogins++; return { success:false, status:201, code:'MISSING_SESSION_TOKEN' }; };
  `, context);
  await vm.runInContext("tokenResolver(db.findUserById('one'))", context);
  await vm.runInContext("tokenResolver(db.findUserById('one'))", context);
  assert.equal(vm.runInContext('failedLogins', context), 1);
  assert.equal(vm.runInContext('authRetryState.get("one").failures', context), 1);
  assert.equal(vm.runInContext('db.getAdvanceReservations().length', context), 2);
  vm.runInContext("authRetryState.get('one').until = 0", context);
  await vm.runInContext("tokenResolver(db.findUserById('one'))", context);
  assert.equal(vm.runInContext('failedLogins', context), 2);
});

test('queue summary includes pending authentication and labels paused automation without counting it as watching', () => {
  const { context } = createBurstHarness();
  vm.runInContext(`
    db.getAllReservations = () => [];
    db.getAllUsers(false).forEach(user => { user.autoSniper = true; });
    authWarnings.set('two', Date.now());
  `, context);
  let summary = vm.runInContext("getPendingQueueSnapshot('2026-11-19', 'CENA')", context);
  assert.equal(summary.queue.length, 2);
  assert.equal(summary.totalPendingCount, 2);
  assert.equal(summary.pendingStudentCount, 2);
  assert.equal(summary.sentinelStudentCount, 2);
  assert.equal(summary.authPendingStudentCount, 1);
  assert.equal(vm.runInContext("getStudentsInSentinelQueue('2026-11-19', 'CENA').length", context), 2);
  vm.runInContext("db.getAllUsers(false)[1].autoSniper = false", context);
  summary = vm.runInContext("getPendingQueueSnapshot('2026-11-19', 'CENA')", context);
  assert.equal(summary.totalPendingCount, 2);
  assert.equal(summary.pendingStudentCount, 2);
  assert.equal(summary.sentinelStudentCount, 1);
  assert.equal(summary.queue.find(item => item.studentUsername === 'two').statusText, 'Automatización pausada');
  vm.runInContext(`
    db.getAllUsers(false)[1].autoSniper = true;
    db.getAdvanceReservations().push({ alumnoCodigo:'one', tipoComida:'ALMUERZO', fecha:'2026-11-19', status:'ACTIVA' });
  `, context);
  summary = vm.runInContext("getPendingQueueSnapshot('2026-11-19', 'CENA')", context);
  assert.equal(summary.totalPendingCount, 3);
  assert.equal(summary.pendingStudentCount, 2);
  assert.equal(summary.sentinelStudentCount, 2);
});
