import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const NEG_RISK = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
  const CTF      = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
  const USDC     = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  const wallet   = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
  const abi = ['function redeemPositions(address,bytes32,bytes32,uint256[]) external'];

  const conditions = [
    { title: 'Bournemouth',    id: '0xe068813cdcbd7f933818fa8ee81b4609a99238febf2c363ab9fc0d893ca7469d' },
    { title: 'Atletico',       id: '0x8aa2f0b3b9edd1b07163286d3159c3a501d94cf0808841d5274336c68b1f7d44' },
    { title: 'Getafe',         id: '0x59c40aaee58e8390355c868fd11e352a5e94d08fb3ebf23015171500422e0a74' },
    { title: 'Ulsan',          id: '0x8f3beedac1019a960f93741a8eff789701d28990836c362e697b176a9eb55960' },
    { title: 'Liaoning draw',  id: '0x84364834ded07234ffda054d6bc8ce5bca7ff77d906f280ef03309052e5bca80' },
    { title: 'Daejeon',        id: '0x55ad20d8f1134c715125a05b6fc44f1a9567e7c5bbc8ade4f0a2f0ef1670a90e' },
    { title: 'FC Porto',       id: '0x0b16581de8e856273ed232e960219b070aeb279cbbeefd22602b2174ca67c788' },
    { title: 'Preston',        id: '0x6ff59389925508fb576af18fe576c729e0384a0584734cfe6b82e122e4e48a19' },
    { title: 'Dalian',         id: '0xc7471f269a1f8749d87f9269fdfe0a2596b5da2e98d61a98e7f743b5ed63ed42' },
    { title: 'Tigres',         id: '0xb0675e0c6da647a28150e4e0fdb8e1bb2b57cc52e68a18fee0d1d48c1c73a9e5' },
    { title: 'Atlanta United', id: '0x8d209b22e1fd10dcb415f2f1c5b43f1c26e0a3f93b34cb61fd72cf6e5f9e1c2a' },
    { title: 'Toronto FC',     id: '0xa76747519418158768a12e5f5b7b38c31d4b5e58d394d6b69dd6e3c0f20c7b44' },
    { title: 'Sheffield',      id: '0x91f0e7afa0504733b9e42f6939e53728ea6e66c55cc36ddfa9e907dd9d9ff658' },
    { title: 'Birmingham',     id: '0xdc6d2f94f7b6d693c7d910a65f50ae117e9e5d02f46ec5f8c845872f55f8d45a' },
    { title: 'Cardiff',        id: '0xa08c11f2261e4f79ec2b4f33d7f755bef6b19d5c9a04650bb943e0b0bce6c85f' },
    { title: 'Atalanta',       id: '0x64f04fdd39193064a1a60fd3408f77a3143423ad272c1d97714d7e9b6d1066d1' },
    { title: 'Real Sociedad',  id: '0xf7774c1abc013938e05b8a2073e0cf9876612ae49fb2fe828953675042ee4190' },
  ];

  const negRisk = new ethers.Contract(NEG_RISK, abi, provider);
  const ctf     = new ethers.Contract(CTF, abi, provider);

  for (const c of conditions) {
    let negOk = false, ctfOk = false;
    try { await negRisk.callStatic.redeemPositions(USDC, ethers.constants.HashZero, c.id, [1,2], { from: wallet }); negOk = true; } catch {}
    try { await ctf.callStatic.redeemPositions(USDC, ethers.constants.HashZero, c.id, [1,2], { from: wallet }); ctfOk = true; } catch {}
    const status = negOk ? '✅ negRisk' : ctfOk ? '✅ CTF   ' : '❌ blocked';
    console.log(`${status}  ${c.title}`);
  }
}
main().catch(e => console.error(e.message));
