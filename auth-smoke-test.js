// Automated demonstration of wallet challenge/response.
// Use a newly generated temporary test wallet; never use a real wallet/private key here.
'use strict';
const { Wallet } = require('ethers');
const BASE = 'http://127.0.0.1:3000';

async function request(path, method = 'GET', data, cookie) {
  const headers = { Origin: BASE };
  if (data) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(BASE + path, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined
  });
  const body = await response.json();
  return { response, body };
}

async function main() {
  const wallet = Wallet.createRandom();
  const intruder = Wallet.createRandom();
  const protectedBefore = await request('/api/protected-demo');
  if (protectedBefore.response.status !== 401) throw Error('Protected route was not protected.');
  console.log('PASS: protected route blocks anonymous request');

  const first = await request('/api/auth/challenge', 'POST', {
    address: wallet.address, chainId: '0xaa36a7'
  });
  if (first.response.status !== 200) throw Error('Could not request a challenge.');
  const invalid = await request('/api/auth/verify', 'POST', {
    nonce: first.body.nonce,
    signature: await intruder.signMessage(first.body.message)
  });
  if (invalid.response.status !== 401) throw Error('Different wallet signature was accepted.');
  console.log('PASS: wrong-wallet signature rejected');

  const second = await request('/api/auth/challenge', 'POST', {
    address: wallet.address, chainId: '0xaa36a7'
  });
  if (second.response.status !== 200) throw Error('Could not request second challenge.');
  const signature = await wallet.signMessage(second.body.message);
  const success = await request('/api/auth/verify', 'POST', {
    nonce: second.body.nonce, signature
  });
  if (success.response.status !== 200 || !success.body.authenticated)
    throw Error('Valid signature was rejected.');
  console.log('PASS: correct wallet signature verified');

  const reused = await request('/api/auth/verify', 'POST', {
    nonce: second.body.nonce, signature
  });
  if (reused.response.status !== 401) throw Error('Replay signature was accepted.');
  console.log('PASS: replayed challenge rejected');

  const cookie = success.response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw Error('Session cookie not returned.');
  const protectedAfter = await request('/api/protected-demo', 'GET', undefined, cookie);
  if (protectedAfter.response.status !== 200)
    throw Error('Authenticated session was not accepted.');
  console.log('PASS: authenticated session accesses protected route');

  const signedOut = await request('/api/auth/logout', 'POST', undefined, cookie);
  if (signedOut.response.status !== 200) throw Error('Logout failed.');
  const protectedFinal = await request('/api/protected-demo', 'GET', undefined, cookie);
  if (protectedFinal.response.status !== 401) throw Error('Logged-out session still works.');
  console.log('PASS: logout invalidates the session');
  console.log('\nAll six authentication smoke tests passed.');
}

main().catch(error => {
  console.error('TEST FAILED:', error.message);
  process.exitCode = 1;
});
