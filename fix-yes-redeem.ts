/**
 * Finds and redeems YES-winning negRisk positions.
 *
 * Strategy: All 5 markets share groupQuestionId 0x74dcd73f...
 * The YES tokens are CTF positions under a group condition.
 * Brute-force (oracle, N_outcomes, outcome_index) to find positionId match,
 * then call CTF.redeemPositions with the correct parentCollectionId.
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const WALLET    = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
const NEG_RISK  = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF_ADDR  = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E    = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const GROUP_QID = '0x74dcd73f29877722e217723e10f2e8f9a888976f7cfc796234b75a3d3214d1c8';

// Known Polymarket oracle addresses to try
const ORACLES = [
  NEG_RISK,
  '0xCB1822859cEF82Cd2Eb4E6276C7916e692995130', // Polymarket UMA oracle
  '0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74', // another common oracle
];

const CTF_ABI = [
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external pure returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)',
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) external view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];

interface YesPosition {
  title: string;
  apiCondId: string;
  asset: bigint;
  balance: ethers.BigNumber;
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const ctf      = new ethers.Contract(CTF_ADDR, CTF_ABI, wallet);

  // Fetch live positions
  const res = await fetch(`https://data-api.polymarket.com/positions?user=${WALLET}&sizeThreshold=0`);
  const all: any[] = await res.json();
  const targets = all.filter(p => p.redeemable && parseFloat(p.curPrice ?? 0) >= 0.99 && p.outcomeIndex === 0);

  const yesPositions: YesPosition[] = [];
  for (const p of targets) {
    const asset   = BigInt(String(p.asset));
    const balance = await ctf.balanceOf(WALLET, asset);
    if (balance.isZero()) continue;
    yesPositions.push({ title: p.title?.slice(0, 50) ?? p.conditionId, apiCondId: p.conditionId, asset, balance });
    console.log(`Found YES: ${p.title?.slice(0, 50)} — balance=${balance.toString()} (~${parseFloat(ethers.utils.formatUnits(balance, 6)).toFixed(2)})`);
  }

  if (!yesPositions.length) { console.log('No YES positions to redeem'); return; }

  // Brute-force group structure: try oracle × N_outcomes × outcome_index
  console.log('\nSearching for group structure...');
  let found = false;
  outer:
  for (const oracle of ORACLES) {
    for (let N = 2; N <= 20; N++) {
      // group CTF conditionId
      const groupCondId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(['address', 'bytes32', 'uint256'], [oracle, GROUP_QID, N])
      );
      // Check if this group condition is resolved
      const denom = await ctf.payoutDenominator(groupCondId);

      for (let K = 0; K < N; K++) {
        const indexSet = 1 << K;
        // Try: posId = getPositionId(USDC_E, getCollectionId(HashZero, groupCondId, indexSet))
        // This handles the case where YES tokens ARE the group-level outcome tokens
        try {
          const collId = await ctf.getCollectionId(ethers.constants.HashZero, groupCondId, indexSet);
          const posId  = await ctf.getPositionId(USDC_E, collId);

          for (const yp of yesPositions) {
            if (posId.toBigInt() === yp.asset) {
              console.log(`\n✅ MATCH: oracle=${oracle} N=${N} K=${K}`);
              console.log(`   groupCondId: ${groupCondId}  resolved: ${!denom.isZero()}`);
              found = true;

              // Try to redeem via CTF directly (works if groupCondId is resolved)
              if (!denom.isZero()) {
                try {
                  await ctf.callStatic.redeemPositions(USDC_E, ethers.constants.HashZero, groupCondId, [indexSet]);
                  console.log('   ✅ callStatic passed — redeeming...');
                  const gas = await getGas(provider);
                  const tx  = await ctf.redeemPositions(USDC_E, ethers.constants.HashZero, groupCondId, [indexSet], gas);
                  console.log(`   ⏳ tx: ${tx.hash}`);
                  await tx.wait();
                  console.log('   ✅ Redeemed!');
                } catch (e: any) {
                  console.log(`   ❌ callStatic: ${e.reason ?? e.message.slice(0, 80)}`);
                }
              } else {
                console.log('   ⚠️  Group condition not resolved yet — redemption not available');
              }
            }
          }
        } catch { /* invalid parent — skip */ }
      }
    }
  }

  if (!found) {
    console.log('\n❌ No group structure match found.');
    console.log('The positions may need to wait for Polymarket oracle to settle the group condition.');
    console.log('Current on-chain balances:');
    for (const yp of yesPositions) {
      console.log(`  ${yp.title}: ${parseFloat(ethers.utils.formatUnits(yp.balance, 6)).toFixed(4)} shares`);
    }
  }
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

main().catch(e => { console.error(e.message); process.exit(1); });
