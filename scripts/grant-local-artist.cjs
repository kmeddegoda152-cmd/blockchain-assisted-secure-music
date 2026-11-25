
const fs = require("node:fs");
const path = require("node:path");

const {
  JsonRpcProvider,
  Contract,
  getAddress,
  parseEther
} = require("ethers");

async function main() {
  // Get the MetaMask wallet address from the command line.
  const inputAddress = process.argv[2];

  if (!inputAddress) {
    throw new Error(
      "Provide your MetaMask public address."
    );
  }

  const artistAddress = getAddress(inputAddress);

  // Connect ONLY to the local development blockchain.
  const provider = new JsonRpcProvider(
    "http://127.0.0.1:8545"
  );

  const network = await provider.getNetwork();

  if (network.chainId !== 31337n) {
    throw new Error("Not connected to Hardhat Local.");
  }

  // Read the actual deployed contract address.
  const deploymentPath = path.join(
    __dirname,
    "..",
    "blockchain",
    "ignition",
    "deployments",
    "chain-31337",
    "deployed_addresses.json"
  );

  const deployments = JSON.parse(
    fs.readFileSync(deploymentPath, "utf8")
  );

  const contractAddress =
    deployments["MusicAccessModule#MusicAccessControl"];

  if (!contractAddress) {
    throw new Error("Contract deployment not found.");
  }

  const bytecode = await provider.getCode(contractAddress);

  if (bytecode === "0x") {
    throw new Error(
      "Contract missing. Redeploy to the running local node."
    );
  }

  // Hardhat's first unlocked development account
  // should be the account used for deployment.
  const admin = await provider.getSigner(0);
  const adminAddress = await admin.getAddress();

  const abi = [
    "function ARTIST_ROLE() view returns (bytes32)",
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function grantRole(bytes32,address)"
  ];

  const contract = new Contract(
    contractAddress,
    abi,
    admin
  );

  const artistRole = await contract.ARTIST_ROLE();
  const adminRole = await contract.DEFAULT_ADMIN_ROLE();

  const isAdmin = await contract.hasRole(
    adminRole,
    adminAddress
  );

  if (!isAdmin) {
    throw new Error(
      "The first Hardhat account is not this contract's admin."
    );
  }

  console.log("Contract:", contractAddress);
  console.log("Admin:", adminAddress);
  console.log("Artist:", artistAddress);

  // Grant the Artist role only if not already granted.
  const alreadyArtist = await contract.hasRole(
    artistRole,
    artistAddress
  );

  if (!alreadyArtist) {
    const tx = await contract.grantRole(
      artistRole,
      artistAddress
    );

    console.log("Grant transaction:", tx.hash);

    await tx.wait();
  }

  // Give the wallet some local TEST ETH for gas.
  // This is NOT real ETH.
  const balance = await provider.getBalance(artistAddress);

  if (balance < parseEther("0.05")) {
    const fundingTx = await admin.sendTransaction({
      to: artistAddress,
      value: parseEther("0.1")
    });

    await fundingTx.wait();
  }

  const confirmed = await contract.hasRole(
    artistRole,
    artistAddress
  );

  console.log("Artist role assigned:", confirmed);
  console.log(
    "Local test ETH:",
    (await provider.getBalance(artistAddress)).toString(),
    "wei"
  );
}

main().catch((error) => {
  console.error("Setup failed:", error.message);
  process.exitCode = 1;
});
