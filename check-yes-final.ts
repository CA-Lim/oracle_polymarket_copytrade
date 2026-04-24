/**
 * 1. Check who holds the YES tokens now (wallet vs negRiskAdapter vs burned)
 * 2. Fetch current Polymarket API positions to see if they're still redeemable
 * 3. Try to find the correct CTF parentCollectionId by brute-forcing the negRiskAdapter's internal questionId
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const WALLET   = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
const NEG_RISK = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF      = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E   = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const CTF_ABI = [
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external pure returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)',
];

const NEG_RISK_ABI = [
  'function getConditionId(bytes32 questionId) external view returns (bytes32)',
  'function redeemPositions(bytes32 _conditionId, uint256[] calldata _amounts) public',
];

const cases = [
  { title: 'Getafe',     apiConditionId: '0x59c40aaee58e8390355c868fd11e352a5e94d08fb3ebf23015171500422e0a74',  asset: '81264206779664384809193742007700082726449979022895745059918855547249234044776' },
  { title: 'Birmingham', apiConditionId: '0xdc6d2f94f7b6d693c7d910a65f50ae117e9e5d02f46ec5f8c845872f55f8d45a', asset: '25499824980131532132948948530893067753741869748266327513614399561020449337671' },
  { title: 'Cardiff',    apiConditionId: '0xa08c11f2261e4f79ec2b4f33d7f755bef6b19d5c9a04650bb943e0b0bce6c85f',  asset: '46054249237466132571982477027498451481867649893530200350879278742034497764376' },
  { title: 'Flamengo',   apiConditionId: '0xe9fc4edd6b22ae56ae53b9788597bc2fd4c86d611a8ea31136690a96904fafa3',  asset: '10549382228821336104367403375726975753459082765720609437093424640012024785097' },
  { title: 'Dalian',     apiConditionId: '0xc7471f269a1f8749d87f9269fdfe0a2596b5da2e98d61a98e7f743b5ed63ed42',  asset: '10523804029439676324987539748665929800803680434718399126127888889618617095756' },
];

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const ctf      = new ethers.Contract(CTF,      CTF_ABI,      provider);
  const negRisk  = new ethers.Contract(NEG_RISK, NEG_RISK_ABI, provider);

  // 1. Check token balances: wallet vs negRiskAdapter
  console.log('=== Token Balances ===');
  for (const c of cases) {
    const walletBal  = await ctf.balanceOf(WALLET,   c.asset);
    const adapterBal = await ctf.balanceOf(NEG_RISK, c.asset);
    console.log(`${c.title}: wallet=${walletBal.toString()}  negRiskAdapter=${adapterBal.toString()}`);
  }

  // 2. Check if negRiskAdapter exposes getConditionId
  console.log('\n=== negRiskAdapter.getConditionId ===');
  for (const c of cases) {
    try {
      const ctfCondId = await negRisk.getConditionId(c.apiConditionId);
      console.log(`${c.title}: ctfConditionId=${ctfCondId}`);
      // Try positionId with this derived CTF conditionId
      const collId = await ctf.getCollectionId(ethers.constants.HashZero, ctfCondId, 1);
      const posId  = await ctf.getPositionId(USDC_E, collId);
      const match  = posId.toBigInt() === BigInt(c.asset);
      console.log(`  posId(USDC.e, HashZero, derivedCondId, 1) = ${posId.toString().slice(0,20)}... ${match ? '✅ MATCH' : '❌ no match'}`);
    } catch (e: any) {
      console.log(`${c.title}: getConditionId not available — ${e.message.slice(0,60)}`);
    }
  }

  // 3. Current Polymarket API positions
  console.log('\n=== Polymarket API (current) ===');
  const res = await fetch(`https://data-api.polymarket.com/positions?user=${WALLET}&sizeThreshold=0`);
  const positions: any[] = await res.json();
  for (const c of cases) {
    const p = positions.find((x: any) => x.conditionId === c.apiConditionId);
    if (p) {
      console.log(`${c.title}: size=${p.size}  curPrice=${p.curPrice}  redeemable=${p.redeemable}  currentValue=${p.currentValue}`);
    } else {
      console.log(`${c.title}: NOT in API response (possibly already fully redeemed)`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
