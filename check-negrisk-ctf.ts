/**
 * 1. Find the CTF address the negRiskAdapter actually uses
 * 2. Check if derived conditionIds are resolved on that CTF
 * 3. Try positionId match with derived conditionId + non-HashZero parents
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const WALLET   = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
const NEG_RISK = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF_OLD  = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E   = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const CTF_ABI = [
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external pure returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) external view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256)',
];

const NEG_RISK_ABI = [
  'function ctf() external view returns (address)',
  'function col() external view returns (address)',
  'function getConditionId(bytes32 questionId) external view returns (bytes32)',
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
];

const cases = [
  { title: 'Getafe',     apiCondId: '0x59c40aaee58e8390355c868fd11e352a5e94d08fb3ebf23015171500422e0a74',  asset: '81264206779664384809193742007700082726449979022895745059918855547249234044776' },
  { title: 'Birmingham', apiCondId: '0xdc6d2f94f7b6d693c7d910a65f50ae117e9e5d02f46ec5f8c845872f55f8d45a', asset: '25499824980131532132948948530893067753741869748266327513614399561020449337671' },
];

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const negRisk  = new ethers.Contract(NEG_RISK, NEG_RISK_ABI, provider);

  // Find actual CTF and collateral addresses used by negRiskAdapter
  let ctfAddr = CTF_OLD;
  let colAddr = USDC_E;
  try {
    ctfAddr = await negRisk.ctf();
    console.log(`negRiskAdapter.ctf() = ${ctfAddr}`);
  } catch { console.log(`negRiskAdapter.ctf() not available, using ${CTF_OLD}`); }
  try {
    colAddr = await negRisk.col();
    console.log(`negRiskAdapter.col() = ${colAddr}`);
  } catch { console.log(`negRiskAdapter.col() not available, using ${USDC_E}`); }

  const ctf = new ethers.Contract(ctfAddr, CTF_ABI, provider);

  for (const c of cases) {
    console.log(`\n=== ${c.title} ===`);
    const derivedCondId = await negRisk.getConditionId(c.apiCondId);
    console.log(`derived CTF conditionId: ${derivedCondId}`);

    // Check if derived conditionId is resolved
    const denom = await ctf.payoutDenominator(derivedCondId);
    console.log(`resolved: ${!denom.isZero()}  (denominator=${denom.toString()})`);
    if (!denom.isZero()) {
      const p0 = await ctf.payoutNumerators(derivedCondId, 0);
      const p1 = await ctf.payoutNumerators(derivedCondId, 1);
      console.log(`payouts: [${p0}, ${p1}]`);
    }

    // Check balance of actual asset at both CTF contracts
    const ctfOld = new ethers.Contract(CTF_OLD, CTF_ABI, provider);
    const balOld = await ctfOld.balanceOf(WALLET, c.asset);
    const balNew = ctfAddr !== CTF_OLD ? await ctf.balanceOf(WALLET, c.asset) : balOld;
    console.log(`YES token balance — CTF_OLD: ${balOld.toString()}  CTF_new: ${ctfAddr !== CTF_OLD ? balNew.toString() : 'same'}`);

    // Try positionId with derived conditionId + colAddr + HashZero
    for (const indexSet of [1, 2]) {
      const collId = await ctf.getCollectionId(ethers.constants.HashZero, derivedCondId, indexSet);
      const posId  = await ctf.getPositionId(colAddr, collId);
      const match  = posId.toBigInt() === BigInt(c.asset);
      const bal    = await ctf.balanceOf(WALLET, posId);
      if (match || !bal.isZero()) {
        console.log(`✅ indexSet=${indexSet} posId=${posId.toString().slice(0,20)}... bal=${bal}  ${match ? 'MATCH' : ''}`);
      }
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
