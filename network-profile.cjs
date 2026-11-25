
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Keep Hardhat Local as the default network.
const selectedNetwork = (
  process.env.MUSIC_CHAIN || "local"
).trim().toLowerCase();

const networks = {
  local: {
    chainId: 31337,
    deploymentFolder: "chain-31337",
    rpcUrl: "http://127.0.0.1:8545"
  },

  sepolia: {
    chainId: 11155111,
    deploymentFolder: "chain-11155111",
    rpcUrl: process.env.SEPOLIA_RPC_URL || ""
  }
};

if (!Object.hasOwn(networks, selectedNetwork)) {
  throw new Error(
    `Unsupported blockchain network: ${selectedNetwork}`
  );
}

const settings = networks[selectedNetwork];

const deploymentFile = path.join(
  __dirname,
  "blockchain",
  "ignition",
  "deployments",
  settings.deploymentFolder,
  "deployed_addresses.json"
);

if (!fs.existsSync(deploymentFile)) {
  throw new Error(
    `Deployment file not found: ${deploymentFile}`
  );
}

const deployments = JSON.parse(
  fs.readFileSync(deploymentFile, "utf8")
);

const matches = Object.entries(deployments).filter(
  ([name, address]) =>
    name.endsWith("#MusicAccessControl") &&
    /^0x[a-fA-F0-9]{40}$/.test(address)
);

if (matches.length !== 1) {
  throw new Error(
    "Expected exactly one MusicAccessControl deployment."
  );
}

module.exports = Object.freeze({
  network: selectedNetwork,
  chainId: settings.chainId,
  rpcUrl: settings.rpcUrl,
  contractAddress: matches[0][1],
  deploymentFile
});
