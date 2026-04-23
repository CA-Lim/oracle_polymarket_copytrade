/**
 * fix-redeem3.ts
 *
 * Redeems winning negRisk Polymarket positions using:
 *   negRiskAdapter.redeemPositions(bytes32 conditionId, uint256[] amounts)
 *
 * Key fixes vs fix-redeem2:
 *   - Uses `p.asset` (not `p.assetId`) for the ERC-1155 token ID
 *   - Reads actual CTF balance for that asset and passes it in amounts[]
 *   - Amounts indexed by outcomeIndex from the API
 *
 * Run: npx tsx fix-redeem3.ts
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 _conditionId, uint256[] calldata _amounts) public',
  'function balanceOf(address _owner, uint256 _id) external view returns (uint256)',
];
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

const CTF      = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const USDC     = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

async function getGas(provider: ethers.providers.JsonRpcProvider) {
  const feeData = await provider.getFeeData();
  const block   = await provider.getBlock('latest');
  const baseFee = block.baseFeePerGas ?? ethers.utils.parseUnits('100', 'gwei');
  const minPri  = ethers.utils.parseUnits('50', 'gwei');
  let maxPri    = feeData.maxPriorityFeePerGas ?? minPri;
  if (maxPri.lt(minPri)) maxPri = minPri;
  const maxFee  = baseFee.mul(2).add(maxPri);
  return { maxPriorityFeePerGas: maxPri, maxFeePerGas: maxFee };
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  console.log(`🔧 Wallet: ${wallet.address}\n`);

  const confirmed = await provider.getTransactionCount(wallet.address, 'latest');
  const pending   = await provider.getTransactionCount(wallet.address, 'pending');
  if (pending > confirmed) {
    console.error(`❌ ${pending - confirmed} pending tx(s) in mempool — run fix-stuck-txs.ts first`);
    process.exit(1);
  }

  const res = await fetch(
    `https://data-api.polymarket.com/positions?user=${wallet.address}&sizeThreshold=.01`
  );
  const positions: any[] = await res.json();

  const redeemable = positions.filter(
    p => p.redeemable === true && parseFloat(p.curPrice ?? 0) >= 0.99
  );
  console.log(`${redeemable.length} winning position(s) to redeem\n`);

  if (!redeemable.length) {
    console.log('Nothing to redeem.');
    return;
  }

  const negRisk  = new ethers.Contract(NEG_RISK, NEG_RISK_ABI, wallet);
  const ctf      = new ethers.Contract(CTF, CTF_ABI, wallet);
  const ctfRead  = new ethers.Contract(CTF, CTF_ABI, provider);
  const usdc     = new ethers.Contract(USDC, ERC20_ABI, provider);
  const balBefore = await usdc.balanceOf(wallet.address);
  console.log(`USDC balance before: $${ethers.utils.formatUnits(balBefore, 6)}\n`);

  // Group by conditionId
  const byCondition = new Map<string, any[]>();
  for (const p of redeemable) {
    const key = p.conditionId as string;
    if (!byCondition.has(key)) byCondition.set(key, []);
    byCondition.get(key)!.push(p);
  }

  for (const [conditionId, posGroup] of byCondition) {
    const label = (posGroup[0]?.title ?? conditionId).slice(0, 70);
    const isNegRisk = posGroup.some(p => p.negativeRisk === true);
    console.log(`\nRedeeming: ${label}`);
    console.log(`  conditionId: ${conditionId}  negRisk=${isNegRisk}`);

    // Build amounts array from actual on-chain CTF balances
    const amounts: ethers.BigNumber[] = [];
    let totalBalance = ethers.BigNumber.from(0);

    for (const p of posGroup) {
      const outcomeIdx  = p.outcomeIndex ?? 0;
      const assetId     = p.asset;  // correct field name from data-api

      while (amounts.length <= outcomeIdx) amounts.push(ethers.BigNumber.from(0));

      if (!assetId) {
        console.warn(`  ⚠️  No 'asset' field for outcome[${outcomeIdx}] — skipping`);
        continue;
      }

      const bal = await ctfRead.balanceOf(wallet.address, assetId);
      amounts[outcomeIdx] = bal;
      totalBalance = totalBalance.add(bal);
      console.log(`  outcome[${outcomeIdx}]="${p.outcome}" asset=${assetId.toString().slice(0,20)}... balance=${bal.toString()} (~${parseFloat(ethers.utils.formatUnits(bal,6)).toFixed(2)} shares)`);
    }

    if (totalBalance.isZero()) {
      console.log('  → On-chain balance is zero — nothing to redeem (may already be redeemed)');
      continue;
    }

    console.log(`  amounts: [${amounts.map(a => a.toString()).join(', ')}]`);

    if (isNegRisk) {
      // Try negRiskAdapter first (correct contract for negRisk positions)
      try {
        await negRisk.callStatic.redeemPositions(conditionId, amounts);
        console.log('  ✅ callStatic passed');
        const gas = await getGas(provider);
        const tx  = await negRisk.redeemPositions(conditionId, amounts, gas);
        console.log(`  ⏳ Tx: ${tx.hash}`);
        const receipt = await Promise.race([
          tx.wait(),
          new Promise<never>((_, r) => setTimeout(() => r(new Error('90s timeout')), 90_000)),
        ]) as ethers.providers.TransactionReceipt;
        console.log(`  ✅ Confirmed (block ${receipt.blockNumber})`);
        continue;
      } catch (e: any) {
        console.log(`  ⚠️  negRiskAdapter failed: ${e.message.slice(0, 100)}`);
        console.log('  Falling back to CTF...');
      }
    }

    // CTF fallback (also used for non-negRisk positions)
    try {
      const gas = await getGas(provider);
      const tx  = await ctf.redeemPositions(USDC, ethers.constants.HashZero, conditionId, [1, 2], gas);
      console.log(`  ⏳ Tx (CTF): ${tx.hash}`);
      const receipt = await Promise.race([
        tx.wait(),
        new Promise<never>((_, r) => setTimeout(() => r(new Error('90s timeout')), 90_000)),
      ]) as ethers.providers.TransactionReceipt;
      console.log(`  ✅ CTF Confirmed (block ${receipt.blockNumber})`);
    } catch (e: any) {
      console.error(`  ❌ CTF also failed: ${e.message.slice(0, 120)}`);
    }
  }

  const balAfter = await usdc.balanceOf(wallet.address);
  const gained   = parseFloat(ethers.utils.formatUnits(balAfter.sub(balBefore), 6));
  console.log(`\n🏆 Total USDC.e claimed: +$${gained.toFixed(2)}`);
  console.log(`💰 Wallet balance: $${ethers.utils.formatUnits(balAfter, 6)}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
