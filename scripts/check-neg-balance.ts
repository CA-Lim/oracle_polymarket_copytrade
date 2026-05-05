import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const NEG_RISK = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
  const wallet   = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';
  const USDC     = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  const abi = ['function balanceOf(address account, uint256 id) view returns (uint256)'];
  const erc20 = ['function balanceOf(address) view returns (uint256)'];
  const negRisk = new ethers.Contract(NEG_RISK, abi, provider);
  const usdc    = new ethers.Contract(USDC, erc20, provider);

  // Check Getafe Yes token — the one that just "redeemed" for $0
  const getafeAsset = '81264206779664384809895025511852188809529769913292826981696063194796903488921';
  const bal = await negRisk.balanceOf(wallet, getafeAsset);
  const usdcBal = await usdc.balanceOf(wallet);
  console.log('Getafe Yes token balance (negRiskAdapter):', bal.toString());
  console.log('Getafe Yes token (raw):', ethers.utils.formatUnits(bal, 0), 'units');
  console.log('USDC wallet balance:', ethers.utils.formatUnits(usdcBal, 6));

  // Also check if negRiskAdapter holds USDC  
  const negRiskUsdcBal = await usdc.balanceOf(NEG_RISK);
  console.log('negRiskAdapter USDC balance:', ethers.utils.formatUnits(negRiskUsdcBal, 6));
}
main().catch(e => console.error(e.message));
