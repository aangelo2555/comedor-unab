const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

if (process.env.FREE_HELP_CHILD) {
  if (process.env.BOOKING_CHILD === '1') {
    const RealDate = Date;
    const offset = RealDate.parse('2026-11-25T09:00:00-05:00') - RealDate.now();
    global.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [RealDate.now()+offset])); }
      static now() { return RealDate.now()+offset; }
    };
  }
  global.fetch = async url => {
    if (url.includes('/auth/login') && process.env.TOKENLESS_LOGIN === '1') return Response.json({}, { status: 201 });
    if (url.includes('/auth/login')) return Response.json({ data: { accessToken: 'e30.' + Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url') + '.test' } }, { status: 201 });
    if (url.endsWith('/auth/me')) return Response.json({ data: { nombre: 'Test student' } });
    return Response.json({ data: [] });
  };
  const http = require('node:http');
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    this.once('listening', () => process.send({ port: this.address().port }));
    return listen.apply(this, args);
  };
  require('../server');
} else {
  async function launch(profileComplete, tokenless = false, booking = false) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-help-'));
    const database = path.join(directory, 'database.json');
    fs.writeFileSync(database, JSON.stringify({ users: [
      { id: 'student', username: 'test-student', password: 'institution-secret', role: 'user', active: true, premiumRequest: { status: 'PENDING', reference: 'OLD-PAYMENT', meals: ['CENA'] } }
    ], reservas: booking ? [
      {id:'old-dinner',alumnoCodigo:'test-student',tipoComida:'CENA',fecha:'2026-11-25',estado:booking === 'confirmed' ? 'ACTIVA' : 'ANULADA'},
      {id:'consumed-breakfast',alumnoCodigo:'test-student',tipoComida:'DESAYUNO',fecha:'2026-11-25',estado:'CONSUMIDA'}
    ] : [], advanceReservations: [], auditLogs: [] }));
    const child = fork(__filename, [], { env: {
      ...process.env, BOOKING_CHILD: booking ? '1' : '0', TOKENLESS_LOGIN: tokenless ? '1' : '0', FREE_HELP_CHILD: '1', DATA_DIR: directory, PORT: '0',
      DATABASE_URL: '', PGHOST: '', ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'admin-test-only',
      SERVICE_OPERATOR: profileComplete ? 'Test operator' : '', SERVICE_CONTACT_EMAIL: profileComplete ? 'test@example.test' : '',
      VOLUNTARY_CONTRIBUTIONS_ENABLED: 'false', UNAB_REQUEST_INTERVAL_MS: '1'
    }, silent: true });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Startup timeout')), 5000);
      child.on('message', message => { if (message.port) { clearTimeout(timer); resolve(message.port); } });
      child.on('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code)); });
    });
    const request = (endpoint, method = 'GET', body, token) => fetch('http://127.0.0.1:' + port + endpoint, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { database, request, async close() {
      const exited = once(child, 'exit'); child.kill(); await exited;
      fs.rmSync(directory, { recursive: true, force: true });
    } };
  }

  test('Premium students can cancel and reactivate a request, book another service and cannot cancel someone else’s queue', async()=>{
    const app=await launch(true,false,true);
    try {
      const {token}=await (await app.request('/api/auth/login','POST',{username:'test-student',password:'institution-secret',termsVersion:'2026-11-20',processingConsent:true})).json();
      const admin=await (await app.request('/api/auth/login','POST',{username:'admin@example.test',password:'admin-test-only'})).json();
      assert.equal((await app.request('/api/admin/premium/student','PUT',{enabled:true,endDate:'2099-12-31',meals:['CENA'],autoCancel:false},admin.token)).status,200);
      const before=await (await app.request('/api/student/premium','GET',undefined,token)).json();
      const dinner=before.appointments.find(item=>item.meal==='CENA');
      assert.equal(dinner.status,'ACTIVA','An old canceled ticket must not mask today’s queue');
      assert.equal((await app.request('/api/student/advance-reservation/'+dinner.id,'DELETE',undefined,token)).status,200);
      const canceled=await (await app.request('/api/student/premium','GET',undefined,token)).json();
      assert.equal(canceled.appointments.find(item=>item.meal==='CENA').canRequestAgain,true);
      assert.equal((await app.request('/api/student/advance-reservation','POST',{meal:'CENA',date:'2026-11-25'},token)).status,200);
      assert.equal((await app.request('/api/student/advance-reservation','POST',{meal:'ALMUERZO',date:'2026-11-25'},token)).status,200);
      const after=await (await app.request('/api/student/premium','GET',undefined,token)).json();
      assert.deepEqual(after.premium.meals,['CENA'],'A one-off booking does not change the recurring plan');
      assert.equal(after.appointments.find(item=>item.meal==='CENA').status,'ACTIVA');
      assert.equal(after.appointments.find(item=>item.meal==='ALMUERZO').status,'ACTIVA');
      assert.equal(after.appointments.filter(item=>item.meal==='CENA').length,1);
      assert.equal((await app.request('/api/student/advance-reservation','POST',{meal:'DESAYUNO',date:'2026-11-25'},token)).status,400,'Consumed tickets cannot be booked again');
      const other=await (await app.request('/api/auth/login','POST',{username:'other-student',password:'test',termsVersion:'2026-11-20',processingConsent:true})).json();
      assert.equal((await app.request('/api/student/advance-reservation/'+dinner.id,'DELETE',undefined,other.token)).status,404);
      const retained=await (await app.request('/api/student/premium','GET',undefined,token)).json();
      assert.equal(retained.appointments.find(item=>item.meal==='CENA').status,'ACTIVA');
    } finally { await app.close(); }
  });

  test('canceling a confirmed Premium ticket stops its daily request and allows an explicit new booking',async()=>{
    const app=await launch(true,false,'confirmed');
    try {
      const {token}=await (await app.request('/api/auth/login','POST',{username:'test-student',password:'institution-secret',termsVersion:'2026-11-20',processingConsent:true})).json();
      const admin=await (await app.request('/api/auth/login','POST',{username:'admin@example.test',password:'admin-test-only'})).json();
      await app.request('/api/admin/premium/student','PUT',{enabled:true,endDate:'2099-12-31',meals:['CENA'],autoCancel:false},admin.token);
      const before=await (await app.request('/api/student/premium','GET',undefined,token)).json();
      const dinner=before.appointments.find(item=>item.meal==='CENA');
      assert.equal(dinner.status,'CONFIRMADA');
      assert.equal((await app.request('/api/student/advance-reservation/'+dinner.id,'DELETE',undefined,token)).status,409);
      assert.equal((await app.request('/api/student/advance-reservation','POST',{meal:'CENA',date:'2026-11-25'},token)).status,400);
      assert.equal((await app.request('/api/comedor/reservas/old-dinner','DELETE',undefined,token)).status,200);
      const canceled=await (await app.request('/api/student/premium','GET',undefined,token)).json();
      assert.equal(canceled.appointments.find(item=>item.meal==='CENA').status,'ANULADA');
      assert.equal(canceled.appointments.find(item=>item.meal==='CENA').canRequestAgain,true);
      assert.equal(canceled.active,true,'Canceling one ticket does not disable Premium');
      assert.equal((await app.request('/api/student/advance-reservation','POST',{meal:'CENA',date:'2026-11-25'},token)).status,200);
      const renewed=await (await app.request('/api/student/premium','GET',undefined,token)).json();
      assert.equal(renewed.appointments.find(item=>item.meal==='CENA').status,'ACTIVA');
      assert.equal(renewed.appointments.filter(item=>item.meal==='CENA').length,1);
    } finally {await app.close();}
  });

  test('a successful HTTP status without an institutional session returns a retryable error to new students', async () => {
    const app = await launch(true, true);
    try {
      const response = await app.request('/api/auth/login', 'POST', { username: 'new-student', password: 'test-only', termsVersion: '2026-11-20', processingConsent: true });
      assert.equal(response.status, 503);
      const data = await response.json();
      assert.equal(data.success, false);
      assert.match(data.error, /sin un token/);
      assert.ok(!JSON.parse(fs.readFileSync(app.database)).users.some(user => user.username === 'new-student'));
    } finally { await app.close(); }
  });

  test('students and admins can sign in without project identification while contributions stay disabled', async () => {
    const app = await launch(false);
    try {
      const policy = await (await app.request('/api/service-policy')).json();
      assert.equal(policy.integrationEnabled, true);
      assert.equal(policy.contributionsEnabled, false);
      assert.equal((await app.request('/')).headers.get('cache-control'), 'no-store');
      assert.equal((await app.request('/app.js?v=login-20261124')).headers.get('cache-control'), 'no-store');
      const versionResponse = await app.request('/api/version');
      assert.equal(versionResponse.headers.get('cache-control'), 'no-store');
      const { version } = await versionResponse.json();
      assert.match(version, /^[a-f0-9]{64}$/);
      for (const page of ['/', '/terminos.html', '/unknown-page']) {
        const html = await (await app.request(page)).text();
        assert.ok(html.includes(`name="app-version" content="${version}"`));
        assert.ok(html.includes(`/auto-update.js?v=${version}`));
        assert.ok(!html.includes('__APP_VERSION__'));
      }
      assert.equal((await app.request('/api/auth/login', 'POST', { username: 'test-student', password: 'institution-secret' })).status, 400);
      const login = await app.request('/api/auth/login', 'POST', { username: 'test-student', password: 'institution-secret', termsVersion: '2026-11-20', processingConsent: true });
      assert.equal(login.status, 200);
      const { token } = await login.json();
      assert.equal((await app.request('/api/student/premium', 'PUT', { meals: ['CENA'], termsVersion: '2026-11-20', automationConsent: true }, token)).status, 403);
      const adminLogin = await app.request('/api/auth/login', 'POST', { username: 'admin@example.test', password: 'admin-test-only' });
      assert.equal(adminLogin.status, 200);
      const admin = await adminLogin.json();
      assert.equal((await app.request('/api/admin/users', 'GET', undefined, admin.token)).status, 200);
      assert.equal((await app.request('/api/events')).status, 401);
      assert.equal((await app.request('/api/sniper/queue')).status, 403);
    } finally { await app.close(); }
  });

  test('only administrators configure Premium services, cycle and cancellation; credentials remain private and revocation works', async () => {
    const app = await launch(true);
    try {
      const credentials = { username: 'test-student', password: 'institution-secret' };
      assert.equal((await app.request('/api/auth/login', 'POST', credentials)).status, 400);
      const login = await app.request('/api/auth/login', 'POST', { ...credentials, termsVersion: '2026-11-20', processingConsent: true });
      assert.equal(login.status, 200);
      const { token } = await login.json();
      assert.equal((await app.request('/api/student/premium', 'PUT', { meals: ['CENA'] }, token)).status, 403);
      assert.equal((await app.request('/api/student/premium/checkout', 'POST', { meals: ['CENA'] }, token)).status, 410);
      const initial = await (await app.request('/api/student/premium', 'GET', undefined, token)).json();
      assert.equal(initial.active, false);
      assert.equal((await app.request('/api/admin/premium/student', 'PUT', { enabled: true }, token)).status, 403);
      const admin = await (await app.request('/api/auth/login', 'POST', { username: 'admin@example.test', password: 'admin-test-only' })).json();
      const endDate = '2099-12-31';
      assert.equal((await app.request('/api/admin/premium/student', 'PUT', { enabled: true, endDate, meals: ['INVALID'] }, admin.token)).status, 400);
      assert.equal((await app.request('/api/admin/premium/student', 'PUT', { enabled: true, endDate, meals: [] }, admin.token)).status, 400);
      const configuration = await app.request('/api/admin/premium/student', 'PUT', { enabled: true, endDate, meals: ['DESAYUNO', 'CENA'], autoCancel: true }, admin.token);
      assert.equal(configuration.status, 200);
      const data = await (await app.request('/api/student/premium', 'GET', undefined, token)).json();
      assert.equal(data.active, true);
      assert.deepEqual(data.premium.meals, ['DESAYUNO', 'CENA']);
      assert.equal(data.premium.endDate, endDate);
      assert.equal(data.premium.managedBy, 'admin');
      assert.equal(data.automationConsent.autoCancel, true);
      assert.equal(data.automationConsent.source, 'admin');
      assert.equal(data.paymentRequest.reference, 'OLD-PAYMENT');
      assert.equal((await app.request('/api/student/premium', 'PUT', { meals: [] }, token)).status, 403);
      assert.equal((await (await app.request('/api/student/premium', 'GET', undefined, token)).json()).active, true);
      assert.equal((await app.request('/api/admin/premium/student', 'PUT', { enabled: false }, admin.token)).status, 200);
      assert.equal((await (await app.request('/api/student/premium', 'GET', undefined, token)).json()).active, false);
      const backup = await (await app.request('/api/admin/backup', 'GET', undefined, admin.token)).json();
      assert.equal(backup.users.find(user => user.id === 'student').password, '');
      assert.equal(backup.users.find(user => user.id === 'student').unabToken, '');
      assert.match(backup.users.find(user => user.role === 'superadmin').password, /^scrypt\$/);
      assert.deepEqual(backup.sessions, []);
      const saved = fs.readFileSync(app.database, 'utf8');
      assert.ok(!saved.includes('institution-secret'));
      assert.ok(!saved.includes('admin-test-only'));
      assert.equal((await app.request('/api/student/authorization', 'DELETE', undefined, token)).status, 200);
      assert.equal((await app.request('/api/auth/me', 'GET', undefined, token)).status, 401);
      const revoked = JSON.parse(fs.readFileSync(app.database, 'utf8')).users.find(user => user.id === 'student');
      assert.equal(revoked.autoSniper, false);
      assert.equal(revoked.premium.enabled, false);
      assert.equal(revoked.legalConsent, null);
    } finally { await app.close(); }
  });
}
