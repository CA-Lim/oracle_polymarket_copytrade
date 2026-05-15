import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { getPool, dbGetCopyTargets, dbUpsertCopyTarget, dbDeleteCopyTarget } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CopyTargetSettings {
  allowKeywords:        string[];
  blockKeywords:        string[];
  multiplier:           number;
  maxTradeSize:         number;
  minTradeSize:         number;
  maxPerMarketNotional: number;
  minPrice:             number;  // skip BUY if oracle price < this
  maxPrice:             number;  // skip BUY if oracle price > this
  minSourceTradeSize:   number;  // skip if oracle's trade size < this USDC
}

export interface CopyTarget {
  address: string;
  enabled: boolean;
  label: string;
  topCategories: string[];
  aiReason: string;
  addedBy: 'ai' | 'manual';
  addedAt: number;
  settings: CopyTargetSettings;
}

interface CopyTargetStore {
  version: number;
  updatedAt: number;
  targets: CopyTarget[];
}

const DATA_PATH = path.join(__dirname, '..', 'data', 'copy-targets.json');

function defaultSettings(): CopyTargetSettings {
  return {
    allowKeywords:        [...config.filters.allowKeywords],
    blockKeywords:        [...config.filters.blockKeywords],
    multiplier:           config.trading.positionSizeMultiplier,
    maxTradeSize:         config.trading.maxTradeSize,
    minTradeSize:         config.trading.minTradeSize,
    maxPerMarketNotional: config.risk.maxPerMarketNotional,
    minPrice:             0.20,
    maxPrice:             1.0,
    minSourceTradeSize:   0,
  };
}

export class CopyTargetManager {
  private targets: CopyTarget[] = [];

  /** Call once after initDb() to load from DB or fall back to JSON. */
  async init(): Promise<void> {
    const pool = getPool();
    if (pool) {
      const dbTargets = await dbGetCopyTargets();
      if (dbTargets.length > 0) {
        this.targets = dbTargets.map(t => this.withDefaults(t));
        console.log(`📋 Loaded ${this.targets.length} copy target(s) from Postgres`);
        return;
      }
      // DB is empty — migrate from JSON file if it exists
      const jsonTargets = this.loadFromJson();
      if (jsonTargets.length > 0) {
        console.log(`📋 Migrating ${jsonTargets.length} copy target(s) from JSON → Postgres`);
        for (const t of jsonTargets) {
          await dbUpsertCopyTarget(this.withDefaults(t));
        }
        this.targets = jsonTargets.map(t => this.withDefaults(t));
        return;
      }
      // Nothing in JSON either — seed from TARGET_WALLET env
      this.targets = this.seed();
      for (const t of this.targets) await dbUpsertCopyTarget(t);
    } else {
      // No DB — fall back to JSON file entirely
      const jsonTargets = this.loadFromJson();
      if (jsonTargets.length > 0) {
        this.targets = jsonTargets.map(t => this.withDefaults(t));
      } else {
        this.targets = this.seed();
        this.saveToJson();
      }
    }
  }

  private withDefaults(t: CopyTarget): CopyTarget {
    const def = defaultSettings();
    return {
      ...t,
      settings: {
        minPrice:           def.minPrice,
        maxPrice:           def.maxPrice,
        minSourceTradeSize: def.minSourceTradeSize,
        ...t.settings,
      },
    };
  }

  private loadFromJson(): CopyTarget[] {
    if (!fs.existsSync(DATA_PATH)) return [];
    try {
      const raw = fs.readFileSync(DATA_PATH, 'utf-8');
      const store = JSON.parse(raw) as CopyTargetStore;
      return store.targets ?? [];
    } catch {
      console.warn('⚠️  copy-targets.json corrupted, ignoring');
      return [];
    }
  }

  private seed(): CopyTarget[] {
    if (!config.targetWallet) return [];
    const t: CopyTarget = {
      address:       config.targetWallet.toLowerCase(),
      enabled:       true,
      label:         'Default (seeded from TARGET_WALLET)',
      topCategories: [],
      aiReason:      'Seeded from existing TARGET_WALLET configuration',
      addedBy:       'manual',
      addedAt:       Date.now(),
      settings:      defaultSettings(),
    };
    console.log(`📋 Seeded copy target from TARGET_WALLET: ${config.targetWallet}`);
    return [t];
  }

  private saveToJson(): void {
    const dir = path.dirname(DATA_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const store: CopyTargetStore = { version: 1, updatedAt: Date.now(), targets: this.targets };
    fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2));
  }

  private async persist(target: CopyTarget): Promise<void> {
    if (getPool()) {
      await dbUpsertCopyTarget(target);
    } else {
      this.saveToJson();
    }
  }

  // ── Synchronous reads (in-memory) ──────────────────────────────────────────

  getAll(): CopyTarget[] {
    return this.targets;
  }

  getEnabled(): CopyTarget[] {
    return this.targets.filter(t => t.enabled);
  }

  get(address: string): CopyTarget | undefined {
    return this.targets.find(t => t.address === address.toLowerCase());
  }

  count(): number {
    return this.targets.length;
  }

  enabledCount(): number {
    return this.getEnabled().length;
  }

  // ── Async writes ────────────────────────────────────────────────────────────

  async add(target: Omit<CopyTarget, 'addedAt'>): Promise<void> {
    const addr = target.address.toLowerCase();
    if (this.targets.find(t => t.address === addr)) {
      throw new Error(`Address ${addr} is already a copy target`);
    }
    const full: CopyTarget = { ...target, address: addr, addedAt: Date.now() };
    this.targets.push(full);
    await this.persist(full);
  }

  async remove(address: string): Promise<boolean> {
    const addr = address.toLowerCase();
    const before = this.targets.length;
    this.targets = this.targets.filter(t => t.address !== addr);
    if (this.targets.length < before) {
      if (getPool()) {
        await dbDeleteCopyTarget(addr);
      } else {
        this.saveToJson();
      }
      return true;
    }
    return false;
  }

  async update(address: string, partial: Partial<Omit<CopyTarget, 'address' | 'addedAt'>>): Promise<boolean> {
    const addr = address.toLowerCase();
    const target = this.targets.find(t => t.address === addr);
    if (!target) return false;
    Object.assign(target, partial);
    if (partial.settings) target.settings = { ...target.settings, ...partial.settings };
    await this.persist(target);
    return true;
  }

  async setEnabled(address: string, enabled: boolean): Promise<boolean> {
    return this.update(address, { enabled });
  }
}

export const copyTargetManager = new CopyTargetManager();
