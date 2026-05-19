import * as dotenv from 'dotenv';
dotenv.config();
import pkg from 'pg';
const { Client } = pkg;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Check row count and date range
  const count = await client.query(`SELECT COUNT(*) AS total, MIN(ts) AS oldest, MAX(ts) AS newest FROM trades`);
  console.log('Total trades in DB:', JSON.stringify(count.rows[0]));

  // Show distinct markets around May 7
  const markets = await client.query(`
    SELECT market, MIN(ts) AS first_seen
    FROM trades
    WHERE ts >= '2026-05-07' AND ts < '2026-05-08'
    GROUP BY market
    ORDER BY first_seen
    LIMIT 30
  `);
  console.log('\nMarkets on May 7:');
  for (const r of markets.rows) console.log(' ', r.market, '|', r.first_seen);

  // Also try by source_address on May 7
  const src = await client.query(`
    SELECT ts, market, outcome, side, original_size, price, status, fail_reason, condition_id
    FROM trades
    WHERE source_address = '0x5d1d9cfd66ee3068c2a8a57dedf1e1b006dcafd2'
      AND ts >= '2026-05-07' AND ts < '2026-05-08'
    ORDER BY ts
  `);
  console.log('\nSource wallet May 7 copy trades:', src.rows.length);
  for (const r of src.rows) console.log(JSON.stringify(r));

  await client.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
