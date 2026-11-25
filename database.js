
'use strict';

const { MongoClient } = require('mongodb');

// Local MongoDB connection
const MONGO_URI = 'mongodb://127.0.0.1:27017';

// Our project database
const DATABASE_NAME = 'secure_music_dapp';

const client = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 5000
});

let db;

// Connect to MongoDB
async function connectDatabase() {
  await client.connect();

  db = client.db(DATABASE_NAME);

  // Verify the connection
  await db.command({ ping: 1 });

  console.log('MongoDB connected successfully!');
  console.log('Database:', DATABASE_NAME);

  // Prevent duplicate blockchain track IDs
  
await db.collection('tracks').createIndex(
  { chainId: 1, trackId: 1 },
  { unique: true, name: 'uniq_chain_track' }
);


  return db;
}

// Access the connected database
function getDatabase() {
  if (!db) {
    throw new Error('Database is not connected.');
  }

  return db;
}

module.exports = {
  connectDatabase,
  getDatabase
};
