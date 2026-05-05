import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const NEG_RISK = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
  const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

  // Try redeemPositions on the negRiskAdapter with same signature as CTF
  const abi = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  ];
  const negRisk = new ethers.Contract(NEG_RISK, abi, provider);

  // Static call to see if it would succeed (no gas spent)
  try {
    await negRisk.callStatic.redeemPositions(
      USDC,
      ethers.constants.HashZero,
      '0xe068813cdcbd7f933818fa8ee81b4609a99238febf2c363ab9fc0d893ca7469d', // Bournemouth
      [1, 2],
      { from: wallet.address },
    );
    console.log('✅ redeemPositions(USDC, HashZero, conditionId, [1,2]) would SUCCEED on negRiskAdapter');
  } catch(e: any) {
    console.log('❌ standard redeemPositions failed:', e.message.slice(0, 120));
  }

  // Try with just indexSet 2 (the NO slot)
  try {
    await negRisk.callStatic.redeemPositions(
      USDC, ethers.constants.HashZero,
      '0xe068813cdcbd7f933818fa8ee81b4609a99238febf2c363ab9fc0d893ca7469d',
      [2],
      { from: wallet.address },
    );
    console.log('✅ redeemPositions(USDC, HashZero, conditionId, [2]) would SUCCEED');
  } catch(e: any) {
    console.log('❌ indexSet [2] only failed:', e.message.slice(0, 120));
  }
}
main().catch(e => console.error(e.message));
