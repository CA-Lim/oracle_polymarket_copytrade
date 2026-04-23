/**
 * fix-redeem2.ts
 *
 * Redeems winning Polymarket negRisk positions using the CORRECT ABI:
 *   negRiskAdapter.redeemPositions(bytes32 conditionId, uint256[] amounts)
 *
 * The old scripts used the CTF-style ABI (address, bytes32, bytes32, uint256[])
 * which is NOT what the negRiskAdapter exposes.
 *
 * Run: npx tsx fix-redeem2.ts
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const NEG_RISK_ABI = [
  // Correct negRiskAdapter redeemPositions — NOT the CTF 4-arg version
  'function redeemPositions(bytes32 _conditionId, uint256[] calldata _amounts) public',
  'function balanceOf(address _owner, uint256 _id) external view returns (uint256)',
];
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];

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
  console.log(`   Gas: baseFee=${ethers.utils.formatUnits(baseFee,'gwei').slice(0,6)} maxPri=${ethers.utils.formatUnits(maxPri,'gwei').slice(0,6)} maxFee=${ethers.utils.formatUnits(maxFee,'gwei').slice(0,6)} gwei`);
  return { maxPriorityFeePerGas: maxPri, maxFeePerGas: maxFee };
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  console.log(`🔧 Wallet: ${wallet.address}\n`);

  // Check for stuck txs first
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
  console.log(`Found ${positions.length} position(s) from API`);

  // Filter winning redeemable positions
  const redeemable = positions.filter(
    p => p.redeemable === true && parseFloat(p.curPrice ?? 0) >= 0.99
  );
  console.log(`${redeemable.length} winning position(s) to redeem\n`);

  if (!redeemable.length) {
    console.log('Nothing to redeem.');
    return;
  }

  // Print full data for first few so we can see the field names
  console.log('Sample position fields:', Object.keys(redeemable[0]));
  console.log('Sample position data:', JSON.stringify(redeemable[0], null, 2));
  console.log();

  const negRisk = new ethers.Contract(NEG_RISK, NEG_RISK_ABI, wallet);
  const ctf     = new ethers.Contract(CTF, CTF_ABI, wallet);
  const usdc    = new ethers.Contract(USDC, ERC20_ABI, provider);
  const balBefore = await usdc.balanceOf(wallet.address);
  console.log(`USDC balance before: $${ethers.utils.formatUnits(balBefore, 6)}\n`);

  // Group by conditionId (one redeem call per condition)
  const byCondition = new Map<string, any[]>();
  for (const p of redeemable) {
    const key = p.conditionId as string;
    if (!byCondition.has(key)) byCondition.set(key, []);
    byCondition.get(key)!.push(p);
  }

  for (const [conditionId, posGroup] of byCondition) {
    const label = (posGroup[0]?.title ?? conditionId).slice(0, 70);
    console.log(`\nRedeeming: ${label}`);
    console.log(`  conditionId: ${conditionId}`);

    // Build amounts array indexed by outcomeIndex
    // outcomeIndex from API tells us which slot each position occupies
    const ctfContract = new ethers.Contract(CTF, CTF_ABI, provider);
    const amounts: ethers.BigNumber[] = [];

    for (const p of posGroup) {
      const outcomeIdx = p.outcomeIndex ?? 0;
      const assetId = p.assetId ?? p.positionId;

      // Ensure amounts array is large enough
      while (amounts.length <= outcomeIdx) amounts.push(ethers.BigNumber.from(0));

      if (assetId) {
        try {
          // Check both CTF and negRisk balances
          let bal = await ctfContract.balanceOf(wallet.address, assetId);
          if (bal.isZero()) {
            bal = await negRisk.balanceOf(wallet.address, assetId);
          }
          amounts[outcomeIdx] = bal;
          console.log(`  outcome[${outcomeIdx}] assetId=${assetId.toString().slice(0,20)}... balance=${bal.toString()}`);
        } catch (e: any) {
          console.warn(`  Warning: could not fetch balance for assetId — ${e.message.slice(0,60)}`);
          // Use a large amount that will be capped by actual balance
          amounts[outcomeIdx] = ethers.utils.parseUnits('10000000', 6);
        }
      } else {
        console.warn(`  Warning: no assetId field found for outcome[${outcomeIdx}]`);
        amounts[outcomeIdx] = ethers.utils.parseUnits('10000000', 6);
      }
    }

    if (amounts.every(a => a.isZero())) {
      console.log('  → All balances zero, skipping');
      continue;
    }

    console.log(`  amounts: [${amounts.map(a => a.toString()).join(', ')}]`);

    // First try: callStatic to see if it would work
    try {
      await negRisk.callStatic.redeemPositions(conditionId, amounts);
      console.log('  ✅ callStatic passed — submitting real tx...');
    } catch (staticErr: any) {
      console.log(`  ⚠️  callStatic failed (${staticErr.message.slice(0,80)}) — trying anyway...`);
    }

    try {
      const gas = await getGas(provider);
      const tx = await negRisk.redeemPositions(conditionId, amounts, gas);
      console.log(`  ⏳ Tx: ${tx.hash}`);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('tx.wait() timed out after 90s')), 90_000)
      );
      const receipt = await Promise.race([tx.wait(), timeout]) as ethers.providers.TransactionReceipt;
      console.log(`  ✅ Confirmed (block ${receipt.blockNumber})`);
    } catch (err: any) {
      console.error(`  ❌ negRiskAdapter failed: ${err.message.slice(0, 120)}`);

      // Fallback: standard CTF redeemPositions with HashZero
      console.log('  Trying CTF fallback...');
      try {
        const gas = await getGas(provider);
        const tx = await ctf.redeemPositions(USDC, ethers.constants.HashZero, conditionId, [1, 2], gas);
        console.log(`  ⏳ Tx (CTF): ${tx.hash}`);
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('tx.wait() timed out after 90s')), 90_000)
        );
        const receipt = await Promise.race([tx.wait(), timeout]) as ethers.providers.TransactionReceipt;
        console.log(`  ✅ CTF Confirmed (block ${receipt.blockNumber})`);
      } catch (ctfErr: any) {
        console.error(`  ❌ CTF also failed: ${ctfErr.message.slice(0, 120)}`);
      }
    }
  }

  const balAfter = await usdc.balanceOf(wallet.address);
  const gained   = parseFloat(ethers.utils.formatUnits(balAfter.sub(balBefore), 6));
  console.log(`\n🏆 Total USDC.e claimed: +$${gained.toFixed(2)}`);
  console.log(`💰 Wallet balance: $${ethers.utils.formatUnits(balAfter, 6)}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
