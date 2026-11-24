const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TERMS_VERSION } = require('../service-policy');

if (process.env.ENROLLMENT_TEST_CHILD) {
  global.fetch = async (url, options) => {
    if (url.includes('/auth/login')) {
      process.send({ auth: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json({
        accessToken:
          'e30.' +
          Buffer.from(
            JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
          ).toString('base64url') +
          '.test'
      });
    }
    if (url.endsWith('/auth/me'))
      return Response.json({ data: { nombre: 'Test student' } });
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
  async function setup(count) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mi-mesa-enrollment-')
    );
    const file = path.join(directory, 'database.json');
    const users = Array.from({ length: count }, (_, index) => ({
      id: 'old-' + index,
      username: 'student-' + index,
      name: 'Test student',
      role: 'user',
      active: true,
      password: 'test',
      createdAt: new Date(
        Date.parse('2020-01-01T00:00:00Z') + index * 86400000
      ).toISOString()
    })).reverse();
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Lima'
    });
    const advances =
      count > 50
        ? [
            {
              id: 'preserved-pending',
              alumnoCodigo: 'student-55',
              tipoComida: 'CENA',
              fecha: today,
              status: 'ACTIVA',
              source: 'manual'
            }
          ]
        : [];
    fs.writeFileSync(
      file,
      JSON.stringify({
        users,
        reservas: [],
        advanceReservations: advances,
        auditLogs: []
      })
    );
    let authCalls = 0;
    const child = fork(__filename, [], {
      env: {
        ...process.env,
        ENROLLMENT_TEST_CHILD: '1',
        DATA_DIR: directory,
        DATABASE_URL: '',
        PGHOST: '',
        NODE_ENV: 'test',
        ADMIN_EMAIL: 'admin@example.test',
        ADMIN_PASSWORD: 'test-admin',
        PORT: '0',
        UNAB_REQUEST_INTERVAL_MS: '1'
      },
      silent: true
    });
    child.on('message', (message) => {
      if (message.auth) authCalls++;
    });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Startup timeout')),
        5000
      );
      child.on('message', (message) => {
        if (message.port) {
          clearTimeout(timer);
          resolve(message.port);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('Server exited ' + code));
      });
    });
    const base = 'http://127.0.0.1:' + port;
    const login = (username, password = 'test') =>
      fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          termsVersion: TERMS_VERSION,
          processingConsent: true
        }),
        signal: AbortSignal.timeout(5000)
      });
    return {
      base,
      file,
      login,
      authCalls: () => authCalls,
      async close() {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
        fs.rmSync(directory, { recursive: true, force: true });
      }
    };
  }

  test('concurrent registration fills only the final slot and retains existing registration order', async () => {
    const app = await setup(49);
    try {
      const results = await Promise.all([
        app.login('new-one'),
        app.login('new-two')
      ]);
      assert.deepEqual(
        results.map((response) => response.status).sort(),
        [200, 409]
      );
      const accepted = await results
        .find((response) => response.status === 200)
        .json();
      assert.equal(accepted.user.enrollment.position, 50);
      assert.equal(accepted.user.enrollment.limit, 50);
      const before = app.authCalls();
      assert.equal(
        (
          await fetch(app.base + '/api/comedor/programacion', {
            headers: { Authorization: 'Bearer ' + accepted.token }
          })
        ).status,
        200
      );
      assert.equal(
        app.authCalls(),
        before,
        'New registrations reuse the already validated institutional token'
      );
      assert.equal((await app.login('another-new')).status, 409);
      assert.equal(
        app.authCalls(),
        before,
        'Full capacity is checked before upstream login'
      );
      const existing = await (await app.login('student-0')).json();
      assert.equal(existing.user.enrollment.position, 1);
      const state = JSON.parse(fs.readFileSync(app.file, 'utf8'));
      assert.equal(
        state.users.filter((user) => user.role !== 'superadmin').length,
        50
      );
      for (let id = 0; id < 49; id++)
        assert.ok(state.users.some((user) => user.id === 'old-' + id));
      const admin = await (
        await app.login('admin@example.test', 'test-admin')
      ).json();
      const denied = await fetch(app.base + '/api/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + admin.token
        },
        body: JSON.stringify({ username: 'admin-created', password: 'test' })
      });
      assert.equal(denied.status, 409);
    } finally {
      await app.close();
    }
  });

  test('older over-capacity accounts retain login and pending data while new reservations are blocked', async () => {
    const app = await setup(60);
    try {
      const login = await app.login('student-55');
      assert.equal(login.status, 200);
      const account = await login.json();
      assert.equal(account.user.enrollment.position, 56);
      assert.equal(account.user.enrollment.admitted, false);
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + account.token
      };
      const own = await fetch(app.base + '/api/student/enrollment', {
        headers
      });
      assert.equal((await own.json()).enrollment.total, 60);
      const reservation = await fetch(
        app.base + '/api/student/advance-reservation',
        { method: 'POST', headers, body: JSON.stringify({ meal: 'CENA' }) }
      );
      assert.equal(reservation.status, 409);
      const enable = await fetch(app.base + '/api/student/premium', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          meals: ['CENA'],
          automationConsent: true,
          termsVersion: TERMS_VERSION
        })
      });
      assert.equal(enable.status, 409);
      assert.equal((await app.login('another-new')).status, 409);
      const state = JSON.parse(fs.readFileSync(app.file, 'utf8'));
      assert.equal(
        state.users.filter((user) => user.role !== 'superadmin').length,
        60
      );
      assert.equal(
        state.advanceReservations.find(
          (item) => item.id === 'preserved-pending'
        ).status,
        'ACTIVA'
      );
    } finally {
      await app.close();
    }
  });
  test('restored legacy accounts keep priority over the next registration', async () => {
    const app = await setup(2);
    try {
      const admin = await (await app.login('admin@example.test', 'test-admin')).json();
      const restored = await fetch(app.base + '/api/admin/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + admin.token },
        body: JSON.stringify({ users: [
          { id: 'backup-a', username: 'backup-a', password: 'test', role: 'user', active: true, createdAt: '2020-01-01T00:00:00Z' },
          { id: 'backup-b', username: 'backup-b', password: 'test', role: 'user', active: true, createdAt: '2021-01-01T00:00:00Z' }
        ], reservas: [], advanceReservations: [], auditLogs: [] })
      });
      assert.equal(restored.status, 200);
      const newcomer = await (await app.login('after-restore')).json();
      assert.equal(newcomer.user.enrollment.position, 3);
      const old = await (await app.login('backup-a')).json();
      assert.equal(old.user.enrollment.position, 1);
    } finally { await app.close(); }
  });

}
