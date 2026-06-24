import pg from 'pg';
import type { CopyTarget } from './copy-target-manager.js';
import { config } from './config.js';

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

CREATE TABLE IF NOT EXISTS losses (
  id           BIGSERIAL     PRIMARY KEY,
  ts           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  condition_id TEXT          NOT NULL UNIQUE,
  label        TEXT          NOT NULL DEFAULT '',
  entry_cost   NUMERIC(18,6) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS losses_ts_idx           ON losses (ts DESC);
CREATE INDEX IF NOT EXISTS losses_condition_id_idx ON losses (condition_id);

CREATE TABLE IF NOT EXISTS logs (
  id      BIGSERIAL   PRIMARY KEY,
  ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level   TEXT        NOT NULL CHECK (level IN ('log','warn','error','info')),
  message TEXT        NOT NULL,
  meta    JSONB
);
CREATE INDEX IF NOT EXISTS logs_ts_idx     ON logs (ts DESC);
CREATE INDEX IF NOT EXISTS logs_errors_idx ON logs (ts DESC) WHERE level = 'error';

CREATE TABLE IF NOT EXISTS copy_targets (
  address          TEXT    PRIMARY KEY,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  label            TEXT    NOT NULL DEFAULT '',
  top_categories   JSONB   NOT NULL DEFAULT '[]',
  ai_reason        TEXT    NOT NULL DEFAULT '',
  added_by         TEXT    NOT NULL DEFAULT 'manual',
  added_at         BIGINT  NOT NULL DEFAULT 0,
  settings         JSONB   NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS daily_balance_snapshots (
  id              BIGSERIAL     PRIMARY KEY,
  snapshot_date   DATE          NOT NULL UNIQUE,
  usdc_balance    NUMERIC(18,6) NOT NULL DEFAULT 0,
  pusd_balance    NUMERIC(18,6) NOT NULL DEFAULT 0,
  pol_balance     NUMERIC(18,6) NOT NULL DEFAULT 0,
  positions_value NUMERIC(18,6) NOT NULL DEFAULT 0,
  total_portfolio NUMERIC(18,6) NOT NULL DEFAULT 0,
  captured_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dbs_date_idx ON daily_balance_snapshots (snapshot_date DESC);

CREATE TABLE IF NOT EXISTS auto_convert_settings (
  id            BOOLEAN       PRIMARY KEY DEFAULT true CHECK (id),
  enabled       BOOLEAN       NOT NULL DEFAULT true,
  reserve_usdc  NUMERIC(18,6) NOT NULL DEFAULT 0,
  max_per_trade NUMERIC(18,6) NOT NULL DEFAULT 50,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

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
    await loadAutoConvertSettings();
  } catch (e: any) {
    process.stderr.write(`⚠️  Postgres init failed: ${e.message} — continuing without DB\n`);
    pool = null;
  }
}

export function getPool(): InstanceType<typeof Pool> | null {
  return pool;
}

// ── Auto-convert (USDC.e → pUSD) settings ────────────────────────────────────
// Single global row in Postgres, editable from the dashboard. Mirrored onto
// config.autoConvert in memory so trader.ts always reads the live value.

export async function loadAutoConvertSettings(): Promise<void> {
  if (!pool) return;
  const result = await pool.query(
    'SELECT enabled, reserve_usdc, max_per_trade FROM auto_convert_settings WHERE id = true'
  );
  if (result.rows.length === 0) {
    // Seed the row from current (env-derived) defaults so the dashboard has something to show.
    await pool.query(
      `INSERT INTO auto_convert_settings (id, enabled, reserve_usdc, max_per_trade)
       VALUES (true, $1, $2, $3)`,
      [config.autoConvert.enabled, config.autoConvert.reserveUsdc, config.autoConvert.maxPerTrade]
    );
    return;
  }
  const row = result.rows[0];
  config.autoConvert.enabled = row.enabled;
  config.autoConvert.reserveUsdc = Number(row.reserve_usdc);
  config.autoConvert.maxPerTrade = Number(row.max_per_trade);
}

export async function saveAutoConvertSettings(settings: {
  enabled: boolean;
  reserveUsdc: number;
  maxPerTrade: number;
}): Promise<void> {
  config.autoConvert.enabled = settings.enabled;
  config.autoConvert.reserveUsdc = settings.reserveUsdc;
  config.autoConvert.maxPerTrade = settings.maxPerTrade;
  if (!pool) return; // no DB configured — in-memory only for this process lifetime
  await pool.query(
    `INSERT INTO auto_convert_settings (id, enabled, reserve_usdc, max_per_trade, updated_at)
     VALUES (true, $1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       reserve_usdc = EXCLUDED.reserve_usdc,
       max_per_trade = EXCLUDED.max_per_trade,
       updated_at = NOW()`,
    [settings.enabled, settings.reserveUsdc, settings.maxPerTrade]
  );
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

export async function insertLoss(params: {
  conditionId: string;
  label: string;
  entryCost: number;
}): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query(
    `INSERT INTO losses (condition_id, label, entry_cost)
     VALUES ($1, $2, $3)
     ON CONFLICT (condition_id) DO NOTHING`,
    [params.conditionId, params.label, params.entryCost]
  ).catch(e => { process.stderr.write(`⚠️  insertLoss error: ${e.message}\n`); return null; });
  return (result?.rowCount ?? 0) > 0;
}

export async function isAlreadySettled(conditionId: string): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query(
    `SELECT 1 FROM redeems WHERE condition_id = $1
     UNION ALL
     SELECT 1 FROM losses WHERE condition_id = $1
     LIMIT 1`,
    [conditionId]
  );
  return (result?.rowCount ?? 0) > 0;
}

export async function getEntryCostForCondition(conditionId: string): Promise<number> {
  if (!pool) return 0;
  const result = await pool.query(
    `SELECT COALESCE(SUM(entry_cost), 0) AS total
     FROM trades
     WHERE condition_id = $1 AND side = 'BUY' AND status = 'filled'`,
    [conditionId]
  );
  return parseFloat(result.rows[0]?.total ?? '0');
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

// ── Copy targets DB helpers ──────────────────────────────────────────────────

export async function dbGetCopyTargets(): Promise<CopyTarget[]> {
  if (!pool) return [];
  const result = await pool.query('SELECT * FROM copy_targets ORDER BY added_at ASC');
  return result.rows.map(row => ({
    address:        row.address,
    enabled:        row.enabled,
    label:          row.label,
    topCategories:  row.top_categories,
    aiReason:       row.ai_reason,
    addedBy:        row.added_by,
    addedAt:        Number(row.added_at),
    settings:       row.settings,
  }));
}

export async function dbUpsertCopyTarget(target: CopyTarget): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO copy_targets
       (address, enabled, label, top_categories, ai_reason, added_by, added_at, settings)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (address) DO UPDATE SET
       enabled        = EXCLUDED.enabled,
       label          = EXCLUDED.label,
       top_categories = EXCLUDED.top_categories,
       ai_reason      = EXCLUDED.ai_reason,
       added_by       = EXCLUDED.added_by,
       settings       = EXCLUDED.settings`,
    [
      target.address,
      target.enabled,
      target.label,
      JSON.stringify(target.topCategories),
      target.aiReason,
      target.addedBy,
      target.addedAt,
      JSON.stringify(target.settings),
    ]
  );
}

export async function dbDeleteCopyTarget(address: string): Promise<void> {
  if (!pool) return;
  await pool.query('DELETE FROM copy_targets WHERE address = $1', [address]);
}
