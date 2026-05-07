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
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
const ONRAMP_ABI = [
  'function wrap(address _asset, address _to, uint256 _amount) external',
];

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const MAX_FAIL_COUNT = 3;

export class AutoRedeemer {
  private wallet: ethers.Wallet;
  private provider: ethers.providers.StaticJsonRpcProvider;
  private redeemed  = new Set<string>();
  private failCount = new Map<string, number>();
  private intervalId?: NodeJS.Timeout;

  constructor() {
    this.provider = new ethers.providers.StaticJsonRpcProvider(config.rpcUrl, { chainId: 137, name: 'matic' });
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
    const usdc    = new ethers.Contract(config.contracts.usdc, ERC20_ABI, this.wallet);
    const onramp  = new ethers.Contract(config.contracts.onramp, ONRAMP_ABI, this.wallet);

    const usdcBefore = await usdc.balanceOf(this.wallet.address);

    const seen = new Set<string>();
    for (const p of winning) {
      if (seen.has(p.conditionId)) continue;
      seen.add(p.conditionId);

      const label = (p.title ?? p.conditionId).slice(0, 65);
      try {
        console.log(`   Redeeming: ${label}`);

        const assetBn = ethers.BigNumber.from(String(p.asset));
        const balance = await ctfRead.balanceOf(this.wallet.address, assetBn);
        if (balance.isZero()) {
          console.log(`   ⚠️  On-chain balance is 0, skipping`);
          this.redeemed.add(p.conditionId);
          continue;
        }

        const conditionId = p.conditionId as string;
        const condBefore  = await usdc.balanceOf(this.wallet.address);
        const gas         = await this.getGasOverrides();
        const zero        = ethers.BigNumber.from(0);

        // Build ordered list of redemption attempts. negRiskAdapter handles the vast
        // majority of Polymarket markets (wcol-backed). CTF fallbacks cover standard
        // binary markets. The previous posId-matching approach failed when the API's
        // asset ID format didn't align with the locally derived positionId.
        const attempts: Array<() => Promise<ethers.ContractTransaction>> = [
          () => negRisk.redeemPositions(conditionId, [balance, zero], gas),
        ];

        // Also try derived conditionId — data-api sometimes returns a questionId
        // instead of the actual CTF conditionId for negRisk markets.
        try {
          const derived = await negRisk.getConditionId(conditionId);
          if (!ethers.BigNumber.from(derived).isZero() && derived !== conditionId) {
            attempts.push(() => negRisk.redeemPositions(derived, [balance, zero], gas));
          }
        } catch { /* conditionId is already the direct CTF conditionId */ }

        attempts.push(
          () => ctf.redeemPositions(config.contracts.usdc, ethers.constants.HashZero, conditionId, [1], gas),
          () => ctf.redeemPositions(WCOL, ethers.constants.HashZero, conditionId, [1], gas),
        );

        let tx: ethers.ContractTransaction | undefined;
        for (const attempt of attempts) {
          try {
            tx = await attempt();
            break;
          } catch (e: any) {
            console.log(`   ↳ attempt failed: ${e.reason ?? e.message.slice(0, 80)}`);
          }
        }

        if (!tx) {
          console.error(`   ❌ All redemption paths exhausted for "${label}"`);
          continue;
        }

        console.log(`   ⏳ Tx: ${tx.hash}`);
        await tx.wait();

        // Verify the CTF balance actually dropped — a successful TX is not enough
        // (e.g. CTF.redeemPositions with wrong collateral type succeeds but pays 0).
        const balanceAfter = await ctfRead.balanceOf(this.wallet.address, assetBn);
        if (!balanceAfter.isZero()) {
          const fails = (this.failCount.get(p.conditionId) ?? 0) + 1;
          this.failCount.set(p.conditionId, fails);
          if (fails >= MAX_FAIL_COUNT) {
            console.error(`   ❌ "${label}" balance unchanged after ${MAX_FAIL_COUNT} attempts — marking done, manual intervention needed`);
            this.redeemed.add(p.conditionId);
          } else {
            console.log(`   ⚠️  Balance unchanged after TX (attempt ${fails}/${MAX_FAIL_COUNT}) — will retry next poll`);
          }
          continue;
        }

        this.redeemed.add(p.conditionId);
        this.failCount.delete(p.conditionId);
        const condAfter    = await usdc.balanceOf(this.wallet.address);
        const condReceived = parseFloat(ethers.utils.formatUnits(condAfter.sub(condBefore), 6));
        insertRedeem({ conditionId: p.conditionId, label, received: condReceived, txHash: tx.hash, source: 'auto_redeemer' });
        console.log(`   ✅ Redeemed (+$${condReceived.toFixed(4)} USDC.e)`);
      } catch (e: any) {
        console.error(`   ❌ Failed to redeem "${label}": ${e.reason ?? e.message}`);
      }
    }

    // Wrap any USDC.e gained from redemptions back into pUSD for trading.
    const usdcGained = (await usdc.balanceOf(this.wallet.address)).sub(usdcBefore);
    if (usdcGained.gt(0)) {
      const gained = parseFloat(ethers.utils.formatUnits(usdcGained, 6));
      console.log(`🏆 Auto-redeem: claimed +$${gained.toFixed(2)} USDC.e — wrapping to pUSD...`);
      try {
        const gas       = await this.getGasOverrides();
        const allowance = await usdc.allowance(this.wallet.address, config.contracts.onramp);
        if (allowance.lt(usdcGained)) {
          const approveTx = await usdc.approve(config.contracts.onramp, ethers.constants.MaxUint256, gas);
          await approveTx.wait();
        }
        const wrapTx = await onramp.wrap(config.contracts.usdc, this.wallet.address, usdcGained, await this.getGasOverrides());
        await wrapTx.wait();
        console.log(`   ✅ Wrapped $${gained.toFixed(2)} USDC.e → pUSD`);
      } catch (e: any) {
        console.error(`   ⚠️  Auto-wrap failed: ${e.reason ?? e.message} — USDC.e remains in wallet`);
      }
    }
  }

  private async getGasOverrides(): Promise<ethers.providers.TransactionRequest> {
    const feeData = await this.provider.getFeeData();
    const block   = await this.provider.getBlock('latest');
    const baseFee = block.baseFeePerGas ?? ethers.utils.parseUnits('100', 'gwei');

    const minPriority = ethers.utils.parseUnits('50', 'gwei');
    let maxPriority = feeData.maxPriorityFeePerGas ?? minPriority;
    if (maxPriority.lt(minPriority)) maxPriority = minPriority;

    const maxFee = baseFee.mul(2).add(maxPriority);
    return { maxPriorityFeePerGas: maxPriority, maxFeePerGas: maxFee };
  }
}
