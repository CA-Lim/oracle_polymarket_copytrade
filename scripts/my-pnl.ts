import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const wallet  = new ethers.Wallet(process.env.PRIVATE_KEY!);
const WALLET  = wallet.address;
const SINCE   = Math.floor(new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime() / 1000) - 86400; // yesterday 00:00 UTC

async function main() {
  const [posRes, actRes] = await Promise.all([
    fetch(`https://data-api.polymarket.com/positions?user=${WALLET}&sizeThreshold=0&limit=500`),
    fetch(`https://data-api.polymarket.com/activity?user=${WALLET}&type=TRADE&limit=500&sortBy=TIMESTAMP&sortDirection=DESC&start=${SINCE}`),
  ]);
  const positions: any[] = await posRes.json();
  const activity: any[]  = await actRes.json();

  const sinceCondIds = new Set(activity.map((a: any) => a.conditionId));
  const relevantPos  = positions.filter((p: any) => sinceCondIds.has(p.conditionId));

  const bought = activity
    .filter((a: any) => a.side?.toUpperCase() === 'BUY')
    .reduce((s: number, a: any) => s + parseFloat(a.usdcSize ?? 0), 0);

  let totalInvested = 0, totalCurVal = 0;
  const wins: any[] = [], losses: any[] = [], open: any[] = [];

  for (const p of relevantPos) {
    const invested = parseFloat(p.initialValue ?? 0);
    const curVal   = parseFloat(p.currentValue ?? 0);
    const pnl      = parseFloat(p.cashPnl ?? 0);
    const price    = parseFloat(p.curPrice ?? 0);
    totalInvested += invested;
    totalCurVal   += curVal;

    if (price === 0 && pnl > 0) wins.push(p);
    else if (price === 0)        losses.push(p);
    else                         open.push(p);
  }

  const sinceDate = new Date(SINCE * 1000).toISOString().slice(0, 10);
  const net       = totalCurVal - totalInvested;

  console.log('\n========================================');
  console.log(`  MY PnL SINCE ${sinceDate.toUpperCase()}  |  ...${WALLET.slice(-6)}`);
  console.log('========================================');
  console.log(`Trades placed:    ${activity.length}  ($${bought.toFixed(2)} deployed)`);
  console.log(`Resolved wins:    ${wins.length}`);
  console.log(`Resolved losses:  ${losses.length}`);
  console.log(`Still open:       ${open.length}`);
  console.log(`Net PnL:          $${net >= 0 ? '+' : ''}${net.toFixed(2)}`);
  console.log(`  invested: $${totalInvested.toFixed(2)}  current value: $${totalCurVal.toFixed(2)}`);

  if (wins.length) {
    console.log('\n--- WINS ---');
    for (const p of wins)
      console.log(`  ✅ ${p.title?.slice(0, 55)} [${p.outcome}]  +$${parseFloat(p.cashPnl).toFixed(2)}`);
  }

  if (open.length) {
    console.log('\n--- OPEN POSITIONS ---');
    for (const p of open.sort((a: any, b: any) => parseFloat(b.currentValue) - parseFloat(a.currentValue))) {
      const pnl = parseFloat(p.cashPnl);
      console.log(`  ⏳ ${p.title?.slice(0, 55)} [${p.outcome}]`);
      console.log(`     endDate=${p.endDate}  price=${p.curPrice}  invested=$${parseFloat(p.initialValue).toFixed(2)}  curVal=$${parseFloat(p.currentValue).toFixed(2)}  pnl=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    }
  }

  if (losses.length) {
    console.log('\n--- LOSSES ---');
    for (const p of losses)
      console.log(`  ❌ ${p.title?.slice(0, 55)} [${p.outcome}]  -$${Math.abs(parseFloat(p.cashPnl)).toFixed(2)}`);
  }

  console.log('\n========================================\n');
}

main().catch(e => { console.error(e.message); process.exit(1); });
