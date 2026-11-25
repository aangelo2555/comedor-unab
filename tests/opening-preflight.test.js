const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createReservationService}=require('../reservation-service');
const date='2026-11-25';
const base=Date.parse(date+'T17:00:00-05:00');

async function withClock(fn) {
  const real=Date.now;
  let now=base-60000;
  Date.now=()=>now;
  try {await fn(value=>{now=value;});} finally {Date.now=real;}
}

test('a verified opening sends POST first and concurrent attempts still share only one write',()=>withClock(async setTime=>{
  const calls=[];
  const reserve=createReservationService(async(endpoint,token,options)=>{
    calls.push({endpoint,method:options?.method});
    if(options?.method==='POST')return {ok:true,status:200,data:{success:true,data:{id:'ticket'}}};
    return {ok:true,data:{data:[]}};
  });
  assert.equal(await reserve.prepare('student','token',date,'CENA',base),true);
  setTime(base+1);
  const results=await Promise.all(Array.from({length:50},()=>reserve('student','token','dinner',date,'CENA',()=>true,{preparedOpeningTs:base})));
  assert.equal(calls.length,2);
  assert.equal(calls[1].method,'POST');
  assert.ok(results.every(result=>result.data.data.id==='ticket'));
}));

test('expired, invalidated and changed-token proofs fall back to fresh ticket verification',()=>withClock(async setTime=>{
  for(const scenario of ['expired','invalidated','token-change','ordinary','stopped']) {
    const methods=[];
    const reserve=createReservationService(async(endpoint,token,options)=>{
      methods.push(options?.method || 'GET');
      return options?.method==='POST' ? {ok:true,data:{success:true,data:{id:'ticket'}}} : {ok:true,data:{data:[]}};
    });
    setTime(base-60000);
    await reserve.prepare('student','token',date,'CENA',base);
    setTime(scenario==='expired'?base+3000:base+1);
    if(scenario==='invalidated')reserve.invalidate('student',date,'CENA');
    if(scenario==='stopped')reserve.clearPrepared();
    await reserve('student',scenario==='token-change'?'new-token':'token','dinner',date,'CENA',()=>true,scenario==='ordinary'?{}:{preparedOpeningTs:base});
    assert.deepEqual(methods,['GET','GET','POST'],scenario);
  }
}));

test('a proof expiring inside the network queue is verified again without blindly submitting',()=>withClock(async setTime=>{
  let reads=0,writes=0;
  const reserve=createReservationService(async(endpoint,token,options)=>{
    if(options?.method==='POST') {
      if(options.validatePreflight) {
        setTime(base+3000);
        assert.equal(options.validatePreflight(),false);
        return {ok:false,status:409,data:{code:'PREFLIGHT_STALE'}};
      }
      writes++;
      return {ok:true,data:{success:true,data:{id:'ticket'}}};
    }
    reads++;
    return {ok:true,data:{data:[]}};
  });
  await reserve.prepare('student','token',date,'CENA',base);
  setTime(base+1);
  await reserve('student','token','dinner',date,'CENA',()=>true,{preparedOpeningTs:base});
  assert.equal(reads,2);
  assert.equal(writes,1);
}));

test('a failed precheck, existing ticket or in-flight cancellation never grants a fast-path proof',()=>withClock(async setTime=>{
  for(const scenario of ['failed','existing','cancelled']) {
    let canProceed=true;
    const reserve=createReservationService(async()=>{
      if(scenario==='cancelled')canProceed=false;
      return scenario==='failed'?{ok:false,status:503}:{ok:true,data:{data:scenario==='existing'?[{id:'existing',tipoComida:'CENA',estado:'ACTIVA',fecha:date}]:[]}};
    });
    setTime(base-60000);
    assert.equal(await reserve.prepare('student','token',date,'CENA',base,{canProceed:()=>canProceed}),false);
  }
}));

test('clearing preparation while its lookup is in flight prevents a late proof from being restored',()=>withClock(async()=>{
  let release;
  const response=new Promise(resolve=>{release=resolve;});
  const reserve=createReservationService(()=>response);
  const pending=reserve.prepare('student','token',date,'CENA',base);
  reserve.clearPrepared();
  release({ok:true,data:{data:[]}});
  assert.equal(await pending,false);
}));

test('a locally expired preparation does not consume a provider rate-limit slot',async()=>{
  const {RequestGate}=require('../upstream-control');
  const gate=new RequestGate({concurrency:2,intervalMs:1000});
  let calls=0;
  assert.deepEqual(await gate.run(()=>{calls++;},1,()=>({expired:true})),{expired:true});
  assert.equal(calls,0);
  await Promise.race([
    gate.run(()=>{calls++;return 'started';}),
    new Promise((resolve,reject)=>setTimeout(()=>reject(Error('Expired local work spent a network slot')),200))
  ]);
  assert.equal(calls,1);
});

test('the opening permit is forwarded only to the coordinated POST, never the precheck',async()=>{
  const permit={};
  const reserve=createReservationService(async(endpoint,token,options)=>{
    if(options?.method==='POST') {
      assert.equal(options.openingBurst,permit);
      return {ok:true,data:{success:true,data:{id:'ticket'}}};
    }
    assert.equal(options?.openingBurst,undefined);
    return {ok:true,data:{data:[]}};
  });
  await reserve('student','token','dinner',date,'CENA',()=>true,{openingBurst:permit});
});

test('an HTTP 200 error with an empty ticket list cannot authorize a reservation',async()=>{
  const reserve=createReservationService(async(endpoint,token,options)=>{
    assert.notEqual(options?.method,'POST');
    return {ok:true,data:{success:false,data:[],message:'Temporalmente no disponible'}};
  });
  const result=await reserve('student','token','dinner',date,'CENA');
  assert.equal(result.ok,false);
});
