const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
Object.assign(process.env, { SERVICE_OPERATOR: 'Test operator', SERVICE_CONTACT_EMAIL: 'test@example.test', INSTITUTION_INTEGRATION_AUTHORIZED: 'true' });

function createContext(fetch, signal = AbortSignal) {
  const context = vm.createContext({
    require: (name) =>
      name === './db'
        ? {}
        : name === 'http'
          ? { createServer: () => ({ listen() {} }) }
          : require(
              name.startsWith('./') ? path.resolve(__dirname, '..', name) : name
            ),
    __dirname: path.resolve(__dirname, '..'),
    process: {
      ...process,
      once() {},
      env: { ...process.env, UNAB_REQUEST_INTERVAL_MS: '1' }
    },
    console,
    setInterval() {},
    clearInterval() {},
    setTimeout,
    clearTimeout,
    Buffer,
    URL,
    AbortSignal: signal,
    fetch
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'),
    context
  );
  return context;
}

test('upstream body timeout produces a retryable error and releases its slot', async () => {
  const deadlines = [];
  let calls = 0;
  const context = createContext(
    async (url, options) => {
      calls++;
      return {
        ok: true,
        status: 200,
        text: () =>
          new Promise((resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(options.signal.reason),
              { once: true }
            );
          })
      };
    },
    {
      timeout(milliseconds) {
        deadlines.push(milliseconds);
        return AbortSignal.timeout(5);
      }
    }
  );
  // Keep this test's event loop alive while its mocked body waits for abort.
  const keepAlive = setInterval(() => {}, 100);
  try {
    const result = await vm.runInContext(
      "fetchUnabResponse('https://comedor-api.unab.edu.pe/test')",
      context
    );
    assert.equal(result.status, 503);
    assert.equal(calls, 2);
    assert.deepEqual(deadlines, [20000, 20000]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(vm.runInContext('upstreamGate.active', context), 0);
  } finally {
    clearInterval(keepAlive);
  }
});

test('429 Retry-After delays the next attempt and 403 pauses the shared budget', async () => {
  const starts = [];
  const context = createContext(async () => {
    starts.push(Date.now());
    return starts.length === 1
      ? Response.json(
          { message: 'Busy' },
          { status: 429, headers: { 'Retry-After': '0.03' } }
        )
      : Response.json({ data: [] });
  });
  const result = await vm.runInContext(
    "fetchUnabResponse('https://comedor-api.unab.edu.pe/test')",
    context
  );
  assert.equal(result.status, 200);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 29);
  vm.runInContext(
    'const pauses = []; upstreamGate.pause = milliseconds => pauses.push(milliseconds);',
    context
  );
  context.fetch = async () =>
    Response.json({ message: 'Denied' }, { status: 403 });
  assert.equal(
    (
      await vm.runInContext(
        "fetchUnabResponse('https://comedor-api.unab.edu.pe/test')",
        context
      )
    ).status,
    403
  );
  assert.equal(vm.runInContext('pauses[0]', context), 60000);
});

test('reservation POST receives one attempt and a canceled queued operation sends none', async () => {
  let calls = 0;
  const context = createContext(async () => {
    calls++;
    return Response.json({ message: 'Busy' }, { status: 503 });
  });
  await vm.runInContext(
    "fetchUnabResponse('https://comedor-api.unab.edu.pe/reservas', { method: 'POST' }, false)",
    context
  );
  assert.equal(calls, 1);
  const result = await vm.runInContext(
    "fetchUnabResponse('https://comedor-api.unab.edu.pe/reservas', { method: 'POST', canProceed: () => false }, false)",
    context
  );
  assert.equal(result.status, 409);
  assert.equal(calls, 1);
});

test('a stale preflight sends no POST and request-start metrics are not passed to native fetch',async()=>{
  let calls=0;
  const context=createContext(async(url,options)=>{
    calls++;
    assert.equal(options.validatePreflight,undefined);
    assert.equal(options.onRequestStart,undefined);
    return Response.json({success:true,data:{id:'ticket'}});
  });
  vm.runInContext('let started=0;',context);
  const rejected=await vm.runInContext("fetchUnabResponse('https://comedor-api.unab.edu.pe/v1/reservas',{method:'POST',validatePreflight:()=>false},false)",context);
  assert.equal(rejected.data.code,'PREFLIGHT_STALE');
  assert.equal(calls,0);
  const result=await vm.runInContext("fetchUnabResponse('https://comedor-api.unab.edu.pe/v1/reservas',{method:'POST',validatePreflight:()=>true,onRequestStart:()=>started++},false)",context);
  assert.equal(result.ok,true);
  assert.equal(calls,1);
  assert.equal(vm.runInContext('started',context),1);
});

test('the HTTP wrapper starts 13 reservation POSTs together and keeps burst credentials out of fetch options',async()=>{
  let calls=0,release;
  const held=new Promise(resolve=>{release=resolve;});
  const context=createContext(async(url,options)=>{
    assert.equal(options.openingBurst,undefined);
    calls++;await held;
    return Response.json({success:true,data:{id:'ticket'}});
  });
  const batch=vm.runInContext(`{
    const permit=upstreamGate.openBurst({maxStarts:13});
    Promise.all(Array.from({length:13},()=>fetchUnabResponse('https://comedor-api.unab.edu.pe/v1/reservas',{method:'POST',openingBurst:permit},false)));
  }`,context);
  try {await new Promise(resolve=>setTimeout(resolve,0));assert.equal(calls,13);}
  finally {release();await batch;}
});

test('opening permits cannot accelerate institutional login or ordinary ticket reads',async()=>{
  for(const request of ["'https://api-login-dev.unab.edu.pe/auth/login',{method:'POST',openingBurst:permit}","'https://comedor-api.unab.edu.pe/v1/reservas/me',{openingBurst:permit}"]) {
    let calls=0,release;
    const held=new Promise(resolve=>{release=resolve;});
    const context=createContext(async()=>{calls++;await held;return Response.json({data:[]});});
    const batch=vm.runInContext(`{const permit=upstreamGate.openBurst({maxStarts:13});Promise.all(Array.from({length:13},()=>fetchUnabResponse(${request},false)));}`,context);
    try {await new Promise(resolve=>setTimeout(resolve,0));assert.ok(calls>=1 && calls<=2,'Ordinary requests remain bounded at two in flight');}
    finally {release();await batch;}
  }
});

test('the observed reservation saturation message triggers the shared provider pause',async()=>{
  const context=createContext(async()=>Response.json({success:false,message:'Hay muchas reservas simultáneas. Vuelve a intentarlo en unos segundos.'},{status:409,headers:{'Retry-After':'0.02'}}));
  vm.runInContext('const pauses=[];upstreamGate.pause=value=>pauses.push(value);',context);
  await vm.runInContext("fetchUnabResponse('https://comedor-api.unab.edu.pe/v1/reservas',{method:'POST'},false)",context);
  assert.deepEqual(Array.from(vm.runInContext('pauses',context)),[20]);
});
