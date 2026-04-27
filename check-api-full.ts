/**
 * Dumps full gamma + CLOB API data for Getafe to find parentCollectionId clues.
 * Also queries the CTF ConditionPreparation event for the apiCondId.
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const CTF     = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const API_COND = '0x59c40aaee58e8390355c868fd11e352a5e94d08fb3ebf23015171500422e0a74';
const WALLET  = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
const USDC_E  = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
// YES asset for Getafe (from live API, full precision)
const YES_ASSET = BigInt('81264206779664384809895025511852188809529769913292826981696063194796903488921');

const CTF_ABI = [
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external pure returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)',
];

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const ctf = new ethers.Contract(CTF, CTF_ABI, provider);

  // 1. Full gamma API response
  console.log('=== Gamma API full response ===');
  const gRes  = await fetch(`https://gamma-api.polymarket.com/markets?conditionId=${API_COND}`);
  const gData = await gRes.json() as any[];
  const m     = gData?.[0];
  if (m) {
    for (const [k, v] of Object.entries(m)) {
      if (v !== null && v !== '' && v !== false && v !== 0) {
        console.log(`  ${k}: ${JSON.stringify(v)}`);
      }
    }
  }

  // 2. CLOB API
  console.log('\n=== CLOB API ===');
  try {
    const cRes  = await fetch(`https://clob.polymarket.com/markets/${API_COND}`);
    const cData = await cRes.json() as any;
    console.log(JSON.stringify(cData, null, 2).slice(0, 2000));
  } catch (e: any) { console.log('CLOB error:', e.message); }

  // 3. Try negRiskOther/negRiskRequestID as conditionId candidates
  console.log('\n=== Try negRisk fields as group conditionId ===');
  const candidateCondIds: string[] = [];
  if (m?.negRiskOther)     candidateCondIds.push(m.negRiskOther);
  if (m?.negRiskRequestID) candidateCondIds.push(m.negRiskRequestID);
  if (m?.questionID)       candidateCondIds.push(m.questionID);

  for (const cid of candidateCondIds) {
    console.log(`\nTrying: ${cid}`);
    for (let K = 0; K < 20; K++) {
      const indexSet = 1 << K;
      try {
        // Case A: YES token is direct outcome K of this condition
        const collIdA = await ctf.getCollectionId(ethers.constants.HashZero, cid, indexSet);
        const posIdA  = await ctf.getPositionId(USDC_E, collIdA);
        if (posIdA.toBigInt() === YES_ASSET) {
          console.log(`  ✅ CASE A MATCH: condId=${cid}  K=${K}  indexSet=${indexSet}`);
        }
      } catch {}

      try {
        // Case B: YES token is binary YES under parentCollId = getCollectionId(HashZero, cid, K)
        const parentCollId = await ctf.getCollectionId(ethers.constants.HashZero, cid, indexSet);
        const collIdB      = await ctf.getCollectionId(parentCollId, API_COND, 1);
        const posIdB       = await ctf.getPositionId(USDC_E, collIdB);
        if (posIdB.toBigInt() === YES_ASSET) {
          console.log(`  ✅ CASE B MATCH: groupCondId=${cid}  K=${K}  parentCollId=${parentCollId}`);
        }
      } catch {}
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
