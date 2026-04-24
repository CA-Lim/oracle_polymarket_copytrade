/**
 * Fetches YES positions directly from the Polymarket API and checks on-chain
 * balance using the raw `asset` string — avoids any hardcoded precision issues.
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const WALLET = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
const CTF    = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_ABI = ['function balanceOf(address account, uint256 id) external view returns (uint256)'];

const YES_CONDITION_IDS = [
  '0x59c40aaee58e8390355c868fd11e352a5e94d08fb3ebf23015171500422e0a74',  // Getafe
  '0xdc6d2f94f7b6d693c7d910a65f50ae117e9e5d02f46ec5f8c845872f55f8d45a', // Birmingham
  '0xa08c11f2261e4f79ec2b4f33d7f755bef6b19d5c9a04650bb943e0b0bce6c85f', // Cardiff
  '0xe9fc4edd6b22ae56ae53b9788597bc2fd4c86d611a8ea31136690a96904fafa3', // Flamengo
  '0xc7471f269a1f8749d87f9269fdfe0a2596b5da2e98d61a98e7f743b5ed63ed42', // Dalian
];

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const ctf      = new ethers.Contract(CTF, CTF_ABI, provider);

  const res       = await fetch(`https://data-api.polymarket.com/positions?user=${WALLET}&sizeThreshold=0`);
  const positions = await res.json() as any[];

  const targets = positions.filter(p => YES_CONDITION_IDS.includes(p.conditionId));
  console.log(`Found ${targets.length} YES positions in API\n`);

  for (const p of targets) {
    console.log(`${p.title?.slice(0, 60)}`);
    console.log(`  conditionId : ${p.conditionId}`);
    console.log(`  asset (raw) : ${p.asset}`);
    console.log(`  outcomeIndex: ${p.outcomeIndex}  outcome: ${p.outcome}`);
    console.log(`  API size    : ${p.size}  curPrice: ${p.curPrice}  redeemable: ${p.redeemable}`);

    // Use asset as a string directly — avoid float precision loss
    const assetBN = ethers.BigNumber.from(String(p.asset));
    const balance = await ctf.balanceOf(WALLET, assetBN);
    console.log(`  on-chain bal: ${balance.toString()} (~${parseFloat(ethers.utils.formatUnits(balance, 6)).toFixed(4)} shares)`);
    console.log();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
