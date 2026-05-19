// One-off investigation: all Al Nassr trades for wallet 0x5d1d...afd2 on 2026-05-12
const TARGET = '0x5d1d9cfd66ee3068c2a8a57dedf1e1b006dcafd2';
const SINCE  = 1746576000; // 2026-05-07 00:00 UTC — wide window to catch everything

// conditionIds for the three Al Nassr markets on 2026-05-12
const WIN_COND    = '0xb39d6f3605a43df153ffe65139cb87f4f01d30fa8d1a1e99aa098834f1978c56';
const BTTS_COND   = '0xc3842d94e27ae321a32936ec35eba310bd9c6b14b4ddb5a9e2700004e9ad32f7';
const OU_COND     = '0xd45f65ab1a2efca90203bf6e65d5dfdb1166d6ef6814978bf77a8bfc02e35d3f';

function fmtDate(ts: number) {
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function pad(s: string | number, n: number) { return String(s).padStart(n); }

async function main() {
  const [actRes, redeemRes] = await Promise.all([
    fetch(`https://data-api.polymarket.com/activity?user=${TARGET}&type=TRADE&limit=500&sortBy=TIMESTAMP&sortDirection=DESC&start=${SINCE}`),
    fetch(`https://data-api.polymarket.com/activity?user=${TARGET}&type=REDEEM&limit=200&sortBy=TIMESTAMP&sortDirection=DESC&start=${SINCE}`),
  ]);

  const activity: any[]  = await actRes.json();
  const redeems:  any[]  = await redeemRes.json();

  const nassr = activity.filter(a => (a.conditionId === WIN_COND || a.conditionId === BTTS_COND || a.conditionId === OU_COND));
  nassr.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)); // ASC for display

  const nassr_redeems = redeems.filter(r => [WIN_COND, BTTS_COND, OU_COND].includes(r.conditionId));

  const markets: Record<string, { label: string; trades: any[]; received: number }> = {
    [WIN_COND]:  { label: 'Will Al Nassr Saudi Club win on 2026-05-12?',                    trades: [], received: 0 },
    [BTTS_COND]: { label: 'Al Nassr vs Al Hilal: Both Teams to Score',                      trades: [], received: 0 },
    [OU_COND]:   { label: 'Al Nassr vs Al Hilal: O/U 2.5',                                  trades: [], received: 0 },
  };

  for (const t of nassr) markets[t.conditionId]?.trades.push(t);
  for (const r of nassr_redeems) {
    if (markets[r.conditionId]) markets[r.conditionId].received += parseFloat(r.usdcSize ?? 0);
  }

  console.log('\n' + '='.repeat(70));
  console.log(`  AL NASSR MATCH INVESTIGATION — Wallet ...${TARGET.slice(-4)}`);
  console.log(`  Match: Al Nassr vs Al Hilal  |  Date: 2026-05-12`);
  console.log('='.repeat(70));

  let grandInvested = 0, grandReceived = 0;

  for (const [cond, mkt] of Object.entries(markets)) {
    if (!mkt.trades.length && mkt.received === 0) continue;

    const groups: Record<string, { invested: number; shares: number }> = {};
    for (const t of mkt.trades) {
      const outcome = (t.outcome ?? 'YES').toUpperCase();
      if (!groups[outcome]) groups[outcome] = { invested: 0, shares: 0 };
      const usdc   = parseFloat(t.usdcSize ?? 0);
      const price  = parseFloat(t.price ?? 0);
      const shares = price > 0 ? usdc / price : 0;
      if ((t.side ?? '').toUpperCase() === 'BUY') {
        groups[outcome].invested += usdc;
        groups[outcome].shares   += shares;
      }
    }

    const totalInvested = Object.values(groups).reduce((s, g) => s + g.invested, 0);
    const pnl = mkt.received - totalInvested;
    grandInvested += totalInvested;
    grandReceived += mkt.received;

    console.log(`\n┌─ ${mkt.label}`);
    console.log(`│  conditionId: ${cond}`);
    console.log('│');
    console.log('│  TRADES:');
    let num = 0;
    for (const t of mkt.trades) {
      num++;
      const outcome = (t.outcome ?? 'YES').toUpperCase();
      const side    = (t.side    ?? 'BUY').toUpperCase();
      const usdc    = parseFloat(t.usdcSize ?? 0);
      const price   = parseFloat(t.price   ?? 0);
      const shares  = price > 0 ? usdc / price : 0;
      console.log(`│  #${num}  ${fmtDate(t.timestamp)}  ${side} ${outcome.padEnd(5)}  $${usdc.toFixed(2).padStart(8)}  @ ${price.toFixed(4)}  → ${shares.toFixed(2).padStart(8)} shares`);
    }
    console.log('│');
    console.log('│  SUMMARY BY OUTCOME:');
    for (const [outcome, g] of Object.entries(groups)) {
      const avg = g.shares > 0 ? g.invested / g.shares : 0;
      console.log(`│    ${outcome.padEnd(7)} invested=$${g.invested.toFixed(2).padStart(8)}  shares=${g.shares.toFixed(2).padStart(9)}  avgPrice=${avg.toFixed(4)}`);
    }
    console.log('│');
    console.log(`│  SETTLEMENT:  received=$${mkt.received.toFixed(2)}  total invested=$${totalInvested.toFixed(2)}`);
    console.log(`│  NET PnL:     ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}  ${pnl >= 0 ? '✅ PROFIT' : '❌ LOSS'}`);
    console.log('└' + '─'.repeat(68));
  }

  const grandPnl = grandReceived - grandInvested;
  console.log('\n' + '='.repeat(70));
  console.log(`  GRAND TOTAL (all Al Nassr markets combined)`);
  console.log(`  Total invested:  $${grandInvested.toFixed(2)}`);
  console.log(`  Total received:  $${grandReceived.toFixed(2)}`);
  console.log(`  Net PnL:         ${grandPnl >= 0 ? '+' : ''}$${grandPnl.toFixed(2)}  ${grandPnl >= 0 ? '✅ PROFIT' : '❌ LOSS'}`);
  console.log('='.repeat(70) + '\n');
}

main().catch(e => { console.error(e.message); process.exit(1); });
