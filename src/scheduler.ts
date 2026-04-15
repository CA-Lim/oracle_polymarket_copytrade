import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { copyTargetManager } from './copy-target-manager.js';
import { reviewCurrentTargets, analyzeNewTraders } from './ai-analyst.js';
import type { TradePerf } from './ai-analyst.js';
import type { TraderDiscovery } from './trader-discovery.js';
import type { PolymarketCopyBot } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', 'data', 'ai-review-state.json');

// ─── State ─────────────────────────────────────────────────────────────────────

export interface AIReviewChange {
  removedAddresses: Array<{ address: string; reason: string }>;
  addedAddresses: Array<{ address: string; label: string }>;
  analyzedCount: number;
}

export interface AIReviewState {
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt: number | null;
  finishedAt: number | null;
  nextRunAt: number | null;
  error?: string;
  lastChanges: AIReviewChange;
}

const DEFAULT_STATE: AIReviewState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  nextRunAt: null,
  lastChanges: { removedAddresses: [], addedAddresses: [], analyzedCount: 0 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function saveState(state: AIReviewState) {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch { /* non-critical */ }
}

function loadState(): AIReviewState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as AIReviewState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function nextCronDate(expression: string): number | null {
  // Rough next-run estimate: parse cron and compute next occurrence
  // Using a simple approach: schedule returns next date
  try {
    // node-cron doesn't expose next-run natively; we approximate by adding 24h for daily crons
    return Date.now() + 24 * 60 * 60 * 1000;
  } catch {
    return null;
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

export class ReviewScheduler {
  private state: AIReviewState;
  private cronJob?: ReturnType<typeof cron.schedule>;
  private discovery: TraderDiscovery;
  private getBot: () => PolymarketCopyBot | null;
  private getHistory: () => Array<{ timestamp: number; status: string; copySize: number; sourceAddress?: string }>;
  private onDone?: () => void; // broadcastSnapshot callback

  constructor(
    discovery: TraderDiscovery,
    getBot: () => PolymarketCopyBot | null,
    getHistory: () => Array<{ timestamp: number; status: string; copySize: number; sourceAddress?: string }>,
    onDone?: () => void,
  ) {
    this.discovery = discovery;
    this.getBot = getBot;
    this.getHistory = getHistory;
    this.onDone = onDone;
    this.state = loadState();
    // Reset running state on restart (process was killed mid-run)
    if (this.state.status === 'running') {
      this.state.status = 'idle';
      saveState(this.state);
    }
  }

  start(): void {
    if (!config.anthropicApiKey) {
      console.log('ℹ️  ANTHROPIC_API_KEY not set — AI daily review disabled');
      return;
    }

    if (!cron.validate(config.aiReviewCron)) {
      console.warn(`⚠️  Invalid AI_REVIEW_CRON expression "${config.aiReviewCron}" — using default "0 2 * * *"`);
    }

    const expr = cron.validate(config.aiReviewCron) ? config.aiReviewCron : '0 2 * * *';
    this.cronJob = cron.schedule(expr, () => {
      this.run().catch((e) => console.error('❌ AI review cron error:', e.message));
    });

    this.state.nextRunAt = nextCronDate(expr);
    saveState(this.state);
    console.log(`🤖 AI review scheduler started (cron: ${expr})`);

    // Weekly re-score of unanalyzed traders (no blockchain scan, just API refresh)
    const refreshExpr = cron.validate(config.discoveryRefreshCron) ? config.discoveryRefreshCron : '0 3 * * 0';
    cron.schedule(refreshExpr, () => {
      console.log('🔄 Weekly discovery refresh starting…');
      this.discovery.refreshUnanalyzed(config.discoveryRefreshLimit)
        .catch((e: any) => console.error('❌ Discovery refresh failed:', e.message));
    });
    console.log(`🔄 Discovery refresh scheduler started (cron: ${refreshExpr})`);
  }

  stop(): void {
    this.cronJob?.stop();
  }

  getState(): AIReviewState {
    return { ...this.state };
  }

  /** Trigger a review manually (e.g. from /api/ai/review). Returns when done. */
  async run(): Promise<AIReviewState> {
    if (this.state.status === 'running') {
      return { ...this.state };
    }

    if (!config.anthropicApiKey) {
      const err = 'ANTHROPIC_API_KEY is not set';
      this.state = { ...this.state, status: 'error', error: err };
      saveState(this.state);
      return { ...this.state };
    }

    this.state = {
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      nextRunAt: this.state.nextRunAt,
      lastChanges: { removedAddresses: [], addedAddresses: [], analyzedCount: 0 },
    };
    saveState(this.state);
    console.log('\n🤖 AI daily review started');

    try {
      await this.doReview();
      this.state.status = 'done';
    } catch (e: any) {
      console.error('❌ AI review error:', e.message);
      this.state.status = 'error';
      this.state.error = e.message;
    }

    this.state.finishedAt = Date.now();
    this.state.nextRunAt = nextCronDate(config.aiReviewCron);
    saveState(this.state);
    this.onDone?.();
    return { ...this.state };
  }

  // ─── Core review cycle ──────────────────────────────────────────────────────

  private async doReview(): Promise<void> {
    // ── Step 1: Compute yesterday's performance per source address ─────────────
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recentTrades = this.getHistory().filter((t) => t.timestamp > cutoff);

    const perfMap = new Map<string, TradePerf>();
    for (const trade of recentTrades) {
      if (!trade.sourceAddress) continue;
      const addr = trade.sourceAddress.toLowerCase();
      const p = perfMap.get(addr) ?? { address: addr, filled: 0, failed: 0, totalCopySize: 0 };
      if (trade.status === 'filled') {
        p.filled++;
        p.totalCopySize += trade.copySize || 0;
      } else {
        p.failed++;
      }
      perfMap.set(addr, p);
    }

    // ── Step 2: AI review — decide which targets to remove ────────────────────
    const activeTargets = copyTargetManager.getEnabled();
    console.log(`   Reviewing ${activeTargets.length} active target(s)…`);

    const reviewResult = await reviewCurrentTargets(activeTargets, perfMap);
    console.log(`   AI says remove ${reviewResult.remove.length} target(s)`);

    for (const { address, reason } of reviewResult.remove) {
      const removed = copyTargetManager.remove(address);
      if (removed) {
        this.state.lastChanges.removedAddresses.push({ address, reason });
        console.log(`   ✂️  Removed ${address}: ${reason}`);
      }
    }

    // ── Step 3: Check available slots ─────────────────────────────────────────
    const slots = config.aiMaxCopyTargets - copyTargetManager.enabledCount();
    if (slots <= 0) {
      console.log(`   Copy target slots full (${config.aiMaxCopyTargets}/${config.aiMaxCopyTargets}) — skipping discovery`);
      return;
    }
    console.log(`   ${slots} slot(s) available — checking for candidates…`);

    // ── Step 3b: Expire dormant traders (no activity in 30 days) ─────────────
    const DORMANT_MS = 30 * 24 * 60 * 60 * 1000;
    let expiredCount = 0;
    for (const t of this.discovery.getTraders()) {
      if (!t.ignored && !t.aiAnalyzedAt && t.lastTradeAt && t.lastTradeAt < Date.now() - DORMANT_MS) {
        this.discovery.patchTrader(t.address, { ignored: true, ignoreReason: 'dormant: no trades in 30 days' });
        expiredCount++;
      }
    }
    if (expiredCount > 0) console.log(`   Expired ${expiredCount} dormant trader(s)`);

    // ── Step 4: Trigger discovery only if not enough unanalyzed candidates ────
    const ACTIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
    const existingAddresses = new Set(copyTargetManager.getAll().map((t) => t.address));
    const unanalyzedCount = this.discovery
      .getTraders()
      .filter(
        (t) =>
          !t.ignored &&
          !t.aiAnalyzedAt &&
          !existingAddresses.has(t.address) &&
          t.tradeCount >= 10 &&
          t.score > 30 &&
          t.lastTradeAt > Date.now() - ACTIVE_WINDOW_MS
      ).length;

    const MIN_CANDIDATES = Math.min(slots * 3, 20);
    if (unanalyzedCount < MIN_CANDIDATES) {
      console.log(`   Only ${unanalyzedCount} unanalyzed candidates cached — running trader discovery…`);
      this.discovery.triggerDiscovery({ lookbackDays: 7 });
      await this.waitForDiscovery();
    } else {
      console.log(`   ${unanalyzedCount} unanalyzed candidates available — skipping discovery`);
    }

    // ── Step 5: Pick top un-analyzed, un-ignored candidates (active in last 14d) ─
    const candidates = this.discovery
      .getTraders()
      .filter(
        (t) =>
          !t.ignored &&
          !t.aiAnalyzedAt &&
          !existingAddresses.has(t.address) &&
          t.tradeCount >= 10 &&
          t.score > 30 &&
          t.lastTradeAt > Date.now() - ACTIVE_WINDOW_MS,
      )
      .slice(0, Math.min(slots * 3, 20)); // give Claude more options than needed

    if (candidates.length === 0) {
      console.log('   No unanalyzed candidates found — review complete');
      return;
    }
    console.log(`   Analysing ${candidates.length} candidate(s) with AI…`);
    this.state.lastChanges.analyzedCount = candidates.length;

    // ── Step 6: AI analysis ───────────────────────────────────────────────────
    const analyzeResult = await analyzeNewTraders(candidates, slots);

    // ── Step 7: Update discovery records + add suitable targets ──────────────
    const now = Date.now();
    for (const analysis of analyzeResult.traders) {
      // Update the DiscoveredTrader record
      this.discovery.patchTrader(analysis.address, {
        ignored: !analysis.suitableForCopy,
        ignoreReason: analysis.ignoreReason ?? undefined,
        aiAnalyzedAt: now,
        topCategories: analysis.topCategories,
        suitableForCopy: analysis.suitableForCopy,
        aiSummary: analysis.aiSummary,
        recommendedSettings: analysis.recommendedSettings,
      });

      if (!analysis.suitableForCopy) {
        console.log(`   🚫 Ignored ${analysis.address}: ${analysis.ignoreReason}`);
        continue;
      }

      if (copyTargetManager.enabledCount() >= config.aiMaxCopyTargets) break;

      try {
        copyTargetManager.add({
          address: analysis.address,
          enabled: true,
          label: analysis.label,
          topCategories: analysis.topCategories,
          aiReason: analysis.aiSummary,
          addedBy: 'ai',
          settings: analysis.recommendedSettings,
        });
        this.state.lastChanges.addedAddresses.push({ address: analysis.address, label: analysis.label });
        console.log(`   ✅ Added ${analysis.address} as "${analysis.label}"`);
      } catch {
        // Already exists — skip
      }
    }

    // ── Step 8: Save discovery data ───────────────────────────────────────────
    await this.discovery.save();

    // ── Step 9: Reload bot monitors ───────────────────────────────────────────
    const bot = this.getBot();
    if (bot) await bot.reloadTargets();

    console.log('🤖 AI review complete');
    console.log(`   Removed: ${this.state.lastChanges.removedAddresses.length}, Added: ${this.state.lastChanges.addedAddresses.length}`);
  }

  private async waitForDiscovery(timeoutMs = 12 * 60 * 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { status } = this.discovery.getStatus();
      if (status === 'done' || status === 'error') return;
      await sleep(5000);
    }
    console.warn('⚠️  Discovery timed out — proceeding with cached traders');
  }
}
