import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { ethers } from 'ethers';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { PolymarketCopyBot } from './index.js';
import { config } from './config.js';
import { TraderDiscovery } from './trader-discovery.js';
import { copyTargetManager } from './copy-target-manager.js';
import { ReviewScheduler } from './scheduler.js';
import { TradeExecutor } from './trader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH   = path.join(__dirname, '..', 'dashboard', 'index.html');
const LOGIN_PATH       = path.join(__dirname, '..', 'dashboard', 'login.html');
const DISCOVERY_PATH   = path.join(__dirname, '..', 'dashboard', 'discovery.html');
const ENV_PATH = path.join(__dirname, '..', '.env');
const PORT = parseInt(process.env.DASHBOARD_PORT || '3001');

// ─── Auth ────────────────────────────────────────────────────────────────────

const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'polybot';
const sessions       = new Set<string>(); // active session tokens

function parseCookies(cookieHeader: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function getSessionToken(req: http.IncomingMessage): string | null {
  return parseCookies(req.headers.cookie || '').session || null;
}

function isAuthenticated(req: http.IncomingMessage): boolean {
  const token = getSessionToken(req);
  return !!token && sessions.has(token);
}

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

// ─── Trade history ring buffer ──────────────────────────────────────────────

interface TradeRecord {
  id: string;
  timestamp: number;
  market: string;
  tokenId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  originalSize: number;
  copySize: number;
  price: number;
  shares: number;
  status: 'filled' | 'failed';
  failReason?: string;
  entryCost?: number;       // USDC actually spent (= copySize for filled BUYs)
  conditionId?: string;     // links trade to redemption event
  sourceAddress?: string;   // which copy target originated this trade
}

// ─── Account summary (from Polymarket activity API) ──────────────────────────

interface AccountSummary {
  totalDeposited: number;  // USDC deposited into the account (all-time)
  totalWithdrawn: number;  // USDC withdrawn from the account (all-time)
  totalInvested: number;   // USDC spent on BUY trades (all-time)
  totalReturned: number;   // USDC received from REDEEMs (all-time)
  tradingPnl: number;      // totalReturned - totalInvested (realized trading P&L)
  tradeCount: number;      // total BUY trades counted
  redeemCount: number;     // total redeems counted
}

let accountSummary: AccountSummary = {
  totalDeposited: 0, totalWithdrawn: 0, totalInvested: 0,
  totalReturned: 0, tradingPnl: 0, tradeCount: 0, redeemCount: 0,
};

// Known Polymarket contract addresses (lowercase) — outgoing USDC to these is NOT a withdrawal
const POLYMARKET_CONTRACTS = new Set([
  '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e', // exchange
  '0x4d97dcd97ec945f40cf65f87097ace5ea0476045', // ctf
  '0xd91e80cf2e7be2e162c6513ced06f1dd0da35296', // negRiskAdapter
  '0xc5d563a36ae78145c45a50134d48a1215220f80a', // negRiskExchange
]);

// USDC contract addresses on Polygon (both variants)
const USDC_CONTRACTS = new Set([
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e (bridged)
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC (native)
]);

// Fetch all ERC20 transfers to/from wallet via Polygonscan, filter for USDC tokens.
// incoming to wallet  → deposits
// outgoing to non-Polymarket address → withdrawals
async function fetchUsdcTransfers(): Promise<{ deposited: number; withdrawn: number }> {
  if (!walletAddress) return { deposited: 0, withdrawn: 0 };
  const apiKey = process.env.POLYGONSCAN_API_KEY ?? '';
  // Fetch all pages (Etherscan returns max 10000 per page)
  const allTxs: any[] = [];
  let page = 1;
  while (true) {
    const url = `https://api.etherscan.io/v2/api?chainid=137&module=account&action=tokentx` +
      `&address=${walletAddress}&sort=asc&page=${page}&offset=10000` +
      (apiKey ? `&apikey=${apiKey}` : '');
    const res = await fetch(url);
    const data = await res.json() as any;
    console.log(`📊 Polygonscan tokentx page ${page}: status=${data.status} message=${data.message} records=${Array.isArray(data.result) ? data.result.length : 'n/a'}`);
    if (data.status !== '1' || !Array.isArray(data.result) || data.result.length === 0) break;
    allTxs.push(...data.result);
    if (data.result.length < 10000) break; // last page
    page++;
  }
  if (allTxs.length === 0) return { deposited: 0, withdrawn: 0 };
  const wallet = walletAddress.toLowerCase();

  // Identify "swap" tx hashes — same tx has BOTH incoming and outgoing USDC variants.
  // e.g. swap-usdc-to-usdce.ts sends USDC and receives USDC.e in one tx.
  // Both sides should be excluded: it's a currency conversion, not a deposit or withdrawal.
  const hasIncoming = new Set<string>();
  const hasOutgoing = new Set<string>();
  for (const tx of allTxs) {
    if (!USDC_CONTRACTS.has(tx.contractAddress?.toLowerCase())) continue;
    if (tx.to.toLowerCase() === wallet) hasIncoming.add(tx.hash);
    else if (tx.from.toLowerCase() === wallet) hasOutgoing.add(tx.hash);
  }
  const swapHashes = new Set([...hasOutgoing].filter(h => hasIncoming.has(h)));

  let deposited = 0;
  let withdrawn = 0;
  for (const tx of allTxs) {
    if (!USDC_CONTRACTS.has(tx.contractAddress?.toLowerCase())) continue;
    const decimals = parseInt(tx.tokenDecimal ?? '6');
    const amount = parseFloat(tx.value) / Math.pow(10, decimals);
    if (isNaN(amount)) continue;

    if (swapHashes.has(tx.hash)) {
      // Both sides of a USDC ↔ USDC.e swap — skip entirely
      console.log(`  🔄 Swap     $${amount.toFixed(2)} ${tx.tokenSymbol} (excluded — currency conversion)`);
      continue;
    }
    if (tx.to.toLowerCase() === wallet && !POLYMARKET_CONTRACTS.has(tx.from.toLowerCase())) {
      deposited += amount;
      console.log(`  ↓ Deposit  +$${amount.toFixed(2)} ${tx.tokenSymbol} from ${tx.from.slice(0,10)}… (tx: ${tx.hash.slice(0,12)}…)`);
    } else if (tx.to.toLowerCase() === wallet && POLYMARKET_CONTRACTS.has(tx.from.toLowerCase())) {
      console.log(`  ↩ Redeem   +$${amount.toFixed(2)} ${tx.tokenSymbol} from Polymarket (excluded from deposits)`);
    } else if (tx.from.toLowerCase() === wallet && !POLYMARKET_CONTRACTS.has(tx.to.toLowerCase())) {
      withdrawn += amount;
      console.log(`  ↑ Withdraw -$${amount.toFixed(2)} ${tx.tokenSymbol} to   ${tx.to.slice(0,10)}… (tx: ${tx.hash.slice(0,12)}…)`);
    }
  }
  console.log(`📊 Transfers summary: deposited=$${deposited.toFixed(2)} withdrawn=$${withdrawn.toFixed(2)}`);
  return { deposited, withdrawn };
}

async function fetchAccountSummary(): Promise<void> {
  if (!walletAddress) return;
  const summary: AccountSummary = {
    totalDeposited: 0, totalWithdrawn: 0, totalInvested: 0,
    totalReturned: 0, tradingPnl: 0, tradeCount: 0, redeemCount: 0,
  };

  // ── Polymarket activity: trades + redeems ──────────────────────────────
  let offset = 0;
  const limit = 500;
  while (true) {
    try {
      const res = await fetch(
        `https://data-api.polymarket.com/activity?user=${walletAddress}&limit=${limit}&offset=${offset}`
      );
      if (!res.ok) break;
      const records: any[] = await res.json();
      if (!Array.isArray(records) || records.length === 0) break;
      for (const r of records) {
        const amt = parseFloat(r.amount ?? r.usdcSize ?? 0);
        if (isNaN(amt)) continue;
        if (r.type === 'TRADE' && r.side === 'BUY') {
          summary.totalInvested += amt;
          summary.tradeCount++;
        } else if (r.type === 'REDEEM') {
          summary.totalReturned += amt;
          summary.redeemCount++;
        }
      }
      if (records.length < limit) break;
      offset += limit;
    } catch {
      break;
    }
  }

  // ── Polygonscan: USDC.e transfers = deposits & withdrawals ────────────
  try {
    const { deposited, withdrawn } = await fetchUsdcTransfers();
    summary.totalDeposited = deposited;
    summary.totalWithdrawn = withdrawn;
  } catch {
    // leave at 0 if Polygonscan is unavailable
  }

  summary.tradingPnl = summary.totalReturned - summary.totalInvested;
  accountSummary = summary;
}

// ─── Persistent trade history ────────────────────────────────────────────────

const DATA_PATH = path.join(__dirname, '..', 'data', 'trades.json');
const tradeHistory: TradeRecord[] = [];
const MAX_HISTORY = 500;

async function loadTradeHistory(): Promise<void> {
  try {
    const raw = await fs.readFile(DATA_PATH, 'utf-8');
    const records: TradeRecord[] = JSON.parse(raw);
    if (Array.isArray(records)) {
      tradeHistory.push(...records.slice(0, MAX_HISTORY));
    }
    console.log(`📂 Loaded ${tradeHistory.length} trade records from disk`);
  } catch {
    // File doesn't exist yet — start fresh
  }
}

async function saveTradeHistory(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
    await fs.writeFile(DATA_PATH, JSON.stringify(tradeHistory, null, 2), 'utf-8');
  } catch (e: any) {
    console.error('⚠️  Failed to save trade history:', e.message);
  }
}

function addToHistory(record: TradeRecord) {
  tradeHistory.unshift(record);
  if (tradeHistory.length > MAX_HISTORY) tradeHistory.pop();
  saveTradeHistory().catch(() => {}); // fire-and-forget
}

// ─── Bot state ───────────────────────────────────────────────────────────────

let bot: PolymarketCopyBot | null = null;

// Lazy executor for position exits — works even when the bot is stopped.
let _exitExecutor: TradeExecutor | null = null;
async function getExitExecutor(): Promise<TradeExecutor> {
  if (bot) return (bot as any).executor as TradeExecutor; // reuse bot's executor if available
  if (!_exitExecutor) {
    _exitExecutor = new TradeExecutor();
    await _exitExecutor.initialize();
  }
  return _exitExecutor;
}
let botStatus: 'stopped' | 'running' | 'initializing' | 'error' = 'stopped';
let botError: string | null = null;
let manuallyStopped = false;                    // prevent auto-start after manual stop
const redeemedConditions = new Set<string>();   // avoid double-redeem
const AUTO_START_THRESHOLD = 20;                // USDC.e balance to auto-start bot

async function startBot() {
  if (botStatus === 'running' || botStatus === 'initializing') return;
  botError = null;
  botStatus = 'initializing';
  broadcast({ type: 'status', botStatus, botError });

  bot = new PolymarketCopyBot();

  bot.onTradeCopied = (trade: any, result: any) => {
    addToHistory({
      id: result.orderId || randomUUID(),
      timestamp: Date.now(),
      market: trade.market || '',
      tokenId: trade.tokenId || result.tokenId || '',
      outcome: trade.outcome || '',
      side: trade.side,
      originalSize: trade.size,
      copySize: result.copyNotional,
      price: result.price,
      shares: result.copyShares,
      status: 'filled',
      entryCost: result.copyNotional,
      conditionId: result.conditionId ?? trade.conditionId ?? '',
      sourceAddress: trade.sourceAddress || '',
    });
    broadcastSnapshot();
  };

  bot.onTradeFailed = (trade: any, reason: string) => {
    addToHistory({
      id: randomUUID(),
      timestamp: Date.now(),
      market: trade.market || '',
      tokenId: trade.tokenId || '',
      outcome: trade.outcome || '',
      side: trade.side,
      originalSize: trade.size,
      copySize: 0,
      price: trade.price,
      shares: 0,
      status: 'failed',
      failReason: reason,
      sourceAddress: trade.sourceAddress || '',
    });
    broadcastSnapshot();
  };

  try {
    await bot.initialize();
    botStatus = 'running';
    broadcast({ type: 'status', botStatus, botError });
    // start() runs an infinite loop — fire without await
    bot.start().catch((e: any) => {
      botError = e.message;
      botStatus = 'error';
      broadcast({ type: 'status', botStatus, botError });
    });
  } catch (e: any) {
    botError = e.message;
    botStatus = 'error';
    broadcast({ type: 'status', botStatus, botError });
  }
}

function stopBot(manual = false) {
  if (bot) {
    bot.stop();
    bot = null;
  }
  botStatus = 'stopped';
  botError = null;
  if (manual) manuallyStopped = true;
  broadcast({ type: 'status', botStatus, botError });
}

// ─── Data fetchers ───────────────────────────────────────────────────────────

let walletAddress = '';
try {
  walletAddress = new ethers.Wallet(config.privateKey).address;
} catch {}

// Fallback public RPCs if QuikNode times out
const FALLBACK_RPCS = [
  config.rpcUrl,
  'https://polygon-rpc.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
];

async function getBalances(): Promise<{ pol: string; usdc: string }> {
  for (const rpc of FALLBACK_RPCS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpc);
      const [polBal, usdcBal] = await Promise.all([
        provider.getBalance(walletAddress),
        new ethers.Contract(config.contracts.usdc, ERC20_ABI, provider).balanceOf(walletAddress),
      ]);
      return {
        pol: parseFloat(ethers.utils.formatEther(polBal)).toFixed(4),
        usdc: parseFloat(ethers.utils.formatUnits(usdcBal, 6)).toFixed(2),
      };
    } catch {
      // try next RPC
    }
  }
  return { pol: '—', usdc: '—' };
}

async function getPositions(): Promise<any[]> {
  if (!walletAddress) return [];
  try {
    const res = await fetch(
      `https://data-api.polymarket.com/positions?user=${walletAddress}&sizeThreshold=.1`
    );
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// ─── WebSocket broadcast ─────────────────────────────────────────────────────

const clients: Set<WebSocket> = new Set();

function broadcast(data: object) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

async function broadcastSnapshot() {
  const [balances, positions] = await Promise.all([getBalances(), getPositions()]);
  const stats = bot?.getStats() ?? {
    tradesDetected: 0, tradesCopied: 0, tradesFailed: 0, totalVolume: 0,
  };

  const usdcBalance = parseFloat(balances.usdc);

  // ── Low balance auto-stop ──────────────────────────────────────────────
  const lowBalance = usdcBalance < config.trading.minTradeSize;
  if (lowBalance && botStatus === 'running') {
    console.log(`⚠️  Low balance ($${balances.usdc} USDC.e < $${config.trading.minTradeSize} min). Stopping bot.`);
    stopBot();
    botError = `Auto-stopped: balance $${balances.usdc} is below min trade size $${config.trading.minTradeSize}`;
    botStatus = 'stopped';
  }

  // ── Auto-start when balance recovers ──────────────────────────────────
  if (
    usdcBalance >= AUTO_START_THRESHOLD &&
    botStatus === 'stopped' &&
    !manuallyStopped
  ) {
    // Clear any auto-stop error so the bot can restart cleanly
    botError = null;
    console.log(`✅ Balance $${balances.usdc} ≥ $${AUTO_START_THRESHOLD} threshold. Auto-starting bot.`);
    startBot();
  }

  broadcast({
    type: 'snapshot',
    botStatus,
    botError,
    walletAddress,
    balances,
    lowBalance,
    autoStartThreshold: AUTO_START_THRESHOLD,
    manuallyStopped,
    positions,
    sessionStats: stats,
    recentTrades: tradeHistory.slice(0, 100),
    accountSummary,
    copyTargets: copyTargetManager.getAll(),
    aiReviewState: reviewScheduler.getState(),
    config: {
      targetWallet: config.targetWallet,
      minTradeSize: config.trading.minTradeSize,
      maxTradeSize: config.trading.maxTradeSize,
      positionMultiplier: config.trading.positionSizeMultiplier,
      orderType: config.trading.orderType,
      slippageTolerance: config.trading.slippageTolerance,
      maxPerMarketNotional: config.risk.maxPerMarketNotional,
      maxSessionNotional: config.risk.maxSessionNotional,
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function updateEnv(updates: Record<string, string>) {
  let content = await fs.readFile(ENV_PATH, 'utf-8').catch(() => '');
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }
  await fs.writeFile(ENV_PATH, content, 'utf-8');
}

function json(res: http.ServerResponse, status: number, data: object) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Public routes (no auth required) ─────────────────────────────────────
  if (req.method === 'GET' && pathname === '/login') {
    const html = await fs.readFile(LOGIN_PATH, 'utf-8').catch(
      () => '<h1 style="font-family:sans-serif;padding:2rem">Login page not found</h1>'
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readBody(req);
    if (body.username === DASHBOARD_USER && body.password === DASHBOARD_PASS) {
      const token = randomUUID();
      sessions.add(token);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`,
      });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid username or password' }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const token = getSessionToken(req);
    if (token) sessions.delete(token);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Auth guard ────────────────────────────────────────────────────────────
  if (!isAuthenticated(req)) {
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
    } else {
      res.writeHead(302, { Location: '/login' });
      res.end();
    }
    return;
  }

  // ── Protected routes ──────────────────────────────────────────────────────

  // Serve dashboard HTML
  if (req.method === 'GET' && pathname === '/') {
    const html = await fs.readFile(DASHBOARD_PATH, 'utf-8').catch(
      () => '<h1 style="font-family:sans-serif;padding:2rem">Dashboard not found</h1>'
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Serve discovery page
  if (req.method === 'GET' && pathname === '/discovery') {
    const html = await fs.readFile(DISCOVERY_PATH, 'utf-8').catch(
      () => '<h1 style="font-family:sans-serif;padding:2rem">Discovery page not found</h1>'
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // API routes
  if (!pathname.startsWith('/api/')) { res.writeHead(404); res.end('Not found'); return; }

  res.setHeader('Content-Type', 'application/json');

  try {
    // GET /api/status
    if (req.method === 'GET' && pathname === '/api/status') {
      const [balances] = await Promise.all([getBalances()]);
      const stats = bot?.getStats() ?? { tradesDetected: 0, tradesCopied: 0, tradesFailed: 0, totalVolume: 0 };
      return json(res, 200, { botStatus, botError, walletAddress, balances, sessionStats: stats });
    }

    // GET /api/positions
    if (req.method === 'GET' && pathname === '/api/positions') {
      return json(res, 200, await getPositions());
    }

    // GET /api/history
    if (req.method === 'GET' && pathname === '/api/history') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500);
      const offset = parseInt(url.searchParams.get('offset') || '0');
      return json(res, 200, { trades: tradeHistory.slice(offset, offset + limit), total: tradeHistory.length });
    }

    // POST /api/trades/refresh — pull recent activity from Polymarket and merge into local history
    if (req.method === 'POST' && pathname === '/api/trades/refresh') {
      if (!walletAddress) return json(res, 400, { error: 'Wallet not initialised' });
      try {
        const resp = await fetch(
          `https://data-api.polymarket.com/activity?user=${walletAddress.toLowerCase()}&type=TRADE&limit=500&sortBy=TIMESTAMP&sortDirection=DESC`
        );
        const raw: any[] = await resp.json();
        if (!Array.isArray(raw)) return json(res, 502, { error: 'Unexpected response from Polymarket' });

        const existingTxHashes = new Set(tradeHistory.map((t) => t.id));
        let added = 0;
        for (const t of raw) {
          const txHash: string = t.transactionHash || '';
          if (!txHash || existingTxHashes.has(txHash)) continue;

          // Skip if already recorded by onTradeCopied (same tokenId+side within 120s)
          const tMs = (t.timestamp ?? 0) * 1000;
          const alreadyRecorded = tradeHistory.some(
            (e) => e.tokenId === t.asset && e.side === t.side?.toUpperCase() && Math.abs(e.timestamp - tMs) < 120_000
          );
          if (alreadyRecorded) continue;

          addToHistory({
            id: txHash,
            timestamp: (t.timestamp ?? 0) * 1000,   // API returns seconds
            market: t.title || '',
            tokenId: t.asset || '',
            outcome: t.outcome || '',
            side: (t.side as 'BUY' | 'SELL') || 'BUY',
            originalSize: t.usdcSize ?? 0,
            copySize: t.usdcSize ?? 0,
            price: t.price ?? 0,
            shares: t.size ?? 0,
            status: 'filled',
            conditionId: t.conditionId || '',
            entryCost: t.usdcSize ?? 0,
          });
          existingTxHashes.add(txHash);
          added++;
        }
        // Re-sort by timestamp descending after merge
        tradeHistory.sort((a, b) => b.timestamp - a.timestamp);
        await saveTradeHistory();
        broadcastSnapshot();
        return json(res, 200, { ok: true, added, total: tradeHistory.length });
      } catch (e: any) {
        return json(res, 500, { error: e.message });
      }
    }

    // GET /api/account-summary
    if (req.method === 'GET' && pathname === '/api/account-summary') {
      return json(res, 200, accountSummary);
    }

    // GET /api/config
    if (req.method === 'GET' && pathname === '/api/config') {
      return json(res, 200, {
        targetWallet: config.targetWallet,
        minTradeSize: config.trading.minTradeSize,
        maxTradeSize: config.trading.maxTradeSize,
        positionMultiplier: config.trading.positionSizeMultiplier,
        orderType: config.trading.orderType,
        slippageTolerance: config.trading.slippageTolerance,
        maxPerMarketNotional: config.risk.maxPerMarketNotional,
        maxSessionNotional: config.risk.maxSessionNotional,
        blockKeywords: config.filters.blockKeywords,
        allowKeywords: config.filters.allowKeywords,
      });
    }

    // POST /api/bot/start
    if (req.method === 'POST' && pathname === '/api/bot/start') {
      manuallyStopped = false; // re-enable auto-start
      startBot();
      return json(res, 200, { ok: true, status: botStatus });
    }

    // POST /api/bot/stop
    if (req.method === 'POST' && pathname === '/api/bot/stop') {
      stopBot(true); // manual stop — suppress auto-restart
      return json(res, 200, { ok: true, status: botStatus });
    }

    // POST /api/settings
    if (req.method === 'POST' && pathname === '/api/settings') {
      const body = await readBody(req);
      const envUpdates: Record<string, string> = {};

      if (body.maxTradeSize !== undefined) {
        config.trading.maxTradeSize = parseFloat(body.maxTradeSize);
        envUpdates['MAX_TRADE_SIZE'] = String(body.maxTradeSize);
      }
      if (body.minTradeSize !== undefined) {
        config.trading.minTradeSize = parseFloat(body.minTradeSize);
        envUpdates['MIN_TRADE_SIZE'] = String(body.minTradeSize);
      }
      if (body.positionMultiplier !== undefined) {
        config.trading.positionSizeMultiplier = parseFloat(body.positionMultiplier);
        envUpdates['POSITION_MULTIPLIER'] = String(body.positionMultiplier);
      }
      if (body.maxPerMarketNotional !== undefined) {
        config.risk.maxPerMarketNotional = parseFloat(body.maxPerMarketNotional);
        envUpdates['MAX_PER_MARKET_NOTIONAL'] = String(body.maxPerMarketNotional);
      }
      if (body.maxSessionNotional !== undefined) {
        config.risk.maxSessionNotional = parseFloat(body.maxSessionNotional);
        envUpdates['MAX_SESSION_NOTIONAL'] = String(body.maxSessionNotional);
      }
      if (body.targetWallet !== undefined) {
        const addr = String(body.targetWallet).toLowerCase().trim();
        if (/^0x[0-9a-f]{40}$/.test(addr)) {
          config.targetWallet = addr;
          envUpdates['TARGET_WALLET'] = addr;
        }
      }
      if (body.blockKeywords !== undefined) {
        // Accept a comma-separated string or an array
        const kwList: string[] = Array.isArray(body.blockKeywords)
          ? body.blockKeywords.map(String)
          : String(body.blockKeywords).split(',').map((s: string) => s.trim());
        config.filters.blockKeywords = kwList.filter(Boolean);
        envUpdates['MARKET_BLOCK_KEYWORDS'] = config.filters.blockKeywords.join(',');
      }
      if (body.allowKeywords !== undefined) {
        const kwList: string[] = Array.isArray(body.allowKeywords)
          ? body.allowKeywords.map(String)
          : String(body.allowKeywords).split(',').map((s: string) => s.trim());
        config.filters.allowKeywords = kwList.filter(Boolean);
        envUpdates['MARKET_ALLOW_KEYWORDS'] = config.filters.allowKeywords.join(',');
      }

      await updateEnv(envUpdates);
      return json(res, 200, {
        ok: true,
        config: {
          minTradeSize: config.trading.minTradeSize,
          maxTradeSize: config.trading.maxTradeSize,
          positionMultiplier: config.trading.positionSizeMultiplier,
          blockKeywords: config.filters.blockKeywords,
          allowKeywords: config.filters.allowKeywords,
        },
      });
    }

    // GET /api/traders
    if (req.method === 'GET' && pathname === '/api/traders') {
      return json(res, 200, { traders: traderDiscovery.getTraders() });
    }

    // POST /api/traders/discover  (body: { lookbackDays?: number })
    if (req.method === 'POST' && pathname === '/api/traders/discover') {
      const body = await readBody(req);
      if (traderDiscovery.getStatus().status === 'running') {
        return json(res, 409, { error: 'Discovery already running' });
      }
      const lookbackDays = Math.max(1, Math.min(90, parseInt(body.lookbackDays ?? '30') || 30));
      traderDiscovery.triggerDiscovery({ lookbackDays });
      return json(res, 202, { ok: true, status: traderDiscovery.getStatus() });
    }

    // GET /api/traders/discovery-status
    if (req.method === 'GET' && pathname === '/api/traders/discovery-status') {
      return json(res, 200, traderDiscovery.getStatus());
    }

    // ── AI Review ─────────────────────────────────────────────────────────────

    // GET /api/ai/status
    if (req.method === 'GET' && pathname === '/api/ai/status') {
      return json(res, 200, reviewScheduler.getState());
    }

    // POST /api/ai/review  — trigger manual review
    if (req.method === 'POST' && pathname === '/api/ai/review') {
      if (reviewScheduler.getState().status === 'running') {
        return json(res, 409, { error: 'Review already running' });
      }
      // Fire without awaiting so the HTTP response returns immediately
      reviewScheduler.run().catch(console.error);
      return json(res, 202, { ok: true, status: reviewScheduler.getState() });
    }

    // ── Copy Targets ──────────────────────────────────────────────────────────

    // GET /api/copy-targets
    if (req.method === 'GET' && pathname === '/api/copy-targets') {
      return json(res, 200, { targets: copyTargetManager.getAll() });
    }

    // POST /api/copy-targets  (body: { address, label?, settings? })
    if (req.method === 'POST' && pathname === '/api/copy-targets') {
      const body = await readBody(req);
      const addr = String(body.address || '').toLowerCase().trim();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) {
        return json(res, 400, { error: 'Invalid address' });
      }
      try {
        copyTargetManager.add({
          address: addr,
          enabled: true,
          label: body.label || addr.slice(0, 10) + '...',
          topCategories: [],
          aiReason: 'Added manually',
          addedBy: 'manual',
          settings: {
            allowKeywords: body.settings?.allowKeywords ?? [...config.filters.allowKeywords],
            blockKeywords: body.settings?.blockKeywords ?? [...config.filters.blockKeywords],
            multiplier: body.settings?.multiplier ?? config.trading.positionSizeMultiplier,
            maxTradeSize: body.settings?.maxTradeSize ?? config.trading.maxTradeSize,
            minTradeSize: body.settings?.minTradeSize ?? config.trading.minTradeSize,
            maxPerMarketNotional: body.settings?.maxPerMarketNotional ?? config.risk.maxPerMarketNotional,
          },
        });
        if (bot) await bot.reloadTargets();
        broadcastSnapshot();
        return json(res, 201, { ok: true, targets: copyTargetManager.getAll() });
      } catch (e: any) {
        return json(res, 409, { error: e.message });
      }
    }

    // DELETE /api/copy-targets/:address
    const deleteTargetMatch = pathname.match(/^\/api\/copy-targets\/(.+)$/);
    if (req.method === 'DELETE' && deleteTargetMatch) {
      const addr = decodeURIComponent(deleteTargetMatch[1]).toLowerCase();
      const removed = copyTargetManager.remove(addr);
      if (!removed) return json(res, 404, { error: 'Address not found' });
      if (bot) await bot.reloadTargets();
      broadcastSnapshot();
      return json(res, 200, { ok: true, targets: copyTargetManager.getAll() });
    }

    // PUT /api/copy-targets/:address  (body: partial CopyTarget fields)
    const updateTargetMatch = pathname.match(/^\/api\/copy-targets\/(.+)$/);
    if (req.method === 'PUT' && updateTargetMatch) {
      const addr = decodeURIComponent(updateTargetMatch[1]).toLowerCase();
      const body = await readBody(req);
      const updated = copyTargetManager.update(addr, body);
      if (!updated) return json(res, 404, { error: 'Address not found' });
      if (bot) await bot.reloadTargets();
      broadcastSnapshot();
      return json(res, 200, { ok: true, target: copyTargetManager.get(addr) });
    }

    // POST /api/positions/:tokenId/exit  (body: { shares: number })
    const exitPosMatch = pathname.match(/^\/api\/positions\/([^/]+)\/exit$/);
    if (req.method === 'POST' && exitPosMatch) {
      const tokenId = decodeURIComponent(exitPosMatch[1]);
      const body = await readBody(req);
      const shares = parseFloat(body.shares);
      if (!shares || shares <= 0) return json(res, 400, { error: 'Invalid shares amount' });
      try {
        const executor = await getExitExecutor();
        const result = await executor.exitPosition(tokenId, shares);
        broadcastSnapshot();
        return json(res, 200, { ok: true, ...result });
      } catch (e: any) {
        return json(res, 500, { error: e.message });
      }
    }

    // POST /api/redeem/:conditionId  (body: { outcomeIndex: number })
    const redeemMatch = pathname.match(/^\/api\/redeem\/(.+)$/);
    if (req.method === 'POST' && redeemMatch) {
      const conditionId = redeemMatch[1];
      const body = await readBody(req);
      const outcomeIndex: number = body.outcomeIndex ?? 0;
      const indexSet = Math.pow(2, outcomeIndex); // 0→1, 1→2

      const CTF_ABI = [
        'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
      ];
      const ERC20_ABI_BAL = ['function balanceOf(address) view returns (uint256)'];

      const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
      const wallet   = new ethers.Wallet(config.privateKey, provider);
      const ctf      = new ethers.Contract(config.contracts.ctf, CTF_ABI, wallet);
      const usdc     = new ethers.Contract(config.contracts.usdc, ERC20_ABI_BAL, provider);

      const before   = await usdc.balanceOf(wallet.address);

      const feeData  = await provider.getFeeData();
      const minPri   = ethers.utils.parseUnits('30', 'gwei');
      const priority = (feeData.maxPriorityFeePerGas ?? minPri).lt(minPri) ? minPri : feeData.maxPriorityFeePerGas!;
      const maxFee   = (feeData.maxFeePerGas ?? ethers.utils.parseUnits('300', 'gwei')).mul(12).div(10);

      const tx = await ctf.redeemPositions(
        config.contracts.usdc,
        ethers.constants.HashZero,
        conditionId,
        [indexSet],
        { maxPriorityFeePerGas: priority, maxFeePerGas: maxFee }
      );
      await tx.wait();

      const after    = await usdc.balanceOf(wallet.address);
      const received = parseFloat(ethers.utils.formatUnits(after.sub(before), 6));

      broadcastSnapshot(); // refresh dashboard
      return json(res, 200, { ok: true, txHash: tx.hash, received });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (e: any) {
    return json(res, 500, { error: e.message });
  }
});

// ─── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws, req) => {
  // Reject unauthenticated WebSocket connections
  if (!isAuthenticated(req)) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  // Send full snapshot immediately on connect
  const [balances, positions] = await Promise.all([getBalances(), getPositions()]);
  const stats = bot?.getStats() ?? { tradesDetected: 0, tradesCopied: 0, tradesFailed: 0, totalVolume: 0 };
  ws.send(JSON.stringify({
    type: 'snapshot',
    botStatus,
    botError,
    walletAddress,
    balances,
    positions,
    sessionStats: stats,
    recentTrades: tradeHistory.slice(0, 100),
    accountSummary,
    copyTargets: copyTargetManager.getAll(),
    aiReviewState: reviewScheduler.getState(),
    config: {
      targetWallet: config.targetWallet,
      minTradeSize: config.trading.minTradeSize,
      maxTradeSize: config.trading.maxTradeSize,
      positionMultiplier: config.trading.positionSizeMultiplier,
      orderType: config.trading.orderType,
      slippageTolerance: config.trading.slippageTolerance,
      maxPerMarketNotional: config.risk.maxPerMarketNotional,
      maxSessionNotional: config.risk.maxSessionNotional,
    },
  }));
});

// ── Auto-redeem background poller ────────────────────────────────────────────
async function autoRedeem() {
  const positions = await getPositions();
  const winning = positions.filter(
    (p: any) => p.redeemable && parseFloat(p.curPrice ?? 0) >= 0.99 && !redeemedConditions.has(p.conditionId)
  );
  if (winning.length === 0) return;

  const NEG_RISK_ABI = ['function redeemPositions(bytes32 _conditionId, uint256[] calldata _amounts) public'];
  const CTF_ABI      = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
    'function balanceOf(address account, uint256 id) external view returns (uint256)',
  ];
  const ERC20_B    = ['function balanceOf(address) view returns (uint256)'];
  const provider   = new ethers.providers.JsonRpcProvider(config.rpcUrl);
  const wallet     = new ethers.Wallet(config.privateKey, provider);
  const negRisk    = new ethers.Contract(config.contracts.negRiskAdapter, NEG_RISK_ABI, wallet);
  const ctf        = new ethers.Contract(config.contracts.ctf, CTF_ABI, wallet);
  const ctfRead    = new ethers.Contract(config.contracts.ctf, CTF_ABI, provider);
  const usdcC      = new ethers.Contract(config.contracts.usdc, ERC20_B, provider);

  // Skip if pending txs — avoid nonce queue pile-up
  const confirmed = await provider.getTransactionCount(wallet.address, 'latest');
  const pending   = await provider.getTransactionCount(wallet.address, 'pending');
  if (pending > confirmed) {
    console.log(`🔄 Auto-redeem: skipping — ${pending - confirmed} pending tx(s)`);
    return;
  }

  // Group by conditionId — one redeemPositions call per condition
  const byCondition = new Map<string, any[]>();
  for (const p of winning) {
    if (!byCondition.has(p.conditionId)) byCondition.set(p.conditionId, []);
    byCondition.get(p.conditionId)!.push(p);
  }

  for (const [conditionId, posGroup] of byCondition) {
    const label = (posGroup[0]?.title ?? conditionId).slice(0, 65);
    try {
      redeemedConditions.add(conditionId);
      const before = await usdcC.balanceOf(wallet.address);

      const feeData = await provider.getFeeData();
      const minPri  = ethers.utils.parseUnits('50', 'gwei');
      const priority = (feeData.maxPriorityFeePerGas ?? minPri).lt(minPri) ? minPri : feeData.maxPriorityFeePerGas!;
      const block   = await provider.getBlock('latest');
      const baseFee = block.baseFeePerGas ?? ethers.utils.parseUnits('100', 'gwei');
      const maxFee  = baseFee.mul(2).add(priority);
      const gasOverrides = { maxPriorityFeePerGas: priority, maxFeePerGas: maxFee };

      // Build amounts[] from actual on-chain CTF balances
      const amounts: ethers.BigNumber[] = [];
      for (const p of posGroup) {
        const outcomeIdx = p.outcomeIndex ?? 0;
        while (amounts.length <= outcomeIdx) amounts.push(ethers.BigNumber.from(0));
        if (p.asset) {
          const bal = await ctfRead.balanceOf(wallet.address, p.asset);
          amounts[outcomeIdx] = bal;
        }
      }

      console.log(`🔄 Auto-redeeming: ${label}`);
      let tx: ethers.ContractTransaction;
      const isNegRisk   = posGroup.some((p: any) => p.negativeRisk);
      const hasBalance  = amounts.some(a => !a.isZero());

      if (hasBalance && isNegRisk) {
        try {
          tx = await negRisk.redeemPositions(conditionId, amounts, gasOverrides);
        } catch {
          tx = await ctf.redeemPositions(config.contracts.usdc, ethers.constants.HashZero, conditionId, [1, 2], gasOverrides);
        }
      } else {
        tx = await ctf.redeemPositions(config.contracts.usdc, ethers.constants.HashZero, conditionId, [1, 2], gasOverrides);
      }

      await tx.wait();
      const after    = await usdcC.balanceOf(wallet.address);
      const received = parseFloat(ethers.utils.formatUnits(after.sub(before), 6));
      console.log(`✅ Auto-redeemed ${label}: +$${received.toFixed(2)} USDC.e (tx: ${tx.hash})`);
      broadcast({ type: 'redeemed', market: posGroup[0]?.title ?? label, received, txHash: tx.hash });
    } catch (e: any) {
      redeemedConditions.delete(conditionId);
      console.error(`❌ Auto-redeem failed for ${label}: ${e.message}`);
    }
  }
  if (winning.length > 0) broadcastSnapshot();
}

setInterval(autoRedeem, 30_000); // check every 30s

// Broadcast snapshot every 5 seconds
setInterval(broadcastSnapshot, 5000);

// Refresh account summary every 5 minutes
setInterval(() => fetchAccountSummary().catch(console.error), 5 * 60 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────

// Load persisted trade history + warm account summary before accepting connections
await loadTradeHistory();
fetchAccountSummary().catch(console.error);

// ─── Trader Discovery ────────────────────────────────────────────────────────
const traderDiscovery = new TraderDiscovery();
await traderDiscovery.load();

// ─── AI Review Scheduler ─────────────────────────────────────────────────────
const reviewScheduler = new ReviewScheduler(
  traderDiscovery,
  () => bot,
  () => tradeHistory,
  () => broadcastSnapshot(),
);
reviewScheduler.start();

server.listen(PORT, () => {
  console.log(`\n📊 Dashboard: http://localhost:${PORT}`);
  console.log('   Open in your browser to monitor the bot\n');
});

process.on('SIGINT', () => { reviewScheduler.stop(); stopBot(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { reviewScheduler.stop(); stopBot(); server.close(); process.exit(0); });
