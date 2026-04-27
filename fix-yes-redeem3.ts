/**
 * Redeems YES-winning negRisk positions.
 * Uses LOCAL collection-ID computation (no CTF call) to avoid "invalid parent" reverts.
 *
 * CTF formula (from source):
 *   collectionId = keccak256(conditionId || indexSet) + parentCollectionId  [uint256 addition mod 2^256]
 *   positionId   = keccak256(collateralToken || collectionId)
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const WALLET   = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
const NEG_RISK = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF_ADDR = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E   = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const CTF_ABI = [
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) external view returns (uint256)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];

// Local (off-chain) CTF math — avoids "invalid parent collection ID" revert
function localCollectionId(parentCollectionId: string, conditionId: string, indexSet: number): string {
  const hash   = BigInt(ethers.utils.keccak256(ethers.utils.solidityPack(['bytes32', 'uint256'], [conditionId, indexSet])));
  const parent = BigInt(parentCollectionId);
  const result = (hash + parent) % (2n ** 256n);
  return '0x' + result.toString(16).padStart(64, '0');
}

function localPositionId(collateralToken: string, collectionId: string): bigint {
  return BigInt(ethers.utils.keccak256(ethers.utils.solidityPack(['address', 'bytes32'], [collateralToken, collectionId])));
}

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

  const res = await fetch(`https://data-api.polymarket.com/positions?user=${WALLET}&sizeThreshold=0`);
  const all: any[] = await res.json();
  const yesTargets = all.filter(p => p.redeemable && parseFloat(p.curPrice ?? 0) >= 0.99 && p.outcomeIndex === 0);
  console.log(`Found ${yesTargets.length} YES positions\n`);

  const usdc       = new ethers.Contract(USDC_E, ['function balanceOf(address) view returns (uint256)'], provider);
  const balBefore  = await usdc.balanceOf(WALLET);

  for (const p of yesTargets) {
    const yesAsset = BigInt(String(p.asset));
    const balance  = await ctf.balanceOf(WALLET, yesAsset);
    if (balance.isZero()) { console.log(`${p.title?.slice(0,50)}: balance=0, skip`); continue; }

    const label = p.title?.slice(0, 55) ?? p.conditionId;
    console.log(`\n--- ${label} ---`);
    console.log(`  balance: ~$${parseFloat(ethers.utils.formatUnits(balance, 6)).toFixed(2)}`);

    // Fetch neg_risk_market_id + question_id from CLOB
    const cRes = await fetch(`https://clob.polymarket.com/markets/${p.conditionId}`);
    const cData = await cRes.json() as any;
    const negRiskMarketId = cData?.neg_risk_market_id;
    const questionId      = cData?.question_id;
    if (!negRiskMarketId) { console.log('  No neg_risk_market_id, skip'); continue; }

    const K = Number(BigInt(questionId) - BigInt(negRiskMarketId));
    console.log(`  K=${K}  negRiskMarketId=${negRiskMarketId}`);

    // Brute-force N using LOCAL math (no CTF call = no revert)
    let matchFound = false;
    for (let N = Math.max(K + 1, 2); N <= 50; N++) {
      const groupCondId = ethers.utils.keccak256(
        ethers.utils.solidityPack(['address', 'bytes32', 'uint256'], [NEG_RISK, negRiskMarketId, N])
      );

      // Compute parentCollId locally
      const parentCollId = localCollectionId(ethers.constants.HashZero, groupCondId, 1 << K);
      // Compute YES positionId locally
      const collId  = localCollectionId(parentCollId, p.conditionId, 1);
      const posId   = localPositionId(USDC_E, collId);

      if (posId === yesAsset) {
        console.log(`  ✅ MATCH: N=${N}  groupCondId=${groupCondId}`);
        console.log(`           parentCollId=${parentCollId}`);

        const denom = await ctf.payoutDenominator(groupCondId);
        console.log(`  group condition resolved: ${!denom.isZero()}`);

        try {
          await ctf.callStatic.redeemPositions(USDC_E, parentCollId, p.conditionId, [1], { from: WALLET });
          console.log('  ✅ callStatic passed — redeeming...');
          const gas = await getGas(provider);
          const tx  = await ctf.redeemPositions(USDC_E, parentCollId, p.conditionId, [1], gas);
          console.log(`  ⏳ tx: ${tx.hash}`);
          await tx.wait();
          console.log('  ✅ Redeemed!');
        } catch (e: any) {
          console.log(`  ❌ ${e.reason ?? e.message.slice(0, 100)}`);
          console.log('  Waiting for Polymarket oracle to settle group condition.');
        }
        matchFound = true;
        break;
      }
    }

    if (!matchFound) {
      console.log(`  ❌ No group structure found for N=2..50`);
    }
  }

  const balAfter = await usdc.balanceOf(WALLET);
  const gained   = parseFloat(ethers.utils.formatUnits(balAfter.sub(balBefore), 6));
  console.log(`\n🏆 Total claimed: +$${gained.toFixed(2)}  Wallet: $${ethers.utils.formatUnits(balAfter, 6)}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
