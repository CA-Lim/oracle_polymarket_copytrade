import { ethers } from 'ethers';
import { config } from './config.js';
import { insertRedeem } from './db.js';

const WCOL = '0x3A3BD7bb9528E159577F7C2e685CC81A765002E2';

const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 _conditionId, uint256[] calldata _amounts) public',
  'function getConditionId(bytes32 questionId) external view returns (bytes32)',
];
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external view returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) external view returns (uint256)',
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

    console.log(`♻️  Auto-redeem: ${winning.length} winning position(s) to redeem`);

    const negRisk = new ethers.Contract(config.contracts.negRiskAdapter, NEG_RISK_ABI, this.wallet);
    const ctf     = new ethers.Contract(config.contracts.ctf, CTF_ABI, this.wallet);
    const ctfRead = new ethers.Contract(config.contracts.ctf, CTF_ABI, this.provider);
    const usdc    = new ethers.Contract(config.contracts.usdc, ERC20_ABI, this.provider);
    const balBefore = await usdc.balanceOf(this.wallet.address);

    // Deduplicate by conditionId — one redemption call per condition
    const seen = new Set<string>();
    for (const p of winning) {
      if (seen.has(p.conditionId)) continue;
      seen.add(p.conditionId);

      const label = (p.title ?? p.conditionId).slice(0, 65);
      try {
        const gasOverrides = await this.getGasOverrides();
        console.log(`   Redeeming: ${label}`);

        const assetBn  = ethers.BigNumber.from(String(p.asset));
        const balance  = await ctfRead.balanceOf(this.wallet.address, assetBn);
        if (balance.isZero()) {
          console.log(`   ⚠️  On-chain balance is 0, skipping`);
          this.redeemed.add(p.conditionId);
          continue;
        }

        // Detect which collateral token this position uses by deriving the positionId
        // on-chain and comparing against the known asset id.
        const conditionId = p.conditionId as string;
        const collId      = await ctfRead.getCollectionId(ethers.constants.HashZero, conditionId, 1);
        const posIdWcol   = (await ctfRead.getPositionId(WCOL, collId)).toBigInt();
        const posIdUsdc   = (await ctfRead.getPositionId(config.contracts.usdc, collId)).toBigInt();
        const assetBig    = assetBn.toBigInt();

        const condBefore = await usdc.balanceOf(this.wallet.address);
        let tx: ethers.ContractTransaction;

        if (posIdWcol === assetBig) {
          // negRisk / wcol-backed — redeem via negRiskAdapter
          console.log(`   Collateral: wcol → negRiskAdapter`);
          try {
            tx = await negRisk.redeemPositions(conditionId, [balance, ethers.BigNumber.from(0)], gasOverrides);
          } catch (e1: any) {
            console.log(`   negRiskAdapter failed (${e1.reason ?? e1.message.slice(0, 60)}), trying CTF(wcol)...`);
            tx = await ctf.redeemPositions(WCOL, ethers.constants.HashZero, conditionId, [1], gasOverrides);
          }
        } else if (posIdUsdc === assetBig) {
          // Standard binary — redeem via CTF with USDC.e
          console.log(`   Collateral: usdc → CTF`);
          tx = await ctf.redeemPositions(config.contracts.usdc, ethers.constants.HashZero, conditionId, [1], gasOverrides);
        } else {
          // Nested negRisk: conditionId in API may be the questionId, not the CTF conditionId.
          // Derive the real conditionId via negRiskAdapter.getConditionId(questionId).
          console.log(`   No direct match — checking nested negRisk structure...`);
          let derivedCondId: string | null = null;
          try {
            const derived    = await negRisk.getConditionId(conditionId);
            const dCollId    = await ctfRead.getCollectionId(ethers.constants.HashZero, derived, 1);
            const dPosIdWcol = (await ctfRead.getPositionId(WCOL, dCollId)).toBigInt();
            if (dPosIdWcol === assetBig) derivedCondId = derived;
          } catch { /* ignore */ }

          if (derivedCondId) {
            console.log(`   Derived conditionId matches — negRiskAdapter`);
            tx = await negRisk.redeemPositions(derivedCondId, [balance, ethers.BigNumber.from(0)], gasOverrides);
          } else {
            // Last resort: try both paths with the original conditionId
            console.log(`   Falling back to negRiskAdapter with original conditionId...`);
            try {
              tx = await negRisk.redeemPositions(conditionId, [balance, ethers.BigNumber.from(0)], gasOverrides);
            } catch {
              tx = await ctf.redeemPositions(config.contracts.usdc, ethers.constants.HashZero, conditionId, [1, 2], gasOverrides);
            }
          }
        }

        console.log(`   ⏳ Tx: ${tx.hash}`);
        await tx.wait();
        this.redeemed.add(p.conditionId);
        const condAfter = await usdc.balanceOf(this.wallet.address);
        const condReceived = parseFloat(ethers.utils.formatUnits(condAfter.sub(condBefore), 6));
        insertRedeem({ conditionId: p.conditionId, label, received: condReceived, txHash: tx.hash, source: 'auto_redeemer' });
        console.log(`   ✅ Redeemed`);
      } catch (e: any) {
        console.error(`   ❌ Failed to redeem "${label}": ${e.reason ?? e.message}`);
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
