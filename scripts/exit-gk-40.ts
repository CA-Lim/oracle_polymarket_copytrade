import * as dotenv from 'dotenv';
dotenv.config();
import { ethers } from 'ethers';
import { ClobClient, Side, OrderType, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import { config } from '../src/config.js';

const TOKEN      = '107948107720847476441358468910042997238251918638477707843543085826693546197162';
const SHARES     = 40;
const CTF        = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const V2_EXCHANGE = '0xE111180000d2663C0091e4f400237545B87B996B';

const CTF_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
];

async function main() {
  const provider = new ethers.providers.StaticJsonRpcProvider(
    process.env.RPC_URL ?? 'https://polygon-rpc.com',
    { chainId: 137, name: 'matic' }
  );
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  console.log(`Wallet: ${wallet.address}`);

  // ── Step 1: Approve CTF tokens to V2 Exchange ──────────────────────────────
  const ctf = new ethers.Contract(CTF, CTF_ABI, wallet);
  const isApproved = await ctf.isApprovedForAll(wallet.address, V2_EXCHANGE);
  if (!isApproved) {
    console.log(`\nApproving CTF tokens to V2 Exchange...`);
    const feeData = await provider.getFeeData();
    const tip = ethers.utils.parseUnits('30', 'gwei');
    const maxFee = (feeData.lastBaseFeePerGas ?? ethers.utils.parseUnits('100', 'gwei')).mul(2).add(tip);
    const tx = await ctf.setApprovalForAll(V2_EXCHANGE, true, { maxPriorityFeePerGas: tip, maxFeePerGas: maxFee });
    console.log(`  tx: ${tx.hash}`);
    await tx.wait();
    console.log(`  ✅ approved`);
  } else {
    console.log(`✅ CTF already approved to V2 Exchange`);
  }

  // ── Step 2: Get current SELL price from CLOB ───────────────────────────────
  const priceRes = await fetch(`https://clob.polymarket.com/price?token_id=${TOKEN}&side=SELL`);
  const { price: rawPrice } = await priceRes.json() as { price: string };
  const sellPrice = parseFloat(rawPrice);
  console.log(`\nCLOB SELL price: $${sellPrice}`);
  console.log(`Expected proceeds: ~$${(SHARES * sellPrice).toFixed(2)}`);

  // ── Step 3: Create CLOB client and place SELL order ───────────────────────
  const creds = { key: '', secret: '', passphrase: '' };
  // Generate API credentials
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await wallet.signMessage(`CLOB API\n${wallet.address}\n${ts}`);
  const deriveCreds = await fetch('https://clob.polymarket.com/auth/derive-api-key', {
    method: 'GET',
    headers: {
      'POLY_ADDRESS': wallet.address,
      'POLY_SIGNATURE': sig,
      'POLY_TIMESTAMP': ts,
      'POLY_NONCE': '',
    },
  });
  const apiCreds = await deriveCreds.json() as any;

  const clobClient = new ClobClient(
    'https://clob.polymarket.com',
    137,
    wallet as any,
    { key: apiCreds.apiKey, secret: apiCreds.secret, passphrase: apiCreds.passphrase },
    SignatureTypeV2.EOA,
    undefined,
    undefined,
  );

  // Get order options (tick size, negRisk flag)
  const orderOpts = await clobClient.getOrderBookSummary(TOKEN);
  const tickSizeStr = '0.01';

  const slippage = 0.02; // 2% slippage tolerance
  const limitPrice = parseFloat((sellPrice * (1 - slippage)).toFixed(2));
  console.log(`Placing FOK SELL: ${SHARES} shares @ $${limitPrice} (${slippage * 100}% slippage on $${sellPrice})`);

  const response = await clobClient.createAndPostMarketOrder(
    {
      tokenID: TOKEN,
      amount: SHARES,
      price: limitPrice,
      side: Side.SELL,
      orderType: OrderType.FOK,
    },
    { tickSize: tickSizeStr as any, negRisk: false },
    OrderType.FOK,
  );

  if (response.success) {
    console.log(`\n✅ Exit executed!`);
    console.log(`   Order ID : ${response.orderID}`);
    console.log(`   Proceeds : ~$${(SHARES * limitPrice).toFixed(2)}`);
  } else {
    console.error(`❌ Order failed: ${response.errorMsg || response.error}`);
    console.log('Full response:', JSON.stringify(response, null, 2));
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
