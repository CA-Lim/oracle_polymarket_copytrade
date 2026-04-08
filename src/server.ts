import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { ethers } from 'ethers';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { PolymarketCopyBot } from './index.js';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard', 'index.html');
const LOGIN_PATH     = path.join(__dirname, '..', 'dashboard', 'login.html');
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
  entryCost?: number;    // USDC actually spent (= copySize for filled BUYs)
  conditionId?: string;  // links trade to redemption event
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
    config: {
      targetWallet: config.targetWallet,
      minTradeSize: config.trading.minTradeSize,
      maxTradeSize: config.trading.maxTradeSize,
      positionMultiplier: config.trading.positionSizeMultiplier,
      orderType: config.trading.orderType,
      slippageTolerance: config.trading.slippageTolerance,
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

      await updateEnv(envUpdates);
      return json(res, 200, {
        ok: true,
        config: {
          minTradeSize: config.trading.minTradeSize,
          maxTradeSize: config.trading.maxTradeSize,
          positionMultiplier: config.trading.positionSizeMultiplier,
        },
      });
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
    config: {
      targetWallet: config.targetWallet,
      minTradeSize: config.trading.minTradeSize,
      maxTradeSize: config.trading.maxTradeSize,
      positionMultiplier: config.trading.positionSizeMultiplier,
      orderType: config.trading.orderType,
      slippageTolerance: config.trading.slippageTolerance,
    },
  }));
});

// ── Auto-redeem background poller ────────────────────────────────────────────
async function autoRedeem() {
  const positions = await getPositions();
  const redeemable = positions.filter((p: any) => p.redeemable && !redeemedConditions.has(p.conditionId));
  if (redeemable.length === 0) return;

  const CTF_ABI  = ['function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external'];
  const ERC20_B  = ['function balanceOf(address) view returns (uint256)'];
  const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
  const wallet   = new ethers.Wallet(config.privateKey, provider);
  const ctf      = new ethers.Contract(config.contracts.ctf, CTF_ABI, wallet);
  const usdcC    = new ethers.Contract(config.contracts.usdc, ERC20_B, provider);

  for (const pos of redeemable) {
    try {
      redeemedConditions.add(pos.conditionId); // mark early to prevent double-trigger
      const before   = await usdcC.balanceOf(wallet.address);
      const feeData  = await provider.getFeeData();
      const minPri   = ethers.utils.parseUnits('30', 'gwei');
      const priority = (feeData.maxPriorityFeePerGas ?? minPri).lt(minPri) ? minPri : feeData.maxPriorityFeePerGas!;
      const maxFee   = (feeData.maxFeePerGas ?? ethers.utils.parseUnits('300', 'gwei')).mul(12).div(10);
      const indexSet = Math.pow(2, pos.outcomeIndex ?? 0);

      console.log(`🔄 Auto-redeeming: ${pos.title} (${pos.outcome})`);
      const tx = await ctf.redeemPositions(
        config.contracts.usdc, ethers.constants.HashZero, pos.conditionId, [indexSet],
        { maxPriorityFeePerGas: priority, maxFeePerGas: maxFee }
      );
      await tx.wait();
      const after    = await usdcC.balanceOf(wallet.address);
      const received = parseFloat(ethers.utils.formatUnits(after.sub(before), 6));
      console.log(`✅ Auto-redeemed ${pos.title}: +$${received.toFixed(2)} USDC.e (tx: ${tx.hash})`);
      broadcast({ type: 'redeemed', market: pos.title, received, txHash: tx.hash });
    } catch (e: any) {
      redeemedConditions.delete(pos.conditionId); // allow retry on failure
      console.error(`❌ Auto-redeem failed for ${pos.title}: ${e.message}`);
    }
  }
  if (redeemable.length > 0) broadcastSnapshot();
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

server.listen(PORT, () => {
  console.log(`\n📊 Dashboard: http://localhost:${PORT}`);
  console.log('   Open in your browser to monitor the bot\n');
});

process.on('SIGINT', () => { stopBot(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { stopBot(); server.close(); process.exit(0); });
