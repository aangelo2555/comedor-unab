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
    autoSniper: true,
    legalConsent: { version: '2026-11-20' },
    password: 'test',
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
    process: { ...process, once() {} },
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
    const apiCaller = fetchComedorApi;
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
    db.getAllUsers(false).push({id:'late',username:'late',role:'user',active:true,autoSniper:true});
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
    broadcastSSE('institutional-session-required',{student:'one'});
  `, context);
  assert.equal(vm.runInContext('delivered.one.length', context), 2);
  assert.equal(vm.runInContext('delivered.two.length', context), 1);
  assert.equal(vm.runInContext('delivered.admin.length', context), 4);
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

test('lost institutional credentials require login once, send no authentication request, and recover with a fresh token', async () => {
  const { context } = createBurstHarness();
  vm.runInContext(`
    const messages = [];
    const notices = [];
    emitLog = message => messages.push(message);
    broadcastSSE = (event, payload) => notices.push({event,payload});
    const lostStudent = { id:'one',username:'one',legalConsent:{version:TERMS_VERSION} };
    db.findUserById = () => lostStudent;
    authenticateUserWithUnab = async () => { throw Error('Must not call login without credentials'); };
  `, context);
  assert.equal(await vm.runInContext('tokenResolver(lostStudent)', context), null);
  assert.equal(await vm.runInContext('tokenResolver(lostStudent)', context), null);
  assert.equal(vm.runInContext('messages.length', context), 1);
  assert.equal(vm.runInContext('messages[0].includes("error de comunicación")', context), false);
  assert.equal(vm.runInContext('notices[0].event', context), 'institutional-session-required');
  assert.equal(vm.runInContext('authIssues.get("one").requiresLogin', context), true);
  assert.equal(vm.runInContext('db.getAdvanceReservations().length', context), 2);
  vm.runInContext(`lostStudent.unabToken = 'e30.' + Buffer.from(JSON.stringify({exp: Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.signature';`, context);
  assert.ok(await vm.runInContext('tokenResolver(lostStudent)', context));
  assert.equal(vm.runInContext('authIssues.has("one") || authWarnings.has("one")', context), false);
});

test('paused automation is excluded consistently from burst and sentinel without deleting its request', async () => {
  const { context, intervals } = createBurstHarness();
  vm.runInContext(`
    db.getAllUsers(false)[1].autoSniper = false;
    db.getAllReservations = () => [];
    getValidUnabToken = async user => { probeUsers.push(user.id); return null; };
  `, context);
  await vm.runInContext('executeMultiUserBurst()', context);
  await intervals.at(-1)();
  await intervals.at(-1)();
  assert.deepEqual(Array.from(vm.runInContext('probeUsers', context)), ['one', 'one']);
  assert.equal(vm.runInContext("getStudentsInSentinelQueue('2026-11-19', 'CENA').length", context), 1);
  assert.equal(vm.runInContext('db.getAdvanceReservations().length', context), 2);
});

test('failed session preparation does not report unpublished services without actually checking programming', async () => {
  const { context, intervals } = createBurstHarness();
  vm.runInContext(`
    const statusMessages = [];
    emitLog = message => statusMessages.push(message);
    getValidUnabToken = async () => null;
    fetchComedorApi = async () => { throw Error('Must not query programming without a session'); };
  `, context);
  await vm.runInContext('executeMultiUserBurst()', context);
  const poll = intervals.at(-1);
  for (let index=0; index<61; index++) await poll();
  assert.ok(vm.runInContext('statusMessages.some(message => message.includes("ninguna sesión institucional estuvo lista"))', context));
  assert.equal(vm.runInContext('statusMessages.some(message => message.includes("sin detectar publicación"))', context), false);
  assert.equal(vm.runInContext('sentinelStarted', context), true);
});

test('simultaneous rejected reads share automatic renewal and retry once with the fresh token', async () => {
  const {context} = createBurstHarness();
  vm.runInContext(`
    const owner = db.getAllUsers(false)[0];
    owner.unabToken = 'old-token';
    db.findUserById = id => db.getAllUsers(false).find(user => user.id === id);
    db.updateUser = (id,value) => Object.assign(db.findUserById(id), value);
    let renewals = 0;
    let apiReads = 0;
    fetchComedorApi = apiCaller;
    getValidUnabToken = tokenResolver;
    authenticateUserWithUnab = async user => {
      renewals++;
      await new Promise(resolve => setTimeout(resolve, 15));
      const token = 'e30.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.fresh';
      user.unabToken = token;
      return {success:true,token};
    };
    fetchUnabResponse = async (url, options) => {
      apiReads++;
      return options.headers.Authorization === 'Bearer old-token' ? {status:401,ok:false,data:{}} : {status:200,ok:true,data:{data:[]}};
    };
  `,context);
  const results = await vm.runInContext("Promise.all([apiCaller('/reservas/me', 'old-token'), apiCaller('/programacion/me', 'old-token')])",context);
  assert.ok(results.every(result => result.ok));
  assert.equal(vm.runInContext('renewals',context),1);
  assert.equal(vm.runInContext('apiReads',context),4);
});

test('warmup rejection does not deadlock on its own pending renewal and writes are never blindly replayed', async () => {
  const {context} = createBurstHarness();
  vm.runInContext(`
    const owner = db.getAllUsers(false)[0];
    owner.unabToken = 'e30.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.old';
    db.findUserById = id => db.getAllUsers(false).find(user => user.id === id);
    db.updateUser = (id,value) => Object.assign(db.findUserById(id), value);
    getValidUnabToken = tokenResolver;
    fetchComedorApi = apiCaller;
    let renewals = 0;
    let apiCalls = 0;
    authenticateUserWithUnab = async user => { renewals++; user.unabToken = 'fresh-token'; return {success:true,token:'fresh-token'}; };
    fetchUnabResponse = async () => { apiCalls++; return {ok:false,status:401,data:{}}; };
  `,context);
  const token = await Promise.race([
    vm.runInContext('tokenResolver(owner, true)',context),
    new Promise((resolve,reject)=>setTimeout(()=>reject(Error('Warmup deadlocked')),300))
  ]);
  assert.equal(token,'fresh-token');
  assert.equal(vm.runInContext('renewals',context),1);
  await vm.runInContext("apiCaller('/reservas', 'fresh-token', {method:'POST'})",context);
  assert.equal(vm.runInContext('apiCalls',context),2);
  assert.equal(vm.runInContext('renewals',context),1);
});

test('definitively rejected credentials pause retries until credentials change', async()=>{
  const {context}=createBurstHarness();
  vm.runInContext(`
    const owner = db.getAllUsers(false)[0];
    db.findUserById = () => owner;
    let renewals = 0;
    authenticateUserWithUnab = async () => { renewals++; return {success:false,status:401,code:'CREDENTIALS_REJECTED'}; };
  `,context);
  await vm.runInContext('tokenResolver(owner)',context);
  await vm.runInContext('tokenResolver(owner)',context);
  assert.equal(vm.runInContext('renewals',context),1);
  vm.runInContext("owner.password = 'corrected-password'",context);
  await vm.runInContext('tokenResolver(owner)',context);
  assert.equal(vm.runInContext('renewals',context),2);
});

test('a late rejection of an old session does not discard a newer successful login', async()=>{
  const {context}=createBurstHarness();
  vm.runInContext(`
    const owner = db.getAllUsers(false)[0];
    const makeToken = suffix => 'e30.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.'+suffix;
    owner.unabToken = makeToken('old');
    db.findUserById = () => owner;
    db.updateUser = (id,value) => Object.assign(owner,value);
    fetchComedorApi = async () => { owner.unabToken = makeToken('new'); return {ok:false,status:401}; };
    authenticateUserWithUnab = async () => { throw Error('New login must be retained'); };
  `,context);
  assert.equal(await vm.runInContext('tokenResolver(owner,true)',context),vm.runInContext("makeToken('new')",context));
});

test('a generic institution 401 renews automatically after a pause without asking the student to log in', async()=>{
  const {context}=createBurstHarness();
  vm.runInContext(`
    const owner = db.getAllUsers(false)[0];
    db.findUserById = () => owner;
    let loginCalls = 0;
    authenticateUserWithUnab = async () => {
      loginCalls++;
      if (loginCalls === 1) return {success:false,status:401,code:'AUTHENTICATION_UNCONFIRMED'};
      owner.unabToken = 'e30.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.fresh';
      return {success:true,token:owner.unabToken};
    };
  `,context);
  assert.equal(await vm.runInContext('tokenResolver(owner)',context),null);
  assert.equal(vm.runInContext('institutionalSessionState(owner)',context),'RECOVERING');
  assert.equal(vm.runInContext('authIssues.get(owner.id).requiresLogin',context),false);
  await vm.runInContext('tokenResolver(owner)',context);
  assert.equal(vm.runInContext('loginCalls',context),1);
  vm.runInContext('authRetryState.get(owner.id).until = 0',context);
  assert.ok(await vm.runInContext('tokenResolver(owner)',context));
  assert.equal(vm.runInContext('institutionalSessionState(owner)',context),'READY');
  assert.equal(vm.runInContext('authIssues.has(owner.id)',context),false);
});
