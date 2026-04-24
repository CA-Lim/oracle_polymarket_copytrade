/**
 * Try deriving the actual CTF conditionId used by the negRiskAdapter.
 * In Polymarket negRisk: CTF conditionId = keccak256(negRiskAdapter, questionId, outcomeSlotCount)
 * The API's conditionId might be the questionId, not the CTF-level conditionId.
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const USDC_E   = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const NEG_RISK = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF      = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const WALLET   = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';

const CTF_ABI = [
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external pure returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)',
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) external view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256)',
];

const cases = [
  { title: 'Getafe',     apiConditionId: '0x59c40aaee58e8390355c868fd11e352a5e94d08fb3ebf23015171500422e0a74',  actualAsset: '81264206779664384809193742007700082726449979022895745059918855547249234044776' },
  { title: 'Birmingham', apiConditionId: '0xdc6d2f94f7b6d693c7d910a65f50ae117e9e5d02f46ec5f8c845872f55f8d45a', actualAsset: '25499824980131532132948948530893067753741869748266327513614399561020449337671' },
];

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const ctf = new ethers.Contract(CTF, CTF_ABI, provider);

  for (const c of cases) {
    console.log(`\n=== ${c.title} ===`);
    console.log(`actual asset: ${c.actualAsset.slice(0,20)}...`);

    // Derive CTF conditionId: keccak256(abi.encodePacked(negRiskAdapter, questionId, outcomeSlotCount))
    for (const outcomeCount of [2, 3]) {
      const derived = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['address', 'bytes32', 'uint256'],
          [NEG_RISK, c.apiConditionId, outcomeCount]
        )
      );
      console.log(`  derived conditionId (outcomes=${outcomeCount}): ${derived}`);

      // Check if this derived conditionId is resolved on CTF
      const denom = await ctf.payoutDenominator(derived);
      if (!denom.isZero()) {
        console.log(`  ✅ RESOLVED on CTF: payout=[${
          await ctf.payoutNumerators(derived, 0)},${await ctf.payoutNumerators(derived, 1)}]`);
      }

      for (const indexSet of [1, 2]) {
        const collectionId = await ctf.getCollectionId(ethers.constants.HashZero, derived, indexSet);
        const positionId   = await ctf.getPositionId(USDC_E, collectionId);
        const match = positionId.toBigInt() === BigInt(c.actualAsset);
        const bal   = await ctf.balanceOf(WALLET, positionId);
        if (match || !bal.isZero()) {
          console.log(`  ${match ? '✅ MATCH' : '⚡ nonzero-bal'}  indexSet=${indexSet}  posId=${positionId.toString().slice(0,20)}...  bal=${bal.toString()}`);
        }
      }
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
