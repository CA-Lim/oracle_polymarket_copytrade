import { config, validateConfig } from './config.js';
import { MultiMonitor } from './multi-monitor.js';
import type { TaggedTrade } from './multi-monitor.js';
import { WebSocketMonitor } from './websocket-monitor.js';
import type { Trade } from './monitor.js';
import { TradeExecutor } from './trader.js';
import { PositionTracker } from './positions.js';
import { RiskManager } from './risk-manager.js';
import { copyTargetManager } from './copy-target-manager.js';
import type { CopyTarget } from './copy-target-manager.js';
import { AutoRedeemer } from './redeemer.js';
import { initLogger, initDb } from './db.js';

export class PolymarketCopyBot {
  private multiMonitor: MultiMonitor;
  private wsMonitor?: WebSocketMonitor;
  private executor: TradeExecutor;
  private positions: PositionTracker;
  private risk: RiskManager;
  private redeemer: AutoRedeemer;
  private stopLossTimer?: NodeJS.Timeout;
  private cutPositions = new Set<string>();
  private isRunning: boolean = false;
  private tradeQueue: Promise<void> = Promise.resolve();
  private processedTrades: Set<string> = new Set();
  private botStartTime: number = 0;
  private readonly maxProcessedTrades = 10000;
  private stats = {
    tradesDetected: 0,
    tradesCopied: 0,
    tradesFailed: 0,
    totalVolume: 0,
  };

  public onTradeCopied?: (trade: Trade, result: any) => void;
  public onTradeFailed?: (trade: Trade, reason: string) => void;

  constructor() {
    this.multiMonitor = new MultiMonitor();
    this.executor = new TradeExecutor();
    this.positions = new PositionTracker();
    this.risk = new RiskManager(this.positions);
    this.redeemer = new AutoRedeemer();
  }

  async initialize(): Promise<void> {
    console.log('🤖 Polymarket Copy Trading Bot');
    console.log('================================');
    const targets = copyTargetManager.getEnabled();
    console.log(`Copy targets: ${targets.length} address(es)`);
    for (const t of targets) {
      console.log(`  • ${t.address} — ${t.label}`);
    }
    console.log(`Position multiplier: ${config.trading.positionSizeMultiplier * 100}%`);
    console.log(`Max trade size: ${config.trading.maxTradeSize} USDC`);
    console.log(`Order type: ${config.trading.orderType}`);
    console.log(`WebSocket: ${config.monitoring.useWebSocket ? 'Enabled' : 'Disabled'}`);
    if (config.risk.maxSessionNotional > 0 || config.risk.maxPerMarketNotional > 0) {
      console.log(`Risk caps: session=${config.risk.maxSessionNotional || '∞'} USDC, per-market=${config.risk.maxPerMarketNotional || '∞'} USDC`);
    }
    console.log(`Auth mode: EOA (signature type 0)`);
    console.log('================================\n');

    validateConfig();

    this.botStartTime = Date.now();
    console.log(`⏰ Bot start time: ${new Date(this.botStartTime).toISOString()}`);
    console.log('   (Only trades after this time will be copied)\n');

    await this.executor.initialize();
    await this.reconcilePositions();
    this.redeemer.start();
    this.checkStopLoss().catch(console.error);
    this.stopLossTimer = setInterval(() => this.checkStopLoss().catch(console.error), 2 * 60 * 1000);

    // Start multi-wallet monitor
    await this.multiMonitor.start(targets);
    this.multiMonitor.on('trade', (tagged: TaggedTrade) => {
      this.handleNewTrade(tagged).catch(console.error);
    });

    if (config.monitoring.useWebSocket) {
      this.wsMonitor = new WebSocketMonitor();
      try {
        const wsAuth = this.executor.getWsAuth();
        const channel = config.monitoring.useUserChannel ? 'user' : 'market';
        await this.wsMonitor.initialize(async () => {}, channel, wsAuth);
        console.log(`✅ WebSocket monitor initialized (${channel} channel — price updates only)\n`);
      } catch (error) {
        console.error('⚠️  WebSocket initialization failed, continuing with REST polling only');
        this.wsMonitor = undefined;
      }
    }
  }

  async start(): Promise<void> {
    this.isRunning = true;
    console.log(`🚀 Bot started! Monitoring ${this.multiMonitor.getActiveAddresses().length} wallet(s) via REST polling\n`);

    // Keep-alive — polling is driven by MultiMonitor's internal setIntervals
    while (this.isRunning) {
      await this.sleep(5000);
    }
  }

  private async handleNewTrade(trade: TaggedTrade): Promise<void> {
    // Serialize all trade processing — prevents concurrent trades from all passing
    // the per-market notional check before any fill is recorded
    this.tradeQueue = this.tradeQueue.then(() => this.processTrade(trade)).catch(() => {});
    return this.tradeQueue;
  }

  private async processTrade(trade: TaggedTrade): Promise<void> {
    if (trade.timestamp && trade.timestamp < this.botStartTime) return;

    const tradeKeys = this.getTradeKeys(trade);
    if (tradeKeys.some((key) => this.processedTrades.has(key))) return;
    for (const key of tradeKeys) this.processedTrades.add(key);
    this.pruneProcessedTrades();
    this.stats.tradesDetected++;

    const target = trade.copyTarget;

    // Stale-signal guard: skip if trade is older than 10 minutes
    const MAX_TRADE_AGE_MS = 10 * 60 * 1000;
    const tradeAgeMs = Date.now() - trade.timestamp;
    if (tradeAgeMs > MAX_TRADE_AGE_MS) {
      const ageMin = Math.round(tradeAgeMs / 60000);
      console.log(`⏭️  Skipping trade — signal is ${ageMin}min old (max ${MAX_TRADE_AGE_MS / 60000}min)`);
      this.onTradeFailed?.(trade, `stale signal (${ageMin}min old)`);
      return;
    }

    console.log('\n' + '='.repeat(50));
    console.log(`🎯 NEW TRADE DETECTED`);
    console.log(`   Source: ${target.label} (${trade.sourceAddress})`);
    console.log(`   Time: ${new Date(trade.timestamp).toISOString()}`);
    console.log(`   Market: ${trade.market}`);
    console.log(`   Side: ${trade.side} ${trade.outcome}`);
    console.log(`   Size: ${trade.size} USDC @ ${trade.price.toFixed(3)}`);
    console.log(`   Token ID: ${trade.tokenId}`);
    console.log('='.repeat(50));

    // Skip re-entry into markets where stop-loss already fired this session
    if (this.cutPositions.has(trade.tokenId)) {
      console.log(`⏭️  Skipping trade — stop-loss already triggered for this token this session`);
      this.onTradeFailed?.(trade, 'stop-loss cut this session');
      return;
    }

    // --- SELL: mirror the oracle's exit against our own position ---
    if (trade.side === 'SELL') {
      const posState = this.positions.getPosition(trade.tokenId);
      if (!posState || posState.shares <= 0) {
        console.log(`⏭️  Skipping SELL — no position held for this token`);
        return;
      }
      console.log(`🔴 Copying SELL: exiting ${posState.shares.toFixed(4)} shares`);
      try {
        const result = await this.executor.exitPosition(trade.tokenId, posState.shares);
        this.positions.recordFill({ trade, notional: result.copyNotional, shares: posState.shares, price: result.price, side: 'SELL' });
        this.stats.tradesCopied++;
        this.stats.totalVolume += result.copyNotional;
        console.log(`✅ Copy SELL executed`);
        console.log(`📊 Session Stats: ${this.stats.tradesCopied}/${this.stats.tradesDetected} copied, ${this.stats.tradesFailed} failed`);
        this.onTradeCopied?.(trade, result);
      } catch (e: any) {
        this.stats.tradesFailed++;
        console.error(`❌ Copy SELL failed: ${e.message}`);
        console.log(`📊 Session Stats: ${this.stats.tradesCopied}/${this.stats.tradesDetected} copied, ${this.stats.tradesFailed} failed`);
        this.onTradeFailed?.(trade, e.message);
      }
      return;
    }

    // --- BUY filters (not applicable to SELL) ---

    // Per-wallet price floor / ceiling
    const priceFloor   = target.settings.minPrice   ?? 0.20;
    const priceCeiling = target.settings.maxPrice   ?? 1.0;
    if (trade.price < priceFloor) {
      console.log(`⏭️  Skipping trade — entry price ${trade.price.toFixed(3)} below floor ${priceFloor}`);
      this.onTradeFailed?.(trade, `entry price ${trade.price.toFixed(3)} below floor ${priceFloor}`);
      return;
    }
    if (priceCeiling < 1.0 && trade.price > priceCeiling) {
      console.log(`⏭️  Skipping trade — entry price ${trade.price.toFixed(3)} above ceiling ${priceCeiling}`);
      this.onTradeFailed?.(trade, `entry price ${trade.price.toFixed(3)} above ceiling ${priceCeiling}`);
      return;
    }

    // Per-wallet minimum source trade size
    const minSrc = target.settings.minSourceTradeSize ?? 0;
    if (minSrc > 0 && trade.size < minSrc) {
      console.log(`⏭️  Skipping trade — source trade $${trade.size} below minimum $${minSrc}`);
      this.onTradeFailed?.(trade, `source trade $${trade.size} below minimum $${minSrc}`);
      return;
    }

    // Per-target market keyword filter
    const filterResult = this.checkMarketFilter(trade.market, target);
    if (!filterResult.allowed) {
      console.log(`⏭️  Skipping trade — market filter: ${filterResult.reason}`);
      this.onTradeFailed?.(trade, filterResult.reason);
      return;
    }

    if (this.wsMonitor) {
      await this.wsMonitor.subscribeToMarket(trade.tokenId);
    }

    // Calculate copy size using per-target settings (fallback to global config)
    const multiplier = target.settings.multiplier ?? config.trading.positionSizeMultiplier;
    const maxSize = target.settings.maxTradeSize ?? config.trading.maxTradeSize;
    const minSize = target.settings.minTradeSize ?? config.trading.minTradeSize;
    const scaled = trade.size * multiplier;
    // Polymarket CLOB enforces $1 minimum for FOK/FAK. Skip rather than inflate.
    const exchangeMin = (config.trading.orderType === 'FOK' || config.trading.orderType === 'FAK') ? 1 : minSize;
    if (scaled < exchangeMin) {
      console.log(`⏭️  Skipping trade — scaled size $${scaled.toFixed(3)} below exchange minimum $${exchangeMin}`);
      return;
    }
    const copyNotional = Math.min(maxSize, scaled);

    // Per-target per-market notional cap (swap config temporarily — JS is single-threaded)
    const savedPerMarket = config.risk.maxPerMarketNotional;
    if (target.settings.maxPerMarketNotional > 0) {
      config.risk.maxPerMarketNotional = target.settings.maxPerMarketNotional;
    }
    const riskCheck = this.risk.checkTrade(trade, copyNotional);
    config.risk.maxPerMarketNotional = savedPerMarket;

    if (!riskCheck.allowed) {
      console.log(`⚠️  Risk check blocked trade: ${riskCheck.reason}`);
      return;
    }

    try {
      const drift = await this.executor.checkPriceDrift(trade.tokenId, trade.side, trade.price);
      if (drift.drifted) {
        console.log(`⏭️  Skipping trade — price drifted ${(drift.driftPct * 100).toFixed(1)}% (trader bought: ${trade.price.toFixed(3)} → market now: ${drift.currentPrice.toFixed(3)})`);
        this.onTradeFailed?.(trade, `price drifted ${(drift.driftPct * 100).toFixed(1)}% (trader: ${trade.price.toFixed(3)} → now: ${drift.currentPrice.toFixed(3)})`);
        return;
      }

      // Collapse guard: if current price dropped >50% below source, the position is likely dead
      const COLLAPSE_THRESHOLD = 0.50;
      if (drift.currentPrice < trade.price * (1 - COLLAPSE_THRESHOLD)) {
        const dropPct = ((1 - drift.currentPrice / trade.price) * 100).toFixed(1);
        console.log(`⏭️  Skipping trade — price collapsed ${dropPct}% below source (${trade.price.toFixed(3)} → ${drift.currentPrice.toFixed(3)})`);
        this.onTradeFailed?.(trade, `price collapsed ${dropPct}% (${trade.price.toFixed(3)} → ${drift.currentPrice.toFixed(3)})`);
        return;
      }

      const result = await this.executor.executeCopyTrade(trade, copyNotional);
      this.risk.recordFill({
        trade,
        notional: result.copyNotional,
        shares: result.copyShares,
        price: result.price,
        side: result.side,
      });
      this.stats.tradesCopied++;
      this.stats.totalVolume += result.copyNotional;
      console.log(`✅ Successfully copied trade!`);
      console.log(`📊 Session Stats: ${this.stats.tradesCopied}/${this.stats.tradesDetected} copied, ${this.stats.tradesFailed} failed`);
      this.onTradeCopied?.(trade, result);
    } catch (error: any) {
      this.stats.tradesFailed++;
      console.log(`❌ Failed to copy trade`);
      if (error?.message) console.log(`   Reason: ${error.message}`);
      console.log(`📊 Session Stats: ${this.stats.tradesCopied}/${this.stats.tradesDetected} copied, ${this.stats.tradesFailed} failed`);
      this.onTradeFailed?.(trade, error?.message || 'Unknown error');
    }
  }

  async reconcilePositions(): Promise<void> {
    try {
      const positions = await this.executor.getPositions();
      if (!positions || positions.length === 0) {
        console.log('🧾 Positions: none found (fresh session)');
        return;
      }
      const { loaded, skipped } = this.positions.loadFromClobPositions(positions);
      const totalNotional = this.positions.getTotalNotional();
      console.log(`🧾 Positions loaded: ${loaded} (skipped ${skipped}), total notional ≈ ${totalNotional.toFixed(2)} USDC`);
    } catch (error: any) {
      console.log(`🧾 Positions reconciliation failed: ${error.message || 'Unknown error'}`);
    }
  }

  /** Manually exit a position by placing a FOK sell order for all shares. */
  async exitPosition(tokenId: string, shares: number) {
    return this.executor.exitPosition(tokenId, shares);
  }

  /** Reload monitors when copy targets change at runtime. */
  async reloadTargets(): Promise<void> {
    const targets = copyTargetManager.getEnabled();
    await this.multiMonitor.reload(targets);
    console.log(`🔄 Copy targets reloaded: ${targets.length} active wallet(s)`);
  }

  getStats() {
    return { ...this.stats };
  }

  getActiveAddresses(): string[] {
    return this.multiMonitor.getActiveAddresses();
  }

  get running(): boolean {
    return this.isRunning;
  }

  stop(): void {
    this.isRunning = false;
    this.multiMonitor.stop();
    this.redeemer.stop();
    if (this.stopLossTimer) { clearInterval(this.stopLossTimer); this.stopLossTimer = undefined; }
    if (this.wsMonitor) this.wsMonitor.close();
    console.log('\n🛑 Bot stopped');
    this.printStats();
  }

  private async checkStopLoss(): Promise<void> {
    const THRESHOLD = 0.65;  // exit when curPrice drops to <65% of entry (35% loss)
    const MIN_ENTRY = 0.30;
    const walletAddress = this.executor.getWalletAddress();

    let apiPositions: any[];
    try {
      const res = await fetch(`https://data-api.polymarket.com/positions?user=${walletAddress}&sizeThreshold=.01`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      apiPositions = await res.json();
    } catch (e: any) {
      console.error('⚡ Stop-loss: failed to fetch positions:', e.message);
      return;
    }

    // Count positions per conditionId — >1 means both sides held (paired/hedged)
    const conditionCount = new Map<string, number>();
    for (const p of apiPositions) {
      if (p.conditionId) conditionCount.set(p.conditionId, (conditionCount.get(p.conditionId) ?? 0) + 1);
    }

    let triggered = 0;
    for (const p of apiPositions) {
      const tokenId = p.asset;
      const curPrice = parseFloat(p.curPrice ?? 0);

      if (this.cutPositions.has(tokenId)) continue;
      if (curPrice >= 0.99 || curPrice <= 0.01) continue;

      const posState = this.positions.getPosition(tokenId);
      // Use API avgPrice as fallback for positions not tracked by the bot
      const apiAvgPrice = parseFloat(p.avgPrice ?? 0);
      const entryPrice = ((posState?.avgPrice ?? 0) > 0) ? posState!.avgPrice! : apiAvgPrice;
      const shares = (posState?.shares ?? 0) > 0 ? posState!.shares! : parseFloat(p.size ?? p.quantity ?? 0);

      if (shares <= 0) continue;
      if (entryPrice <= 0) continue;
      if (entryPrice <= MIN_ENTRY) continue;
      if (curPrice >= entryPrice * THRESHOLD) continue;

      if ((conditionCount.get(p.conditionId) ?? 0) > 1) {
        console.log(`⚡ Stop-loss: skipping paired position ${(p.title || tokenId).slice(0, 50)}`);
        continue;
      }

      const label = (p.title ?? tokenId).slice(0, 60);
      const lossPct = ((1 - curPrice / entryPrice) * 100).toFixed(0);
      const source = (posState?.avgPrice ?? 0) > 0 ? 'bot' : 'api';
      console.log(`⚡ Stop-loss: ${label}`);
      console.log(`   Entry ${entryPrice.toFixed(3)} (${source}) → Current ${curPrice.toFixed(3)} (-${lossPct}%)`);
      try {
        await this.executor.exitPosition(tokenId, shares);
        this.cutPositions.add(tokenId);
        triggered++;
        console.log(`✅ Stop-loss executed`);
      } catch (e: any) {
        console.error(`❌ Stop-loss failed: ${e.message}`);
      }
    }

    if (triggered === 0) console.log('⚡ Stop-loss: no positions triggered');
  }

  printStats(): void {
    console.log('\n📊 Session Statistics:');
    console.log(`   Trades detected: ${this.stats.tradesDetected}`);
    console.log(`   Trades copied: ${this.stats.tradesCopied}`);
    console.log(`   Trades failed: ${this.stats.tradesFailed}`);
    console.log(`   Total volume: ${this.stats.totalVolume.toFixed(2)} USDC`);
  }

  /**
   * Checks market keyword filters. Per-target settings override global config.
   * Allow list is checked first; then block list.
   */
  private checkMarketFilter(market: string, target: CopyTarget): { allowed: boolean; reason: string } {
    const title = market.toLowerCase();

    // Use target's per-address keywords if set, otherwise fall back to global config
    const allowKeywords = target.settings.allowKeywords.length > 0
      ? target.settings.allowKeywords
      : config.filters.allowKeywords;
    const blockKeywords = target.settings.blockKeywords.length > 0
      ? target.settings.blockKeywords
      : config.filters.blockKeywords;

    if (allowKeywords.length > 0) {
      const matched = allowKeywords.find((kw) => title.includes(kw.toLowerCase()));
      if (!matched) {
        return { allowed: false, reason: `market not in allowlist (title: "${market.slice(0, 60)}")` };
      }
    }

    if (blockKeywords.length > 0) {
      const hit = blockKeywords.find((kw) => title.includes(kw.toLowerCase()));
      if (hit) {
        return { allowed: false, reason: `blocked keyword "${hit}" in market: "${market.slice(0, 60)}"` };
      }
    }

    return { allowed: true, reason: '' };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getTradeKeys(trade: Trade): string[] {
    const keys: string[] = [];
    if (trade.txHash) keys.push(trade.txHash);
    keys.push(`${trade.tokenId}|${trade.side}|${trade.size}|${trade.price}|${trade.timestamp}`);
    return keys;
  }

  private pruneProcessedTrades(): void {
    if (this.processedTrades.size <= this.maxProcessedTrades) return;
    const entries = Array.from(this.processedTrades);
    this.processedTrades = new Set(entries.slice(-Math.floor(this.maxProcessedTrades / 2)));
  }
}

async function main() {
  const bot = new PolymarketCopyBot();

  process.on('SIGINT', () => {
    console.log('\n\nReceived SIGINT, shutting down...');
    bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    bot.stop();
    process.exit(0);
  });

  try {
    initLogger();
    await initDb();
    await bot.initialize();
    await bot.start();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Only run when invoked directly, not when imported as a module
const entryFile = process.argv[1] || '';
if (
  entryFile.endsWith('src/index.ts') || entryFile.endsWith('src/index.js') ||
  entryFile.endsWith('src\\index.ts') || entryFile.endsWith('src\\index.js')
) {
  main();
}
