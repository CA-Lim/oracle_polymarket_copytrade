import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', 'data', 'discovered-traders.json');

// OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker,
//             uint256 makerAssetId, uint256 takerAssetId,
//             uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)
const ORDER_FILLED_TOPIC0 = ethers.utils.id(
  'OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'
);

const CTF_EXCHANGE    = '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e';
const NEG_RISK_EX     = '0xc5d563a36ae78145c45a50134d48a1215220f80a';
const POLYGONSCAN_BASE = 'https://api.etherscan.io/v2/api';
const DATA_API_BASE    = 'https://data-api.polymarket.com';
const SECONDS_PER_BLOCK = 2.1; // Polygon average block time

const BLOCKLIST = new Set([
  '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',
  '0xc5d563a36ae78145c45a50134d48a1215220f80a',
  '0xd91e80cf2e7be2e162c6513ced06f1dd0da35296',
  '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
  '0x0000000000000000000000000000000000000000',
]);

export interface DiscoveredTrader {
  address: string;
  firstSeen: number;       // unix ms
  lastTradeAt: number;     // unix ms
  totalVolume: number;     // USDC invested (BUY trades)
  totalReturned: number;   // USDC redeemed
  realizedPnl: number;     // returned - invested
  winRate: number;         // won / settled markets (0–1); open positions excluded
  tradeCount: number;      // BUY trade count
  marketCount: number;     // unique conditionIds
  settledMarkets: number;  // markets fully resolved (no open position)
  openMarkets: number;     // markets still active (excluded from win rate)
  score: number;           // composite 0–100
  evaluatedAt: number;
  error?: string;

  // AI analysis fields (populated by ai-analyst.ts)
  ignored?: boolean;
  ignoreReason?: string;
  aiAnalyzedAt?: number;
  topCategories?: string[];
  suitableForCopy?: boolean;
  aiSummary?: string;
  recommendedSettings?: {
    allowKeywords: string[];
    blockKeywords: string[];
    multiplier: number;
    maxTradeSize: number;
    minTradeSize: number;
    maxPerMarketNotional: number;
  };
  recentMarketTitles?: string[];  // sample of recent market names for AI context
}

export interface DiscoveryState {
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt: number | null;
  finishedAt: number | null;
  progress: string;
  addressesFound: number;
  addressesEvaluated: number;
  error?: string;
}

export class TraderDiscovery {
  private state: DiscoveryState = {
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    progress: '',
    addressesFound: 0,
    addressesEvaluated: 0,
  };

  // address (lowercase) → trader record
  private traders: Map<string, DiscoveredTrader> = new Map();
  private abortFlag = false;

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(DATA_PATH, 'utf-8');
      const stored = JSON.parse(raw);
      if (Array.isArray(stored.traders)) {
        for (const t of stored.traders) {
          this.traders.set(t.address.toLowerCase(), t);
        }
        console.log(`🔍 Loaded ${this.traders.size} discovered traders from disk`);
      }
    } catch {
      // File doesn't exist yet — start fresh
    }
  }

  async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
      const payload = {
        version: 1,
        savedAt: Date.now(),
        traders: Array.from(this.traders.values()),
      };
      await fs.writeFile(DATA_PATH, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (e: any) {
      console.error('⚠️  Failed to save discovered traders:', e.message);
    }
  }

  getStatus(): DiscoveryState {
    return { ...this.state };
  }

  /** Returns traders sorted by score descending */
  getTraders(): DiscoveredTrader[] {
    return Array.from(this.traders.values()).sort((a, b) => b.score - a.score);
  }

  /** Merge fields into an existing trader record (creates entry if missing). */
  patchTrader(address: string, patch: Partial<DiscoveredTrader>): void {
    const addr = address.toLowerCase();
    const existing = this.traders.get(addr);
    if (existing) {
      Object.assign(existing, patch);
    }
  }

  /**
   * Re-evaluate top unanalyzed traders via Polymarket API to refresh lastTradeAt and score.
   * No blockchain scan — much faster than full discovery. Runs ~500ms per trader.
   */
  async refreshUnanalyzed(limit = 200): Promise<number> {
    const stale = Array.from(this.traders.values())
      .filter((t) => !t.aiAnalyzedAt && !t.ignored)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    console.log(`🔄 Refreshing ${stale.length} unanalyzed trader records…`);
    let refreshed = 0;
    for (const t of stale) {
      if (this.abortFlag) break;
      try {
        const updated = await this.evaluateAddress(t.address);
        if (updated) this.traders.set(t.address, updated);
      } catch {
        // non-critical — keep old record
      }
      refreshed++;
      await this.sleep(500);
    }
    await this.save();
    console.log(`✅ Refreshed ${refreshed} trader records`);
    return refreshed;
  }

  /** Kick off a full discovery run in the background. No-ops if already running. */
  triggerDiscovery(options: { lookbackDays?: number } = {}): void {
    if (this.state.status === 'running') return;
    this.abortFlag = false;
    this.runDiscovery(options.lookbackDays ?? 30).catch((e: any) => {
      this.state.status = 'error';
      this.state.error = e.message;
      this.state.finishedAt = Date.now();
      console.error('❌ Trader discovery failed:', e.message);
    });
  }

  // ─── Core pipeline ──────────────────────────────────────────────────────────

  private async runDiscovery(lookbackDays: number): Promise<void> {
    this.state = {
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      progress: 'Fetching latest block…',
      addressesFound: 0,
      addressesEvaluated: 0,
    };

    console.log(`🔍 Starting trader discovery (lookback: ${lookbackDays} days)`);

    // Step 1: determine block range
    const apiKey = process.env.POLYGONSCAN_API_KEY ?? '';
    const latestBlock = await this.fetchLatestBlock(apiKey);
    const fromBlock = Math.max(
      0,
      Math.floor(latestBlock - (lookbackDays * 86400 / SECONDS_PER_BLOCK))
    );

    this.state.progress = `Mining blocks ${fromBlock.toLocaleString()}–${latestBlock.toLocaleString()}…`;
    console.log(`🔍 Mining blocks ${fromBlock}–${latestBlock} for trader addresses`);

    // Step 2: mine addresses from on-chain logs
    const addresses = await this.mineAddressesFromLogs(fromBlock, latestBlock, apiKey);

    if (this.abortFlag) {
      this.state.status = 'idle';
      return;
    }

    this.state.addressesFound = addresses.size;
    this.state.progress = `Found ${addresses.size} addresses. Evaluating…`;
    console.log(`🔍 Found ${addresses.size} unique trader addresses`);

    // Step 3: evaluate each address via Polymarket data API
    let evaluated = 0;
    for (const address of addresses) {
      if (this.abortFlag) break;

      this.state.progress = `Evaluating ${evaluated + 1}/${addresses.size}: ${address.slice(0, 8)}…`;

      try {
        const trader = await this.evaluateAddress(address);
        if (trader) {
          this.traders.set(address, trader);
        }
      } catch (e: any) {
        // Record failed evaluations so we know what we tried
        const existing = this.traders.get(address);
        if (!existing) {
          this.traders.set(address, {
            address,
            firstSeen: Date.now(),
            lastTradeAt: 0,
            totalVolume: 0,
            totalReturned: 0,
            realizedPnl: 0,
            winRate: 0,
            tradeCount: 0,
            marketCount: 0,
            settledMarkets: 0,
            openMarkets: 0,
            score: 0,
            evaluatedAt: Date.now(),
            error: e.message,
          });
        }
      }

      evaluated++;
      this.state.addressesEvaluated = evaluated;

      // Save incrementally every 50 evaluations so restarts don't lose all data
      if (evaluated % 50 === 0) this.save().catch(() => {});

      await this.sleep(500); // stay well under data-api rate limit
    }

    await this.save();

    this.state.status = 'done';
    this.state.finishedAt = Date.now();
    this.state.progress = `Done. Evaluated ${evaluated} addresses, ${this.traders.size} stored.`;
    console.log(`✅ Trader discovery complete: ${this.traders.size} traders stored`);
  }

  // ─── Block fetching ─────────────────────────────────────────────────────────

  private async fetchLatestBlock(apiKey: string): Promise<number> {
    const url = `${POLYGONSCAN_BASE}?chainid=137&module=proxy&action=eth_blockNumber` +
      (apiKey ? `&apikey=${apiKey}` : '');
    const res = await fetch(url);
    const data = await res.json() as any;
    return parseInt(data.result, 16);
  }

  // ─── Log mining ─────────────────────────────────────────────────────────────

  private async mineAddressesFromLogs(
    fromBlock: number,
    toBlock: number,
    apiKey: string
  ): Promise<Set<string>> {
    const addresses = new Set<string>();
    const CHUNK_SIZE = 50_000;

    for (let from = fromBlock; from <= toBlock; from += CHUNK_SIZE) {
      if (this.abortFlag) break;
      const to = Math.min(from + CHUNK_SIZE - 1, toBlock);

      // Query both exchanges in parallel
      const [logs1, logs2] = await Promise.all([
        this.fetchLogs(CTF_EXCHANGE, from, to, apiKey),
        this.fetchLogs(NEG_RISK_EX, from, to, apiKey),
      ]);

      for (const log of [...logs1, ...logs2]) {
        this.extractAddresses(log, addresses);
      }

      await this.sleep(250); // ≤4 req/sec on free tier
    }

    return addresses;
  }

  /**
   * Fetches OrderFilled event logs for a given contract + block range.
   * If the result is exactly 1000 (Polygonscan cap), bisects and re-queries.
   */
  private async fetchLogs(
    contractAddress: string,
    fromBlock: number,
    toBlock: number,
    apiKey: string,
    depth = 0
  ): Promise<any[]> {
    if (fromBlock > toBlock || depth > 10) return [];

    const url = `${POLYGONSCAN_BASE}?chainid=137&module=logs&action=getLogs` +
      `&address=${contractAddress}` +
      `&topic0=${ORDER_FILLED_TOPIC0}` +
      `&fromBlock=${fromBlock}&toBlock=${toBlock}` +
      (apiKey ? `&apikey=${apiKey}` : '');

    let data: any;
    try {
      const res = await fetch(url);
      data = await res.json();
    } catch {
      return [];
    }

    if (data.status !== '1' || !Array.isArray(data.result)) return [];

    const logs: any[] = data.result;

    // Polygonscan caps at 1000 — bisect to ensure completeness
    if (logs.length >= 1000 && toBlock - fromBlock > 100) {
      const mid = Math.floor((fromBlock + toBlock) / 2);
      await this.sleep(250);
      const [left, right] = await Promise.all([
        this.fetchLogs(contractAddress, fromBlock, mid, apiKey, depth + 1),
        this.fetchLogs(contractAddress, mid + 1, toBlock, apiKey, depth + 1),
      ]);
      return [...left, ...right];
    }

    return logs;
  }

  private extractAddresses(log: any, out: Set<string>): void {
    if (!log.topics || log.topics.length < 4) return;
    // topics[2] = maker, topics[3] = taker (both padded to 32 bytes)
    // '0x' + 24 leading zero chars + 40-char address = 66 chars total
    const maker = ('0x' + log.topics[2].slice(26)).toLowerCase();
    const taker = ('0x' + log.topics[3].slice(26)).toLowerCase();
    if (!BLOCKLIST.has(maker) && /^0x[0-9a-f]{40}$/.test(maker)) out.add(maker);
    if (!BLOCKLIST.has(taker) && /^0x[0-9a-f]{40}$/.test(taker)) out.add(taker);
  }

  // ─── Trader evaluation ──────────────────────────────────────────────────────

  private async evaluateAddress(address: string): Promise<DiscoveredTrader | null> {
    // Skip recently-evaluated traders — re-evaluate if data is > 6 hours old
    const existing = this.traders.get(address);
    if (existing && !existing.error && Date.now() - existing.evaluatedAt < 6 * 3_600_000) {
      return existing;
    }

    const activity: any[] = [];
    let offset = 0;
    const limit = 500;
    const MAX_PAGES = 20; // cap at 10k records to avoid runaway pagination on whales

    while (activity.length / limit < MAX_PAGES) {
      const res = await fetch(
        `${DATA_API_BASE}/activity?user=${address}&limit=${limit}&offset=${offset}`
      );
      if (!res.ok) break;
      const batch: any[] = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      activity.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
      await this.sleep(200);
    }

    if (activity.length === 0) return null; // no Polymarket presence

    let totalInvested = 0;
    let totalReturned = 0;
    let tradeCount = 0;
    let firstTradeTs = Infinity;
    let lastTradeTs = 0;

    const markets = new Set<string>();
    const marketBuys = new Map<string, number>();    // conditionId → USDC spent
    const marketReturns = new Map<string, number>(); // conditionId → USDC returned (SELL + REDEEM)

    for (const r of activity) {
      const ts = ((r.timestamp as number) || 0) * 1000;
      if (ts > lastTradeTs) lastTradeTs = ts;
      if (ts > 0 && ts < firstTradeTs) firstTradeTs = ts;

      const amt = parseFloat(r.amount ?? r.usdcSize ?? 0);
      if (isNaN(amt) || amt <= 0) continue;

      const cid: string = r.conditionId || r.market || '';
      if (cid) markets.add(cid);

      if (r.type === 'TRADE' && r.side === 'BUY') {
        totalInvested += amt;
        tradeCount++;
        marketBuys.set(cid, (marketBuys.get(cid) ?? 0) + amt);
      } else if (r.type === 'TRADE' && r.side === 'SELL') {
        // Early position exits count as returns — ignoring these makes P&L look worse than reality
        totalReturned += amt;
        marketReturns.set(cid, (marketReturns.get(cid) ?? 0) + amt);
      } else if (r.type === 'REDEEM') {
        totalReturned += amt;
        marketReturns.set(cid, (marketReturns.get(cid) ?? 0) + amt);
      }
    }

    // Minimum data quality gates
    if (tradeCount < 5) return null;
    if (totalInvested < 50) return null; // ignore micro-volume wallets

    // Fetch open positions to exclude still-active markets from win rate denominator.
    // A market with an open position hasn't resolved yet — counting it as a loss
    // artificially suppresses win rate for active traders.
    const openConditionIds = new Set<string>();
    try {
      const posRes = await fetch(
        `${DATA_API_BASE}/positions?user=${address}&sizeThreshold=0.01`
      );
      if (posRes.ok) {
        const positions: any[] = await posRes.json();
        if (Array.isArray(positions)) {
          for (const p of positions) {
            const cid: string = p.conditionId || p.market || '';
            if (cid) openConditionIds.add(cid);
          }
        }
      }
    } catch {
      // If positions fetch fails, fall back to counting all markets
    }

    // Win rate: won / settled markets only (exclude open positions)
    let wonMarkets = 0;
    let settledMarkets = 0;
    for (const [cid, spent] of marketBuys) {
      if (openConditionIds.has(cid)) continue; // skip — not yet resolved
      settledMarkets++;
      const returned = marketReturns.get(cid) ?? 0;
      if (returned > spent) wonMarkets++;
    }

    // Bayesian-adjusted win rate: shrink toward 50% when settled sample is small.
    // With < 5 settled markets, raw win rate is statistically noisy — weight it less.
    const PRIOR_STRENGTH = 5; // equivalent to 5 prior markets at 50%
    const winRate = settledMarkets > 0
      ? (wonMarkets + PRIOR_STRENGTH * 0.5) / (settledMarkets + PRIOR_STRENGTH)
      : 0.5;

    const raw = {
      address,
      firstSeen: firstTradeTs === Infinity ? Date.now() : firstTradeTs,
      lastTradeAt: lastTradeTs,
      totalVolume: totalInvested,
      totalReturned,
      realizedPnl: totalReturned - totalInvested,
      winRate,
      tradeCount,
      marketCount: markets.size,
      settledMarkets,
      openMarkets: openConditionIds.size,
      evaluatedAt: Date.now(),
    };

    return { ...raw, score: this.computeScore(raw) };
  }

  // ─── Scoring ────────────────────────────────────────────────────────────────

  private computeScore(t: Omit<DiscoveredTrader, 'score' | 'error'>): number {
    if (t.tradeCount < 5 || t.totalVolume < 50) return 0;

    // Recency: 1.0 if traded in last 7 days, decays to 0 at 90 days
    const daysSinceLastTrade = (Date.now() - t.lastTradeAt) / 86_400_000;
    const recency = Math.max(0, 1 - daysSinceLastTrade / 90);

    // P&L factor: return rate in [-1, +∞], mapped to [0, 1].
    // Break-even (0%) → 0.5, +100% return → 1.0, -100% → 0.0.
    const returnRate = t.totalVolume > 0 ? t.realizedPnl / t.totalVolume : 0;
    const pnlFactor = Math.min(1, Math.max(0, (returnRate + 1) / 2));

    // Volume factor: log scale — $100→~0.4, $10k→~0.8, $100k→1.0
    const volumeFactor = Math.min(1, Math.log10(Math.max(1, t.totalVolume)) / 5);

    // Market diversity: more settled markets = more evidence
    const diversityFactor = Math.min(1, t.settledMarkets / 20);

    // Weighted composite (weights sum to 1)
    // winRate is already Bayesian-adjusted (shrunk toward 50% for small samples)
    const score =
      pnlFactor       * 0.35 +
      t.winRate       * 0.25 +
      recency         * 0.20 +
      volumeFactor    * 0.10 +
      diversityFactor * 0.10;

    return Math.round(score * 100);
  }

  // ─── Utility ────────────────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
