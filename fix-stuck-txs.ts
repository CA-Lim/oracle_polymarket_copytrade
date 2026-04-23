/**
 * fix-stuck-txs.ts
 *
 * Cancels all pending txs stuck in the mempool (maxFee < baseFee) by
 * replacing them with 0-value self-transfers at a high gas price,
 * then redeems all winning Polymarket positions.
 *
 * Run: npx tsx fix-stuck-txs.ts
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const REDEEM_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

const CTF         = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK    = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const USDC        = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

async function getGas(provider: ethers.providers.JsonRpcProvider, forceHighGwei?: number) {
  const feeData = await provider.getFeeData();
  const block   = await provider.getBlock('latest');
  const baseFee = block.baseFeePerGas ?? ethers.utils.parseUnits('100', 'gwei');

  const minPri  = ethers.utils.parseUnits('50', 'gwei');
  let maxPri    = feeData.maxPriorityFeePerGas ?? minPri;
  if (maxPri.lt(minPri)) maxPri = minPri;

  // Use forceHighGwei when we need to beat a specific pending tx's gas price
  let maxFee = forceHighGwei
    ? ethers.utils.parseUnits(forceHighGwei.toString(), 'gwei')
    : baseFee.mul(2).add(maxPri);

  if (maxFee.lt(maxPri)) maxFee = maxPri;

  console.log(`   Gas: baseFee=${ethers.utils.formatUnits(baseFee,'gwei').slice(0,6)} maxPri=${ethers.utils.formatUnits(maxPri,'gwei').slice(0,6)} maxFee=${ethers.utils.formatUnits(maxFee,'gwei').slice(0,6)} gwei`);
  return { maxPriorityFeePerGas: maxPri, maxFeePerGas: maxFee };
}

async function cancelStuckTxs(wallet: ethers.Wallet, provider: ethers.providers.JsonRpcProvider) {
  const confirmed = await provider.getTransactionCount(wallet.address, 'latest');
  const pending   = await provider.getTransactionCount(wallet.address, 'pending');

  if (pending <= confirmed) {
    console.log('✅ No stuck transactions found');
    return;
  }

  const stuckCount = pending - confirmed;
  console.log(`\n🚫 Found ${stuckCount} stuck tx(s) (nonces ${confirmed}–${pending - 1})`);
  console.log('   Replacing with high-gas self-transfers...');

  // Try escalating maxFee levels — each retry beats the previous pending tx by >10%
  const GAS_LADDER = [300, 400, 500, 700, 1000];
  const receipts: Promise<any>[] = [];

  for (let nonce = confirmed; nonce < pending; nonce++) {
    let submitted = false;
    for (const gwei of GAS_LADDER) {
      try {
        const gasOverrides = await getGas(provider, gwei);
        const tx = await wallet.sendTransaction({
          to: wallet.address,
          value: 0,
          nonce,
          ...gasOverrides,
        });
        console.log(`   Nonce ${nonce}: cancel tx → ${tx.hash}`);
        receipts.push(tx.wait());
        submitted = true;
        break;
      } catch (e: any) {
        const msg = e.message ?? '';
        if (e.code === 'REPLACEMENT_UNDERPRICED' || msg.includes('replacement') || msg.includes('underpriced') || msg.includes('already known')) {
          console.log(`   Nonce ${nonce}: ${gwei} gwei too low, trying higher...`);
          continue;
        }
        // Nonce already mined — no need to cancel
        if (msg.includes('nonce too low') || msg.includes('already mined')) {
          console.log(`   Nonce ${nonce}: already confirmed, skipping`);
          submitted = true;
          break;
        }
        console.error(`   Nonce ${nonce}: unexpected error — ${msg}`);
        // Don't set submitted=true — try next gas level
        break;
      }
    }
    if (!submitted) {
      console.error(`   Nonce ${nonce}: could not replace even at ${GAS_LADDER.at(-1)} gwei — skipping`);
    }
  }

  console.log('   Waiting for cancellations to confirm...');
  await Promise.all(receipts);
  console.log('✅ All stuck transactions cancelled');
}

async function redeemAll(wallet: ethers.Wallet, provider: ethers.providers.JsonRpcProvider) {
  console.log('\n🔍 Fetching redeemable positions...');

  const res = await fetch(
    `https://data-api.polymarket.com/positions?user=${wallet.address}&sizeThreshold=.01`
  );
  const positions: any[] = await res.json();
  console.log(`   Found ${positions.length} total position(s)`);

  // Only redeem winning positions (curPrice ≈ $1). curPrice=0 means a losing token — no payout.
  const winning = new Map<string, any>();
  for (const p of positions) {
    if (p.redeemable === true && parseFloat(p.curPrice ?? 0) >= 0.99) {
      if (!winning.has(p.conditionId)) winning.set(p.conditionId, p);
    }
  }

  if (!winning.size) {
    console.log('✅ No winning positions to redeem');
    return;
  }

  console.log(`💰 ${winning.size} winning condition(s) to redeem`);

  const negRisk = new ethers.Contract(NEG_RISK, REDEEM_ABI, wallet);
  const ctf     = new ethers.Contract(CTF,      REDEEM_ABI, wallet);
  const usdc    = new ethers.Contract(USDC, ERC20_ABI, provider);
  const balBefore = await usdc.balanceOf(wallet.address);

  for (const [conditionId, pos] of winning) {
    const label = (pos.title ?? conditionId).slice(0, 65);
    console.log(`\n   Redeeming: ${label}`);

    // Try negRiskAdapter first (most Polymarket positions), fall back to CTF.
    try {
      const gasOverrides = await getGas(provider);
      const tx = await negRisk.redeemPositions(
        USDC,
        ethers.constants.HashZero,
        conditionId,
        [1, 2],
        gasOverrides,
      );
      console.log(`   ⏳ Tx: ${tx.hash}`);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('tx.wait() timed out after 90s — tx may be stuck')), 90_000)
      );
      const receipt = await Promise.race([tx.wait(), timeout]) as ethers.providers.TransactionReceipt;
      console.log(`   ✅ Confirmed (block ${receipt.blockNumber})`);
    } catch (negRiskErr: any) {
      // negRiskAdapter not yet resolved for this condition — try CTF directly
      try {
        const gasOverrides = await getGas(provider);
        const tx = await ctf.redeemPositions(USDC, ethers.constants.HashZero, conditionId, [1, 2], gasOverrides);
        console.log(`   ⏳ Tx (CTF): ${tx.hash}`);
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('tx.wait() timed out after 90s')), 90_000)
        );
        const receipt = await Promise.race([tx.wait(), timeout]) as ethers.providers.TransactionReceipt;
        console.log(`   ✅ Confirmed (block ${receipt.blockNumber})`);
      } catch (ctfErr: any) {
        console.error(`   ❌ Both failed — negRisk: ${negRiskErr.message.slice(0,60)} | CTF: ${ctfErr.message.slice(0,60)}`);
        console.error(`      (Market may not yet be resolved on-chain — retry later)`);
      }
    }
  }

  const balAfter = await usdc.balanceOf(wallet.address);
  const gained   = parseFloat(ethers.utils.formatUnits(balAfter.sub(balBefore), 6));
  console.log(`\n🏆 Total USDC.e claimed: +$${gained.toFixed(2)}`);
  console.log(`💰 Wallet balance: $${ethers.utils.formatUnits(balAfter, 6)}`);
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  console.log(`🔧 Wallet: ${wallet.address}`);

  await cancelStuckTxs(wallet, provider);
  await redeemAll(wallet, provider);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
