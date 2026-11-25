'use strict';

const connectWalletButton = document.getElementById('connectWallet');
const signInButton = document.getElementById('signIn');
const testProtectedButton = document.getElementById('testProtected');
const signOutButton = document.getElementById('signOut');
const walletStatus = document.getElementById('walletStatus');
const authStatus = document.getElementById('authStatus');
const testStatus = document.getElementById('testStatus');

let currentAddress = null;

async function api(path, method = 'GET', data) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

function shortAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function resetLoginUI(message = 'Not authenticated') {
  authStatus.textContent = message;
  authStatus.className = '';
  testProtectedButton.disabled = true;
  signOutButton.hidden = true;
  signInButton.disabled = !currentAddress;
  testStatus.textContent = '';
}

async function connectWallet() {
  if (!window.ethereum) {
    walletStatus.textContent = 'MetaMask is not installed in this browser.';
    return;
  }

  connectWalletButton.disabled = true;
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts?.length) throw new Error('No wallet account selected.');
    currentAddress = accounts[0];
    walletStatus.textContent = `Connected: ${shortAddress(currentAddress)}`;
    signInButton.disabled = false;
    await refreshLoginStatus();
  } catch (error) {
    walletStatus.textContent = error.code === 4001
      ? 'Wallet connection was cancelled.'
      : `Connection failed: ${error.message}`;
  } finally {
    connectWalletButton.disabled = false;
  }
}

// MetaMask personal_sign expects UTF-8 message bytes encoded as hex.
function utf8ToHex(message) {
  return '0x' + Array.from(new TextEncoder().encode(message))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function signIn() {
  if (!currentAddress || !window.ethereum) return;
  signInButton.disabled = true;
  authStatus.textContent = 'Preparing a one-time login challenge...';
  try {
    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
    const { nonce, message } = await api('/api/auth/challenge', 'POST', {
      address: currentAddress,
      chainId
    });

    authStatus.textContent = 'Please review and sign the MetaMask message...';
    const signature = await window.ethereum.request({
      method: 'personal_sign',
      params: [utf8ToHex(message), currentAddress]
    });

    const result = await api('/api/auth/verify', 'POST', { nonce, signature });
    authStatus.textContent = `Authenticated as ${shortAddress(result.wallet)}`;
    authStatus.className = 'success';
    testProtectedButton.disabled = false;
    signOutButton.hidden = false;
  } catch (error) {
    resetLoginUI(error.code === 4001
      ? 'You cancelled the signature request. Try again when ready.'
      : `Sign-in failed: ${error.message}`);
  } finally {
    // Keep Sign In available only when not logged in.
    if (signOutButton.hidden) signInButton.disabled = !currentAddress;
  }
}

async function refreshLoginStatus() {
  try {
    const session = await api('/api/auth/me');
    if (session.authenticated && currentAddress &&
        session.wallet.toLowerCase() === currentAddress.toLowerCase()) {
      authStatus.textContent = `Authenticated as ${shortAddress(session.wallet)}`;
      authStatus.className = 'success';
      signInButton.disabled = true;
      testProtectedButton.disabled = false;
      signOutButton.hidden = false;
      return;
    }
  } catch (error) {
    console.error(error);
  }
  resetLoginUI();
}

async function testProtectedRoute() {
  testProtectedButton.disabled = true;
  try {
    const result = await api('/api/protected-demo');
    testStatus.textContent = result.message;
    testStatus.className = 'success';
  } catch (error) {
    testStatus.textContent = error.message;
    testStatus.className = '';
  } finally {
    testProtectedButton.disabled = false;
  }
}

async function signOut() {
  try {
    await api('/api/auth/logout', 'POST');
    resetLoginUI('Signed out successfully.');
  } catch (error) {
    authStatus.textContent = `Sign-out failed: ${error.message}`;
  }
}

connectWalletButton.addEventListener('click', connectWallet);
signInButton.addEventListener('click', signIn);
testProtectedButton.addEventListener('click', testProtectedRoute);
signOutButton.addEventListener('click', signOut);

// If the user switches wallet accounts or networks, clear the old login.
if (window.ethereum?.on) {
  const handleWalletChange = async () => {
    try { await api('/api/auth/logout', 'POST'); } catch (_) {}
    currentAddress = null;
    walletStatus.textContent = 'Wallet changed. Connect again.';
    resetLoginUI('Please sign in again with the new wallet/network.');
  };
  window.ethereum.on('accountsChanged', handleWalletChange);
  window.ethereum.on('chainChanged', handleWalletChange);
}

// Show any existing login after a refresh only once the wallet is reconnected.
refreshLoginStatus();
