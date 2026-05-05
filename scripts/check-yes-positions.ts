import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const CTF    = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const WALLET = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';

const CTF_ABI = [
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) external view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256)',
];

const positions = [
  { title: 'Getafe',     conditionId: '0x59c40aaee58e8390355c868fd11e352a5e94d08fb3ebf23015171500422e0a74',  asset: '81264206779664384809193742007700082726449979022895745059918855547249234044776' },
  { title: 'Birmingham', conditionId: '0xdc6d2f94f7b6d693c7d910a65f50ae117e9e5d02f46ec5f8c845872f55f8d45a', asset: '25499824980131532132948948530893067753741869748266327513614399561020449337671' },
  { title: 'Cardiff',    conditionId: '0xa08c11f2261e4f79ec2b4f33d7f755bef6b19d5c9a04650bb943e0b0bce6c85f',  asset: '46054249237466132571982477027498451481867649893530200350879278742034497764376' },
  { title: 'Flamengo',   conditionId: '0xe9fc4edd6b22ae56ae53b9788597bc2fd4c86d611a8ea31136690a96904fafa3',  asset: '10549382228821336104367403375726975753459082765720609437093424640012024785097' },
  { title: 'Dalian',     conditionId: '0xc7471f269a1f8749d87f9269fdfe0a2596b5da2e98d61a98e7f743b5ed63ed42',  asset: '10523804029439676324987539748665929800803680434718399126127888889618617095756' },
];

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const ctf = new ethers.Contract(CTF, CTF_ABI, provider);

  for (const p of positions) {
    const bal   = await ctf.balanceOf(WALLET, p.asset);
    const denom = await ctf.payoutDenominator(p.conditionId);
    const payouts: string[] = [];
    for (let i = 0; i < 2; i++) {
      try { payouts.push((await ctf.payoutNumerators(p.conditionId, i)).toString()); }
      catch { payouts.push('err'); }
    }
    console.log(`\n${p.title}`);
    console.log(`  YES balance:      ${bal.toString()} (~${parseFloat(ethers.utils.formatUnits(bal, 6)).toFixed(2)} shares)`);
    console.log(`  payoutDenominator: ${denom.toString()}`);
    console.log(`  payoutNumerators:  [${payouts.join(', ')}]`);
    console.log(`  resolved: ${!denom.isZero()}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
