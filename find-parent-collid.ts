/**
 * Exhaustive local search for YES token parentCollectionId.
 * Tries every combination of: groupQuestionId × N × parentIndexSet × binaryCondId
 * All computed locally (no CTF calls) to avoid "invalid parent" reverts.
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const NEG_RISK  = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF_ADDR  = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E    = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const HASH_ZERO = '0x' + '0'.repeat(64);

function localCollId(parent: string, condId: string, indexSet: number): string {
  const h = BigInt(ethers.utils.keccak256(ethers.utils.solidityPack(['bytes32', 'uint256'], [condId, indexSet])));
  const p = BigInt(parent);
  return '0x' + ((h + p) % (2n ** 256n)).toString(16).padStart(64, '0');
}
function localPosId(collateral: string, collId: string): bigint {
  return BigInt(ethers.utils.keccak256(ethers.utils.solidityPack(['address', 'bytes32'], [collateral, collId])));
}

// Getafe test case (all values from live API)
const API_COND_ID     = '0x59c40aaee58e8390355c868fd11e352a5e94d08fb3ebf23015171500422e0a74';
const DERIVED_COND_ID = '0xd12df1beb5bbd498c0af94b859c4e71fd4fad149a417605ecc4222a3a8dce56f'; // from negRisk.getConditionId
const YES_ASSET       = BigInt('81264206779664384809895025511852188809529769913292826981696063194796903488921');

// Multiple candidates for group questionId
const GROUP_CANDIDATES: Record<string, string> = {
  'negRiskMarketId':    '0xdd2e3f665cd9b4fac76a8cabf83eb92a4705022945dea8d45447e3e765f02800',
  'clobQuestionId':     '0xdd2e3f665cd9b4fac76a8cabf83eb92a4705022945dea8d45447e3e765f02802',
  'neg_risk_request_id':'0x002118dce4dfff586b869ab1b95fd691de118b66ea76f7d4d7669954186ccee7',
  'apiCondId':          API_COND_ID,
  'derivedCondId':      DERIVED_COND_ID,
};

async function main() {
  // Verify local formula matches CTF for a known case
  // apiCondId + HashZero + indexSet=1 should give posId=89016...
  const knownCollId  = localCollId(HASH_ZERO, API_COND_ID, 1);
  const knownPosId   = localPosId(USDC_E, knownCollId);
  console.log('Formula check (should be 89016...):');
  console.log('  computed:', knownPosId.toString().slice(0, 22) + '...');
  console.log('  expected: 89016732137360019841...\n');

  let matchFound = false;

  for (const [label, groupQId] of Object.entries(GROUP_CANDIDATES)) {
    for (let N = 2; N <= 60; N++) {
      // Derive group conditionId
      const groupCondId = ethers.utils.keccak256(
        ethers.utils.solidityPack(['address', 'bytes32', 'uint256'], [NEG_RISK, groupQId, N])
      );

      // Try every possible parentIndexSet (bitmask for each outcome slot)
      for (let pIdx = 0; pIdx < N && pIdx < 30; pIdx++) {
        const pIndexSet  = 1 << pIdx;
        const parentCollId = localCollId(HASH_ZERO, groupCondId, pIndexSet);

        // Case A: YES = direct outcome under parent, conditionId = apiCondId
        const collA  = localCollId(parentCollId, API_COND_ID, 1);
        const posIdA = localPosId(USDC_E, collA);
        if (posIdA === YES_ASSET) {
          console.log(`✅ MATCH A: groupQId=${label}  N=${N}  parentIndexSet=${pIndexSet}`);
          console.log(`   groupCondId=${groupCondId}`);
          console.log(`   parentCollId=${parentCollId}`);
          console.log(`   Call: CTF.redeemPositions(USDC_E, parentCollId, ${API_COND_ID}, [1])`);
          matchFound = true;
        }

        // Case B: YES = direct outcome under parent, conditionId = derivedCondId
        const collB  = localCollId(parentCollId, DERIVED_COND_ID, 1);
        const posIdB = localPosId(USDC_E, collB);
        if (posIdB === YES_ASSET) {
          console.log(`✅ MATCH B: groupQId=${label}  N=${N}  parentIndexSet=${pIndexSet}`);
          console.log(`   groupCondId=${groupCondId}`);
          console.log(`   parentCollId=${parentCollId}`);
          console.log(`   Call: CTF.redeemPositions(USDC_E, parentCollId, ${DERIVED_COND_ID}, [1])`);
          matchFound = true;
        }
      }

      // Case C: YES is a direct group outcome (no nested binary)
      for (let K = 0; K < N && K < 30; K++) {
        const collC  = localCollId(HASH_ZERO, groupCondId, 1 << K);
        const posIdC = localPosId(USDC_E, collC);
        if (posIdC === YES_ASSET) {
          console.log(`✅ MATCH C (direct group outcome): groupQId=${label}  N=${N}  K=${K}`);
          console.log(`   groupCondId=${groupCondId}`);
          console.log(`   Call: CTF.redeemPositions(USDC_E, HashZero, groupCondId, [${1 << K}])`);
          matchFound = true;
        }
      }
    }
  }

  if (!matchFound) {
    console.log('\n❌ No match found across all combinations.');
    console.log('These positions may require waiting for Polymarket oracle to call reportPayouts,');
    console.log('or use a different oracle address for the group condition.');
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
