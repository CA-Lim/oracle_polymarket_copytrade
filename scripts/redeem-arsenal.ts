import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const RPC          = 'https://polygon-bor.publicnode.com';
const CTF          = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const WCOL         = '0x3A3BD7bb9528E159577F7C2e685CC81A765002E2';
const NEG_RISK     = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const USDC_E       = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const conditionId  = '0x069189619c7ae96da2abd767071f659190af6cadf9ef1c0b875f99268b5b4ebe';

const CTF_ABI = [
  'function balanceOf(address, uint256) external view returns (uint256)',
  'function getCollectionId(bytes32, bytes32, uint256) external view returns (bytes32)',
  'function getPositionId(address, bytes32) external pure returns (uint256)',
];
const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 _conditionId, uint256[] calldata _amounts) public',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function main() {
  const provider = new ethers.providers.StaticJsonRpcProvider(RPC, 137);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const ctf      = new ethers.Contract(CTF, CTF_ABI, provider);
  const negRisk  = new ethers.Contract(NEG_RISK, NEG_RISK_ABI, wallet);
  const usdc     = new ethers.Contract(USDC_E, ERC20_ABI, provider);

  console.log('Wallet:', wallet.address);

  // Fetch current YES token balance
  const collId  = await ctf.getCollectionId(ethers.constants.HashZero, conditionId, 1);
  const posId   = await ctf.getPositionId(WCOL, collId);
  const balance = await ctf.balanceOf(wallet.address, posId);

  console.log('YES balance to redeem:', ethers.utils.formatUnits(balance, 6), 'tokens');
  if (balance.isZero()) {
    console.log('Nothing to redeem — balance is 0.');
    return;
  }

  const usdcBefore = await usdc.balanceOf(wallet.address);
  console.log('USDC.e before:', ethers.utils.formatUnits(usdcBefore, 6));

  // Gas overrides — 50 gwei priority floor to ensure quick inclusion on Polygon
  const feeData    = await provider.getFeeData();
  const block      = await provider.getBlock('latest');
  const baseFee    = block.baseFeePerGas ?? ethers.utils.parseUnits('100', 'gwei');
  const minPri     = ethers.utils.parseUnits('50', 'gwei');
  const maxPri     = feeData.maxPriorityFeePerGas?.lt(minPri) ? minPri : (feeData.maxPriorityFeePerGas ?? minPri);
  const maxFee     = baseFee.mul(2).add(maxPri);

  console.log('Submitting redeem via negRiskAdapter...');
  const tx = await negRisk.redeemPositions(
    conditionId,
    [balance, ethers.BigNumber.from(0)],
    { maxPriorityFeePerGas: maxPri, maxFeePerGas: maxFee },
  );

  console.log('Tx hash:', tx.hash);
  console.log('Waiting for confirmation...');
  await tx.wait();

  const usdcAfter = await usdc.balanceOf(wallet.address);
  const received  = parseFloat(ethers.utils.formatUnits(usdcAfter.sub(usdcBefore), 6));
  console.log('USDC.e after: ', ethers.utils.formatUnits(usdcAfter, 6));
  console.log(`✅ Received: +$${received.toFixed(6)} USDC.e`);
}

main().catch(console.error);
