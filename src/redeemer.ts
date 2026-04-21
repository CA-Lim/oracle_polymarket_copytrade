import { ethers } from 'ethers';
import { config } from './config.js';

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

// How often to poll for redeemable positions (default: 10 minutes)
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

export class AutoRedeemer {
  private wallet: ethers.Wallet;
  private provider: ethers.providers.JsonRpcProvider;
  // Track conditionIds already redeemed this session to avoid redundant txns
  private redeemed = new Set<string>();
  private intervalId?: NodeJS.Timeout;

  constructor() {
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
  }

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    console.log(`♻️  Auto-redeemer started (checking every ${intervalMs / 1000}s)`);
    this.checkAndRedeem().catch(console.error);
    this.intervalId = setInterval(() => this.checkAndRedeem().catch(console.error), intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  async checkAndRedeem(): Promise<void> {
    let positions: any[];
    try {
      const res = await fetch(
        `https://data-api.polymarket.com/positions?user=${this.wallet.address}&sizeThreshold=.01`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      positions = await res.json();
    } catch (e: any) {
      console.error('♻️  Auto-redeem: failed to fetch positions:', e.message);
      return;
    }

    // Collect conditionIds that have at least one winning token (curPrice ≈ $1)
    // We call redeemPositions with [1, 2] (both outcome slots) — the CTF contract
    // pays out winning tokens and is a no-op for zero-balance losing tokens.
    const winningConditions = new Set<string>();
    for (const p of positions) {
      if (p.redeemable === true && parseFloat(p.curPrice ?? 0) >= 0.99) {
        winningConditions.add(p.conditionId);
      }
    }

    const toRedeem = [...winningConditions].filter(id => !this.redeemed.has(id));

    if (!toRedeem.length) {
      console.log('♻️  Auto-redeem: nothing to redeem');
      return;
    }

    console.log(`♻️  Auto-redeem: ${toRedeem.length} winning condition(s) to redeem`);

    const ctf = new ethers.Contract(config.contracts.ctf, CTF_ABI, this.wallet);
    const usdc = new ethers.Contract(config.contracts.usdc, ERC20_ABI, this.provider);
    const balBefore = await usdc.balanceOf(this.wallet.address);

    for (const conditionId of toRedeem) {
      const sample = positions.find(p => p.conditionId === conditionId);
      const label = (sample?.title ?? conditionId).slice(0, 65);
      try {
        const gasOverrides = await this.getGasOverrides();
        console.log(`   Redeeming: ${label}`);
        const tx = await ctf.redeemPositions(
          config.contracts.usdc,
          ethers.constants.HashZero,
          conditionId,
          [1, 2],
          gasOverrides,
        );
        console.log(`   ⏳ Tx: ${tx.hash}`);
        await tx.wait();
        this.redeemed.add(conditionId);
        console.log(`   ✅ Redeemed`);
      } catch (e: any) {
        console.error(`   ❌ Failed to redeem "${label}": ${e.message}`);
      }
    }

    const balAfter = await usdc.balanceOf(this.wallet.address);
    const gained = parseFloat(ethers.utils.formatUnits(balAfter.sub(balBefore), 6));
    if (gained > 0) {
      console.log(`🏆 Auto-redeem: claimed +$${gained.toFixed(2)} USDC.e`);
    }
  }

  private async getGasOverrides(): Promise<ethers.providers.TransactionRequest> {
    const feeData = await this.provider.getFeeData();
    const block   = await this.provider.getBlock('latest');
    const baseFee = block.baseFeePerGas ?? ethers.utils.parseUnits('100', 'gwei');

    // Floor priority at 50 gwei so the tx beats competing txs on Polygon
    const minPriority = ethers.utils.parseUnits('50', 'gwei');
    let maxPriority = feeData.maxPriorityFeePerGas ?? minPriority;
    if (maxPriority.lt(minPriority)) maxPriority = minPriority;

    // maxFee = 2× baseFee + priority — guarantees inclusion even if baseFee doubles
    const maxFee = baseFee.mul(2).add(maxPriority);

    return { maxPriorityFeePerGas: maxPriority, maxFeePerGas: maxFee };
  }
}
