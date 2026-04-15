import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { config } from './config.js';
import type { CopyTarget } from './copy-target-manager.js';
import type { DiscoveredTrader } from './trader-discovery.js';

const MODEL = 'claude-haiku-4-5-20251001';
const DATA_API = 'https://data-api.polymarket.com';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface TradePerf {
  address: string;
  filled: number;
  failed: number;
  totalCopySize: number;  // USDC
}

export interface ReviewResult {
  remove: Array<{ address: string; reason: string }>;
}

export interface TraderAnalysis {
  address: string;
  suitableForCopy: boolean;
  ignoreReason: string | null;
  topCategories: string[];
  label: string;
  aiSummary: string;
  recommendedSettings: {
    allowKeywords: string[];
    blockKeywords: string[];
    multiplier: number;
    maxTradeSize: number;
    minTradeSize: number;
    maxPerMarketNotional: number;
  };
}

export interface AnalyzeResult {
  traders: TraderAnalysis[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getClient(): Anthropic {
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  return new Anthropic({ apiKey: config.anthropicApiKey });
}

/** Fetch a small sample of recent market titles for a trader address. */
async function fetchRecentMarketTitles(address: string, limit = 20): Promise<string[]> {
  try {
    const resp = await axios.get(`${DATA_API}/activity`, {
      params: { user: address.toLowerCase(), type: 'TRADE', limit, sortBy: 'TIMESTAMP', sortDirection: 'DESC' },
      timeout: 8000,
    });
    if (!Array.isArray(resp.data)) return [];
    const titles = new Set<string>();
    for (const t of resp.data) {
      const title = t.title || t.question || t.market || t.conditionId || '';
      if (title && !/^0x/.test(title)) titles.add(title);
    }
    return [...titles].slice(0, 15);
  } catch {
    return [];
  }
}

function parseJson<T>(text: string, fallback: T): T {
  // Try to extract a JSON array or object from anywhere in the text
  // This handles cases where Claude wraps JSON in markdown or appends extra commentary
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  const objectMatch = text.match(/\{[\s\S]*\}/);
  const jsonStr = arrayMatch?.[0] ?? objectMatch?.[0] ?? text;
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return fallback;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ask Claude to review current copy targets based on recent performance.
 * Returns a list of addresses to remove with reasons.
 * Cost: ~1-2k tokens total (haiku) → < $0.001
 */
export async function reviewCurrentTargets(
  targets: CopyTarget[],
  perfByAddress: Map<string, TradePerf>,
): Promise<ReviewResult> {
  if (targets.length === 0) return { remove: [] };

  const client = getClient();

  const targetLines = targets.map((t) => {
    const perf = perfByAddress.get(t.address);
    const perfStr = perf
      ? `filled=${perf.filled}, failed=${perf.failed}, volume=$${perf.totalCopySize.toFixed(2)}`
      : 'no trades yesterday';
    return `• ${t.address} | ${t.label} | categories: [${t.topCategories.join(', ') || 'unknown'}] | yesterday: ${perfStr}`;
  }).join('\n');

  const prompt = `You are managing a Polymarket copy trading bot. Review these wallet addresses and their yesterday's performance. Decide which to REMOVE.

REMOVE if:
- Fill rate < 40% (filled / (filled + failed) < 0.4) AND more than 3 total attempts
- Consistently failing with no fills
- Added reason suggests crypto/price prediction markets (not suitable for our strategy)

KEEP if:
- Insufficient data (< 3 trade attempts yesterday) — not enough signal
- Reasonable fill rate
- No prior issues

Active copy targets and yesterday's performance:
${targetLines}

Reply with JSON only, no commentary:
{"remove": [{"address": "0x...", "reason": "brief reason"}]}
If nothing to remove: {"remove": []}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content.find((b) => b.type === 'text')?.text ?? '{"remove":[]}';
  const result = parseJson<ReviewResult>(text, { remove: [] });

  // Validate — only remove addresses that are actually in our targets
  const validAddresses = new Set(targets.map((t) => t.address.toLowerCase()));
  result.remove = (result.remove || []).filter((r) => validAddresses.has(r.address.toLowerCase()));

  return result;
}

/**
 * Ask Claude to analyse a batch of discovered traders and decide who to add + with what settings.
 * Processes in batches of 10 to avoid hitting max_tokens limits.
 * Cost: ~6-10k tokens total (haiku) → < $0.01 per run
 */
export async function analyzeNewTraders(
  candidates: DiscoveredTrader[],
  maxTargets: number,
): Promise<AnalyzeResult> {
  if (candidates.length === 0) return { traders: [] };

  // Fetch recent market titles for context (in parallel, fire-and-forget failures)
  const titlesMap = new Map<string, string[]>();
  await Promise.all(
    candidates.map(async (c) => {
      const titles = c.recentMarketTitles?.length
        ? c.recentMarketTitles
        : await fetchRecentMarketTitles(c.address);
      titlesMap.set(c.address, titles);
    }),
  );

  const client = getClient();

  // Process in batches of 10 to keep responses well within token limits
  const BATCH_SIZE = 10;
  const allTraders: TraderAnalysis[] = [];

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);

    // Use numbered indices (T1, T2…) — avoids Claude mis-copying 42-char hex addresses
    const traderBlocks = batch.map((c, idx) => {
      const titles = titlesMap.get(c.address) ?? [];
      const marketList = titles.length
        ? titles.map((t) => `  - "${t}"`).join('\n')
        : '  (no market titles available)';
      return `T${i + idx + 1}: Score=${c.score.toFixed(0)}/100 | WinRate=${(c.winRate * 100).toFixed(0)}% | PnL=$${c.realizedPnl.toFixed(0)} | Trades=${c.tradeCount} | Markets=${c.marketCount}
Recent markets:
${marketList}`;
    }).join('\n\n---\n\n');

    const prompt = `You are configuring a Polymarket prediction market copy trading bot. Analyse these traders and recommend settings.

CONTEXT:
- We copy YES/NO prediction market trades
- Want specialists in specific categories: politics, sports, finance, science, entertainment
- UNSUITABLE: primarily crypto price prediction (e.g. "Will BTC hit $X?"), wash traders, < 10 trades
- Multiplier: 0.05–0.30 | maxTradeSize: $1–$10 | maxPerMarketNotional: $5–$20
- Add at most ${maxTargets} total. Quality over quantity.

${traderBlocks}

Reply with a JSON array — one entry per trader in the SAME ORDER (T${i + 1}…T${i + batch.length}):
[
  {
    "idx": ${i + 1},
    "suitableForCopy": true,
    "ignoreReason": null,
    "topCategories": ["politics", "sports"],
    "label": "Politics & Sports Specialist",
    "aiSummary": "68% win rate over 145 trades, strong in US politics and Premier League.",
    "recommendedSettings": {
      "allowKeywords": ["election", "politics", "premier league"],
      "blockKeywords": ["bitcoin", "btc price", "crypto price"],
      "multiplier": 0.15,
      "maxTradeSize": 5,
      "minTradeSize": 1,
      "maxPerMarketNotional": 10
    }
  }
]`;

    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 6000,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = msg.content.find((b) => b.type === 'text')?.text ?? '[]';
    console.log(`   AI batch ${Math.floor(i / BATCH_SIZE) + 1}: stop_reason=${msg.stop_reason}, tokens=${msg.usage?.output_tokens}`);

    // Parse array response and map back to candidate addresses by index
    type BatchItem = Omit<TraderAnalysis, 'address'> & { idx: number };
    const batchItems = parseJson<BatchItem[]>(rawText, []);
    let matched = 0;
    for (const item of Array.isArray(batchItems) ? batchItems : []) {
      const candidateIdx = (item.idx ?? 0) - 1; // idx is 1-based globally
      const candidate = candidates[candidateIdx];
      if (!candidate) continue;
      allTraders.push({
        address: candidate.address,
        suitableForCopy: !!item.suitableForCopy,
        ignoreReason: item.ignoreReason ?? null,
        topCategories: item.topCategories ?? [],
        label: item.label ?? candidate.address.slice(0, 10),
        aiSummary: item.aiSummary ?? '',
        recommendedSettings: item.recommendedSettings ?? {
          allowKeywords: [], blockKeywords: [],
          multiplier: 0.1, maxTradeSize: 5, minTradeSize: 1, maxPerMarketNotional: 10,
        },
      });
      matched++;
    }
    console.log(`   Batch result: ${matched}/${batch.length} traders matched`);
  }

  return { traders: allTraders };
}
