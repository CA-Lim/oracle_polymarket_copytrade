import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const NEG_RISK = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
  const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
  const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  const wallet = '0x51d80Bf31c374F1fBaD43cD90B29295633587536';

  // Try to find the negRisk questionId for Bournemouth conditionId
  // The negRiskAdapter maps conditionId -> questionId
  const negRiskAbi = [
    'function getQuestionId(bytes32 conditionId) view returns (bytes32)',
    'function getConditionId(bytes32 questionId, uint256 outcomeIndex) view returns (bytes32)',
    'function redeemPositions(bytes32 questionId, bool[] calldata positionIds) external',
    'function redeemNegRiskPosition(bytes32 _questionId, uint256 _indexSet) external',
    'function convertPositions(bytes32 questionId, address account) external',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
  ];

  const negRisk = new ethers.Contract(NEG_RISK, negRiskAbi, provider);

  // Check if the negRiskAdapter holds our CTF tokens (i.e., it wraps them)
  const ctfAbi = ['function balanceOf(address account, uint256 id) view returns (uint256)'];
  const ctf = new ethers.Contract(CTF, ctfAbi, provider);

  const bournemouthAsset = '58143018192488982732556002004047817589427905076553532335924433576396244620758';

  // Check if the negRiskAdapter owns the underlying CTF position
  const negRiskCtfBal = await ctf.balanceOf(NEG_RISK, bournemouthAsset);
  console.log('negRiskAdapter CTF balance of Bournemouth token:', negRiskCtfBal.toString());

  // Check if wallet has negRiskAdapter ERC-1155 tokens
  const negRiskUserBal = await negRisk.balanceOf(wallet, bournemouthAsset);
  console.log('wallet negRiskAdapter balance of Bournemouth token:', negRiskUserBal.toString());

  // Try getQuestionId
  try {
    const qId = await negRisk.getQuestionId('0xe068813cdcbd7f933818fa8ee81b4609a99238febf2c363ab9fc0d893ca7469d');
    console.log('questionId for Bournemouth conditionId:', qId);
  } catch(e: any) {
    console.log('getQuestionId failed:', e.message.slice(0, 80));
  }
}
main().catch(e => console.error(e.message));
