const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');

if (process.env.PG_RESTART_CHILD) {
  const RealDate = Date;
  const offset = RealDate.parse('2026-11-19T09:00:00-05:00') - RealDate.now();
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [RealDate.now() + offset]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  };
  global.fetch = async (url) => {
    if (url.includes('/auth/login'))
      return Response.json({
        accessToken:
          'e30.' +
          Buffer.from(JSON.stringify({ exp: 4102444800 })).toString(
            'base64url'
          ) +
          '.test'
      });
    if (url.endsWith('/auth/me'))
      return Response.json({ data: { nombre: 'Migrated student' } });
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
  test(
    'PostgreSQL migrates legacy data and persists sessions, requests and payments through abrupt restarts',
    { skip: !process.env.PG_TEST_CONFIG },
    async () => {
      const config = JSON.parse(
        fs.readFileSync(process.env.PG_TEST_CONFIG, 'utf8')
      );
      const connection = {
        host: config.PGHOST,
        port: Number(config.PGPORT),
        user: config.PGUSER,
        password: config.PGPASSWORD
      };
      const administrator = new Client({
        ...connection,
        database: config.PGDATABASE
      });
      await administrator.connect();
      const database = 'comedor_test_' + Date.now();
      await administrator.query(`CREATE DATABASE ${database}`);
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'comedor-pg-migration-')
      );
      const file = path.join(directory, 'database.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          users: [
            {
              id: 'legacy-admin',
              username: 'legacy-admin@example.test',
              password: 'test-admin-old',
              role: 'superadmin',
              active: true
            },
            {
              id: 'legacy-student',
              username: 'legacy',
              password: 'test',
              role: 'user',
              active: true,
              autoSniper: true
            }
          ],
          reservas: [
            {
              id: 'old-ticket',
              alumnoCodigo: 'legacy',
              tipoComida: 'DESAYUNO',
              fecha: '2026-11-18',
              estado: 'CONSUMIDA'
            }
          ],
          advanceReservations: [],
          auditLogs: [],
          settings: { preservedSetting: true }
        })
      );
      let child;
      let base;
      const stop = async () => {
        if (!child) return;
        if (child.exitCode !== null || child.signalCode !== null) {
          child = null;
          return;
        }
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
        child = null;
      };
      const start = async () => {
        child = fork(__filename, [], {
          env: {
            ...process.env,
            ...config,
            PGDATABASE: database,
            DATA_DIR: directory,
            DATABASE_URL: '',
            PORT: '0',
            PG_RESTART_CHILD: '1',
            UNAB_REQUEST_INTERVAL_MS: '1'
          },
          silent: true
        });
        const port = await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('PostgreSQL startup timeout')),
            10000
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
        base = 'http://127.0.0.1:' + port;
      };
      const inspect = new Client({ ...connection, database });
      try {
        const request = (url, options = {}) =>
          fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
        await start();
        const login = await request(base + '/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'legacy', password: 'test' })
        });
        assert.equal(login.status, 200);
        const token = (await login.json()).token;
        const headers = {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        };
        const advance = await request(
          base + '/api/student/advance-reservation',
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ meal: 'CENA', date: '2026-11-19' })
          }
        );
        assert.equal(advance.status, 200);
        const id = (await advance.json()).data.id;
        const checkout = await request(base + '/api/student/premium/checkout', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            meals: ['CENA'],
            reference: 'TEST-PAYMENT-123'
          })
        });
        assert.equal(checkout.status, 200);
        await stop();
        fs.unlinkSync(file);
        await start();
        const session = await request(base + '/api/auth/me', { headers });
        assert.equal(session.status, 200);
        assert.equal((await session.json()).user.id, 'legacy-student');
        const restored = await request(
          base + '/api/student/advance-reservations',
          { headers }
        );
        assert.ok((await restored.json()).data.some((item) => item.id === id));
        const premium = await request(base + '/api/student/premium', {
          headers
        });
        assert.equal(
          (await premium.json()).paymentRequest.reference,
          'TEST-PAYMENT-123'
        );
        await inspect.connect();
        const state = (
          await inspect.query('SELECT document FROM comedor_state WHERE id = 1')
        ).rows[0].document;
        assert.equal(state.settings.preservedSetting, true);
        assert.equal(
          state.users.find((user) => user.id === 'legacy-admin').username,
          'legacy-admin@example.test'
        );
        assert.equal(
          state.users.find((user) => user.id === 'legacy-admin').password,
          'test-admin-old'
        );
        assert.equal(
          state.users.some((user) => user.id === 'usr-angelo'),
          false
        );
        assert.ok(state.reservas.some((item) => item.id === 'old-ticket'));
        assert.ok(
          !JSON.stringify(state.sessions).includes(token),
          'Session tokens are hashed at rest'
        );
        assert.equal(
          (
            await request(base + '/api/auth/logout', {
              method: 'POST',
              headers
            })
          ).status,
          200
        );
        await stop();
        await start();
        assert.equal(
          (await request(base + '/api/auth/me', { headers })).status,
          401
        );
        assert.equal(
          (
            await request(base + '/api/comedor/programacion?date=2026-11-20', {
              headers
            })
          ).status,
          400
        );
        await stop();
        const previous = {};
        for (const key of new Set([
          ...Object.keys(config),
          'PGDATABASE',
          'DATABASE_URL'
        ]))
          previous[key] = process.env[key];
        Object.assign(process.env, config, {
          PGDATABASE: database,
          DATABASE_URL: ''
        });
        const { openPostgres } = require('../postgres-store');
        const first = await openPostgres();
        const second = await openPostgres();
        try {
          const firstState = await first.read();
          const secondState = await second.read();
          firstState.settings.winningWrite = true;
          await first.write(JSON.stringify(firstState));
          secondState.settings.winningWrite = false;
          await assert.rejects(
            second.write(JSON.stringify(secondState)),
            (error) => error.code === 'STATE_CONFLICT'
          );
          assert.equal((await second.read()).settings.winningWrite, true);
        } finally {
          await first.close();
          await second.close();
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      } finally {
        await stop();
        await inspect.end().catch(() => {});
        await administrator.query(`DROP DATABASE ${database} WITH (FORCE)`);
        await administrator.end();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );
}
