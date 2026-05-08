import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const WALLET = '0x5d1d9cfd66ee3068c2a8a57dedf1e1b006dcafd2';
const CTF    = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_ABI = ['function balanceOf(address account, uint256 id) external view returns (uint256)'];
const SINCE  = 1778112000; // 2026-05-07 00:00:00 UTC (yesterday)

async function main() {
  const rpc = process.env.RPC_URL || 'https://polygon-rpc.com';
  const provider = new ethers.providers.StaticJsonRpcProvider(rpc, { chainId: 137, name: 'matic' });
  const ctf = new ethers.Contract(CTF, CTF_ABI, provider);

  const [posRes, actRes] = await Promise.all([
    fetch(`https://data-api.polymarket.com/positions?user=${WALLET}&sizeThreshold=0&limit=500`),
    fetch(`https://data-api.polymarket.com/activity?user=${WALLET}&type=TRADE&limit=200&sortBy=TIMESTAMP&sortDirection=DESC&start=${SINCE}`),
  ]);
  const positions: any[] = await posRes.json();
  const activity: any[]  = await actRes.json();

  const yesterdayCondIds = new Set(activity.map((a: any) => a.conditionId));
  const relevantPos = positions.filter((p: any) => yesterdayCondIds.has(p.conditionId));

  // Verify on-chain balance for each position
  const withBal = await Promise.all(relevantPos.map(async (p: any) => {
    let onChain = '?';
    try {
      const bn  = ethers.BigNumber.from(p.asset.toString());
      const raw = await ctf.balanceOf(WALLET, bn);
      onChain = (raw.toBigInt() === 0n) ? '0' : (Number(raw.toBigInt()) / 1e6).toFixed(4);
    } catch (e: any) {
      onChain = `ERR:${e.message?.slice(0,30)}`;
    }
    return { ...p, onChain };
  }));

  const bought = activity
    .filter((a: any) => a.side?.toUpperCase() === 'BUY')
    .reduce((s: number, a: any) => s + parseFloat(a.usdcSize ?? 0), 0);

  let totalInvested = 0, totalCurVal = 0;
  const wins: any[] = [], losses: any[] = [], open: any[] = [];

  for (const p of withBal) {
    const invested = parseFloat(p.initialValue ?? 0);
    const curVal   = parseFloat(p.currentValue ?? 0);
    const pnl      = parseFloat(p.cashPnl ?? 0);
    const price    = parseFloat(p.curPrice ?? 0);
    totalInvested += invested;
    totalCurVal   += curVal;

    if (price === 0 && pnl > 0)      wins.push(p);
    else if (price === 0)             losses.push(p);
    else                              open.push(p);
  }

  console.log('\n========================================');
  console.log(`  PnL SINCE MAY 7  |  wallet: ...${WALLET.slice(-6)}`);
  console.log('========================================');
  console.log(`Trades placed:    ${activity.length}  ($${bought.toFixed(2)} deployed)`);
  console.log(`Resolved wins:    ${wins.length}`);
  console.log(`Resolved losses:  ${losses.length}`);
  console.log(`Still open:       ${open.length}`);
  console.log(`Net PnL (May 6+): $${(totalCurVal - totalInvested) >= 0 ? '+' : ''}${(totalCurVal - totalInvested).toFixed(2)}`);
  console.log(`  invested: $${totalInvested.toFixed(2)}  current value: $${totalCurVal.toFixed(2)}`);

  if (wins.length) {
    console.log('\n--- WINS ---');
    for (const p of wins) {
      console.log(`  ✅ ${p.title?.slice(0, 55)} [${p.outcome}]`);
      console.log(`     invested=$${parseFloat(p.initialValue).toFixed(2)}  pnl=+$${parseFloat(p.cashPnl).toFixed(2)}  onChain=${p.onChain}`);
    }
  }

  console.log('\n--- OPEN POSITIONS ---');
  for (const p of open.sort((a: any, b: any) => parseFloat(b.currentValue) - parseFloat(a.currentValue))) {
    const pnl = parseFloat(p.cashPnl);
    console.log(`  ⏳ ${p.title?.slice(0, 55)} [${p.outcome}]`);
    console.log(`     endDate=${p.endDate}  price=${p.curPrice}  invested=$${parseFloat(p.initialValue).toFixed(2)}  curVal=$${parseFloat(p.currentValue).toFixed(2)}  pnl=${pnl>=0?'+':''}$${pnl.toFixed(2)}  onChain=${p.onChain}`);
  }

  console.log('\n--- LOSSES ---');
  for (const p of losses) {
    console.log(`  ❌ ${p.title?.slice(0, 55)} [${p.outcome}]  -$${Math.abs(parseFloat(p.cashPnl)).toFixed(2)}  onChain=${p.onChain}`);
  }
  console.log('\n========================================\n');
}

main().catch(e => { console.error(e.message); process.exit(1); });
