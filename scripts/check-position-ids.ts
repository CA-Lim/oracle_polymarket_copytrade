import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
  const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  const abi = [
    'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
    'function getPositionId(address collateralToken, bytes32 collectionId) pure returns (uint256)',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
  ];
  const ctf = new ethers.Contract(CTF, abi, provider);
  const wallet = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';

  const cases = [
    { title: 'Bournemouth', conditionId: '0xe068813cdcbd7f933818fa8ee81b4609a99238febf2c363ab9fc0d893ca7469d', apiAsset: '58143018192488982732556002004047817589427905076553532335924433576396244620758', outcome: 'No' },
    { title: 'Cardiff',     conditionId: '0xa08c11f2261e4f79ec2b4f33d7f755bef6b19d5c9a04650bb943e0b0bce6c85f', apiAsset: '46054249237466132571546742007664193299022364933265161758169543112147455889560', outcome: 'Yes' },
  ];

  for (const c of cases) {
    console.log(`\n=== ${c.title} (${c.outcome}) ===`);
    console.log(`  API asset ID: ${c.apiAsset}`);
    // Check both indexSets
    for (const indexSet of [1, 2]) {
      const collectionId = await ctf.getCollectionId(ethers.constants.HashZero, c.conditionId, indexSet);
      const positionId = await ctf.getPositionId(USDC, collectionId);
      const bal = await ctf.balanceOf(wallet, positionId);
      const match = positionId.toString() === c.apiAsset ? ' ← MATCH' : '';
      console.log(`  indexSet=${indexSet}: positionId=${positionId.toString()} bal=${bal.toString()}${match}`);
    }
    // Check if API asset has a balance
    const apiBal = await ctf.balanceOf(wallet, c.apiAsset);
    console.log(`  API asset balance in wallet: ${apiBal.toString()}`);
  }
}
main().catch(e => console.error(e.message));
