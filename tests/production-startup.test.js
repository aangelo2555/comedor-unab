const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.env.PRODUCTION_STARTUP_CHILD) {
  if (process.env.PRODUCTION_PG_REJECT) {
    require('../postgres-store').openPostgres = async () => {
      throw Object.assign(new Error('Test authentication rejection'), {
        code: '28P01'
      });
    };
  }
  const http = require('node:http');
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    this.once('listening', () => process.send({ port: this.address().port }));
    return listen.apply(this, args);
  };
  require('../server');
} else {
  const createDirectory = () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'comedor-production-')
    );
    fs.writeFileSync(
      path.join(directory, 'database.json'),
      JSON.stringify({
        users: [
          {
            id: 'existing',
            username: 'existing-student',
            password: 'test',
            role: 'user',
            active: true
          }
        ],
        reservas: [],
        advanceReservations: [],
        auditLogs: [],
        settings: { preserved: true }
      })
    );
    return directory;
  };
  const launch = (directory, extra = {}) =>
    fork(__filename, [], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        RAILWAY_ENVIRONMENT: 'production',
        DATABASE_URL: '',
        PGHOST: '',
        DATA_DIR: directory,
        PORT: '0',
        ADMIN_EMAIL: 'admin@example.test',
        ADMIN_PASSWORD: 'test-only',
        PRODUCTION_STARTUP_CHILD: '1',
        ...extra
      },
      silent: true
    });
  const stop = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  };
  const ready = (child) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Startup timeout')),
        5000
      );
      child.on('message', (message) => {
        if (message.port) {
          clearTimeout(timer);
          resolve('http://127.0.0.1:' + message.port);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('Server exited ' + code));
      });
    });

  test('Railway production starts without PostgreSQL and preserves existing JSON data and sessions', async () => {
    const directory = createDirectory();
    let child = launch(directory);
    try {
      let base = await ready(child);
      const health = await fetch(base + '/healthz');
      assert.equal(health.status, 200);
      assert.equal((await health.json()).storage, 'json');
      const login = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin@example.test',
          password: 'test-only'
        })
      });
      assert.equal(login.status, 200);
      const headers = { Authorization: 'Bearer ' + (await login.json()).token };
      await stop(child);
      child = launch(directory);
      base = await ready(child);
      assert.equal(
        (await fetch(base + '/api/auth/me', { headers })).status,
        200
      );
      const users = await (
        await fetch(base + '/api/admin/users', { headers })
      ).json();
      assert.ok(users.users.some((user) => user.id === 'existing'));
      assert.equal(
        JSON.parse(
          fs.readFileSync(path.join(directory, 'database.json'), 'utf8')
        ).settings.preserved,
        true
      );
    } finally {
      await stop(child);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('configured PostgreSQL rejection is reported without falling back to JSON', async () => {
    const directory = createDirectory();
    const original = fs.readFileSync(
      path.join(directory, 'database.json'),
      'utf8'
    );
    const child = launch(directory, {
      PGHOST: 'configured.invalid',
      PRODUCTION_PG_REJECT: '1'
    });
    try {
      const [code] = await once(child, 'exit');
      assert.equal(code, 1);
      assert.equal(
        fs.readFileSync(path.join(directory, 'database.json'), 'utf8'),
        original
      );
    } finally {
      await stop(child);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
