const {test} = require('node:test');
const assert = require('node:assert/strict');
const {requestView} = require('../reservation-view');
const request = {id:'request',alumnoCodigo:'student',fecha:'2026-11-25',tipoComida:'CENA',status:'ACTIVA'};
const ticket = {id:'old-ticket',alumnoCodigo:'student',fecha:'2026-11-25',tipoComida:'CENA',estado:'ANULADA'};

test('a canceled previous ticket does not mask a reactivated request',()=>{
  assert.equal(requestView(request,[ticket]).status,'ACTIVA');
  assert.equal(requestView({...request,status:'ANULADA'},[{...ticket,estado:'ACTIVA'}]).status,'ANULADA');
  assert.equal(requestView({...request,status:'CONFIRMADA',ticketId:ticket.id},[ticket]).status,'ANULADA');
});
test('a current active ticket wins over an earlier cancellation while other students and services are ignored',()=>{
  const current = {...ticket,id:'new-ticket',estado:'ACTIVA'};
  assert.equal(requestView(request,[ticket,current]).status,'CONFIRMADA');
  assert.equal(requestView({...request,status:'CONFIRMADA',ticketId:current.id},[ticket,current]).status,'CONFIRMADA');
  assert.equal(requestView(request,[{...current,tipoComida:'ALMUERZO'},{...current,alumnoCodigo:'other'}]).status,'ACTIVA');
  assert.equal(requestView(request,[{...current,estado:'CONSUMIDA'}]).status,'CONSUMIDA');
});

test('the shared coordinator reuses a consumed ticket without submitting another reservation',async()=>{
  const {createReservationService}=require('../reservation-service');
  const consumed={...ticket,estado:'CONSUMIDA'};
  const reserve=createReservationService(async(endpoint,token,options)=>{
    assert.equal(options?.method,undefined,'No reservation write is allowed after consumption');
    return {ok:true,data:{data:[consumed]}};
  });
  const result=await reserve('student','token','dinner','2026-11-25','CENA');
  assert.equal(result.data.data.estado,'CONSUMIDA');
  assert.equal(result.data.data.id,consumed.id);
});

test('a reservation stays marked as submitting until uncertain-result reconciliation finishes',async()=>{
  const {createReservationService}=require('../reservation-service');
  let begin,finish,reconciling,finishReconciliation,reads=0;
  const started=new Promise(resolve=>{begin=resolve;});
  const held=new Promise(resolve=>{finish=resolve;});
  const checking=new Promise(resolve=>{reconciling=resolve;});
  const reconciliation=new Promise(resolve=>{finishReconciliation=resolve;});
  const reserve=createReservationService(async(endpoint,token,options)=>{
    if(options?.method==='POST') {
      options.onRequestStart({});begin();await held;
      return {ok:false,status:503,data:{message:'response lost'}};
    }
    if(++reads===1)return {ok:true,data:{data:[]}};
    reconciling();await reconciliation;
    return {ok:true,data:{data:[{id:'ticket',tipoComida:'CENA',fecha:'2026-11-25',estado:'ACTIVA'}]}};
  });
  const operation=reserve('student','token','dinner','2026-11-25','CENA');
  assert.equal(reserve.isSubmitting('student','2026-11-25','CENA'),false);
  await started;
  assert.equal(reserve.isSubmitting('student','2026-11-25','CENA'),true);
  finish();await checking;
  assert.equal(reserve.isSubmitting('student','2026-11-25','CENA'),true);
  finishReconciliation();const result=await operation;
  assert.equal(result.data.data.id,'ticket');
  assert.equal(reserve.isSubmitting('student','2026-11-25','CENA'),false);
});
