const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

if (process.env.FREE_HELP_CHILD) {
  global.fetch = async url => {
    if (url.includes('/auth/login')) return Response.json({ accessToken: 'e30.' + Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url') + '.test' });
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
  async function launch(profileComplete) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-help-'));
    const database = path.join(directory, 'database.json');
    fs.writeFileSync(database, JSON.stringify({ users: [
      { id: 'student', username: 'test-student', password: 'institution-secret', role: 'user', active: true, premiumRequest: { status: 'PENDING', reference: 'OLD-PAYMENT', meals: ['CENA'] } }
    ], reservas: [], advanceReservations: [], auditLogs: [] }));
    const child = fork(__filename, [], { env: {
      ...process.env, FREE_HELP_CHILD: '1', DATA_DIR: directory, PORT: '0',
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
      assert.equal((await app.request('/api/student/premium', 'PUT', { meals: ['CENA'], termsVersion: '2026-11-20', automationConsent: true }, token)).status, 200);
      const adminLogin = await app.request('/api/auth/login', 'POST', { username: 'admin@example.test', password: 'admin-test-only' });
      assert.equal(adminLogin.status, 200);
      const admin = await adminLogin.json();
      assert.equal((await app.request('/api/admin/users', 'GET', undefined, admin.token)).status, 200);
      assert.equal((await app.request('/api/events')).status, 401);
      assert.equal((await app.request('/api/sniper/queue')).status, 403);
    } finally { await app.close(); }
  });

  test('free automation requires consent, ignores old payments, omits credentials and supports revocation', async () => {
    const app = await launch(true);
    try {
      const credentials = { username: 'test-student', password: 'institution-secret' };
      assert.equal((await app.request('/api/auth/login', 'POST', credentials)).status, 400);
      const login = await app.request('/api/auth/login', 'POST', { ...credentials, termsVersion: '2026-11-20', processingConsent: true });
      assert.equal(login.status, 200);
      const { token } = await login.json();
      assert.equal((await app.request('/api/student/premium', 'PUT', { meals: ['CENA'] }, token)).status, 400);
      assert.equal((await app.request('/api/student/premium/checkout', 'POST', { meals: ['CENA'] }, token)).status, 410);
      const preferences = await app.request('/api/student/premium', 'PUT', { meals: ['CENA'], termsVersion: '2026-11-20', automationConsent: true }, token);
      assert.equal(preferences.status, 200);
      const data = await preferences.json();
      assert.equal(data.active, true);
      assert.equal(data.automationConsent.autoCancel, false);
      assert.equal(data.paymentRequest.reference, 'OLD-PAYMENT');
      assert.equal(data.paymentRequest.status, 'PENDING');
      const admin = await (await app.request('/api/auth/login', 'POST', { username: 'admin@example.test', password: 'admin-test-only' })).json();
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
