const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('600 active appointments and tickets survive a subsequent database write and reload', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unab-retention-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  const database = path.join(directory, 'database.json');
  const advances = Array.from({ length: 600 }, (_, index) => ({
    id: 'advance-' + index,
    alumnoCodigo: 'student-' + index,
    tipoComida: 'CENA',
    fecha: '2026-11-20',
    status: 'ACTIVA',
    createdAt: '2026-11-01T12:00:00Z'
  }));
  const tickets = Array.from({ length: 600 }, (_, index) => ({
    id: 'ticket-' + index,
    estado: 'ACTIVA'
  }));
  fs.writeFileSync(
    database,
    JSON.stringify({
      users: [],
      reservas: tickets,
      advanceReservations: advances,
      auditLogs: []
    })
  );
  try {
    const db = require('../db');
    db.createAdvanceReservation({
      alumnoCodigo: 'new-student',
      tipoComida: 'ALMUERZO',
      fecha: '2026-11-20'
    });
    db.recordReservation({ id: 'new-ticket', estado: 'ACTIVA' });
    db.recordReservations([{ id: 'batch-ticket', estado: 'ACTIVA' }]);
    db.createAdvanceReservation({
      alumnoCodigo: 'student-599',
      tipoComida: 'CENA',
      fecha: '2026-11-20'
    });
    const saved = JSON.parse(fs.readFileSync(database, 'utf8'));
    assert.equal(saved.advanceReservations.length, 601);
    assert.equal(
      saved.advanceReservations.find((item) => item.id === 'advance-599')
        .createdAt,
      '2026-11-01T12:00:00Z'
    );
    assert.equal(saved.reservas.length, 602);
    assert.ok(
      saved.advanceReservations.some((item) => item.id === 'advance-599')
    );
    assert.ok(saved.reservas.some((item) => item.id === 'ticket-599'));
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
