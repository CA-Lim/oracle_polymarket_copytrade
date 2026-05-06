import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const RPC      = 'https://polygon-bor.publicnode.com';
const CTF      = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const WCOL     = '0x3A3BD7bb9528E159577F7C2e685CC81A765002E2';
const USDC_E   = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const conditionId = '0x069189619c7ae96da2abd767071f659190af6cadf9ef1c0b875f99268b5b4ebe';

const CTF_ABI = [
  'function payoutDenominator(bytes32) external view returns (uint256)',
  'function payoutNumerators(bytes32, uint256) external view returns (uint256)',
  'function getCollectionId(bytes32, bytes32, uint256) external view returns (bytes32)',
  'function getPositionId(address, bytes32) external pure returns (uint256)',
  'function balanceOf(address, uint256) external view returns (uint256)',
];

async function main() {
  const provider = new ethers.providers.StaticJsonRpcProvider(RPC, 137);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const ctf      = new ethers.Contract(CTF, CTF_ABI, provider);

  console.log('Wallet:', wallet.address);
  console.log('ConditionId:', conditionId);

  const denom = await ctf.payoutDenominator(conditionId);
  const num0  = await ctf.payoutNumerators(conditionId, 0);
  const num1  = await ctf.payoutNumerators(conditionId, 1);

  console.log('\n--- Condition resolution ---');
  console.log('payoutDenominator:', denom.toString(), denom.isZero() ? '(NOT resolved)' : '(resolved)');
  console.log('payoutNumerators[0] (YES):', num0.toString());
  console.log('payoutNumerators[1] (NO): ', num1.toString());

  if (!denom.isZero()) {
    const yesWon = num0.gt(0);
    console.log('\nResult:', yesWon ? '✅ YES won — should have received collateral' : '❌ NO won — YES tokens worth 0');
  }

  // Check current balances for both collateral types
  const collId      = await ctf.getCollectionId(ethers.constants.HashZero, conditionId, 1);
  const posIdWcol   = await ctf.getPositionId(WCOL, collId);
  const posIdUsdc   = await ctf.getPositionId(USDC_E, collId);
  const balWcol     = await ctf.balanceOf(wallet.address, posIdWcol);
  const balUsdc     = await ctf.balanceOf(wallet.address, posIdUsdc);

  console.log('\n--- Current CTF balances (should be 0 if already redeemed) ---');
  console.log('YES (wcol-backed)  posId:', posIdWcol.toString());
  console.log('YES (wcol) balance:', ethers.utils.formatUnits(balWcol, 6));
  console.log('YES (usdc.e) posId:', posIdUsdc.toString());
  console.log('YES (usdc.e) balance:', ethers.utils.formatUnits(balUsdc, 6));
}

main().catch(console.error);
