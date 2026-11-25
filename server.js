// Milestone 2: Local-only backend for verifying MetaMask signatures.
// For learning/testing; NOT a production-ready authentication system.
'use strict';

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const database = require('./database');
const {
  getAddress,
  verifyMessage,
  JsonRpcProvider,
  Contract
} = require('ethers');
const fs = require('node:fs');
const createMusicUploadRouter = require('./music-upload');
const createPlaybackRouter = require('./playback-auth');
const networkProfile = require("./network-profile.cjs");


const app = express();
app.get("/api/network", (_req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    network: networkProfile.network,
    chainId: networkProfile.chainId,
    contractAddress: networkProfile.contractAddress
  });
});
const HOST = '127.0.0.1';
const PORT = 3000;
const APP_ORIGIN = `http://${HOST}:${PORT}`;
const CHALLENGE_MS = 5 * 60 * 1000;  // 5 minutes
const SESSION_MS = 60 * 60 * 1000;   // 1 hour

// Stored in RAM for now. Restarting the server clears logins and challenges.
const challenges = new Map(); // nonce -> {address, message, expiresAt}
const sessions = new Map();   // sid -> {address, expiresAt}

app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  // Reject cross-origin POSTs. All browser requests should originate here.
  if (req.method === 'POST' && req.get('origin') !== APP_ORIGIN) {
    return res.status(403).json({ error: 'Request must come from the local app.' });
  }
  next();
});

// Serve ONLY approved frontend files; never expose server.js or config files.

// Serve only approved frontend files
for (const [route, filename, contentType] of [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/index.html', 'index.html', 'text/html; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
  ['/app.js', 'app.js', 'application/javascript; charset=utf-8'],
  ['/artist.html', 'artist.html', 'text/html; charset=utf-8'],
  ['/artist.js', 'artist.js', 'application/javascript; charset=utf-8'],
]) {
  app.get(route, (req, res) => {
    res.type(contentType).sendFile(
      path.join(__dirname, filename)
    );
  });
}

// Serve the locally installed Ethers.js browser library
app.get('/vendor/ethers.umd.min.js', (req, res) => {
  res.type('application/javascript');

  res.sendFile(
    path.join(
      __dirname,
      'node_modules',
      'ethers',
      'dist',
      'ethers.umd.min.js'
    )
  );
});


function cookieValue(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  const entry = cookies.map(c => c.trim()).find(c => c.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : null;
}

function currentSession(req) {
  const sid = cookieValue(req, 'music_sid');
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (Date.now() >= session.expiresAt) {
    sessions.delete(sid);
    return null;
  }
  return session;
}

app.post('/api/auth/challenge', (req, res) => {
  let address;
  try {
    address = getAddress(req.body?.address);
  } catch {
    return res.status(400).json({ error: 'Valid wallet address required.' });
  }

  const rawChainId = req.body?.chainId;
  if (typeof rawChainId !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(rawChainId)) {
    return res.status(400).json({ error: 'Invalid wallet network identifier.' });
  }

  const chainId = BigInt(rawChainId).toString(10);
  const now = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = now + CHALLENGE_MS;

  // Domain, URI, chain ID, nonce and expiry make this a purpose-bound challenge.
  const message = [
    'Secure Music dApp requests a sign-in using this Ethereum wallet.',
    `Domain: ${HOST}:${PORT}`,
    `URI: ${APP_ORIGIN}`,
    `Wallet: ${address}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued at: ${new Date(now).toISOString()}`,
    `Expires at: ${new Date(expiresAt).toISOString()}`,
    '',
    'Signing proves control of this wallet. It is free and sends no blockchain transaction.'
  ].join('\n');

  // Avoid unbounded growth from expired challenges during local testing.
  for (const [key, value] of challenges) {
    if (Date.now() >= value.expiresAt) challenges.delete(key);
  }
  challenges.set(nonce, { address, message, expiresAt });
  res.json({ nonce, message });
});

app.post('/api/auth/verify', (req, res) => {
  const { nonce, signature } = req.body || {};
  if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce) ||
      typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return res.status(400).json({ error: 'Missing or invalid signature details.' });
  }

  const challenge = challenges.get(nonce);
  if (!challenge) {
    return res.status(401).json({ error: 'Challenge not found or already used.' });
  }
  // Single-use even if signature fails.
  challenges.delete(nonce);
  if (Date.now() >= challenge.expiresAt) {
    return res.status(401).json({ error: 'Challenge has expired. Please try again.' });
  }

  try {
    const recovered = getAddress(verifyMessage(challenge.message, signature));
    if (recovered !== challenge.address) {
      return res.status(401).json({ error: 'The signature belongs to a different wallet.' });
    }
  } catch {
    return res.status(401).json({ error: 'Signature verification failed.' });
  }

  const sid = crypto.randomBytes(32).toString('hex');
  const existingSid = cookieValue(req, 'music_sid');
  if (existingSid) sessions.delete(existingSid);
  sessions.set(sid, { address: challenge.address, expiresAt: Date.now() + SESSION_MS });

  res.set('Set-Cookie', `music_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
  res.json({ authenticated: true, wallet: challenge.address });
});

app.get('/api/auth/me', (req, res) => {
  const session = currentSession(req);
  if (!session) return res.json({ authenticated: false });
  res.json({ authenticated: true, wallet: session.address });
});

app.post('/api/auth/logout', (req, res) => {
  const sid = cookieValue(req, 'music_sid');
  if (sid) sessions.delete(sid);
  res.set('Set-Cookie', 'music_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ authenticated: false });
});

app.get('/api/protected-demo', (req, res) => {
  const session = currentSession(req);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });
  res.json({ message: 'You accessed a protected backend route.', wallet: session.address });
});

// Encrypted music-upload API
app.use(
  '/api/music',
  createMusicUploadRouter({
    currentSession,
    getDatabase: database.getDatabase
  })
);

// Register the playback authorization API
app.use(
  '/api/playback',
  createPlaybackRouter({
    currentSession,
    getDatabase: database.getDatabase
  })
);

// Check that the authenticated application can use MongoDB
app.get('/api/database/health', async (req, res) => {

  // Require a valid wallet login session
  const session = currentSession(req);

  if (!session) {
    return res.status(401).json({
      error: 'Authentication required.'
    });
  }

  try {
    const db = database.getDatabase();

    // Send a real command to MongoDB
    const result = await db.command({ ping: 1 });

    res.json({
      connected: result.ok === 1,
      database: 'secure_music_dapp',
      message: 'Database connection successful'
    });

  } catch (error) {
    console.error('Database health error:', error);

    res.status(503).json({
      error: 'Database is unavailable.'
    });
  }
});



 // Check the real deployed blockchain contract
 app.get('/api/blockchain/status', async (req, res) => {

   // Only signed-in users can use this endpoint
   const session = currentSession(req);

   if (!session) {
     return res.status(401).json({
       error: 'Please sign in first.'
     });
   }

   try {


    // Use the blockchain selected in network-profile.cjs.
    // Hardhat Local = 31337; Ethereum Sepolia = 11155111.
    const contractAddress = networkProfile.contractAddress;

    if (!networkProfile.rpcUrl) {
      return res.status(503).json({
        error: 'Blockchain RPC URL is not configured.'
      });
    }

    // Connect to the selected blockchain.
    const provider = new JsonRpcProvider(networkProfile.rpcUrl);

    // Verify the RPC is connected to the expected chain.
    const network = await provider.getNetwork();

    if (network.chainId !== BigInt(networkProfile.chainId)) {
      return res.status(503).json({
        error: 'Blockchain RPC network does not match the configured chain.'
      });
    }


     // Make sure the contract still exists on this node
     const bytecode = await provider.getCode(
       contractAddress
     );

     if (bytecode === '0x') {
       return res.status(503).json({
         error: 'No deployed contract found on the configured blockchain.'
       });
     }

     // Functions we need to read from the contract
     const contractABI = [
       'function ARTIST_ROLE() view returns (bytes32)',
       'function hasRole(bytes32 role, address account) view returns (bool)'
     ];

     const contract = new Contract(
       contractAddress,
       contractABI,
       provider
     );

     // Check whether the logged-in wallet has Artist role
     const artistRole = await contract.ARTIST_ROLE();

     const isArtist = await contract.hasRole(
       artistRole,
       session.address
     );

     res.json({
       network: networkProfile.network === 'sepolia'
  ? 'Sepolia'
  : 'Hardhat Local',
       chainId: Number(network.chainId),
       contractAddress,
       wallet: session.address,
       artistRole: isArtist
     });

   } catch (error) {
     console.error('Blockchain status error:', error);

     res.status(503).json({
       error: 'Could not read blockchain status. Check the configured RPC and contract deployment.'
     });
   }
 });


app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON request.' });
  }
  console.error('Server error:', error.message);
  res.status(500).json({ error: 'Unexpected server error.' });
});


if (require.main === module) {

  // Connect to MongoDB before starting the web server
  database.connectDatabase()

    .then(() => {

      app.listen(PORT, HOST, () => {
        console.log('Secure Music dApp running!');
        console.log('Web application:', APP_ORIGIN);
        console.log('MongoDB: Connected');
      });

    })

    .catch((error) => {

      console.error(
        'Failed to connect to MongoDB:',
        error.message
      );

      process.exitCode = 1;
    });
}


module.exports = app;
