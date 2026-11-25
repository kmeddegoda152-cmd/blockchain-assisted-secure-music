
'use strict';

const $ = (id) => document.getElementById(id);

// Functions from our MusicAccessControl Solidity contract
const CONTRACT_ABI = [
  'function ARTIST_ROLE() view returns (bytes32)',
  'function hasRole(bytes32,address) view returns (bool)',
  'function registerTrack(bytes32,bytes32)',
  'function grantAccess(bytes32,address)',
  'function revokeAccess(bytes32,address)',
  'function checkAccess(bytes32,address) view returns (bool)',
  'function tracks(bytes32) view returns (address,bytes32,bool)'
];

const actionButtons = [
  'registerTrack',
  'uploadEncrypted',
  'grantAccess',
  'checkAccess',
  'revokeAccess'
];

let musicAppNetworkPromise;

function loadMusicAppNetwork() {
  if (!musicAppNetworkPromise) {
    musicAppNetworkPromise = fetch("/api/network", {
      credentials: "same-origin",
      cache: "no-store"
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error("Cannot load blockchain configuration");
      }

      const config = await response.json();

      if (
        !config.chainId ||
        !config.contractAddress ||
        !config.network
      ) {
        throw new Error("Incomplete blockchain configuration");
      }

      return config;
    }).catch((error) => {
      musicAppNetworkPromise = undefined;
      throw error;
    });
  }

  return musicAppNetworkPromise;
}

async function requireCorrectMusicChain() {
  if (!window.ethereum) {
    throw new Error("MetaMask is not installed");
  }

  const config = await loadMusicAppNetwork();

  const currentChainId = await window.ethereum.request({
    method: "eth_chainId"
  });

  if (BigInt(currentChainId) !== BigInt(config.chainId)) {
    throw new Error(
      `Wrong MetaMask network. Please select ${config.network}.`
    );
  }

  return config;
}

if (window.ethereum) {
  window.ethereum.on("chainChanged", () => {
    window.location.reload();
  });
}

function showResult(message) {
  $('actionStatus').textContent = message;
}

function setBusy(busy) {
  for (const id of actionButtons) {
    const button = document.getElementById(id);

    if (button) {
      button.disabled = busy;
    }
  }
}

// Verify the current user and blockchain before every action
async function getContract(requireArtist = false) {

  if (!window.ethereum) {
    throw new Error('MetaMask is not installed.');
  }

  if (!window.ethers) {
    throw new Error('Ethers.js browser library did not load.');
  }

  const response = await fetch(
    '/api/blockchain/status',
    {
      credentials: 'same-origin',
      cache: 'no-store'
    }
  );

  const status = await response.json();

  if (!response.ok) {
    throw new Error(status.error || 'Please sign in again.');
  }

  const accounts = await window.ethereum.request({
    method: 'eth_accounts'
  });

  if (!accounts.length) {
    throw new Error('Connect your MetaMask wallet first.');
  }

  const selectedAccount = accounts[0];

  if (
    selectedAccount.toLowerCase() !==
    status.wallet.toLowerCase()
  ) {
    throw new Error(
      'MetaMask account differs from your signed-in wallet.'
    );
  }

  const chainHex = await window.ethereum.request({
    method: 'eth_chainId'
  });

  if (BigInt(chainHex) !== BigInt(status.chainId)) {
  throw new Error(
    `Wrong MetaMask network. Your wallet is on chain ${BigInt(chainHex).toString()}, ` +
    `but the backend requires chain ${status.chainId}.`
  );
}

  if (requireArtist && !status.artistRole) {
    throw new Error(
      'This wallet does not have the Artist role.'
    );
  }

  const provider = new ethers.BrowserProvider(
    window.ethereum
  );

  const signer = await provider.getSigner();

  const signerAddress = await signer.getAddress();

  if (
    signerAddress.toLowerCase() !==
    status.wallet.toLowerCase()
  ) {
    throw new Error('Wallet account changed. Sign in again.');
  }

  const contract = new ethers.Contract(
    status.contractAddress,
    CONTRACT_ABI,
    signer
  );

  return { status, contract };
}

async function refreshBlockchainStatus() {
  try {
    const { status } = await getContract();

    $('chainStatus').textContent = [
      'Network: ' + status.network,
      'Chain ID: ' + status.chainId,
      'Wallet: ' + status.wallet,
      'Contract: ' + status.contractAddress,
      'Artist Role: ' + (status.artistRole ? 'YES' : 'NO')
    ].join('\n');

  } catch (error) {
    $('chainStatus').textContent =
      'Connection check failed: ' + error.message;
  }
}

function getTrackId() {
  const id = $('trackId').value.trim();

  if (!ethers.isHexString(id, 32)) {
    throw new Error('Enter a valid 32-byte Track ID.');
  }

  return id;
}

function getCollaboratorAddress() {
  return ethers.getAddress(
    $('collaboratorWallet').value.trim()
  );
}

// Create a SHA-256 digest of the selected audio file
async function hashFile(file) {
  const fileBytes = await file.arrayBuffer();

  const digest = await crypto.subtle.digest(
    'SHA-256',
    fileBytes
  );

  const hex = Array.from(
    new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, '0')
  ).join('');

  return '0x' + hex;
}

async function registerMusicTrack() {
  const file = $('audioFile').files[0];

  if (!file) {
    showResult('Please select an audio file first.');
    return;
  }

  if (file.size === 0 || file.size > 20 * 1024 * 1024) {
    showResult('Select a non-empty file under 20 MB.');
    return;
  }

  if (!/\.(mp3|wav|flac|ogg)$/i.test(file.name)) {
    showResult('Use a sample MP3, WAV, FLAC or OGG file.');
    return;
  }

  setBusy(true);

  try {
    const { status, contract } = await getContract(true);

    showResult('Calculating the file SHA-256 hash...');

    const fileHash = await hashFile(file);

    // Deterministic track ID for this artist and sample
    const trackId = ethers.id(
      status.wallet.toLowerCase() +
      '|' + file.name +
      '|' + fileHash
    );

    const existing = await contract.tracks(trackId);

    if (existing[2]) {
      throw new Error(
        'This track is already registered. Track ID: ' + trackId
      );
    }

    showResult(
      'File hash: ' + fileHash +
      '\nPlease approve the registration in MetaMask.'
    );

    const tx = await contract.registerTrack(
      trackId,
      fileHash
    );

    showResult(
      'Transaction submitted: ' + tx.hash +
      '\nWaiting for confirmation...'
    );

    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new Error('Registration transaction failed.');
    }

    $('trackId').value = trackId;

    showResult(
      'TRACK REGISTERED SUCCESSFULLY' +
      '\nTrack ID: ' + trackId +
      '\nSHA-256: ' + fileHash +
      '\nTransaction: ' + tx.hash
    );

  
} catch (error) {

  // Display the full error in Chrome's developer console
  console.error('FULL REGISTRATION ERROR:', error);

  // Try to find the original error from MetaMask
  const detailedMessage =
    error.info?.error?.message ||
    error.error?.message ||
    error.data?.message ||
    error.shortMessage ||
    error.message;

  showResult(
    'Registration failed: ' + detailedMessage
  );
}
finally {

    // Always re-enable buttons after registration
    setBusy(false);


}
}


async function uploadEncryptedTrack() {
  setBusy(true);

  try {
    const file = $('audioFile').files[0];

    if (!file) {
      throw new Error('Select the registered audio file.');
    }

    if (file.size < 128 || file.size > 20 * 1024 * 1024) {
      throw new Error('Use an audio file under 20 MB.');
    }

    const trackId = getTrackId();

    // Verify the current wallet has the Artist role
    await getContract(true);

    showResult(
      'Uploading audio securely to the local backend...'
    );

    const response = await fetch('/api/music/upload', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Track-Id': trackId
      },
      body: file
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Upload failed.');
    }

    showResult(
      'AUDIO ENCRYPTED SUCCESSFULLY' +
      '\nTrack ID: ' + data.trackId +
      '\nEncrypted SHA-256: ' + data.ciphertextSha256 +
      '\nStorage status: ENCRYPTED'
    );

  } catch (error) {
    showResult(
      'Encrypted upload failed: ' + error.message
    );
  } finally {
    setBusy(false);
  }
}


async function grantMusicAccess() {
  setBusy(true);

  try {
    const trackId = getTrackId();
    const collaborator = getCollaboratorAddress();

    const { contract } = await getContract(true);

    showResult('Approve the access grant in MetaMask.');

    const tx = await contract.grantAccess(
      trackId,
      collaborator
    );

    showResult(
      'Grant submitted: ' + tx.hash +
      '\nWaiting for confirmation...'
    );

    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new Error('Grant transaction failed.');
    }

    showResult(
      'ACCESS GRANTED' +
      '\nCollaborator: ' + collaborator +
      '\nTrack: ' + trackId +
      '\nTransaction: ' + tx.hash
    );

  } catch (error) {
    showResult(
      'Grant failed: ' +
      (error.shortMessage || error.message)
    );
  } finally {
    setBusy(false);
  }
}

async function checkMusicAccess() {
  setBusy(true);

  try {
    const trackId = getTrackId();
    const collaborator = getCollaboratorAddress();

    const { contract } = await getContract();

    const allowed = await contract.checkAccess(
      trackId,
      collaborator
    );

    showResult(
      'ACCESS CHECK' +
      '\nCollaborator: ' + collaborator +
      '\nPermission: ' + (allowed ? 'GRANTED' : 'DENIED')
    );

  } catch (error) {
    showResult(
      'Access check failed: ' +
      (error.shortMessage || error.message)
    );
  } finally {
    setBusy(false);
  }
}

async function revokeMusicAccess() {
  setBusy(true);

  try {
    const trackId = getTrackId();
    const collaborator = getCollaboratorAddress();

    const { contract } = await getContract(true);

    showResult('Approve the revocation in MetaMask.');

    const tx = await contract.revokeAccess(
      trackId,
      collaborator
    );

    showResult(
      'Revocation submitted: ' + tx.hash +
      '\nWaiting for confirmation...'
    );

    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new Error('Revocation transaction failed.');
    }

    showResult(
      'ACCESS REVOKED' +
      '\nCollaborator: ' + collaborator +
      '\nTrack: ' + trackId +
      '\nTransaction: ' + tx.hash
    );

  } catch (error) {
    showResult(
      'Revocation failed: ' +
      (error.shortMessage || error.message)
    );
  } finally {
    setBusy(false);
  }
}


// This is a playback-session reference, not a login token.
// The backend still requires the original authenticated session.
const PLAYBACK_SESSION_KEY = 'demoPlaybackSessionId';

async function startPlaybackSession() {
  const output = $('playbackTestStatus');

  try {
    // Verify MetaMask matches the authenticated wallet.
    await getContract(false);

    const trackId = getTrackId();

    output.textContent =
      'Checking blockchain playback permission...';

    const response = await fetch('/api/playback/start', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ trackId })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        response.status + ': ' + result.error
      );
    }

    sessionStorage.setItem(
      PLAYBACK_SESSION_KEY,
      result.sessionId
    );

    output.textContent = [
      'PLAYBACK SESSION AUTHORIZED',
      'Track: ' + result.trackId,
      'Session ID: ' + result.sessionId,
      'Expires: ' + result.expiresAt
    ].join('\n');

  } catch (error) {
    output.textContent =
      'Playback request denied: ' + error.message;
  }
}

async function recheckPlaybackSession() {
  const output = $('playbackTestStatus');

  try {
    await getContract(false);

    const sessionId = sessionStorage.getItem(
      PLAYBACK_SESSION_KEY
    );

    if (!sessionId) {
      throw new Error('Start a playback session first.');
    }

    const response = await fetch(
      '/api/playback/status/' + sessionId,
      {
        credentials: 'same-origin',
        cache: 'no-store'
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        response.status + ': ' + result.error
      );
    }

    output.textContent = [
      'PLAYBACK SESSION VALID',
      'Permission: GRANTED',
      'Track: ' + result.trackId,
      'Expires: ' + result.expiresAt
    ].join('\n');

  } catch (error) {
    output.textContent =
      'Playback check failed: ' + error.message;
  }
}



// Load audio through the protected backend endpoint.
async function loadAuthorizedAudio() {

  const output = $('audioPlaybackStatus');
  const player = $('secureAudioPlayer');

  try {
    // Confirm wallet still matches the login.
    await getContract(false);

    // Use the playback session created in Milestone 5A.
    const sessionId = sessionStorage.getItem(
      PLAYBACK_SESSION_KEY
    );

    if (
      !sessionId ||
      !/^[a-f0-9]{48}$/.test(sessionId)
    ) {
      throw new Error(
        'Request a playback session first.'
      );
    }

    output.textContent =
      'Checking playback authorization...';

    // Verify the session before loading the audio.
    const response = await fetch(
      '/api/playback/status/' + sessionId,
      {
        credentials: 'same-origin',
        cache: 'no-store'
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        response.status + ': ' + data.error
      );
    }

    // Point the HTML5 player to the protected route.
    // The browser sends the existing login cookie.
    player.src =
      '/api/playback/audio/' + sessionId;

    player.load();

    output.textContent =
      'AUDIO AUTHORIZED\n' +
      'Press Play on the audio player.';

  } catch (error) {

    player.pause();
    player.removeAttribute('src');
    player.load();

    output.textContent =
      'Audio unavailable: ' + error.message;
  }
}

// Handle browser playback errors.
$('secureAudioPlayer').addEventListener(
  'error',
  () => {
    $('audioPlaybackStatus').textContent =
      'Audio playback failed. Check the Network tab ' +
      'for the protected audio request.';
  }
);


// Connect buttons to their functions
$('refreshChain').addEventListener(
  'click', refreshBlockchainStatus
);

$('registerTrack').addEventListener(
  'click', registerMusicTrack
);

$('uploadEncrypted').addEventListener(
  'click', uploadEncryptedTrack
);

$('grantAccess').addEventListener(
  'click', grantMusicAccess
);

$('checkAccess').addEventListener(
  'click', checkMusicAccess
);

$('revokeAccess').addEventListener(
  'click', revokeMusicAccess
);

$('startPlaybackSession').addEventListener(
  'click',
  startPlaybackSession
);

$('checkPlaybackSession').addEventListener(
  'click',
  recheckPlaybackSession
);

$('loadAuthorizedAudio').addEventListener(
  'click',
  loadAuthorizedAudio
);

// Refresh after wallet or network changes
if (window.ethereum?.on) {
  window.ethereum.on(
    'accountsChanged',
    () => window.location.reload()
  );

  window.ethereum.on(
    'chainChanged',
    () => window.location.reload()
  );
}

refreshBlockchainStatus();
