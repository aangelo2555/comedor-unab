// Serialize each student's date/meal across automatic and manual entry points.
function createReservationService(callApi) {
  const pending = new Map();
  const submitting = new Set();
  const prepared = new Map();
  const generations = new Map();
  let preparationEpoch = 0;
  const proofLifetimeMs = 90000;
  const openingWindowMs = 2500;
  const keyFor = (userId, date, meal) => JSON.stringify([userId, date, meal.toUpperCase()]);
  const proofValid = proof => proof && proof.epoch === preparationEpoch && Date.now() >= proof.openingTs && Date.now() <= proof.openingTs + openingWindowMs && Date.now() - proof.checkedAt <= proofLifetimeMs;
  function invalidate(userId, date, meal) {
    const key = keyFor(userId, date, meal);
    prepared.delete(key);
    generations.set(key, (generations.get(key) || 0) + 1);
  }
  function prune() {
    const now = Date.now();
    for (const [key, proof] of prepared) if (now > proof.openingTs + openingWindowMs || now - proof.checkedAt > proofLifetimeMs) prepared.delete(key);
  }

  async function reserve(
    token,
    programming,
    date,
    meal,
    canProceed = () => true,
    requestOptions,
    proof,
    onSubmit
  ) {
    const { preparedOpeningTs, onWriteStart, openingBurst, ...apiOptions } = requestOptions || {};
    proof = proofValid(proof) ? proof : null;
    const query = `/reservas/me?fecha=${encodeURIComponent(date)}`;
    const existing = proof ? { ok: true, data: { data: [] } } : await callApi(query, token, requestOptions ? apiOptions : undefined);
    if (!existing.ok || existing.data?.success === false || !Array.isArray(existing.data?.data)) {
      return {
        ok: false,
        status: 503,
        data: {
          message:
            'No se pudo verificar si ya existe un ticket. Reserva pendiente.'
        }
      };
    }
    const ticket = existing.data.data.find(
      (item) =>
        item.id &&
        (item.tipoComida || '').toUpperCase() === meal &&
        (!item.fecha || item.fecha === date) &&
        ['ACTIVA', 'CONSUMIDA'].includes(item.estado)
    );
    if (ticket)
      return { ok: true, status: 200, data: { success: true, data: ticket } };
    if (!canProceed())
      return {
        ok: false,
        status: 409,
        data: { message: 'La solicitud dejó de estar activa.' }
      };
    const result = await callApi('/reservas', token, {
      ...apiOptions,
      ...(openingBurst ? { openingBurst } : {}),
      ...(proof ? { validatePreflight: () => proofValid(proof) } : {}),
      ...((onSubmit || onWriteStart) ? { onRequestStart: info => { onSubmit?.(); onWriteStart?.(info); } } : {}),
      priority: Math.max(apiOptions.priority || 0, preparedOpeningTs ? 2 : 0),
      method: 'POST',
      body: JSON.stringify({ programacionId: programming }),
      canProceed
    });
    if (proof && result.data?.code === 'PREFLIGHT_STALE' && canProceed()) return reserve(token, programming, date, meal, canProceed, requestOptions, undefined, onSubmit);
    if (result.ok && result.data?.success && result.data.data?.id)
      return result;
    // A lost response can still mean the upstream committed the reservation.
    const check = await callApi(query, token, requestOptions ? apiOptions : undefined);
    const found =
      check.ok &&
      Array.isArray(check.data?.data) &&
      check.data.data.find(
        (item) =>
          item.id &&
          (item.tipoComida || '').toUpperCase() === meal &&
          (!item.fecha || item.fecha === date) &&
          ['ACTIVA', 'CONSUMIDA'].includes(item.estado)
      );
    if (found)
      return { ok: true, status: 200, data: { success: true, data: found } };
    return {
      ...result,
      ok: false,
      data: {
        ...result.data,
        success: false,
        message:
          result.data?.message ||
          result.error ||
          'Reserva pendiente de confirmar en UNAB.'
      }
    };
  }

  async function reserveOnce(
    userId,
    token,
    programming,
    date,
    meal,
    canProceed,
    requestOptions
  ) {
    meal = meal.toUpperCase();
    const key = keyFor(userId, date, meal);
    if (pending.has(key)) return pending.get(key);
    prune();
    const candidate = prepared.get(key);
    const proof = requestOptions?.preparedOpeningTs === candidate?.openingTs && candidate?.token === token && proofValid(candidate) ? candidate : null;
    invalidate(userId, date, meal);
    const operation = reserve(
      token,
      programming,
      date,
      meal,
      canProceed,
      requestOptions,
      proof,
      () => submitting.add(key)
    );
    pending.set(key, operation);
    try {
      return await operation;
    } finally {
      pending.delete(key);
      submitting.delete(key);
    }
  };
  reserveOnce.isSubmitting = (userId, date, meal) => submitting.has(keyFor(userId, date, meal));
  reserveOnce.invalidate = invalidate;
  reserveOnce.clearPrepared = () => { preparationEpoch++; prepared.clear(); generations.clear(); };
  reserveOnce.prepare = async (userId, token, date, meal, openingTs, options = {}) => {
    prune();
    if (!Number.isFinite(openingTs) || Date.now() >= openingTs || openingTs - Date.now() > 65000 || (options.canProceed && !options.canProceed())) return false;
    const key = keyFor(userId, date, meal);
    if (pending.has(key)) return false;
    const generation = generations.get(key) || 0;
    const epoch = preparationEpoch;
    const result = await callApi(`/reservas/me?fecha=${encodeURIComponent(date)}`, token, options);
    if (!result.ok || result.data?.success === false || !Array.isArray(result.data?.data) || pending.has(key) || generation !== (generations.get(key) || 0) || epoch !== preparationEpoch || (options.canProceed && !options.canProceed())) return false;
    if (result.data.data.some(item => (item.tipoComida || '').toUpperCase() === meal.toUpperCase() && (!item.fecha || item.fecha === date) && ['ACTIVA', 'CONSUMIDA'].includes(item.estado))) return false;
    if (Date.now() >= openingTs) return false;
    prepared.set(key, { token, openingTs, epoch, checkedAt: Date.now() });
    return true;
  };
  return reserveOnce;

}

async function mapWithConcurrency(items, concurrency, operation) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return results;
}

module.exports = { createReservationService, mapWithConcurrency };
