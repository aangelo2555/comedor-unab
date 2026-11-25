const {test}=require('node:test');
const assert=require('node:assert/strict');
const {RequestGate}=require('../upstream-control');
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));

test('13 opening POSTs start together despite an ordinary rate timer and an earlier unfinished request',async()=>{
  const gate=new RequestGate({concurrency:2,intervalMs:60000});
  let release, cancelRead=false, started=0;
  const held=new Promise(resolve=>{release=resolve;});
  const first=gate.run(()=>held);
  const waitingRead=gate.run(()=>{throw Error('Canceled read must not start');},0,()=>cancelRead?{cancelled:true}:undefined);
  const permit=gate.openBurst({maxStarts:13});
  const opening=Array.from({length:13},()=>gate.run(()=>{started++;return held;},3,undefined,permit));
  await turn();
  assert.equal(started,13,'All 13 must start before any confirmation, without a 500 ms gap');
  cancelRead=true;
  release();
  await Promise.all([first,waitingRead,...opening]);
});

test('opening concurrency and starts are bounded at 50; excess work keeps ordinary pacing',async()=>{
  const gate=new RequestGate({concurrency:2,intervalMs:1,openingConcurrency:50});
  const permit=gate.openBurst({maxStarts:1000});
  let release,started=0,active=0,peak=0;
  const held=new Promise(resolve=>{release=resolve;});
  const work=Array.from({length:60},()=>gate.run(async()=>{
    started++;peak=Math.max(peak,++active);await held;active--;
  },2,undefined,permit));
  await turn();
  assert.equal(started,50);
  assert.equal(peak,50);
  release();
  await Promise.all(work);
  assert.equal(started,60);
});

test('provider pauses apply to opening bursts too',async()=>{
  const gate=new RequestGate({intervalMs:60000});
  gate.pause(50);
  const beginning=Date.now();
  const permit=gate.openBurst({maxStarts:3});
  const starts=[];
  const work=Array.from({length:3},()=>gate.run(()=>{starts.push(Date.now());},2,undefined,permit));
  await turn();
  assert.equal(starts.length,0);
  await Promise.all(work);
  assert.ok(starts.every(value=>value-beginning>=45));
  assert.ok(Math.max(...starts)-Math.min(...starts)<100);
});

test('unknown or expired permits cannot bypass the ordinary concurrency limit',async()=>{
  for(const permitKind of ['unknown','expired']) {
    const gate=new RequestGate({concurrency:1,intervalMs:1});
    const permit=permitKind==='unknown'?{}:gate.openBurst({maxStarts:2,durationMs:0});
    let release,started=0;
    const held=new Promise(resolve=>{release=resolve;});
    const first=gate.run(()=>{started++;return held;});
    const second=gate.run(()=>{started++;},2,undefined,permit);
    await turn();
    assert.equal(started,1);
    release();await Promise.all([first,second]);
    assert.equal(started,2);
  }
});
