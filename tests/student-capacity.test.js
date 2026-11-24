const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  STUDENT_LIMIT,
  assignRegistrationOrder,
  orderedStudents,
  enrollment,
  admittedStudents
} = require('../student-capacity');
const { compareQueue } = require('../premium-service');

test('existing registration seniority survives migration and newer accounts append after it', () => {
  const users = [
    { id: 'admin', role: 'superadmin' },
    { id: 'recent', role: 'user', createdAt: '2026-11-20T10:00:00Z' },
    { id: 'first', role: 'user', createdAt: '2026-01-01T10:00:00Z' },
    { id: 'legacy', role: 'user' }
  ];
  assignRegistrationOrder(users);
  assert.deepEqual(
    orderedStudents(users).map((user) => user.id),
    ['legacy', 'first', 'recent']
  );
  const original = users.map((user) => user.registrationOrder);
  assignRegistrationOrder(users);
  assert.deepEqual(
    users.map((user) => user.registrationOrder),
    original
  );
  users.push({ id: 'new', role: 'user', createdAt: '2026-11-24T10:00:00Z' });
  assignRegistrationOrder(users);
  assert.equal(enrollment(users, 'new').position, 4);
  assert.equal(enrollment(users, 'first').position, 2);
});

test('only the first 50 registrations are admitted and all older accounts remain present', () => {
  const users = Array.from({ length: 60 }, (_, index) => ({
    id: String(index),
    role: 'user'
  }));
  assignRegistrationOrder(users);
  assert.equal(STUDENT_LIMIT, 50);
  assert.equal(admittedStudents(users).length, 50);
  assert.equal(enrollment(users, '49').admitted, true);
  assert.equal(enrollment(users, '50').admitted, false);
  assert.equal(enrollment(users, '59').position, 60);
  assert.equal(users.length, 60);
  assert.equal(enrollment(users).available, 0);
});

test('reservation dispatch follows registration seniority even for a later request', () => {
  const queue = [
    {
      id: 'new-student',
      registrationOrder: 2,
      createdAt: '2026-11-24T10:00:00Z'
    },
    {
      id: 'existing-student',
      registrationOrder: 1,
      createdAt: '2026-11-24T12:00:00Z'
    }
  ];
  assert.equal(queue.sort(compareQueue)[0].id, 'existing-student');
});
