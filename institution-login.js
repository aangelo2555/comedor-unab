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
    if (!response.ok) return { success: false, status: response.status, error: 'La institución no confirmó el acceso. Verifica tus credenciales o inténtalo de nuevo.' };
    const token = extractToken(response.data);
    if (token) return { success: true, token };
    if (attempt === 1) return {
      success: false, status: response.status, code: 'MISSING_SESSION_TOKEN',
      error: 'La institución respondió sin un token de sesión. No se consultaron cupos ni se dio la reserva por agotada.'
    };
  }
}

module.exports = { extractToken, loginInstitution };
