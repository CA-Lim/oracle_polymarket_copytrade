import { ethers } from 'ethers';
import { config } from './config.js';

const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 _conditionId, uint256[] calldata _amounts) public',
];
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
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
    // Skip if there are pending (unconfirmed) txs — submitting now would stack
    // a redeem behind stuck trade txs (or vice-versa) and block the nonce queue.
    const confirmed = await this.provider.getTransactionCount(this.wallet.address, 'latest');
    const pending   = await this.provider.getTransactionCount(this.wallet.address, 'pending');
    if (pending > confirmed) {
      console.log(`♻️  Auto-redeem: skipping — ${pending - confirmed} pending tx(s) in mempool`);
      return;
    }

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

    // Filter winning redeemable positions not yet redeemed this session
    const winning = positions.filter(
      p => p.redeemable === true
        && parseFloat(p.curPrice ?? 0) >= 0.99
        && !this.redeemed.has(p.conditionId)
    );

    if (!winning.length) {
      console.log('♻️  Auto-redeem: nothing to redeem');
      return;
    }

    // Group by conditionId — one redeemPositions call per condition
    const byCondition = new Map<string, any[]>();
    for (const p of winning) {
      if (!byCondition.has(p.conditionId)) byCondition.set(p.conditionId, []);
      byCondition.get(p.conditionId)!.push(p);
    }

    console.log(`♻️  Auto-redeem: ${byCondition.size} winning condition(s) to redeem`);

    const negRisk  = new ethers.Contract(config.contracts.negRiskAdapter, NEG_RISK_ABI, this.wallet);
    const ctf      = new ethers.Contract(config.contracts.ctf, CTF_ABI, this.wallet);
    const ctfRead  = new ethers.Contract(config.contracts.ctf, CTF_ABI, this.provider);
    const usdc     = new ethers.Contract(config.contracts.usdc, ERC20_ABI, this.provider);
    const balBefore = await usdc.balanceOf(this.wallet.address);

    for (const [conditionId, posGroup] of byCondition) {
      const label = (posGroup[0]?.title ?? conditionId).slice(0, 65);
      try {
        const gasOverrides = await this.getGasOverrides();
        console.log(`   Redeeming: ${label}`);

        // Build amounts[] from actual on-chain CTF balances
        const amounts: ethers.BigNumber[] = [];
        for (const p of posGroup) {
          const outcomeIdx = p.outcomeIndex ?? 0;
          while (amounts.length <= outcomeIdx) amounts.push(ethers.BigNumber.from(0));
          if (p.asset) {
            const bal = await ctfRead.balanceOf(this.wallet.address, p.asset);
            amounts[outcomeIdx] = bal;
          }
        }

        let tx: ethers.ContractTransaction;
        const hasBalance = amounts.some(a => !a.isZero());

        if (hasBalance && posGroup.some(p => p.negativeRisk)) {
          // negRisk positions: use correct 2-arg ABI with real balances
          try {
            tx = await negRisk.redeemPositions(conditionId, amounts, gasOverrides);
          } catch {
            tx = await ctf.redeemPositions(config.contracts.usdc, ethers.constants.HashZero, conditionId, [1, 2], gasOverrides);
          }
        } else {
          tx = await ctf.redeemPositions(config.contracts.usdc, ethers.constants.HashZero, conditionId, [1, 2], gasOverrides);
        }

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
