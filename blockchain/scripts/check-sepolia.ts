
import { network } from "hardhat";

const { provider } = await network.connect();

const chainIdHex = await provider.request({
  method: "eth_chainId",
});

const chainId = Number(BigInt(chainIdHex as string));

console.log("Connected chain ID:", chainId);

if (chainId !== 11155111) {
  throw new Error("Wrong network! Expected Ethereum Sepolia.");
}

const accounts = await provider.request({
  method: "eth_accounts",
}) as string[];

if (accounts.length === 0) {
  throw new Error("No deployment wallet configured.");
}

const address = accounts[0];

console.log("Deployment wallet:", address);

const balanceHex = await provider.request({
  method: "eth_getBalance",
  params: [address, "latest"],
});

const balance = Number(BigInt(balanceHex as string)) / 1e18;

console.log("Sepolia ETH balance:", balance);

console.log("Read-only Sepolia connection check completed.");
