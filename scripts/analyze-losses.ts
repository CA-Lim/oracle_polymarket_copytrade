/**
 * Run against production DB to diagnose losses since yesterday.
 * Usage: DATABASE_URL=<prod-url> npx tsx scripts/analyze-losses.ts
 */

import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SINCE = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

async function run() {
  const client = await pool.connect();
  try {
    console.log(`\n=== Trade Analysis since ${SINCE} ===\n`);

    // 1. Summary counts & totals
    const summary = await client.query(`
      SELECT
        COUNT(*)                                                               AS total_trades,
        COUNT(*) FILTER (WHERE side = 'BUY')                                  AS buys,
        COUNT(*) FILTER (WHERE side = 'SELL')                                 AS sells,
        COUNT(*) FILTER (WHERE status = 'failed')                             AS failed,
        ROUND(SUM(CASE WHEN side='BUY' THEN COALESCE(entry_cost,0) ELSE 0 END)::numeric, 4)
                                                                               AS total_spent,
        ROUND(SUM(CASE WHEN side='SELL' THEN copy_size * price ELSE 0 END)::numeric, 4)
                                                                               AS total_proceeds,
        ROUND(SUM(CASE WHEN side='BUY' THEN copy_size ELSE 0 END)::numeric, 4) AS shares_bought,
        ROUND(AVG(price)::numeric, 4)                                          AS avg_price
      FROM trades
      WHERE ts >= $1
    `, [SINCE]);
    console.log('--- SUMMARY ---');
    console.table(summary.rows);

    // 2. Per-market P&L for trades in window
    const byMarket = await client.query(`
      SELECT
        market,
        outcome,
        COUNT(*) FILTER (WHERE side='BUY')                                    AS buys,
        COUNT(*) FILTER (WHERE side='SELL')                                   AS sells,
        ROUND(SUM(CASE WHEN side='BUY' THEN COALESCE(entry_cost,0) ELSE 0 END)::numeric,4)
                                                                               AS invested,
        ROUND(SUM(CASE WHEN side='SELL' THEN copy_size * price ELSE 0 END)::numeric,4)
                                                                               AS proceeds,
        ROUND(AVG(price) FILTER (WHERE side='BUY')::numeric, 4)               AS avg_buy_price,
        ROUND(AVG(price) FILTER (WHERE side='SELL')::numeric, 4)              AS avg_sell_price,
        ROUND(SUM(CASE WHEN side='BUY' THEN copy_size ELSE 0 END)::numeric,4) AS shares_bought,
        ROUND(SUM(CASE WHEN side='SELL' THEN copy_size ELSE 0 END)::numeric,4) AS shares_sold,
        MIN(ts)::text                                                          AS first_trade,
        MAX(ts)::text                                                          AS last_trade
      FROM trades
      WHERE ts >= $1
      GROUP BY market, outcome
      ORDER BY invested DESC NULLS LAST
    `, [SINCE]);
    console.log('\n--- BY MARKET ---');
    console.table(byMarket.rows);

    // 3. Failed trades
    const failed = await client.query(`
      SELECT ts, market, outcome, side, copy_size, price, fail_reason
      FROM trades
      WHERE ts >= $1 AND status = 'failed'
      ORDER BY ts DESC
    `, [SINCE]);
    if (failed.rows.length > 0) {
      console.log('\n--- FAILED TRADES ---');
      console.table(failed.rows);
    } else {
      console.log('\n--- FAILED TRADES: none ---');
    }

    // 4. Balance snapshots (last 3 days for trend)
    const snapshots = await client.query(`
      SELECT snapshot_date, usdc_balance, pusd_balance, positions_value, total_portfolio
      FROM daily_balance_snapshots
      ORDER BY snapshot_date DESC
      LIMIT 3
    `);
    console.log('\n--- BALANCE SNAPSHOTS (last 3 days) ---');
    console.table(snapshots.rows);

    // 5. Portfolio delta
    if (snapshots.rows.length >= 2) {
      const latest = parseFloat(snapshots.rows[0].total_portfolio);
      const prev   = parseFloat(snapshots.rows[1].total_portfolio);
      const delta  = latest - prev;
      console.log(`\nPortfolio change (${snapshots.rows[1].snapshot_date} → ${snapshots.rows[0].snapshot_date}): ${delta >= 0 ? '+' : ''}${delta.toFixed(4)} USDC`);
    }

    // 6. Source wallets being copied — who drove the most trades?
    const sources = await client.query(`
      SELECT
        source_address,
        COUNT(*)                                                               AS trades,
        ROUND(SUM(CASE WHEN side='BUY' THEN COALESCE(entry_cost,0) ELSE 0 END)::numeric,4)
                                                                               AS invested
      FROM trades
      WHERE ts >= $1
      GROUP BY source_address
      ORDER BY invested DESC NULLS LAST
    `, [SINCE]);
    console.log('\n--- BY SOURCE WALLET ---');
    console.table(sources.rows);

    // 7. Redeems in the window
    const redeems = await client.query(`
      SELECT ts, condition_id, label, received, tx_hash
      FROM redeems
      WHERE ts >= $1
      ORDER BY ts DESC
    `, [SINCE]);
    if (redeems.rows.length > 0) {
      console.log('\n--- REDEEMS ---');
      console.table(redeems.rows);
    } else {
      console.log('\n--- REDEEMS: none in window ---');
    }

    // 8. Open positions cost (BUYs with no matching redeem yet)
    const openCost = await client.query(`
      SELECT
        ROUND(SUM(COALESCE(entry_cost,0))::numeric,4) AS unredeemed_invested,
        COUNT(DISTINCT condition_id)                   AS open_markets
      FROM trades t
      WHERE side = 'BUY'
        AND status = 'filled'
        AND NOT EXISTS (
          SELECT 1 FROM redeems r WHERE r.condition_id = t.condition_id
        )
    `);
    console.log('\n--- OPEN / UNREDEEMED POSITIONS ---');
    console.table(openCost.rows);

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
