import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const usdc = new ethers.Contract('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', ['function balanceOf(address) view returns (uint256)'], provider);
  const bal = await usdc.balanceOf(wallet.address);
  const pending = await provider.getTransactionCount(wallet.address, 'pending');
  const confirmed = await provider.getTransactionCount(wallet.address, 'latest');
  console.log('Wallet:', wallet.address);
  console.log('USDC balance:', ethers.utils.formatUnits(bal, 6));
  console.log('Pending txs:', pending - confirmed);
}
main().catch(e => console.error(e.message));
