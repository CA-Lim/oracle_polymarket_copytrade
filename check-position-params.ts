/**
 * Computes CTF positionId for different (collateral, parentCollectionId) combos
 * to find which set of params matches the actual YES token we hold (p.asset).
 * Once we find the match, we know the correct CTF.redeemPositions call.
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const USDC_E      = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const NEG_RISK    = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF         = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// Getafe condition and YES asset
const CONDITION_ID = '0x59c40aaee58e8390355c868fd11e352a5e94d08fb3ebf23015171500422e0a74';
const ACTUAL_ASSET = BigInt('81264206779664384809193742007700082726449979022895745059918855547249234044776');

const CTF_ABI = [
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external pure returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)',
];

async function tryCombo(ctf: ethers.Contract, label: string, collateral: string, parent: string, indexSet: number) {
  try {
    const collectionId = await ctf.getCollectionId(parent, CONDITION_ID, indexSet);
    const positionId   = await ctf.getPositionId(collateral, collectionId);
    const match = positionId.toBigInt() === ACTUAL_ASSET;
    console.log(`${match ? '✅ MATCH' : '   '}  ${label}  indexSet=${indexSet}  posId=${positionId.toString().slice(0,20)}...`);
    if (match) {
      console.log(`       collateral: ${collateral}`);
      console.log(`       parent:     ${parent}`);
      console.log(`       collectionId: ${collectionId}`);
    }
  } catch (e: any) {
    console.log(`   ERROR  ${label}: ${e.message.slice(0,60)}`);
  }
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const ctf = new ethers.Contract(CTF, CTF_ABI, provider);

  console.log(`Looking for positionId: ${ACTUAL_ASSET.toString().slice(0,20)}...`);
  console.log(`ConditionId: ${CONDITION_ID}\n`);

  for (const indexSet of [1, 2]) {
    await tryCombo(ctf, 'USDC.e + HashZero',     USDC_E,      ethers.constants.HashZero, indexSet);
    await tryCombo(ctf, 'USDC native + HashZero', USDC_NATIVE, ethers.constants.HashZero, indexSet);
    await tryCombo(ctf, 'negRiskAdapter + HashZero', NEG_RISK, ethers.constants.HashZero, indexSet);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
