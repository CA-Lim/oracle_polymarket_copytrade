/**
 * Redeems YES-winning negRisk positions using correct neg_risk_market_id from CLOB API.
 *
 * Key insight: CLOB API returns neg_risk_market_id (group ID) and question_id.
 * question_id = neg_risk_market_id | outcomeIndex (last nibble).
 * Group CTF conditionId = keccak256(solidityPack([negRiskAdapter, neg_risk_market_id, N])).
 * YES token parentCollId = getCollectionId(HashZero, groupCondId, 1<<K) where K=outcomeIndex.
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const WALLET   = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
const NEG_RISK = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF_ADDR = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E   = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const CTF_ABI = [
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external pure returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)',
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) external view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];

async function getGas(provider: ethers.providers.JsonRpcProvider) {
  const feeData = await provider.getFeeData();
  const block   = await provider.getBlock('latest');
  const baseFee = block.baseFeePerGas ?? ethers.utils.parseUnits('100', 'gwei');
  const minPri  = ethers.utils.parseUnits('50', 'gwei');
  let maxPri    = feeData.maxPriorityFeePerGas ?? minPri;
  if (maxPri.lt(minPri)) maxPri = minPri;
  return { maxPriorityFeePerGas: maxPri, maxFeePerGas: baseFee.mul(2).add(maxPri) };
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const ctf      = new ethers.Contract(CTF_ADDR, CTF_ABI, wallet);

  // Fetch live YES positions
  const res = await fetch(`https://data-api.polymarket.com/positions?user=${WALLET}&sizeThreshold=0`);
  const all: any[] = await res.json();
  const yesTargets = all.filter(p => p.redeemable && parseFloat(p.curPrice ?? 0) >= 0.99 && p.outcomeIndex === 0);

  console.log(`Found ${yesTargets.length} YES positions to process\n`);

  const usdc = new ethers.Contract(USDC_E, ['function balanceOf(address) view returns (uint256)'], provider);
  const balBefore = await usdc.balanceOf(WALLET);

  for (const p of yesTargets) {
    const yesAsset = BigInt(String(p.asset));
    const balance  = await ctf.balanceOf(WALLET, yesAsset);
    if (balance.isZero()) { console.log(`${p.title?.slice(0,50)}: balance=0, skipping`); continue; }

    console.log(`\n--- ${p.title?.slice(0, 60)} ---`);
    console.log(`  balance: ~${parseFloat(ethers.utils.formatUnits(balance, 6)).toFixed(2)}`);

    // Fetch CLOB API for this market
    const cRes  = await fetch(`https://clob.polymarket.com/markets/${p.conditionId}`);
    const cData = await cRes.json() as any;
    const negRiskMarketId = cData?.neg_risk_market_id;
    const questionId      = cData?.question_id;

    if (!negRiskMarketId) {
      console.log('  No neg_risk_market_id from CLOB API, skipping');
      continue;
    }

    // Derive outcome index K from questionId vs neg_risk_market_id
    const mktIdBig  = BigInt(negRiskMarketId);
    const qIdBig    = BigInt(questionId);
    const K         = Number(qIdBig - mktIdBig); // usually 0,1,2...
    console.log(`  neg_risk_market_id: ${negRiskMarketId}`);
    console.log(`  question_id:        ${questionId}`);
    console.log(`  outcome index K:    ${K}`);

    // Brute-force N (total outcomes in group) using solidityPack
    let redeemed = false;
    for (let N = K + 1; N <= 30; N++) {
      const groupCondId = ethers.utils.keccak256(
        ethers.utils.solidityPack(['address', 'bytes32', 'uint256'], [NEG_RISK, negRiskMarketId, N])
      );

      let parentCollId: string;
      try {
        parentCollId = await ctf.getCollectionId(ethers.constants.HashZero, groupCondId, 1 << K);
      } catch { continue; }

      let collId: string;
      try {
        collId = await ctf.getCollectionId(parentCollId, p.conditionId, 1);
      } catch { continue; }

      const posId = await ctf.getPositionId(USDC_E, collId);
      if (posId.toBigInt() !== yesAsset) continue;

      console.log(`  ✅ MATCH: N=${N}  groupCondId=${groupCondId}`);
      console.log(`           parentCollId=${parentCollId}`);

      // Check if group condition is resolved
      const denom = await ctf.payoutDenominator(groupCondId);
      console.log(`  group resolved: ${!denom.isZero()}`);

      // Try to redeem via CTF
      try {
        await ctf.callStatic.redeemPositions(USDC_E, parentCollId, p.conditionId, [1], { from: WALLET });
        console.log(`  ✅ callStatic passed — submitting tx...`);
        const gas = await getGas(provider);
        const tx  = await ctf.redeemPositions(USDC_E, parentCollId, p.conditionId, [1], gas);
        console.log(`  ⏳ tx: ${tx.hash}`);
        await tx.wait();
        console.log(`  ✅ Redeemed!`);
        redeemed = true;
      } catch (e: any) {
        console.log(`  ❌ redeemPositions failed: ${e.reason ?? e.message.slice(0, 100)}`);
        console.log(`     Waiting for Polymarket oracle to settle group condition.`);
      }
      break;
    }

    if (!redeemed) {
      console.log(`  No matching group structure found or redemption failed.`);
    }
  }

  const balAfter = await usdc.balanceOf(WALLET);
  const gained   = parseFloat(ethers.utils.formatUnits(balAfter.sub(balBefore), 6));
  console.log(`\n🏆 Total claimed: +$${gained.toFixed(2)}  Wallet: $${ethers.utils.formatUnits(balAfter, 6)}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
