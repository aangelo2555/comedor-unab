const crypto = require('node:crypto');

function readKey(value = process.env.INSTITUTION_CREDENTIAL_KEY) {
  if (!value) return null;
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value)
    throw new Error('INSTITUTION_CREDENTIAL_KEY debe contener 32 bytes aleatorios en Base64.');
  return key;
}

function sealCredentials(user, key = readKey()) {
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify([user.id, user.username])));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ password: user.password || '', token: user.unabToken || '' })),
    cipher.final()
  ]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function openCredentials(record, user, key = readKey()) {
  if (!key || !record || record.version !== 1) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify([user.id, user.username])));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    const data = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()
    ]).toString('utf8'));
    return typeof data.password === 'string' && typeof data.token === 'string' ? data : null;
  } catch { return null; }
}
module.exports = { readKey, sealCredentials, openCredentials };
