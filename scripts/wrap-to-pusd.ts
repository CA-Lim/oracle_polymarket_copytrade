/**
 * Convert USDC.e → pUSD so the wallet can trade on the Polymarket V2 exchange.
 *
 * Uses CollateralOnramp contract (0x93070a847efEf7F70739046A929D47a521F5B8ee):
 *   wrap(address _asset, address _to, uint256 _amount)
 *
 * Steps:
 *   1. Approve USDC.e to the CollateralOnramp
 *   2. Call wrap() — mints pUSD 1:1 to recipient
 *   3. Approve pUSD to V2 exchange + V2 negRisk exchange
 *
 * Usage: npx tsx scripts/wrap-to-pusd.ts [amount_usdc]
 *   amount_usdc defaults to 50 (50 USDC.e → 50 pUSD)
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { ethers } from 'ethers';

const PUSD          = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const USDC_E        = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ONRAMP        = '0x93070a847efEf7F70739046A929D47a521F5B8ee'; // CollateralOnramp
const V2_EXCHANGE      = '0xE111180000d2663C0091e4f400237545B87B996B';
const V2_NEG_RISK      = '0xe2222d279d744050d28e00520010520000310F59';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'; // used as spender for negRisk BUY orders
const MAX_UINT256   = ethers.constants.MaxUint256;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

const PUSD_ABI = [...ERC20_ABI];

const ONRAMP_ABI = [
  'function wrap(address _asset, address _to, uint256 _amount)',
  'function paused(address _asset) view returns (bool)',
];

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL ?? 'https://polygon-rpc.com';
  if (!privateKey) throw new Error('PRIVATE_KEY not set');

  const amountUsdc = parseFloat(process.argv[2] ?? '50');
  const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, { chainId: 137, name: 'matic' });
  const wallet = new ethers.Wallet(privateKey, provider);

  // Dynamically set gas: tip=30 Gwei, maxFee = 2× current base fee + tip
  const feeData = await provider.getFeeData();
  const tip = ethers.utils.parseUnits('30', 'gwei');
  const baseFee = feeData.lastBaseFeePerGas ?? ethers.utils.parseUnits('100', 'gwei');
  const maxFee = baseFee.mul(2).add(tip);
  const gasOverrides = { maxPriorityFeePerGas: tip, maxFeePerGas: maxFee };
  console.log(`Gas: tip=${ethers.utils.formatUnits(tip,'gwei')} Gwei, maxFee=${ethers.utils.formatUnits(maxFee,'gwei')} Gwei`);

  console.log(`Wallet   : ${wallet.address}`);
  console.log(`Amount   : ${amountUsdc} USDC.e → pUSD`);

  const usdce  = new ethers.Contract(USDC_E, ERC20_ABI, wallet);
  const pusd   = new ethers.Contract(PUSD, PUSD_ABI, wallet);
  const onramp = new ethers.Contract(ONRAMP, ONRAMP_ABI, wallet);

  // ── Check balances ──────────────────────────────────────────────────────────
  const [usdceBal, pusdBal, usdceAllow, isPaused] = await Promise.all([
    usdce.balanceOf(wallet.address),
    pusd.balanceOf(wallet.address),
    usdce.allowance(wallet.address, ONRAMP),
    onramp.paused(USDC_E),
  ]);
  if (isPaused) throw new Error('CollateralOnramp is paused for USDC.e');
  const decimals = 6;
  console.log(`\nBefore:`);
  console.log(`  USDC.e balance   : ${ethers.utils.formatUnits(usdceBal, decimals)}`);
  console.log(`  pUSD balance     : ${ethers.utils.formatUnits(pusdBal, decimals)}`);
  console.log(`  USDC.e → OnRamp allowance: ${ethers.utils.formatUnits(usdceAllow, decimals)}`);

  const amountWei = ethers.utils.parseUnits(amountUsdc.toString(), decimals);
  if (usdceBal.lt(amountWei)) {
    throw new Error(`Insufficient USDC.e: have ${ethers.utils.formatUnits(usdceBal, decimals)}, need ${amountUsdc}`);
  }

  // ── Step 1: Approve USDC.e → CollateralOnramp ────────────────────────────
  if (usdceAllow.lt(amountWei)) {
    console.log(`\nApproving USDC.e to CollateralOnramp...`);
    const tx = await usdce.approve(ONRAMP, MAX_UINT256, gasOverrides);
    console.log(`  tx: ${tx.hash}`);
    await tx.wait();
    console.log(`  ✅ approved`);
  } else {
    console.log(`\nUSCD.e already approved to CollateralOnramp`);
  }

  // ── Step 2: Wrap USDC.e → pUSD via CollateralOnramp ──────────────────────
  console.log(`\nWrapping ${amountUsdc} USDC.e → pUSD...`);
  const wrapTx = await onramp.wrap(
    USDC_E,          // _asset
    wallet.address,  // _to
    amountWei,       // _amount
    gasOverrides,
  );
  console.log(`  tx: ${wrapTx.hash}`);
  const receipt = await wrapTx.wait();
  console.log(`  ✅ wrapped  (gas used: ${receipt.gasUsed.toString()})`);

  // ── Step 3: Approve pUSD to V2 exchange contracts ─────────────────────────
  const [allowV2, allowV2NR] = await Promise.all([
    pusd.allowance(wallet.address, V2_EXCHANGE),
    pusd.allowance(wallet.address, V2_NEG_RISK),
  ]);

  const allowNRA = await pusd.allowance(wallet.address, NEG_RISK_ADAPTER);

  for (const [label, spender, current] of [
    ['V2 Exchange',         V2_EXCHANGE,      allowV2],
    ['V2 NegRisk Exchange', V2_NEG_RISK,      allowV2NR],
    ['NegRisk Adapter',     NEG_RISK_ADAPTER, allowNRA],
  ] as const) {
    if ((current as ethers.BigNumber).lt(amountWei)) {
      console.log(`\nApproving pUSD to ${label}...`);
      const tx = await pusd.approve(spender, MAX_UINT256, gasOverrides);
      console.log(`  tx: ${tx.hash}`);
      await tx.wait();
      console.log(`  ✅ approved`);
    } else {
      console.log(`\npUSD already approved to ${label}`);
    }
  }

  // ── Final balances ────────────────────────────────────────────────────────
  const [newUsdce, newPusd] = await Promise.all([
    usdce.balanceOf(wallet.address),
    pusd.balanceOf(wallet.address),
  ]);
  console.log(`\nAfter:`);
  console.log(`  USDC.e balance : ${ethers.utils.formatUnits(newUsdce, decimals)}`);
  console.log(`  pUSD balance   : ${ethers.utils.formatUnits(newPusd, decimals)}`);
  console.log(`\n✅ Done — wallet is ready to trade on V2 exchange`);
  console.log(`   Run: npx tsx scripts/basic-trade.ts`);
}

main().catch(e => { console.error('❌', (e as Error).message); process.exit(1); });
