import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
  const wallet = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
  const abi = ['function balanceOf(address account, uint256 id) view returns (uint256)'];
  const ctf = new ethers.Contract(CTF, abi, provider);
  const assets = [
    { title: 'Bournemouth No', id: '58143018192488982732556002004047817589427905076553532335924433576396244620758' },
    { title: 'Atletico No',    id: '32970592838518231857960834683525212992911465765611987905622054312859827533999' },
    { title: 'Cardiff Yes',    id: '46054249237466132571546742007664193299022364933265161758169543112147455889560' },
  ];
  for (const a of assets) {
    const b = await ctf.balanceOf(wallet, a.id);
    console.log(a.title + ': ' + b.toString() + ' tokens');
  }
}
main().catch(e => console.error(e.message));
