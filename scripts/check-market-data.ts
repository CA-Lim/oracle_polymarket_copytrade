/**
 * 1. Fetches Polymarket gamma/clob API for market data (parentCollectionId, neg_risk_market_id)
 * 2. Probes negRiskAdapter with more function selectors to find group/parent info
 * 3. If we find the group conditionId, computes parentCollectionId and verifies positionId match
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const NEG_RISK = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF      = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E   = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const WALLET   = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';

const CTF_ABI = [
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external pure returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)',
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
];

// Getafe test case
const API_COND_ID = '0x59c40aaee58e8390355c868fd11e352a5e94d08fb3ebf23015171500422e0a74';
const YES_ASSET   = '81264206779664384809895025511852188809529769913292826981696063194796903488921';

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const ctf      = new ethers.Contract(CTF, CTF_ABI, provider);

  // 1. Fetch market data from Polymarket APIs
  console.log('=== Polymarket gamma API ===');
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/markets?conditionId=${API_COND_ID}`);
    const data = await r.json() as any[];
    if (data?.length) {
      const m = data[0];
      console.log('neg_risk:', m.negRisk);
      console.log('neg_risk_market_id:', m.negRiskMarketID);
      console.log('neg_risk_request_id:', m.negRiskRequestID);
      console.log('question_id:', m.questionID);
      console.log('group_item_threshold:', m.groupItemThreshold);
      console.log('Full market keys:', Object.keys(m).filter(k => k.toLowerCase().includes('neg') || k.toLowerCase().includes('group') || k.toLowerCase().includes('parent') || k.toLowerCase().includes('collection')));
    }
  } catch (e: any) { console.log('gamma API error:', e.message.slice(0, 80)); }

  // 2. Probe negRiskAdapter with more selectors
  console.log('\n=== More negRiskAdapter probes ===');
  const nr = new ethers.Contract(NEG_RISK, [
    'function getQuestion(bytes32 questionId) external view returns (bytes32, bool, uint256)',
    'function getGroupData(bytes32 groupId) external view returns (uint256, bool)',
    'function negRiskQuestions(bytes32 questionId) external view returns (bytes32 groupId, bool determined)',
    'function questions(bytes32 questionId) external view returns (uint256 index)',
  ], provider);

  for (const fn of ['getQuestion', 'negRiskQuestions']) {
    try {
      const r = await (nr as any)[fn](API_COND_ID);
      console.log(`✅ ${fn}(apiCondId) = ${JSON.stringify(r)}`);
    } catch (e: any) { console.log(`   ${fn}: ${e.message.slice(0,60)}`); }
  }

  // 3. Try raw low-level calls for common selector patterns
  console.log('\n=== Raw selector probes ===');
  const selectors: Record<string, string> = {
    'getGroupId(bytes32)':            ethers.utils.id('getGroupId(bytes32)').slice(0, 10),
    'questionGroups(bytes32)':         ethers.utils.id('questionGroups(bytes32)').slice(0, 10),
    'getParent(bytes32)':             ethers.utils.id('getParent(bytes32)').slice(0, 10),
    'parentCollections(bytes32)':      ethers.utils.id('parentCollections(bytes32)').slice(0, 10),
    'getQuestionGroupId(bytes32)':     ethers.utils.id('getQuestionGroupId(bytes32)').slice(0, 10),
  };
  const encoded = ethers.utils.defaultAbiCoder.encode(['bytes32'], [API_COND_ID]);
  for (const [name, sel] of Object.entries(selectors)) {
    try {
      const result = await provider.call({ to: NEG_RISK, data: sel + encoded.slice(2) });
      if (result !== '0x' && result !== '0x' + '0'.repeat(64)) {
        console.log(`✅ ${name} = ${result}`);
      }
    } catch {}
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
