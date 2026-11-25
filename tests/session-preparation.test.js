const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  WARMUP_LEAD_MS,
  REFRESH_LEAD_MS,
  PUBLICATION_POLL_MS,
  prepareSessions
} = require('../session-preparation');

test('50 sessions are prepared with bounded workers and validity beyond opening', async () => {
  const users = Array.from({ length: 50 }, (_, id) => ({ id }));
  let active = 0;
  let peak = 0;
  const requested = [];
  const result = await prepareSessions(users, {
    targetTs: 300000,
    now: () => 0,
    canProceed: () => true,
    isExpired: () => false,
    getToken: async (user, verify, options, validity) => {
      requested.push({ user, verify, options, validity });
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return 'valid-token';
    }
  });
  assert.equal(WARMUP_LEAD_MS, 300000);
  assert.equal(REFRESH_LEAD_MS, 60000);
  assert.equal(PUBLICATION_POLL_MS, 250);
  assert.equal(result.ready, 50);
  assert.ok(peak <= 2);
  assert.ok(
    requested.every(
      (item) =>
        item.verify && item.options.skipProfile && item.validity === 420000
    )
  );
});

test('last minute refresh includes new arrivals and avoids unnecessary remote verification', async () => {
  const requested = [];
  const result = await prepareSessions(
    [{ id: 'existing' }, { id: 'late-arrival' }],
    {
      targetTs: 60000,
      now: () => 0,
      canProceed: () => true,
      verifyRemote: false,
      isExpired: () => false,
      getToken: async (user, verify, options, validity) => {
        requested.push({ user, verify, validity });
        return 'token';
      }
    }
  );
  assert.equal(result.ready, 2);
  assert.ok(
    requested.every((item) => item.verify === false && item.validity === 180000)
  );
  assert.equal(requested[1].user.id, 'late-arrival');
});

test('canceled preparation does not initiate authentication and short-lived tokens remain unprepared', async () => {
  let calls = 0;
  const canceled = await prepareSessions([{ id: 'a' }], {
    targetTs: 60000,
    now: () => 0,
    canProceed: () => false,
    isExpired: () => false,
    getToken: async () => {
      calls++;
    }
  });
  assert.equal(calls, 0);
  assert.equal(canceled.ready, 0);
  const expired = await prepareSessions([{ id: 'a' }], {
    targetTs: 60000,
    now: () => 0,
    canProceed: () => true,
    isExpired: () => true,
    getToken: async () => 'short-lived'
  });
  assert.equal(expired.ready, 0);
});

test('the final session pass prepares tickets only for authenticated ready users',async()=>{
  const checked=[];
  const result=await prepareSessions([{id:'ready'},{id:'missing'}],{
    targetTs:Date.now()+60000,
    canProceed:()=>true,
    verifyRemote:false,
    isExpired:()=>false,
    getToken:async user=>user.id==='ready'?'valid-token':null,
    prepareReservations:async(user,token)=>{checked.push({user:user.id,token});}
  });
  assert.equal(result.ready,1);
  assert.deepEqual(checked,[{user:'ready',token:'valid-token'}]);
});
