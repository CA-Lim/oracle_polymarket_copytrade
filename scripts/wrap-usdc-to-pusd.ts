import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const RPC     = 'https://polygon-bor.publicnode.com';
const USDC_E  = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const PUSD    = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const ONRAMP  = '0x93070a847efEf7F70739046A929D47a521F5B8ee';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
];
const ONRAMP_ABI = [
  'function wrap(address _asset, address _to, uint256 _amount) external',
];

async function main() {
  const provider = new ethers.providers.StaticJsonRpcProvider(RPC, 137);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const usdc     = new ethers.Contract(USDC_E, ERC20_ABI, wallet);
  const pusd     = new ethers.Contract(PUSD, ERC20_ABI, provider);
  const onramp   = new ethers.Contract(ONRAMP, ONRAMP_ABI, wallet);

  const balance = await usdc.balanceOf(wallet.address);
  console.log('USDC.e to wrap:', ethers.utils.formatUnits(balance, 6));
  if (balance.isZero()) { console.log('Nothing to wrap.'); return; }

  const feeData = await provider.getFeeData();
  const block   = await provider.getBlock('latest');
  const baseFee = block.baseFeePerGas ?? ethers.utils.parseUnits('100', 'gwei');
  const minPri  = ethers.utils.parseUnits('50', 'gwei');
  const maxPri  = feeData.maxPriorityFeePerGas?.lt(minPri) ? minPri : (feeData.maxPriorityFeePerGas ?? minPri);
  const gas     = { maxPriorityFeePerGas: maxPri, maxFeePerGas: baseFee.mul(2).add(maxPri) };

  const allowance = await usdc.allowance(wallet.address, ONRAMP);
  if (allowance.lt(balance)) {
    console.log('Approving onramp...');
    const approveTx = await usdc.approve(ONRAMP, ethers.constants.MaxUint256, gas);
    await approveTx.wait();
    console.log('Approved.');
  }

  const pusdBefore = await pusd.balanceOf(wallet.address);
  console.log('Wrapping...');
  const wrapTx = await onramp.wrap(USDC_E, wallet.address, balance, gas);
  console.log('Tx hash:', wrapTx.hash);
  await wrapTx.wait();

  const pusdAfter = await pusd.balanceOf(wallet.address);
  const gained    = parseFloat(ethers.utils.formatUnits(pusdAfter.sub(pusdBefore), 6));
  console.log(`✅ Wrapped +$${gained.toFixed(6)} → pUSD`);
  console.log('pUSD balance:', ethers.utils.formatUnits(pusdAfter, 6));
}

main().catch(console.error);
