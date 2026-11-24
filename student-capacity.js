const STUDENT_LIMIT = 50;

function legacyOrder(a, b) {
  const first = Date.parse(a.user.createdAt);
  const second = Date.parse(b.user.createdAt);
  if (Number.isFinite(first) && Number.isFinite(second) && first !== second)
    return first - second;
  if (Number.isFinite(first) !== Number.isFinite(second))
    return Number.isFinite(first) ? 1 : -1;
  return a.index - b.index;
}

function orderedStudents(users) {
  return users
    .map((user, index) => ({ user, index }))
    .filter((item) => item.user.role !== 'superadmin')
    .sort((a, b) => {
      const first =
        Number.isSafeInteger(a.user.registrationOrder) &&
        a.user.registrationOrder > 0
          ? a.user.registrationOrder
          : Number.MAX_SAFE_INTEGER;
      const second =
        Number.isSafeInteger(b.user.registrationOrder) &&
        b.user.registrationOrder > 0
          ? b.user.registrationOrder
          : Number.MAX_SAFE_INTEGER;
      return first - second || legacyOrder(a, b);
    })
    .map((item) => item.user);
}

function assignRegistrationOrder(users) {
  let next = users.reduce(
    (maximum, user) =>
      Number.isSafeInteger(user.registrationOrder)
        ? Math.max(maximum, user.registrationOrder)
        : maximum,
    0
  );
  const seen = new Set();
  for (const user of orderedStudents(users)) {
    if (
      !Number.isSafeInteger(user.registrationOrder) ||
      user.registrationOrder <= 0 ||
      seen.has(user.registrationOrder)
    )
      user.registrationOrder = ++next;
    seen.add(user.registrationOrder);
  }
}

function enrollment(users, id) {
  const students = orderedStudents(users);
  const index = students.findIndex((user) => user.id === id);
  return {
    limit: STUDENT_LIMIT,
    total: students.length,
    position: index < 0 ? null : index + 1,
    admitted: index >= 0 && index < STUDENT_LIMIT,
    available: Math.max(0, STUDENT_LIMIT - students.length)
  };
}

function admittedStudents(users) {
  return orderedStudents(users).slice(0, STUDENT_LIMIT);
}

function capacityError() {
  return Object.assign(
    new Error(
      `Se alcanzó el cupo de ${STUDENT_LIMIT} alumnos. Las cuentas existentes conservan su lugar.`
    ),
    { status: 409, code: 'STUDENT_CAPACITY_FULL' }
  );
}

module.exports = {
  STUDENT_LIMIT,
  orderedStudents,
  assignRegistrationOrder,
  enrollment,
  admittedStudents,
  capacityError
};
