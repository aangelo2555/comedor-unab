const TERMS_VERSION = '2026-11-20';

function servicePolicy() {
  const operator = (process.env.SERVICE_OPERATOR || '').trim();
  const contact = (process.env.SERVICE_CONTACT_EMAIL || '').trim();
  const ready = Boolean(operator && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact));
  return {
    termsVersion: TERMS_VERSION,
    operator,
    contact,
    ready,
    integrationEnabled: ready && process.env.INSTITUTION_INTEGRATION_AUTHORIZED === 'true',
    contributionsEnabled: ready && process.env.VOLUNTARY_CONTRIBUTIONS_ENABLED === 'true',
    yape: ready && process.env.VOLUNTARY_CONTRIBUTIONS_ENABLED === 'true'
      ? (process.env.CONTRIBUTION_YAPE || '').trim() : ''
  };
}

module.exports = { TERMS_VERSION, servicePolicy };
