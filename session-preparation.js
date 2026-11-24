const { mapWithConcurrency } = require('./reservation-service');
const WARMUP_LEAD_MS = 5 * 60 * 1000;
const REFRESH_LEAD_MS = 60 * 1000;
const SESSION_RESERVATION_MARGIN_MS = 2 * 60 * 1000;
const PUBLICATION_POLL_MS = 250;

async function prepareSessions(
  users,
  {
    getToken,
    canProceed,
    targetTs,
    isExpired,
    verifyRemote = true,
    now = Date.now
  }
) {
  const results = await mapWithConcurrency(users, 2, async (user) => {
    if (!canProceed()) return false;
    const minimumValidityMs = Math.max(
      SESSION_RESERVATION_MARGIN_MS,
      targetTs - now() + SESSION_RESERVATION_MARGIN_MS
    );
    const token = await getToken(
      user,
      verifyRemote,
      { skipProfile: true },
      minimumValidityMs
    );
    return Boolean(token && !isExpired(token, minimumValidityMs));
  });
  return { total: results.length, ready: results.filter(Boolean).length };
}

module.exports = {
  WARMUP_LEAD_MS,
  REFRESH_LEAD_MS,
  PUBLICATION_POLL_MS,
  prepareSessions
};
