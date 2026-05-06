import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const FROM = '2026-05-05 00:00:00+00';
  const TO   = '2026-05-07 00:00:00+00';

  // --- Trade summary ---
  const tradeSummary = await pool.query(`
    SELECT
      COUNT(*)                                                              AS total_trades,
      COUNT(*) FILTER (WHERE status='filled')                              AS filled,
      COUNT(*) FILTER (WHERE status='failed')                              AS failed,
      ROUND(SUM(CASE WHEN status='filled' THEN COALESCE(entry_cost,0) ELSE 0 END)::numeric, 4) AS total_invested,
      ROUND(SUM(CASE WHEN status='filled' THEN shares ELSE 0 END)::numeric, 4)                  AS total_shares
    FROM trades
    WHERE ts >= $1 AND ts < $2
  `, [FROM, TO]);

  // --- Redeems in the same window ---
  const redeemSummary = await pool.query(`
    SELECT
      COUNT(*)                        AS total_redeems,
      ROUND(SUM(received)::numeric, 4) AS total_received
    FROM redeems
    WHERE ts >= $1 AND ts < $2
      AND received > 0
  `, [FROM, TO]);

  // --- Per-market breakdown: cost vs received ---
  const perMarket = await pool.query(`
    SELECT
      t.market,
      t.condition_id,
      ROUND(SUM(CASE WHEN t.status='filled' THEN COALESCE(t.entry_cost,0) ELSE 0 END)::numeric, 4) AS invested,
      ROUND(COALESCE(SUM(r.received), 0)::numeric, 4)                                                AS received,
      ROUND((COALESCE(SUM(r.received), 0) - SUM(CASE WHEN t.status='filled' THEN COALESCE(t.entry_cost,0) ELSE 0 END))::numeric, 4) AS pnl,
      COUNT(DISTINCT t.id)  AS trades,
      COUNT(DISTINCT r.id)  AS redeems
    FROM trades t
    LEFT JOIN redeems r ON r.condition_id = t.condition_id
    WHERE t.ts >= $1 AND t.ts < $2
      AND t.condition_id <> ''
    GROUP BY t.market, t.condition_id
    ORDER BY t.market
  `, [FROM, TO]);

  // --- Open positions (traded but not yet redeemed) ---
  const openPositions = await pool.query(`
    SELECT
      t.market,
      ROUND(SUM(CASE WHEN t.status='filled' THEN COALESCE(t.entry_cost,0) ELSE 0 END)::numeric, 4) AS invested,
      ROUND(SUM(CASE WHEN t.status='filled' THEN t.shares ELSE 0 END)::numeric, 4)                  AS shares
    FROM trades t
    LEFT JOIN redeems r ON r.condition_id = t.condition_id
    WHERE t.ts >= $1 AND t.ts < $2
      AND t.condition_id <> ''
      AND r.id IS NULL
      AND t.status = 'filled'
    GROUP BY t.market, t.condition_id
    ORDER BY invested DESC
  `, [FROM, TO]);

  const s  = tradeSummary.rows[0];
  const r  = redeemSummary.rows[0];
  const invested    = parseFloat(s.total_invested  ?? 0);
  const received    = parseFloat(r.total_received  ?? 0);
  const realizedPnl = received - invested;

  console.log('\n========================================');
  console.log('  TRADE REPORT  |  May 5-6, 2026 UTC');
  console.log('========================================');
  console.log(`Trades:      ${s.total_trades}  (filled: ${s.filled}, failed: ${s.failed})`);
  console.log(`Total invested:    $${invested.toFixed(4)}`);
  console.log(`Total received:    $${received.toFixed(4)}`);
  console.log(`Realized PnL:      $${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(4)}`);

  if (openPositions.rows.length) {
    const openInvested = openPositions.rows.reduce((s: number, r: any) => s + parseFloat(r.invested), 0);
    console.log(`\nOpen (unrealized): ${openPositions.rows.length} market(s), $${openInvested.toFixed(4)} at risk`);
  }

  console.log('\n--- Per-market breakdown ---');
  for (const row of perMarket.rows) {
    const pnl    = parseFloat(row.pnl);
    const status = parseFloat(row.received) > 0 ? '✅' : parseFloat(row.invested) > 0 ? '⏳' : '  ';
    console.log(`${status} ${row.market.slice(0, 60)}`);
    console.log(`   invested: $${row.invested}  received: $${row.received}  PnL: ${pnl >= 0 ? '+' : ''}$${pnl}`);
  }

  if (openPositions.rows.length) {
    console.log('\n--- Still open (no redeem yet) ---');
    for (const row of openPositions.rows) {
      console.log(`⏳ ${row.market.slice(0, 60)}`);
      console.log(`   invested: $${row.invested}  shares: ${row.shares}`);
    }
  }

  console.log('\n========================================\n');
  await pool.end();
}

main().catch(console.error);
