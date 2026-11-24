const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractToken, loginInstitution } = require('../institution-login');

test('HTTP 201 login accepts provider token envelopes and aliases', async () => {
  for (const data of [
    { accessToken: 'jwt' }, { data: { accessToken: 'jwt' } },
    { result: { access_token: 'jwt' } }, { data: { token: 'jwt' } },
    { data: { data: { accessToken: 'jwt' } } }
  ]) {
    let calls = 0;
    const result = await loginInstitution(async () => { calls++; return { ok: true, status: 201, data }; }, 'student', 'secret');
    assert.deepEqual(result, { success: true, token: 'jwt' });
    assert.equal(calls, 1);
  }
  for (const data of [null, {}, { accessToken: {} }, { token: ' ' }, { accessToken: 'two words' }]) assert.equal(extractToken(data), null);
});

test('tokenless HTTP 201 is retried once and can recover without falsely declaring exhausted quotas', async () => {
  let calls = 0;
  const result = await loginInstitution(async () => ({ ok: true, status: 201, data: ++calls === 1 ? {} : { data: { accessToken: 'ready' } } }), 'student', 'secret');
  assert.equal(result.token, 'ready');
  assert.equal(calls, 2);
  calls = 0;
  const failed = await loginInstitution(async () => { calls++; return { ok: true, status: 201, data: {} }; }, 'student', 'secret');
  assert.equal(failed.success, false);
  assert.equal(failed.code, 'MISSING_SESSION_TOKEN');
  assert.equal(calls, 2);
});

test('rejected and canceled logins do not create a session or retry credentials', async () => {
  let calls = 0;
  const rejected = await loginInstitution(async () => { calls++; return { ok: false, status: 401, data: { accessToken: 'untrusted' } }; }, 'student', 'secret');
  assert.equal(rejected.success, false);
  assert.equal(calls, 1);
  const canceled = await loginInstitution(async () => { throw Error('Must not send'); }, 'student', 'secret', { canProceed: () => false });
  assert.equal(canceled.status, 409);
});
