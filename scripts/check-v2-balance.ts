import * as dotenv from 'dotenv';
dotenv.config();
import { ethers } from 'ethers';

// V2 contract addresses (from @polymarket/clob-client-v2 config)
const V2_EXCHANGE     = '0xE111180000d2663C0091e4f400237545B87B996B';
const V2_NEG_RISK_EX  = '0xe2222d279d744050d28e00520010520000310F59';
const PUSD            = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'; // pUSD
const USDC_E          = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // old USDC.e

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
];

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const wallet = process.env.PRIVATE_KEY
    ? new ethers.Wallet(process.env.PRIVATE_KEY, provider)
    : { address: '0x51d80Bf31c374F1fBaD43cD90B29295633587536' };

  const addr = wallet.address;
  console.log(`Wallet: ${addr}\n`);

  for (const [label, token] of [['pUSD (V2)', PUSD], ['USDC.e (V1)', USDC_E]] as const) {
    const c = new ethers.Contract(token, ERC20_ABI, provider);
    const [symbol, decimals, bal, allowV2, allowV2NR] = await Promise.all([
      c.symbol().catch(() => '?'),
      c.decimals().catch(() => 6),
      c.balanceOf(addr),
      c.allowance(addr, V2_EXCHANGE),
      c.allowance(addr, V2_NEG_RISK_EX),
    ]);
    const fmt = (n: ethers.BigNumber) => parseFloat(ethers.utils.formatUnits(n, decimals)).toFixed(4);
    console.log(`${label} (${token})`);
    console.log(`  balance            : ${fmt(bal)} ${symbol}`);
    console.log(`  allowance V2 exch  : ${fmt(allowV2)}`);
    console.log(`  allowance V2 negRsk: ${fmt(allowV2NR)}`);
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
