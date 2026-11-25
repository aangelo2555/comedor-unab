// Serialize each student's date/meal across automatic and manual entry points.
function createReservationService(callApi) {
  const pending = new Map();

  async function reserve(
    token,
    programming,
    date,
    meal,
    canProceed = () => true,
    requestOptions
  ) {
    const query = `/reservas/me?fecha=${encodeURIComponent(date)}`;
    const existing = await callApi(query, token, requestOptions);
    if (!existing.ok || !Array.isArray(existing.data?.data)) {
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
      ...requestOptions,
      method: 'POST',
      body: JSON.stringify({ programacionId: programming }),
      canProceed
    });
    if (result.ok && result.data?.success && result.data.data?.id)
      return result;
    // A lost response can still mean the upstream committed the reservation.
    const check = await callApi(query, token, requestOptions);
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

  return async function reserveOnce(
    userId,
    token,
    programming,
    date,
    meal,
    canProceed,
    requestOptions
  ) {
    meal = meal.toUpperCase();
    const key = JSON.stringify([userId, date, meal]);
    if (pending.has(key)) return pending.get(key);
    const operation = reserve(
      token,
      programming,
      date,
      meal,
      canProceed,
      requestOptions
    );
    pending.set(key, operation);
    try {
      return await operation;
    } finally {
      pending.delete(key);
    }
  };
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
