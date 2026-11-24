const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {readKey, sealCredentials, openCredentials} = require('../credential-vault');

test('credential vault is randomized, authenticates the owner and rejects wrong keys or tampering', () => {
  const key = crypto.randomBytes(32);
  const user = { id:'student', username:'code', password:'private-password', unabToken:'private-token' };
  const sealed = sealCredentials(user, key);
  assert.ok(!JSON.stringify(sealed).includes('private-'));
  assert.notEqual(sealed.ciphertext, sealCredentials(user,key).ciphertext);
  assert.deepEqual(openCredentials(sealed,user,key), {password:user.password,token:user.unabToken});
  assert.equal(openCredentials(sealed,{...user,id:'other'},key),null);
  assert.equal(openCredentials(sealed,user,crypto.randomBytes(32)),null);
  const broken = {...sealed,tag:crypto.randomBytes(16).toString('base64')};
  assert.equal(openCredentials(broken,user,key),null);
  assert.equal(openCredentials({...sealed, version:2},user,key),null);
  assert.equal(readKey(''),null);
  assert.throws(()=>readKey('weak-key'),/32 bytes/);
  assert.deepEqual(readKey(key.toString('base64')),key);
});
