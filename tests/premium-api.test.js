const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

if (process.env.PREMIUM_API_CHILD) {
  global.fetch = async (url) => {
    if (url.includes('/auth/login'))
      return Response.json({
        accessToken:
          'e30.' +
          Buffer.from(
            JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
          ).toString('base64url') +
          '.test'
      });
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
  test('premium entitlement is admin-only and student preferences are validated and persisted', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'premium-api-'));
    const database = path.join(directory, 'database.json');
    fs.writeFileSync(
      database,
      JSON.stringify({
        users: [
          {
            id: 'student',
            username: 'test-student',
            password: 'test',
            role: 'user',
            active: true,
            autoSniper: true
          }
        ],
        reservas: [],
        advanceReservations: [],
        auditLogs: []
      })
    );
    const child = fork(__filename, [], {
      env: {
        ...process.env,
        PREMIUM_API_CHILD: '1',
        DATA_DIR: directory,
        PORT: '0',
        ADMIN_EMAIL: 'admin@example.test',
        ADMIN_PASSWORD: 'local-test-only',
        UNAB_REQUEST_INTERVAL_MS: '1'
      },
      silent: true
    });
    try {
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
          reject(new Error('Exited ' + code));
        });
      });
      const base = 'http://127.0.0.1:' + port;
      async function login(username, password) {
        const result = await fetch(base + '/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        assert.equal(result.status, 200);
        return (await result.json()).token;
      }
      const student = await login('test-student', 'test');
      const admin = await login('admin@example.test', 'local-test-only');
      const put = (url, token, body) =>
        fetch(base + url, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token
          },
          body: JSON.stringify(body)
        });
      assert.equal(
        (
          await put('/api/student/premium', student, {
            enabled: true,
            meals: ['CENA']
          })
        ).status,
        403
      );
      assert.equal(
        (
          await put('/api/admin/premium/student', student, {
            enabled: true,
            endDate: '2027-01-01'
          })
        ).status,
        403
      );
      assert.equal(
        (
          await put('/api/admin/premium/student', admin, {
            enabled: true,
            endDate: '2027-02-30'
          })
        ).status,
        400
      );
      const checkout = await fetch(base + '/api/student/premium/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + student
        },
        body: JSON.stringify({
          meals: ['CENA'],
          reference: 'YAPE-TEST-123',
          amount: 0
        })
      });
      assert.equal(checkout.status, 200);
      const order = (await checkout.json()).paymentRequest;
      assert.equal(order.amount, 9);
      assert.equal(order.yape, '923887478');
      assert.equal(order.status, 'PENDING');
      assert.equal(
        (
          await put('/api/admin/premium/student', admin, {
            enabled: true,
            endDate: '2099-01-01'
          })
        ).status,
        400
      );
      assert.equal(
        (
          await put('/api/admin/premium/student', admin, {
            enabled: true,
            endDate: '2099-01-01',
            confirmPayment: true
          })
        ).status,
        200
      );
      assert.equal(
        (await put('/api/student/premium', student, { meals: ['INVALID'] }))
          .status,
        400
      );
      assert.equal(
        (
          await put('/api/student/premium', student, {
            meals: ['DESAYUNO', 'CENA']
          })
        ).status,
        200
      );
      assert.equal(
        (
          await put('/api/student/premium', student, {
            meals: ['DESAYUNO', 'CENA']
          })
        ).status,
        200
      );
      let saved = JSON.parse(fs.readFileSync(database, 'utf8'));
      const planned = saved.advanceReservations.filter(
        (item) => item.alumnoCodigo === 'test-student'
      );
      const today = new Date().toLocaleDateString('en-CA', {
        timeZone: 'America/Lima'
      });
      assert.ok(planned.every((item) => item.fecha === today));
      assert.deepEqual(
        saved.users.find((user) => user.id === 'student').premium.meals,
        ['DESAYUNO', 'CENA']
      );
      assert.ok(planned.every((item) => item.source === 'premium'));
      assert.equal(
        (await put('/api/student/premium', student, { meals: [] })).status,
        200
      );
      saved = JSON.parse(fs.readFileSync(database, 'utf8'));
      assert.ok(
        saved.advanceReservations
          .filter((item) => item.alumnoCodigo === 'test-student')
          .every((item) => item.status === 'ANULADA')
      );
      assert.equal(
        (await put('/api/admin/premium/student', admin, { enabled: false }))
          .status,
        200
      );
      assert.equal(
        (
          await fetch(base + '/api/comedor/programacion?date=2099-01-01', {
            headers: { Authorization: 'Bearer ' + student }
          })
        ).status,
        400
      );
      const response = await fetch(base + '/api/student/premium', {
        headers: { Authorization: 'Bearer ' + student }
      });
      assert.equal((await response.json()).active, false);
    } finally {
      child.kill();
      await once(child, 'exit');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
