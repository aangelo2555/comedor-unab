const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fork} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

if (process.env.RECOVERY_CHILD) {
  global.fetch = async (url, options) => {
    if (url.includes('/auth/login')) {
      const credentials = JSON.parse(options.body);
      assert.equal(credentials.userspassunab, 'recovery-secret');
      process.send({login:true});
      const exp = process.env.RECOVERY_PHASE === 'initial' ? 1 : Math.floor(Date.now()/1000)+3600;
      return Response.json({data:{accessToken:'e30.'+Buffer.from(JSON.stringify({exp})).toString('base64url')+'.test'}},{status:201});
    }
    if (url.endsWith('/auth/me')) return Response.json({data:{nombre:'Recovery student'}});
    return Response.json({data:[]});
  };
  const http = require('node:http');
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function(...args) {
    this.once('listening',()=>process.send({port:this.address().port}));
    return listen.apply(this,args);
  };
  require('../server');
} else {
  test('encrypted credentials survive abrupt restarts, renew automatically, stay out of backups and are erased on revocation',async()=>{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'mesa-recovery-'));
    const key = crypto.randomBytes(32).toString('base64');
    let child;
    let base;
    let loginCalls = 0;
    const start = async (phase, configuredKey = key) => {
      child = fork(__filename,[],{silent:true,env:{...process.env,RECOVERY_CHILD:'1',RECOVERY_PHASE:phase,INSTITUTION_CREDENTIAL_KEY:configuredKey,DATA_DIR:directory,DATABASE_URL:'',PGHOST:'',PORT:'0',UNAB_REQUEST_INTERVAL_MS:'1',ADMIN_EMAIL:'admin@example.test',ADMIN_PASSWORD:'admin-test-only'}});
      child.on('message', m=>{if(m.login)loginCalls++;});
      base = 'http://127.0.0.1:'+await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('Startup timeout')),5000);
        child.on('message',m=>{if(m.port){clearTimeout(timer);resolve(m.port);}});
        child.once('exit',()=>{clearTimeout(timer);reject(Error('Server exited'));});
      });
    };
    const stop = async()=>{ if(child){const done=once(child,'exit');child.kill('SIGKILL');await done;child=null;} };
    const request = (url, method='GET',body,token)=>fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
    try {
      await start('initial');
      const login=await request('/api/auth/login','POST',{username:'recovery-student',password:'recovery-secret',termsVersion:'2026-11-20',processingConsent:true});
      assert.equal(login.status,200);
      const session=await login.json();
      assert.equal(loginCalls,1);
      await stop();
      const file=path.join(directory,'database.json');
      const saved=fs.readFileSync(file,'utf8');
      assert.ok(!saved.includes('recovery-secret'));
      assert.ok(!saved.includes(session.token));
      const state=JSON.parse(saved);
      assert.ok(state.institutionalCredentials[session.user.id]);
      assert.equal(state.users.find(u=>u.id===session.user.id).password,'');
      await start('wrong-key', crypto.randomBytes(32).toString('base64'));
      assert.equal((await request('/api/comedor/programacion','GET',undefined,session.token)).status,503);
      assert.equal(loginCalls,1,'An incorrect key never sends damaged credentials');
      await stop();
      assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).institutionalCredentials[session.user.id], state.institutionalCredentials[session.user.id], 'Encrypted data survives a key mismatch');
      await start('restarted');
      const response=await request('/api/comedor/programacion','GET',undefined,session.token);
      assert.equal(response.status,200);
      assert.equal(loginCalls,2,'No new student login is needed after restart');
      await request('/api/comedor/programacion','GET',undefined,session.token);
      assert.equal(loginCalls,2,'Ready token is reused');
      const admin=await (await request('/api/auth/login','POST',{username:'admin@example.test',password:'admin-test-only'})).json();
      const backup=await (await request('/api/admin/backup','GET',undefined,admin.token)).json();
      assert.equal(backup.institutionalCredentials,undefined);
      assert.ok(!JSON.stringify(backup).includes('recovery-secret'));
      assert.equal((await request('/api/student/authorization','DELETE',undefined,session.token)).status,200);
      await stop();
      assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).institutionalCredentials[session.user.id],undefined);
      await start('revoked');
      assert.equal((await request('/api/auth/me','GET',undefined,session.token)).status,401);
      assert.equal(loginCalls,2);
    } finally { await stop();fs.rmSync(directory,{recursive:true,force:true}); }
  });
}
