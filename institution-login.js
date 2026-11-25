// The identity provider may wrap its successful response in data/result.
// HTTP 201 alone never establishes an authenticated session.
function extractToken(data) {
  if (!data || typeof data !== 'object') return null;
  for (const value of [data, data.data, data.result, data.data?.data]) {
    if (!value || typeof value !== 'object') continue;
    for (const field of ['accessToken', 'access_token', 'token']) {
      const token = value[field];
      if (typeof token === 'string' && token.trim() && !/\s/.test(token.trim())) return token.trim();
    }
  }
  return null;
}

function credentialsRejected(data) {
  if (!data || typeof data !== 'object') return false;
  const values = [data, data.data, data.error].filter(value => value && typeof value === 'object');
  return values.some(value => ['code', 'errorCode', 'message', 'error', 'detail'].some(field => {
    if (typeof value[field] !== 'string') return false;
    const message = value[field].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return /invalid_credentials|invalid_password|bad_credentials|wrong_password|user_not_found/.test(message) ||
      /credenciales.{0,35}(incorrect|invalid|no.{0,8}valid)|(?:password|contrasena).{0,35}(incorrect|invalid)|(?:incorrect|invalid).{0,25}(?:password|credential)|usuario.{0,25}no (?:existe|encontrado)/.test(message);
  }));
}

async function loginInstitution(request, username, password, options = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (options.canProceed && !options.canProceed()) return { success: false, status: 409, error: 'Preparación cancelada.' };
    const response = await request('https://api-login-dev.unab.edu.pe/auth/login', {
      ...options,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer',
        Origin: 'https://login-dev.unab.edu.pe',
        Referer: 'https://login-dev.unab.edu.pe/'
      },
      body: JSON.stringify({ UserName: username, userspassunab: password })
    });
    if (credentialsRejected(response.data)) return { success: false, status: 401, code: 'CREDENTIALS_REJECTED', error: 'La institución indicó que las credenciales son incorrectas. Actualiza tu acceso institucional.' };
    if (!response.ok) return { success: false, status: response.status, code: 'AUTHENTICATION_UNCONFIRMED', error: 'La institución no pudo confirmar el acceso en este momento.' };
    const token = extractToken(response.data);
    if (token) return { success: true, token };
    if (attempt === 1) return {
      success: false, status: response.status, code: 'MISSING_SESSION_TOKEN',
      error: 'La institución respondió sin un token de sesión. No se consultaron cupos ni se dio la reserva por agotada.'
    };
  }
}

module.exports = { extractToken, loginInstitution, credentialsRejected };
