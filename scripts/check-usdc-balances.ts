/**
 * Checks both USDC.e and native USDC balances, and decodes one of the CTF
 * redemption tx receipts to see where the payout actually went.
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const WALLET     = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
const USDC_E     = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // bridged USDC.e
const USDC_NATIVE= '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // native USDC
const ERC20_ABI  = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];

// One of the CTF redemption txs from the last fix-redeem3 run
const TX_HASH    = '0x7c9fd7725680776e6f232e1eb93a96ba444b5b08937495e6867a7753f15be57c';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);

  const usdce  = new ethers.Contract(USDC_E,      ERC20_ABI, provider);
  const usdc   = new ethers.Contract(USDC_NATIVE, ERC20_ABI, provider);

  const [balE, balN] = await Promise.all([
    usdce.balanceOf(WALLET),
    usdc.balanceOf(WALLET),
  ]);

  console.log(`USDC.e  (bridged) : $${ethers.utils.formatUnits(balE, 6)}`);
  console.log(`USDC    (native)  : $${ethers.utils.formatUnits(balN, 6)}`);
  console.log();

  // Decode Transfer events from the Getafe CTF redemption tx
  console.log(`Checking tx: ${TX_HASH}`);
  const receipt = await provider.getTransactionReceipt(TX_HASH);
  if (!receipt) { console.log('tx not found'); return; }

  const transfers = receipt.logs.filter(l => l.topics[0] === TRANSFER_TOPIC);
  if (!transfers.length) {
    console.log('No ERC-20/ERC-1155 Transfer events found in tx');
  }
  for (const log of transfers) {
    const from  = '0x' + log.topics[1].slice(26);
    const to    = '0x' + log.topics[2].slice(26);
    const value = ethers.BigNumber.from(log.data);
    console.log(`  Transfer  token=${log.address}`);
    console.log(`            from=${from}`);
    console.log(`            to=${to}`);
    console.log(`            amount=${value.toString()} (${ethers.utils.formatUnits(value, 6)})`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
