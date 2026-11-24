const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
Object.assign(process.env, { SERVICE_OPERATOR: 'Test operator', SERVICE_CONTACT_EMAIL: 'test@example.test', INSTITUTION_INTEGRATION_AUTHORIZED: 'true' });

if (process.env.UNAB_TEST_CHILD) {
  let logins = 0;
  global.fetch = async (url, options) => {
    if (url.includes('/auth/login')) {
      logins++;
      process.send({ login: true });
      if (logins === 1) return new Response('{}', { status: 503 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Expired token exercises concurrent renewal during availability queries.
      return Response.json({ data: { accessToken: 'e30.eyJleHAiOjF9.signature' } }, { status: 201 });
    }
    if (url.endsWith('/auth/me')) {
      return Response.json({ data: { nombre: 'Estudiante de prueba' } });
    }
    if (url.includes('/programacion/')) {
      return new Response('{}', { status: 503 });
    }
    if (url.includes('/reservas/me')) return Response.json({ data: [] });
    throw new Error('Unexpected upstream request');
  };
  const http = require('node:http');
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    this.once('listening', () => process.send({ port: this.address().port }));
    return listen.apply(this, args);
  };
  require('../server');
} else {
  test('slow concurrent registration survives and availability failures stay errors', async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'unab-regression-')
    );
    fs.writeFileSync(
      path.join(directory, 'database.json'),
      JSON.stringify({
        users: [],
        reservas: [],
        advanceReservations: [],
        auditLogs: []
      })
    );
    const child = fork(__filename, [], {
      env: {
        ...process.env,
        UNAB_TEST_CHILD: '1',
        DATA_DIR: directory,
        PORT: '0'
      },
      silent: true
    });
    let loginCalls = 0;
    child.on('message', (message) => {
      if (message.login) loginCalls++;
    });
    try {
      const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Server startup timeout')),
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
      const base = `http://127.0.0.1:${port}`;
      const login = () =>
        fetch(base + '/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'regression-student',
            password: 'test-only', termsVersion: '2026-11-20', processingConsent: true
          })
        });
      const responses = await Promise.all([login(), login()]);
      assert.deepEqual(
        responses.map((r) => r.status),
        [200, 200]
      );
      const accounts = await Promise.all(responses.map((r) => r.json()));
      assert.equal(accounts[0].user.id, accounts[1].user.id);
      const before = loginCalls;
      const headers = { Authorization: 'Bearer ' + accounts[0].token };
      const queries = await Promise.all([
        fetch(base + '/api/comedor/programacion', { headers }),
        fetch(base + '/api/comedor/reservas', { headers })
      ]);
      assert.equal(
        loginCalls - before,
        1,
        'Concurrent queries share token renewal'
      );
      assert.equal(queries[0].status, 503);
      assert.equal(queries[1].status, 200);
      assert.equal((await fetch(base + '/api/time')).status, 200);
    } finally {
      child.kill();
      await once(child, 'exit');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
