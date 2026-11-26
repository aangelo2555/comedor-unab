'use strict';
// Integration exercise: real application + real local HTTP, exclusively fictitious students.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { fork, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.env.OPENING_SIM_CHILD === '1') {
  const RealDate = Date;
  const offset = Number(process.env.OPENING_SIM_OFFSET);
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])); }
    static now() { return RealDate.now() + offset; }
  };
  let hashCalls=0, hashNs=0n;
  const originalScrypt=crypto.scryptSync;
  crypto.scryptSync=(...args)=>{const start=process.hrtime.bigint();try{return originalScrypt(...args);}finally{hashCalls++;hashNs+=process.hrtime.bigint()-start;}};
  const nativeFetch = global.fetch;
  global.fetch = async (input, options = {}) => {
    const original = new URL(input);
    if (!['api-login-dev.unab.edu.pe', 'comedor-api.unab.edu.pe'].includes(original.hostname))
      throw new Error('Simulation forbids all other destinations');
    const destination = process.env.OPENING_SIM_PROVIDER + original.pathname + original.search;
    const isPost = original.pathname === '/v1/reservas' && options.method === 'POST';
    if (isPost) {
      const token = String(options.headers?.Authorization || '').slice(7);
      const subject = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub;
      process.send({ type: 'outbound-post', subject, realAt: RealDate.now(), ns: process.hrtime.bigint().toString() });
    }
    return nativeFetch(destination, options);
  };
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    this.once('listening', () => process.send({ type: 'ready', port: this.address().port }));
    return listen.apply(this, args);
  };
  global.__openingSimulationHashStats=()=>({calls:hashCalls,cpuMs:Number(hashNs)/1e6});
  const filename = path.join(root, 'server.js');
  const application = new Module(filename, module);
  application.filename = filename;
  application.paths = Module._nodeModulePaths(root);
  // Expose observation only inside this isolated child; production files are untouched.
  application._compile(fs.readFileSync(filename, 'utf8') + `
    const originalRecord = db.recordReservation;
    db.recordReservation = ticket => {
      const result = originalRecord(ticket);
      process.send({type:'stored-ticket', subject:ticket.alumnoCodigo, id:ticket.id, realAt:require('node:perf_hooks').performance.timeOrigin + require('node:perf_hooks').performance.now()});
      return result;
    };
    module.exports.__simulation = {
      async snapshot() {
        await db.flush();
        return {
          status:globalSniper.status, running:globalSniper.running,
          passwordHashing:global.__openingSimulationHashStats(),
          timing:globalSniper.lastDispatchTiming || null,
          pending:getAllPendingAdvanceReservations().map(item=>({id:item.advanceId,subject:item.studentUsername,premium:item.premium,requiresLogin:item.sessionNeedsLogin})),
          tickets:db.getAllReservations().map(item=>({id:item.id,subject:item.alumnoCodigo,meal:item.tipoComida,state:item.estado})),
          users:db.getAllUsers(false).filter(user=>user.role!=='superadmin').map(user=>({id:user.id,subject:user.username,order:user.registrationOrder,tokenSubject:user.unabToken?JSON.parse(Buffer.from(user.unabToken.split('.')[1],'base64url')).sub:null}))
        };
      },
      async stop() { stopGlobalSniper(true); await db.flush(); }
    };`, filename);
  process.on('message', async message => {
    if (!['snapshot', 'stop'].includes(message.command)) return;
    try { process.send({ type: 'rpc', id: message.id, data: await application.exports.__simulation[message.command]() }); }
    catch { process.send({ type: 'rpc', id: message.id, error: 'Application observation failed' }); }
  });
} else {
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
  const quick = args.includes('--quick');
  const selected = option('--scenario', 'all');
  const names = selected === 'all' ? ['healthy', 'mixed', 'capacity', 'throttled'] : selected === 'window-suite' ? ['window', 'window-stress', 'window-missing', 'window-probe-slow'] : [selected];
  for (const name of names) if (!['healthy', 'mixed', 'capacity', 'throttled', 'window', 'window-stress', 'window-missing', 'window-probe-slow', 'window-revoked-probe'].includes(name)) throw new Error('Unknown scenario');
  const postgresFile = option('--postgres-config', '');
  const postgres = postgresFile ? JSON.parse(fs.readFileSync(postgresFile, 'utf8')) : null;
  const output = path.resolve(option('--output', path.join(root, 'reports', 'simulation-50.json')));
  const report = {
    generatedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceSha256: Object.fromEntries(['server.js', 'db.js', 'reservation-service.js', 'session-preparation.js', 'upstream-control.js'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    method: 'Unmodified production server, real local HTTP sockets, 50 signed fictitious JWT identities, isolated storage',
    externalInstitutionRequests: 0, students: 50, leadSeconds: quick ? 3 : 35,
    ordinaryIntervalMs: quick ? 1 : 500, openingConcurrency: 50, storage: postgres ? 'PostgreSQL' : 'temporary JSON',
    limitations: ['Local HTTP has no institutional TLS, WAN latency, firewall or production backend.', 'Provider capacity and failures are deliberate models, not measurements of UNAB.', 'Accounts start registered; this exercise targets session preparation and reservation dispatch, not browser registration.'],
    scenarios: []
  };
  for (const name of names) {
    console.log(`[simulation] Starting ${name}: 50 distinct identities`);
    const leadSeconds = Number(option('--lead-seconds', quick ? 3 : name === 'window-stress' ? 95 : 35));
    if (!Number.isFinite(leadSeconds) || leadSeconds < 1 || leadSeconds > 360) throw Error('Invalid preparation lead');
    report.scenarios.push(await scenario(name, { quick, postgres, leadMs: leadSeconds * 1000 }));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log('[result] ' + JSON.stringify(report.scenarios.at(-1).summary));
  }
  console.log(`[simulation] Report: ${output}`);
  if (report.scenarios.some(item => !item.invariantsPassed)) process.exitCode = 1;
}

async function scenario(name, settings) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mesa-simulation-'));
  fs.chmodSync(directory, 0o700);
  const realOpening = Date.now() + settings.leadMs;
  const date = '2026-11-26';
  const opening = Date.parse(date + 'T17:00:00-05:00');
  const offset = opening - realOpening;
  const clock = () => Date.now() + offset;
  const signingKey = crypto.randomBytes(32);
  let sequence = 0;
  const issueToken = (subject, expired = false) => {
    const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: subject, exp: Math.floor((expired ? clock() - 1000 : clock() + 3600000) / 1000), jti: ++sequence })).toString('base64url');
    const signature = crypto.createHmac('sha256', signingKey).update(head + '.' + payload).digest('base64url');
    return head + '.' + payload + '.' + signature;
  };
  const users = Array.from({ length: 50 }, (_, index) => {
    const subject = 'SIM-' + String(index + 1).padStart(3, '0');
    const missing = (name === 'mixed' && index >= 47) || (name === 'window-missing' && index === 0);
    return {
      id: 'student-' + index, username: subject, name: 'Alumno simulado ' + (index + 1), role: 'user', active: true, autoSniper: true,
      registrationOrder: index + 1, password: missing ? '' : 'simulation-only-' + subject,
      unabToken: missing ? '' : issueToken(subject, (name === 'mixed' || name === 'window-stress') && index >= 10 && index < 15),
      legalConsent: { version: '2026-11-20', processing: true },
      ...(index < 10 ? { premium: { enabled: true, meals: ['CENA'], endDate: '2026-12-31', managedBy: 'admin' }, automationConsent: { enabled: true, autoCancel: false } } : {})
    };
  });
  const missing = new Set(users.filter(user => !user.password).map(user => user.username));
  const tickets = new Map();
  const attempts = new Map();
  const renewals = new Map();
  const revoked = new Set();
  const events = [], outbound = [], confirmed = [], faults = [], errors = [];
  let acceptedActive = 0, acceptedPeak = 0, invalidAuthentication = 0, identityViolations = 0, duplicateAttempts = 0;
  let institution, child, pgAdmin, database, databaseCreated = false;
  let logs = '', rpcId = 0;
  const rpcWaiters = new Map();
  const expected = name === 'capacity' ? 30 : 50 - missing.size;
  const latency = index => settings.quick ? 10 + index % 5 : 200 + (index % 7) * 25;
  const json = (res, status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
  const body = async req => { let text = ''; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : {}; };
  function authenticate(req) {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (req.headers.cookie !== 'next-login-auth=' + token) { identityViolations++; return null; }
    try {
      const [head, payload, signature] = token.split('.');
      const valid = crypto.createHmac('sha256', signingKey).update(head + '.' + payload).digest('base64url');
      if (signature !== valid) throw Error('Bad signature');
      const data = JSON.parse(Buffer.from(payload, 'base64url'));
      if (!users.some(user => user.username === data.sub) || data.exp * 1000 <= clock() || revoked.has(data.jti)) throw Error('Rejected token');
      return data;
    } catch { invalidAuthentication++; return null; }
  }
  try {
    institution = http.createServer((req, res) => handle(req, res).catch(() => { if (!res.headersSent) json(res, 500, { message: 'Simulation handler failed' }); else res.destroy(); }));
    await new Promise(resolve => institution.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(directory, 'database.json'), JSON.stringify({ users, reservas: [], advanceReservations: users.map(user => ({
      id: 'advance-' + user.id, alumnoCodigo: user.username, alumnoNombre: user.name, tipoComida: 'CENA', fecha: date, status: 'ACTIVA',
      source: user.premium ? 'premium' : 'manual', autoSniper: true, createdAt: date + 'T15:00:' + user.registrationOrder.toString().padStart(2, '0') + 'Z'
    })), auditLogs: [], settings: {} }));
    let pgEnvironment = { DATABASE_URL: '', PGHOST: '', PGPORT: '', PGUSER: '', PGPASSWORD: '', PGDATABASE: '' };
    if (settings.postgres) {
      const { Client } = require('pg');
      pgAdmin = new Client({ host: settings.postgres.PGHOST, port: Number(settings.postgres.PGPORT), user: settings.postgres.PGUSER, password: settings.postgres.PGPASSWORD, database: settings.postgres.PGDATABASE });
      await pgAdmin.connect();
      database = 'sim_' + name.replace(/[^a-z0-9]/g, '_') + '_' + Date.now();
      await pgAdmin.query('CREATE DATABASE ' + database);
      databaseCreated = true;
      pgEnvironment = { ...settings.postgres, DATABASE_URL: '', PGDATABASE: database };
    }
    child = fork(__filename, [], { silent: true, env: {
      ...process.env, ...pgEnvironment, OPENING_SIM_CHILD: '1', OPENING_SIM_OFFSET: String(offset),
      OPENING_SIM_PROVIDER: 'http://127.0.0.1:' + institution.address().port, DATA_DIR: directory, PORT: '0',
      INSTITUTION_CREDENTIAL_KEY: crypto.randomBytes(32).toString('base64'), UNAB_REQUEST_INTERVAL_MS: settings.quick ? '1' : '500',
      UNAB_MAX_CONCURRENCY: '2', UNAB_OPENING_CONCURRENCY: '50', ADMIN_EMAIL: 'simulation-admin@example.test', ADMIN_PASSWORD: crypto.randomBytes(20).toString('hex')
    } });
    child.stdout.on('data', chunk => { logs += chunk.toString(); });
    child.stderr.on('data', chunk => { logs += chunk.toString(); });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Application startup timed out')), 15000);
      child.on('message', message => {
        if (message.type === 'ready') { clearTimeout(timer); resolve(); }
        if (message.type === 'outbound-post') outbound.push(message);
        if (message.type === 'stored-ticket') confirmed.push(message);
        if (message.type === 'rpc') { const waiting = rpcWaiters.get(message.id); if (waiting) { rpcWaiters.delete(message.id); message.error ? waiting.reject(Error(message.error)) : waiting.resolve(message.data); } }
      });
      child.once('exit', code => { clearTimeout(timer); reject(Error('Application exited ' + code)); });
    });
    await ready;
    const rpc = command => new Promise((resolve, reject) => {
      const id = ++rpcId;
      const timer = setTimeout(() => { rpcWaiters.delete(id); reject(Error('Observation timed out')); }, 15000);
      rpcWaiters.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.send({ id, command });
    });
    let snapshot, lastProgress = 0, finished = false;
    const shortWindow = name.startsWith('window');
    const deadline = realOpening + (shortWindow ? 20000 : settings.quick ? 30000 : 120000);
    while (Date.now() < deadline) {
      snapshot = await rpc('snapshot');
      if (Date.now() >= realOpening && snapshot.timing && !['RESERVING', 'ARMED'].includes(snapshot.status)) {
        if (snapshot.tickets.filter(ticket => ['ACTIVA', 'CONSUMIDA'].includes(ticket.state)).length >= expected && acceptedActive === 0) { finished = true; break; }
        if (shortWindow && Date.now() > realOpening + 3500 && acceptedActive === 0) break;
      }
      if (Date.now() - lastProgress >= 10000) {
        console.log(`[${name}] opening ${Math.round((Date.now() - realOpening) / 1000)}s; confirmed ${snapshot.tickets.length}/${expected}; outbound POSTs ${outbound.length}`);
        lastProgress = Date.now();
      }
      await wait(settings.quick ? 100 : 500);
    }
    await rpc('stop');
    snapshot = await rpc('snapshot');
    const mapped = new Map([...tickets.values()].map(ticket => [ticket.id, ticket.alumnoCodigo]));
    const mismatches = snapshot.tickets.filter(ticket => mapped.get(ticket.id) !== ticket.subject);
    const wrongCachedTokens = snapshot.users.filter(user => user.tokenSubject && user.tokenSubject !== user.subject);
    const earliestByUser = new Map();
    for (const event of outbound) if (!earliestByUser.has(event.subject)) earliestByUser.set(event.subject, event);
    const firstPerUser = [...earliestByUser.values()].sort((a, b) => Number(BigInt(a.ns) - BigInt(b.ns)));
    const firstNs = firstPerUser.length ? BigInt(firstPerUser[0].ns) : 0n;
    const lastNs = firstPerUser.length ? firstPerUser.reduce((maximum, event) => BigInt(event.ns) > maximum ? BigInt(event.ns) : maximum, firstNs) : 0n;
    const initialAttempts = firstPerUser.filter(event => event.realAt < realOpening + 10000);
    const initialSpan = initialAttempts.length > 1 ? Number(BigInt(initialAttempts.at(-1).ns) - BigInt(initialAttempts[0].ns)) / 1e6 : 0;
    const arrivals = events.filter(event => event.kind === 'post');
    const uniqueSubjects = new Set(arrivals.map(event => event.subject));
    const confirmedSubjects = new Set(snapshot.tickets.map(ticket => ticket.subject));
    const initialFailures = faults.map(fault => ({ ...fault }));
    const detectedReal = snapshot.timing ? Date.parse(snapshot.timing.detectedAt) - offset : null;
    const summary = {
      scenario: name, preparationLeadSeconds: settings.leadMs / 1000, confirmed: confirmedSubjects.size, pending: snapshot.pending.length, expectedConfirmable: expected,
      detectionAfterOpeningMs: detectedReal === null ? null : detectedReal - realOpening,
      firstPostAfterDetectionMs: snapshot.timing?.firstPostDelayMs ?? null,
      initialUniquePOSTs: initialAttempts.length, initialClientStartSpanMs: Math.round(initialSpan * 100) / 100,
      allFirstAttemptsSpanMs: firstPerUser.length > 1 ? Math.round(Number(lastNs - firstNs) / 1e4) / 100 : 0,
      completionAfterOpeningMs: confirmed.length ? Math.round(Math.max(...confirmed.map(event => event.realAt)) - realOpening) : null,
      providerPeakAcceptedPOSTs: acceptedPeak, uniquePOSTIdentities: uniqueSubjects.size, authenticationRenewals: [...renewals.values()].reduce((a, b) => a + b, 0),
      invalidAuthenticationResponses: invalidAuthentication, identityMismatches: mismatches.length + wrongCachedTokens.length + identityViolations,
      repeatedPOSTsForExistingTickets: duplicateAttempts, totalPOSTs: outbound.length,
      windowMs: shortWindow ? 3500 : null,
      postsReceivedBeforeWindowClosed: shortWindow ? new Set(arrivals.filter(event => event.realAt < realOpening + 3500).map(event => event.subject)).size : null,
      firstProviderArrivalAfterOpeningMs: arrivals.length ? Math.min(...arrivals.map(event => event.realAt)) - realOpening : null,
      lastProviderFirstArrivalAfterOpeningMs: arrivals.length ? Math.max(...[...new Set(arrivals.map(event => event.subject))].map(subject => arrivals.find(event => event.subject === subject).realAt)) - realOpening : null,
      passwordHashCalls:snapshot.passwordHashing.calls, passwordHashCpuMs:Math.round(snapshot.passwordHashing.cpuMs),
      observedForMsAfterOpening: Math.max(0, Date.now() - realOpening), completedWithinObservation: finished
    };
    if (summary.identityMismatches) errors.push('Identity isolation failed');
    if (duplicateAttempts) errors.push('A POST was repeated for an already-issued ticket');
    if (confirmedSubjects.size !== expected) errors.push('Expected confirmable count was not reached');
    if (snapshot.pending.length !== 50 - expected) errors.push('Pending count differs from expected scenario outcome');
    if (name === 'healthy' && initialAttempts.length !== 50) errors.push('Healthy opening did not issue all 50 initial POSTs');
    return { summary, invariantsPassed: !errors.length, errors, providerModel: { quota: name === 'capacity' ? 30 : 50, acceptedConcurrentLimit: name === 'throttled' ? 12 : 50, baseResponseMs: name === 'window-stress' ? 2000 : settings.quick ? '10-14' : '200-350', preOpeningTicketReadMs: name === 'window-stress' ? 2800 : settings.quick ? 1 : 20, publicationResponseMs: name === 'window-probe-slow' ? 2800 : name === 'window-stress' ? 1000 : 0 }, faults: initialFailures,
      users: users.map(user => ({ subject: user.username, premium: Boolean(user.premium), attempts: attempts.get(user.username) || 0, confirmed: confirmedSubjects.has(user.username), remainsPending: snapshot.pending.some(item => item.subject === user.username), loginRequired: snapshot.pending.some(item => item.subject === user.username && item.requiresLogin) })),
      applicationTiming: snapshot.timing, logTail: logs.split('\n').filter(line => /WARMUP|LATENCIA|CENTINELA/.test(line)).slice(-15)
    };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    if (institution) { institution.closeAllConnections(); await new Promise(resolve => institution.close(resolve)); }
    if (pgAdmin) { if (databaseCreated) await pgAdmin.query('DROP DATABASE ' + database + ' WITH (FORCE)'); await pgAdmin.end(); }
    fs.rmSync(directory, { recursive: true, force: true });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local.test');
    if (url.pathname === '/auth/login') {
      const credentials = await body(req);
      const user = users.find(item => item.username === credentials.UserName);
      if (!user || missing.has(user.username) || credentials.userspassunab !== user.password) return json(res, 401, { code: 'INVALID_CREDENTIALS' });
      renewals.set(user.username, (renewals.get(user.username) || 0) + 1);
      return json(res, 201, { data: { accessToken: issueToken(user.username) } });
    }
    const identity = authenticate(req);
    if (!identity) return json(res, 401, { message: 'Simulated invalid session' });
    const subject = identity.sub;
    const index = Number(subject.slice(4)) - 1;
    if (url.pathname === '/v1/reservas/me') {
      events.push({ kind: 'read', subject, realAt: Date.now() });
      await wait(settings.quick ? 1 : name === 'window-stress' && clock() < opening ? 2800 : 20);
      return json(res, 200, { data: [...tickets.values()].filter(ticket => ticket.alumnoCodigo === subject) });
    }
    if (url.pathname === '/v1/alumnos/me/elegibilidad') return json(res, 200, { data: { elegible: true } });
    if (url.pathname === '/v1/auth/me') return json(res, 200, { data: { nombre: 'Alumno simulado ' + (index + 1) } });
    if (url.pathname === '/v1/programacion/me') {
      if (name === 'window-revoked-probe' && clock() >= opening && index === 0) { revoked.add(identity.jti); invalidAuthentication++; faults.push({subject,type:'revoked-publication-probe'}); return json(res,401,{message:'Simulated rejected probe'}); }
      if (clock() >= opening && ['window-stress','window-probe-slow'].includes(name)) await wait(name === 'window-probe-slow' ? 2800 : 1000);
      return json(res, 200, { data: clock() < opening ? [] : [{ id: 'program-CENA', tipoComida: 'CENA', cupoLibre: 50, disponibleLibre: Math.max(0, (name === 'capacity' ? 30 : 50) - tickets.size) }] });
    }
    if (url.pathname !== '/v1/reservas' || req.method !== 'POST') return json(res, 404, { message: 'Not modeled' });
    const payload = await body(req);
    attempts.set(subject, (attempts.get(subject) || 0) + 1);
    const attempt = attempts.get(subject);
    events.push({ kind: 'post', subject, realAt: Date.now() });
    if (payload.programacionId !== 'program-CENA') { identityViolations++; return json(res, 400, { message: 'Wrong service' }); }
    if (clock() < opening) return json(res, 409, { message: 'Aún no abre el servicio' });
    if (name === 'mixed' && index === 43 && attempt === 1) { revoked.add(identity.jti); invalidAuthentication++; faults.push({ subject, type: 'revoked-at-opening' }); return json(res, 401, { message: 'Simulated token revocation' }); }
    if ((name === 'throttled' && acceptedActive >= 12) || (name === 'mixed' && [35, 36, 37].includes(index) && attempt === 1)) {
      faults.push({ subject, type: 'provider-overload' });
      return json(res, name === 'throttled' ? 429 : 409, { success: false, message: 'Hay muchas reservas simultáneas. Vuelve a intentarlo en unos segundos.' }, { 'Retry-After': settings.quick ? '0.02' : '0.2' });
    }
    if (name.startsWith('window') && clock() >= opening + 3500) { faults.push({subject,type:'window-closed'}); return json(res,409,{message:'Cupo agotado en la bolsa LIBRE'}); }
    if (tickets.has(subject)) { duplicateAttempts++; return json(res, 409, { message: 'Ya existe un ticket' }); }
    if (tickets.size >= (name === 'capacity' ? 30 : 50)) { faults.push({ subject, type: 'no-quota' }); return json(res, 409, { message: 'Cupo agotado en la bolsa LIBRE' }); }
    acceptedPeak = Math.max(acceptedPeak, ++acceptedActive);
    try {
      // Reserve capacity atomically, then model response latency independently.
      const ticket = { id: 'ticket-' + subject, alumnoCodigo: subject, fecha: date, tipoComida: 'CENA', estado: 'ACTIVA', qrToken: 'simulation-only-' + subject };
      tickets.set(subject, ticket);
      if (name === 'mixed' && [19, 20].includes(index) && attempt === 1) {
        faults.push({ subject, type: 'committed-response-lost' }); req.socket.destroy(); return;
      }
      if (name === 'mixed' && [29, 30].includes(index)) { faults.push({ subject, type: 'slow-response' }); await wait(settings.quick ? 300 : 2000); }
      else await wait(name === 'window-stress' ? 2000 : latency(index));
      return json(res, 201, { success: true, data: ticket });
    } finally { acceptedActive--; }
  }
}
