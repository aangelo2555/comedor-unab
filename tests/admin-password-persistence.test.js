const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('admin password hashing runs on credential changes, not repeated state writes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-hash-test-'));
  try {
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const crypto = require('node:crypto');
      const original = crypto.scryptSync;
      let calls = 0;
      crypto.scryptSync = (...args) => { calls++; return original(...args); };
      const db = require('./db');
      (async () => {
        await db.initialize();
        const admin = db.getAllUsers(false).find(user => user.role === 'superadmin');
        assert.ok(admin.password.startsWith('scrypt$'));
        const startupHashes = calls;
        assert.ok(startupHashes >= 1 && startupHashes <= 2);
        for (let i = 0; i < 20; i++) db.updateSettings({ concurrency: 3 });
        assert.equal(calls, startupHashes);
        assert.equal(db.verifyPassword(admin, process.env.ADMIN_PASSWORD), true);
        assert.equal(db.verifyPassword(admin, 'wrong'), false);
        const beforeChange = calls;
        db.updateUser(admin.id, { password: 'replacement-test-password' });
        assert.equal(calls, beforeChange + 1);
        const second = db.addUser({ username: 'second-admin', password: 'another-test-password', role: 'superadmin' });
        assert.equal(calls, beforeChange + 2);
        for (let i = 0; i < 20; i++) db.updateSettings({ concurrency: 3 });
        assert.equal(calls, beforeChange + 2);
        assert.equal(db.verifyPassword(db.findUserById(second.id), 'another-test-password'), true);
        assert.equal(db.verifyPassword(admin, 'replacement-test-password'), true);
        const persisted = require('node:fs').readFileSync(require('node:path').join(process.env.DATA_DIR, 'database.json'), 'utf8');
        assert.ok(!persisted.includes('replacement-test-password'));
        assert.ok(!persisted.includes('another-test-password'));
        await db.close();
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, DATA_DIR: directory, DATABASE_URL: '', PGHOST: '',
        ADMIN_PASSWORD: 'isolated-test-admin-password', INSTITUTION_CREDENTIAL_KEY: '' },
      stdio: 'pipe'
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  assert.ok(true);
});
