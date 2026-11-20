const crypto = require('node:crypto');
const { MEALS } = require('./premium-service');
const OFFER = Object.freeze({ amount: 9, currency: 'PEN', yape: '923887478' });

function createPaymentRequest(body, previous) {
  if (
    !Array.isArray(body.meals) ||
    body.meals.length === 0 ||
    body.meals.some((meal) => !MEALS.includes(meal))
  ) {
    throw new Error('Selecciona al menos un servicio válido.');
  }
  const reference =
    typeof body.reference === 'string' ? body.reference.trim() : '';
  if (reference && (reference.length < 3 || reference.length > 80))
    throw new Error('El número de operación de Yape debe tener entre 3 y 80 caracteres.');
  return {
    id: previous?.status === 'PENDING' ? previous.id : crypto.randomUUID(),
    status: 'PENDING',
    meals: [...new Set(body.meals)],
    reference: reference || (previous?.status === 'PENDING' ? previous.reference || '' : ''),
    ...OFFER,
    createdAt:
      previous?.status === 'PENDING'
        ? previous.createdAt
        : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

module.exports = { OFFER, createPaymentRequest };
