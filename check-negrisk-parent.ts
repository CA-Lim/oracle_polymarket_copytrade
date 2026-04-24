/**
 * Probes the negRiskAdapter for parentCollectionId and attempts CTF redemption
 * with the correct parameters for YES-winning positions.
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const WALLET   = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
const NEG_RISK = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF      = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E   = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const CTF_ABI = [
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external pure returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)',
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
];

const NEG_RISK_ABI = [
  'function getConditionId(bytes32 questionId) external view returns (bytes32)',
  // Try to get parent collection via various possible function signatures
  'function getParentCollectionId(bytes32 questionId) external view returns (bytes32)',
  'function parentCollectionId() external view returns (bytes32)',
  'function getQuestionData(bytes32 questionId) external view returns (uint256, uint256, uint256, bytes32, bytes32, bool, bool)',
  'function groupData(bytes32 groupId) external view returns (uint256)',
  'function questions(bytes32 questionId) external view returns (bytes32 groupId, bool determined)',
];

// Use Getafe as the test case
const API_COND_ID = '0x59c40aaee58e8390355c868fd11e352a5e94d08fb3ebf23015171500422e0a74';
const YES_ASSET   = '81264206779664384809895025511852188809529769913292826981696063194796903488921';

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const ctf      = new ethers.Contract(CTF,      CTF_ABI,      provider);
  const negRisk  = new ethers.Contract(NEG_RISK, NEG_RISK_ABI, provider);

  console.log('=== Probing negRiskAdapter functions ===\n');

  // Try each potential function
  for (const fn of ['getParentCollectionId', 'parentCollectionId', 'getQuestionData', 'questions']) {
    try {
      const result = fn === 'parentCollectionId'
        ? await (negRisk as any)[fn]()
        : await (negRisk as any)[fn](API_COND_ID);
      console.log(`✅ ${fn}(apiCondId) = ${JSON.stringify(result)}`);
    } catch (e: any) {
      console.log(`   ${fn}: ${e.message.slice(0, 80)}`);
    }
  }

  // Try to derive parentCollectionId from derived conditionId
  const derivedCondId = await negRisk.getConditionId(API_COND_ID);
  console.log(`\nderived CTF conditionId: ${derivedCondId}`);

  // The YES token must satisfy: positionId = getPositionId(USDC_E, getCollectionId(parent, apiCondId, 1))
  // Try a few candidate parents derived from the negRiskAdapter itself
  const candidates = [
    { label: 'HashZero',             val: ethers.constants.HashZero },
    { label: 'derivedCondId as parent', val: derivedCondId },
    { label: 'keccak256(derivedCondId)', val: ethers.utils.keccak256(derivedCondId) },
    { label: 'keccak256(apiCondId)',     val: ethers.utils.keccak256(API_COND_ID) },
    { label: 'NEG_RISK_addr as bytes32', val: ethers.utils.hexZeroPad(NEG_RISK, 32) },
  ];

  console.log('\n=== Trying parentCollectionId candidates for YES (indexSet=1) ===');
  for (const c of candidates) {
    const collId = await ctf.getCollectionId(c.val, API_COND_ID, 1);
    const posId  = await ctf.getPositionId(USDC_E, collId);
    const match  = posId.toBigInt() === BigInt(YES_ASSET);
    console.log(`${match ? '✅ MATCH' : '   '}  ${c.label}  posId=${posId.toString().slice(0, 22)}...`);
    if (match) console.log(`       parentCollectionId = ${c.val}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
