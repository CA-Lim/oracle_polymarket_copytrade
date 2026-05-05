/**
 * Redeems YES-winning negRisk positions via negRiskAdapter.
 *
 * Key facts (from negRisk CTF adapter source):
 *   - YES tokens use wcol (wrapped USDC) not raw USDC.e
 *   - wcol = 0x3A3BD7bb9528E159577F7C2e685CC81A765002E2
 *   - YES positionId = CTF.getPositionId(wcol, CTF.getCollectionId(HashZero, conditionId, 1))
 *   - Redemption: negRiskAdapter.redeemPositions(conditionId, [yesAmount, 0])
 *
 * The conditionId used by the CTF is the per-market conditionId from the Polymarket API.
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const WALLET      = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
const NEG_RISK    = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF_ADDR    = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E      = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const WCOL        = '0x3A3BD7bb9528E159577F7C2e685CC81A765002E2';

const CTF_ABI = [
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external view returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) external view returns (uint256)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];

const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts) external',
  'function getConditionId(bytes32 questionId) external view returns (bytes32)',
  'function getDenominator(bytes32 marketId) external view returns (uint256)',
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
  const provider  = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const wallet    = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const ctf       = new ethers.Contract(CTF_ADDR, CTF_ABI, wallet);
  const negRisk   = new ethers.Contract(NEG_RISK, NEG_RISK_ABI, wallet);

  // Fetch all redeemable YES positions
  const res = await fetch(`https://data-api.polymarket.com/positions?user=${WALLET}&sizeThreshold=0`);
  const all: any[] = await res.json();
  const yesTargets = all.filter(p =>
    p.redeemable &&
    parseFloat(p.curPrice ?? 0) >= 0.99 &&
    p.outcomeIndex === 0
  );
  console.log(`Found ${yesTargets.length} redeemable YES positions\n`);

  const usdc      = new ethers.Contract(USDC_E, ['function balanceOf(address) view returns (uint256)'], provider);
  const balBefore = await usdc.balanceOf(WALLET);

  for (const p of yesTargets) {
    const yesAsset = BigInt(String(p.asset));
    const balance  = await ctf.balanceOf(WALLET, ethers.BigNumber.from(String(p.asset)));
    if (balance.isZero()) { console.log(`${p.title?.slice(0,50)}: balance=0, skip`); continue; }

    const label = p.title?.slice(0, 60) ?? p.conditionId;
    const balUSD = parseFloat(ethers.utils.formatUnits(balance, 6)).toFixed(2);
    console.log(`\n--- ${label} ---`);
    console.log(`  balance: ~$${balUSD}  conditionId: ${p.conditionId}`);

    const apiCondId = p.conditionId as string;

    // Step 1: Verify YES positionId using wcol
    let yesCollId: string;
    try {
      yesCollId = await ctf.getCollectionId(ethers.constants.HashZero, apiCondId, 1);
    } catch (e: any) {
      console.log(`  ❌ getCollectionId failed: ${e.reason ?? e.message.slice(0, 80)}`);
      continue;
    }
    const posIdWcol  = (await ctf.getPositionId(WCOL, yesCollId)).toBigInt();
    const posIdUsdc  = (await ctf.getPositionId(USDC_E, yesCollId)).toBigInt();
    console.log(`  yesCollId: ${yesCollId}`);
    console.log(`  posId(wcol):  ${posIdWcol.toString().slice(0, 22)}...`);
    console.log(`  posId(usdc):  ${posIdUsdc.toString().slice(0, 22)}...`);
    console.log(`  YES asset:    ${yesAsset.toString().slice(0, 22)}...`);
    console.log(`  match(wcol)=${posIdWcol === yesAsset}  match(usdc)=${posIdUsdc === yesAsset}`);

    // Step 2: Check if the binary condition is resolved
    const denomApi = await ctf.payoutDenominator(apiCondId);
    console.log(`  condition resolved (apiCondId): ${!denomApi.isZero()}`);

    if (posIdWcol === yesAsset) {
      // YES token uses wcol as collateral — redeem via negRiskAdapter
      console.log(`  ✅ wcol match — redeeming via negRiskAdapter...`);
      try {
        // Approve CTF to spend our YES tokens (handled by safeBatchTransferFrom in negRisk)
        const gas = await getGas(provider);
        const tx  = await negRisk.redeemPositions(apiCondId, [balance, 0], gas);
        console.log(`  ⏳ tx: ${tx.hash}`);
        await tx.wait();
        console.log(`  ✅ Redeemed!`);
      } catch (e: any) {
        console.log(`  ❌ negRisk.redeemPositions failed: ${e.reason ?? e.message.slice(0, 120)}`);
        // Fallback: try direct CTF redemption
        console.log(`  Trying direct CTF.redeemPositions(wcol, HashZero, condId, [1])...`);
        try {
          await ctf.callStatic.redeemPositions(WCOL, ethers.constants.HashZero, apiCondId, [1], { from: WALLET });
          const gas = await getGas(provider);
          const tx  = await ctf.redeemPositions(WCOL, ethers.constants.HashZero, apiCondId, [1], gas);
          console.log(`  ⏳ tx: ${tx.hash}`);
          await tx.wait();
          console.log(`  ✅ Redeemed via CTF directly!`);
        } catch (e2: any) {
          console.log(`  ❌ CTF direct also failed: ${e2.reason ?? e2.message.slice(0, 120)}`);
        }
      }
    } else if (posIdUsdc === yesAsset) {
      // YES token uses USDC.e — redeem directly via CTF
      console.log(`  ✅ usdc match — redeeming via CTF...`);
      try {
        await ctf.callStatic.redeemPositions(USDC_E, ethers.constants.HashZero, apiCondId, [1], { from: WALLET });
        const gas = await getGas(provider);
        const tx  = await ctf.redeemPositions(USDC_E, ethers.constants.HashZero, apiCondId, [1], gas);
        console.log(`  ⏳ tx: ${tx.hash}`);
        await tx.wait();
        console.log(`  ✅ Redeemed!`);
      } catch (e: any) {
        console.log(`  ❌ CTF.redeemPositions failed: ${e.reason ?? e.message.slice(0, 120)}`);
      }
    } else {
      console.log(`  ❌ No collateral match (neither wcol nor usdc). Nested structure?`);
      // Try CLOB API to get question_id and derive the condition via negRiskAdapter
      console.log(`  Checking CLOB API for nested structure...`);
      const cRes  = await fetch(`https://clob.polymarket.com/markets/${apiCondId}`);
      const cData = await cRes.json() as any;
      const qId   = cData?.question_id;
      if (qId) {
        const derivedCondId = await negRisk.getConditionId(qId);
        console.log(`  question_id: ${qId}`);
        console.log(`  derivedCondId: ${derivedCondId}`);
        const derivedCollId = await ctf.getCollectionId(ethers.constants.HashZero, derivedCondId, 1);
        const derivedPosId  = (await ctf.getPositionId(WCOL, derivedCollId)).toBigInt();
        console.log(`  posId(wcol, derivedCond): ${derivedPosId.toString().slice(0, 22)}...`);
        console.log(`  match: ${derivedPosId === yesAsset}`);
        if (derivedPosId === yesAsset) {
          console.log(`  ✅ derived match — condition: ${derivedCondId}`);
          const denomDer = await ctf.payoutDenominator(derivedCondId);
          console.log(`  derivedCondId resolved: ${!denomDer.isZero()}`);
          try {
            const gas = await getGas(provider);
            const tx  = await negRisk.redeemPositions(derivedCondId, [balance, 0], gas);
            console.log(`  ⏳ tx: ${tx.hash}`);
            await tx.wait();
            console.log(`  ✅ Redeemed via derived condId!`);
          } catch (e: any) {
            console.log(`  ❌ negRisk.redeemPositions(derived) failed: ${e.reason ?? e.message.slice(0, 120)}`);
          }
        }
      }
    }
  }

  const balAfter = await usdc.balanceOf(WALLET);
  const gained   = parseFloat(ethers.utils.formatUnits(balAfter.sub(balBefore), 6));
  console.log(`\n🏆 Total claimed: +$${gained.toFixed(2)}  Wallet: $${ethers.utils.formatUnits(balAfter, 6)}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
