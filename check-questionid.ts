/**
 * The gamma API returned questionId=0x74dcd73f... for Getafe.
 * Test if this is the correct CTF conditionId for redemption.
 * Also fetch questionIds for all 5 YES positions and try to redeem via callStatic.
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const WALLET  = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
const CTF     = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E  = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const CTF_ABI = [
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external pure returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)',
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) external view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];

const positions = [
  { title: 'Getafe',     apiCondId: '0x59c40aaee58e8390355c868fd11e352a5e94d08fb3ebf23015171500422e0a74' },
  { title: 'Birmingham', apiCondId: '0xdc6d2f94f7b6d693c7d910a65f50ae117e9e5d02f46ec5f8c845872f55f8d45a' },
  { title: 'Cardiff',    apiCondId: '0xa08c11f2261e4f79ec2b4f33d7f755bef6b19d5c9a04650bb943e0b0bce6c85f' },
  { title: 'Flamengo',   apiCondId: '0xe9fc4edd6b22ae56ae53b9788597bc2fd4c86d611a8ea31136690a96904fafa3' },
  { title: 'Dalian',     apiCondId: '0xc7471f269a1f8749d87f9269fdfe0a2596b5da2e98d61a98e7f743b5ed63ed42' },
];

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const ctf      = new ethers.Contract(CTF, CTF_ABI, provider);

  // Fetch live YES assets from API
  const res = await fetch(`https://data-api.polymarket.com/positions?user=${WALLET}&sizeThreshold=0`);
  const allPositions: any[] = await res.json();

  for (const p of positions) {
    const pos = allPositions.find(x => x.conditionId === p.apiCondId && x.outcomeIndex === 0);
    if (!pos) { console.log(`${p.title}: not found in API`); continue; }

    const yesAsset = BigInt(String(pos.asset));
    const balance  = await ctf.balanceOf(WALLET, yesAsset);

    // Fetch questionId from gamma API
    const gRes  = await fetch(`https://gamma-api.polymarket.com/markets?conditionId=${p.apiCondId}`);
    const gData = await gRes.json() as any[];
    const questionId = gData?.[0]?.questionID ?? null;

    console.log(`\n${p.title}`);
    console.log(`  YES balance:  ${balance.toString()} (~${parseFloat(ethers.utils.formatUnits(balance, 6)).toFixed(4)})`);
    console.log(`  apiCondId:    ${p.apiCondId}`);
    console.log(`  questionId:   ${questionId}`);

    if (!questionId) { console.log('  no questionId from gamma API'); continue; }

    // Check if questionId is a valid CTF conditionId
    const denom = await ctf.payoutDenominator(questionId);
    console.log(`  questionId resolved in CTF: ${!denom.isZero()}`);
    if (!denom.isZero()) {
      const p0 = await ctf.payoutNumerators(questionId, 0);
      const p1 = await ctf.payoutNumerators(questionId, 1);
      console.log(`  payouts: [${p0}, ${p1}]`);
    }

    // Test if positionId(USDC_E, HashZero, questionId, 1) matches YES asset
    const collId = await ctf.getCollectionId(ethers.constants.HashZero, questionId, 1);
    const posId  = await ctf.getPositionId(USDC_E, collId);
    const match  = posId.toBigInt() === yesAsset;
    console.log(`  posId(USDC_E, HashZero, questionId, 1): ${match ? '✅ MATCH' : `❌ ${posId.toString().slice(0,22)}...`}`);

    if (match && !denom.isZero()) {
      // Try callStatic
      try {
        await ctf.callStatic.redeemPositions(USDC_E, ethers.constants.HashZero, questionId, [1], { from: WALLET });
        console.log(`  ✅ callStatic passed — ready to redeem!`);
      } catch (e: any) {
        console.log(`  ❌ callStatic failed: ${e.reason ?? e.message.slice(0, 80)}`);
      }
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
