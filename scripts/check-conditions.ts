import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
  const abi = ['function payoutDenominator(bytes32 conditionId) view returns (uint256)'];
  const ctf = new ethers.Contract(CTF, abi, provider);
  const conditions = [
    { title: 'Bournemouth', id: '0xe068813cdcbd7f933818fa8ee81b4609a99238febf2c363ab9fc0d893ca7469d' },
    { title: 'Atletico',    id: '0x8aa2f0b3b9edd1b07163286d3159c3a501d94cf0808841d5274336c68b1f7d44' },
    { title: 'Cardiff',     id: '0xa08c11f2261e4f79ec2b4f33d7f755bef6b19d5c9a04650bb943e0b0bce6c85f' },
    { title: 'Birmingham',  id: '0xdc6d2f94f7b6d693c7d910a65f50ae117e9e5d02f46ec5f8c845872f55f8d45a' },
    { title: 'Sheffield',   id: '0x91f0e7afa0504733b9e42f6939e53728ea6e66c55cc36ddfa9e907dd9d9ff658' },
  ];
  for (const c of conditions) {
    const d = await ctf.payoutDenominator(c.id);
    console.log(c.title + ': payoutDenominator=' + d.toString() + (d.gt(0) ? ' ✅ resolved' : ' ❌ NOT resolved on-chain'));
  }
}
main().catch(e => console.error(e.message));
