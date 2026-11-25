
import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { Interface, getAddress, isAddress } from "ethers";

const artistInput = process.env.ARTIST_WALLET;
const confirmGrant = process.env.CONFIRM_GRANT === "YES";

if (!artistInput || !isAddress(artistInput)) {
  throw new Error(
    "Set ARTIST_WALLET to your public Artist wallet address."
  );
}

const artistAddress = getAddress(artistInput);

// Read the existing Sepolia deployment and contract ABI.
const deployments = JSON.parse(
  readFileSync(
    new URL(
      "../ignition/deployments/chain-11155111/deployed_addresses.json",
      import.meta.url
    ),
    "utf8"
  )
);

const matches = Object.entries(deployments).filter(
  ([name, value]) =>
    name.endsWith("#MusicAccessControl") &&
    typeof value === "string" &&
    isAddress(value)
);

if (matches.length !== 1) {
  throw new Error("Could not identify one Sepolia contract.");
}

const contractAddress = getAddress(matches[0][1] as string);

const artifact = JSON.parse(
  readFileSync(
    new URL(
      "../artifacts/contracts/MusicAccessControl.sol/MusicAccessControl.json",
      import.meta.url
    ),
    "utf8"
  )
);

const iface = new Interface(artifact.abi);

// This script supports the standard AccessControl interface.
for (const name of [
  "ARTIST_ROLE",
  "getRoleAdmin",
  "hasRole",
  "grantRole"
]) {
  if (!iface.hasFunction(name)) {
    throw new Error(
      `Contract does not expose ${name}. Stop and inspect its role interface.`
    );
  }
}

const { provider } = await network.create();

const chainIdHex = (await provider.request({
  method: "eth_chainId"
})) as string;

if (BigInt(chainIdHex) !== 11155111n) {
  throw new Error("Wrong network. Expected Ethereum Sepolia.");
}

const code = (await provider.request({
  method: "eth_getCode",
  params: [contractAddress, "latest"]
})) as string;

if (code === "0x") {
  throw new Error("Contract not found on Sepolia.");
}

const accounts = (await provider.request({
  method: "eth_accounts"
})) as string[];

if (!accounts.length) {
  throw new Error("No deployment account configured in Hardhat.");
}

const deployer = getAddress(accounts[0]);

async function readContract(
  functionName: string,
  args: unknown[] = []
) {
  const data = iface.encodeFunctionData(functionName, args);

  const result = (await provider.request({
    method: "eth_call",
    params: [{ to: contractAddress, data }, "latest"]
  })) as string;

  return iface.decodeFunctionResult(functionName, result);
}

const artistRole = (await readContract("ARTIST_ROLE"))[0];
const adminRole = (await readContract("getRoleAdmin", [artistRole]))[0];

const artistAlreadyGranted = (await readContract(
  "hasRole",
  [artistRole, artistAddress]
))[0];

const deployerIsAdmin = (await readContract(
  "hasRole",
  [adminRole, deployer]
))[0];

console.log("\n=== SEPOLIA ARTIST ROLE CHECK ===");
console.log("Chain ID:", 11155111);
console.log("Contract:", contractAddress);
console.log("Deployment account:", deployer);
console.log("Artist account:", artistAddress);
console.log("Artist already authorized:", artistAlreadyGranted);
console.log("Deployer can administer Artist role:", deployerIsAdmin);

if (artistAlreadyGranted) {
  console.log("\nPASS: Artist role is already granted.");
} else if (!deployerIsAdmin) {
  throw new Error(
    "Deployment account is not an administrator of ARTIST_ROLE."
  );
} else {
  const transactionData = iface.encodeFunctionData(
    "grantRole",
    [artistRole, artistAddress]
  );

  // Read-only preflight: estimate transaction gas.
  const estimatedGas = await provider.request({
    method: "eth_estimateGas",
    params: [{
      from: deployer,
      to: contractAddress,
      data: transactionData
    }]
  });

  console.log("Estimated gas:", BigInt(estimatedGas as string).toString());

  if (!confirmGrant) {
    console.log("\nDRY RUN PASSED.");
    console.log("No transaction was sent.");
    console.log("Set CONFIRM_GRANT=YES to grant the role.");
  } else {
    const hash = (await provider.request({
      method: "eth_sendTransaction",
      params: [{
        from: deployer,
        to: contractAddress,
        data: transactionData
      }]
    })) as string;

    console.log("\nRole grant transaction submitted.");
    console.log("Transaction hash:", hash);
    console.log(
      "Explorer: https://sepolia.etherscan.io/tx/" + hash
    );
    console.log(
      "Check the receipt, then rerun without CONFIRM_GRANT to verify."
    );
  }
}
