import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
  const abi = [
    'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  ];
  const ctf = new ethers.Contract(CTF, abi, provider);
  const conditions = [
    { title: 'Bournemouth No (we hold slot?)', id: '0xe068813cdcbd7f933818fa8ee81b4609a99238febf2c363ab9fc0d893ca7469d' },
    { title: 'Atletico No',                    id: '0x8aa2f0b3b9edd1b07163286d3159c3a501d94cf0808841d5274336c68b1f7d44' },
    { title: 'Cardiff Yes',                    id: '0xa08c11f2261e4f79ec2b4f33d7f755bef6b19d5c9a04650bb943e0b0bce6c85f' },
  ];
  for (const c of conditions) {
    const [n0, n1, denom] = await Promise.all([
      ctf.payoutNumerators(c.id, 0),
      ctf.payoutNumerators(c.id, 1),
      ctf.payoutDenominator(c.id),
    ]);
    console.log(`${c.title}`);
    console.log(`  slot0 (YES/first): ${n0}/${denom}  slot1 (NO/second): ${n1}/${denom}`);
  }
}
main().catch(e => console.error(e.message));
