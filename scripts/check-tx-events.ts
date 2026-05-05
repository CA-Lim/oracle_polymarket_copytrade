/**
 * Dumps all raw logs from a tx and checks when/how the YES token was burned.
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const WALLET  = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
const CTF     = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'.toLowerCase();
const USDC_E  = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'.toLowerCase();

// ERC-1155 TransferSingle topic
const TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
// ERC-20 Transfer topic
const TRANSFER_ERC20  = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Getafe CTF redemption tx (second fix-redeem3 run)
const TX_HASH = '0x7c9fd7725680776e6f232e1eb93a96ba444b5b08937495e6867a7753f15be57c';
// Getafe YES token asset id
const YES_ASSET = '81264206779664384809193742007700082726449979022895745059918855547249234044776';

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);

  // Dump all logs from the tx
  const receipt = await provider.getTransactionReceipt(TX_HASH);
  console.log(`Tx status: ${receipt.status === 1 ? 'success' : 'FAILED'}`);
  console.log(`Total logs in tx: ${receipt.logs.length}`);
  for (const log of receipt.logs) {
    console.log(`\n  Contract: ${log.address}`);
    console.log(`  Topics:   ${log.topics.join('\n            ')}`);
    console.log(`  Data:     ${log.data}`);
  }

  // Search recent blocks for when YES token balance changed for WALLET
  console.log(`\n--- Searching for TransferSingle events burning YES asset ---`);
  const latestBlock = await provider.getBlockNumber();
  const fromBlock   = latestBlock - 5000; // ~last 2 hours on Polygon
  const filter = {
    address: CTF,
    topics: [TRANSFER_SINGLE],
    fromBlock,
    toBlock: 'latest',
  };
  const logs = await provider.getLogs(filter as any);
  const assetHex = '0x' + BigInt(YES_ASSET).toString(16).padStart(64, '0');

  for (const log of logs) {
    // TransferSingle(operator, from, to, id, value)
    const from  = '0x' + log.topics[2].slice(26);
    const to    = '0x' + log.topics[3].slice(26);
    const [id, value] = ethers.utils.defaultAbiCoder.decode(['uint256', 'uint256'], log.data);
    const isBurn = to === '0x0000000000000000000000000000000000000000';
    const isWallet = from.toLowerCase() === WALLET.toLowerCase();
    if (id.toHexString() === assetHex || isWallet) {
      console.log(`  block=${log.blockNumber} tx=${log.transactionHash.slice(0,20)}...`);
      console.log(`  from=${from}  to=${to}  id=${id.toString().slice(0,20)}...  value=${value.toString()}`);
      console.log(`  isBurn=${isBurn}  fromWallet=${isWallet}`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
