import pg from 'pg';

const { Pool } = pg;

let pool: InstanceType<typeof Pool> | null = null;

const DDL = `
CREATE TABLE IF NOT EXISTS trades (
  id             TEXT          PRIMARY KEY,
  ts             TIMESTAMPTZ   NOT NULL,
  market         TEXT          NOT NULL DEFAULT '',
  token_id       TEXT          NOT NULL DEFAULT '',
  outcome        TEXT          NOT NULL DEFAULT '',
  side           TEXT          NOT NULL CHECK (side IN ('BUY','SELL')),
  original_size  NUMERIC(18,6) NOT NULL DEFAULT 0,
  copy_size      NUMERIC(18,6) NOT NULL DEFAULT 0,
  price          NUMERIC(10,6) NOT NULL DEFAULT 0,
  shares         NUMERIC(18,6) NOT NULL DEFAULT 0,
  status         TEXT          NOT NULL CHECK (status IN ('filled','failed')),
  fail_reason    TEXT,
  entry_cost     NUMERIC(18,6),
  condition_id   TEXT          NOT NULL DEFAULT '',
  source_address TEXT          NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS trades_ts_idx           ON trades (ts DESC);
CREATE INDEX IF NOT EXISTS trades_condition_id_idx ON trades (condition_id) WHERE condition_id <> '';
CREATE INDEX IF NOT EXISTS trades_source_addr_idx  ON trades (source_address) WHERE source_address <> '';
CREATE INDEX IF NOT EXISTS trades_status_idx       ON trades (status);

CREATE TABLE IF NOT EXISTS redeems (
  id           BIGSERIAL     PRIMARY KEY,
  ts           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  condition_id TEXT          NOT NULL,
  label        TEXT          NOT NULL DEFAULT '',
  received     NUMERIC(18,6) NOT NULL,
  tx_hash      TEXT          NOT NULL UNIQUE,
  source       TEXT          NOT NULL DEFAULT 'auto'
    CHECK (source IN ('auto_redeemer','auto_server','manual'))
);
CREATE INDEX IF NOT EXISTS redeems_condition_id_idx ON redeems (condition_id);
CREATE INDEX IF NOT EXISTS redeems_ts_idx           ON redeems (ts DESC);

CREATE TABLE IF NOT EXISTS logs (
  id      BIGSERIAL   PRIMARY KEY,
  ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level   TEXT        NOT NULL CHECK (level IN ('log','warn','error','info')),
  message TEXT        NOT NULL,
  meta    JSONB
);
CREATE INDEX IF NOT EXISTS logs_ts_idx     ON logs (ts DESC);
CREATE INDEX IF NOT EXISTS logs_errors_idx ON logs (ts DESC) WHERE level = 'error';

CREATE OR REPLACE VIEW pnl_summary AS
SELECT
  t.condition_id,
  MAX(t.market)                                                              AS market,
  SUM(CASE WHEN t.side='BUY' THEN COALESCE(t.entry_cost,0) ELSE 0 END)     AS total_invested,
  COALESCE(SUM(r.received), 0)                                               AS total_received,
  COALESCE(SUM(r.received), 0)
    - SUM(CASE WHEN t.side='BUY' THEN COALESCE(t.entry_cost,0) ELSE 0 END)  AS realized_pnl,
  COUNT(DISTINCT t.id)                                                       AS trade_count,
  COUNT(DISTINCT r.id)                                                       AS redeem_count,
  MIN(t.ts)                                                                  AS first_trade_at,
  MAX(COALESCE(r.ts, t.ts))                                                  AS last_activity_at
FROM trades t
LEFT JOIN redeems r ON r.condition_id = t.condition_id
WHERE t.condition_id <> ''
GROUP BY t.condition_id;
`;

function insertLog(level: 'log' | 'warn' | 'error' | 'info', message: string, meta?: unknown): void {
  if (!pool) return;
  pool.query(
    'INSERT INTO logs (level, message, meta) VALUES ($1, $2, $3)',
    [level, message, meta !== undefined ? JSON.stringify(meta) : null]
  ).catch(() => {});
}

export function initLogger(): void {
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
  };
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    console[level] = (...args: unknown[]) => {
      orig[level](...args);
      const message = String(args[0] ?? '');
      const extra = args.slice(1).map(a =>
        a instanceof Error
          ? { message: (a as Error).message, stack: (a as Error).stack }
          : a
      );
      insertLog(level, message, extra.length ? (extra.length === 1 ? extra[0] : extra) : undefined);
    };
  }
}

export async function initDb(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write('⚠️  DATABASE_URL not set — Postgres logging disabled\n');
    return;
  }
  try {
    pool = new Pool({ connectionString: url, max: 5 });
    await pool.query('SELECT 1');
    await pool.query(DDL);
    process.stdout.write('🗄️  Postgres connected and schema ready\n');
  } catch (e: any) {
    process.stderr.write(`⚠️  Postgres init failed: ${e.message} — continuing without DB\n`);
    pool = null;
  }
}

export function getPool(): InstanceType<typeof Pool> | null {
  return pool;
}

export function insertTrade(record: {
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
  entryCost?: number;
  conditionId?: string;
  sourceAddress?: string;
}): void {
  if (!pool) return;
  pool.query(
    `INSERT INTO trades
       (id, ts, market, token_id, outcome, side, original_size, copy_size,
        price, shares, status, fail_reason, entry_cost, condition_id, source_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (id) DO NOTHING`,
    [
      record.id,
      new Date(record.timestamp),
      record.market,
      record.tokenId,
      record.outcome,
      record.side,
      record.originalSize,
      record.copySize,
      record.price,
      record.shares,
      record.status,
      record.failReason ?? null,
      record.entryCost ?? null,
      record.conditionId ?? '',
      record.sourceAddress ?? '',
    ]
  ).catch(e => process.stderr.write(`⚠️  insertTrade error: ${e.message}\n`));
}

export function insertRedeem(params: {
  conditionId: string;
  label: string;
  received: number;
  txHash: string;
  source: 'auto_redeemer' | 'auto_server' | 'manual';
}): void {
  if (!pool) return;
  pool.query(
    `INSERT INTO redeems (condition_id, label, received, tx_hash, source)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tx_hash) DO NOTHING`,
    [params.conditionId, params.label, params.received, params.txHash, params.source]
  ).catch(e => process.stderr.write(`⚠️  insertRedeem error: ${e.message}\n`));
}
