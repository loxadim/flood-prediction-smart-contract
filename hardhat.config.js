import { defineConfig, configVariable } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import hardhatUpgrades from "@openzeppelin/hardhat-upgrades";
import "dotenv/config";

// Use env var if set, otherwise fall back to keystore
const envOrVar = (name) => process.env[name] ? process.env[name] : configVariable(name);

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers, hardhatUpgrades],
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainId: 1337,
      hardfork: "cancun",
      blockGasLimit: 60_000_000,
      allowUnlimitedContractSize: false,
    },
    localhost: {
      type: "http",
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      accounts: [envOrVar("PRIVATE_KEY")],
    },
    // Polygon Mainnet
    polygon: {
      type: "http",
      url: envOrVar("POLYGON_RPC_URL"),
      chainId: 137,
      accounts: [envOrVar("PRIVATE_KEY")],
      gasPrice: 50000000000, // 50 gwei
    },
    // Polygon Amoy Testnet
    amoy: {
      type: "http",
      url: envOrVar("AMOY_RPC_URL"),
      chainId: 80002,
      accounts: [envOrVar("PRIVATE_KEY")],
    },
    // Ethereum Sepolia
    sepolia: {
      type: "http",
      url: envOrVar("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      accounts: [envOrVar("PRIVATE_KEY")],
    },
    // Arbitrum Sepolia
    arbitrumSepolia: {
      type: "http",
      url: envOrVar("ARBITRUM_SEPOLIA_RPC_URL"),
      chainId: 421614,
      accounts: [envOrVar("PRIVATE_KEY")],
    },
    // Arbitrum One (Mainnet)
    arbitrum: {
      type: "http",
      url: envOrVar("ARBITRUM_RPC_URL"),
      chainId: 42161,
      accounts: [envOrVar("PRIVATE_KEY")],
    },
  },
  etherscan: {
    apiKey: {
      polygon: envOrVar("POLYGONSCAN_API_KEY"),
      polygonAmoy: envOrVar("POLYGONSCAN_API_KEY"),
      sepolia: envOrVar("ETHERSCAN_API_KEY"),
      arbitrumOne: envOrVar("ARBISCAN_API_KEY"),
      arbitrumSepolia: envOrVar("ARBISCAN_API_KEY"),
    },
  },
  test: {
    mocha: {
      timeout: 120000,
    },
  },
  paths: {
    sources: "./contracts",
    tests: {
      mocha: "./test",
    },
    cache: "./cache",
    artifacts: "./artifacts",
  },
});
