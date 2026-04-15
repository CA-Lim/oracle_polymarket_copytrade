import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CopyTargetSettings {
  allowKeywords: string[];
  blockKeywords: string[];
  multiplier: number;
  maxTradeSize: number;
  minTradeSize: number;
  maxPerMarketNotional: number;
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
    allowKeywords: [...config.filters.allowKeywords],
    blockKeywords: [...config.filters.blockKeywords],
    multiplier: config.trading.positionSizeMultiplier,
    maxTradeSize: config.trading.maxTradeSize,
    minTradeSize: config.trading.minTradeSize,
    maxPerMarketNotional: config.risk.maxPerMarketNotional,
  };
}

export class CopyTargetManager {
  private store: CopyTargetStore;

  constructor() {
    this.store = this.load();
  }

  private load(): CopyTargetStore {
    if (fs.existsSync(DATA_PATH)) {
      try {
        const raw = fs.readFileSync(DATA_PATH, 'utf-8');
        return JSON.parse(raw) as CopyTargetStore;
      } catch {
        console.warn('⚠️  copy-targets.json corrupted, re-initialising');
      }
    }
    return this.seed();
  }

  /** Seed from TARGET_WALLET env var on first boot. */
  private seed(): CopyTargetStore {
    const targets: CopyTarget[] = [];

    if (config.targetWallet) {
      targets.push({
        address: config.targetWallet.toLowerCase(),
        enabled: true,
        label: 'Default (seeded from TARGET_WALLET)',
        topCategories: [],
        aiReason: 'Seeded from existing TARGET_WALLET configuration',
        addedBy: 'manual',
        addedAt: Date.now(),
        settings: defaultSettings(),
      });
      console.log(`📋 Seeded copy-targets.json from TARGET_WALLET: ${config.targetWallet}`);
    }

    const store: CopyTargetStore = { version: 1, updatedAt: Date.now(), targets };
    this.saveStore(store);
    return store;
  }

  private saveStore(store: CopyTargetStore): void {
    const dir = path.dirname(DATA_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2));
  }

  save(): void {
    this.store.updatedAt = Date.now();
    this.saveStore(this.store);
  }

  getAll(): CopyTarget[] {
    return this.store.targets;
  }

  getEnabled(): CopyTarget[] {
    return this.store.targets.filter((t) => t.enabled);
  }

  get(address: string): CopyTarget | undefined {
    return this.store.targets.find((t) => t.address === address.toLowerCase());
  }

  add(target: Omit<CopyTarget, 'addedAt'>): void {
    const addr = target.address.toLowerCase();
    if (this.store.targets.find((t) => t.address === addr)) {
      throw new Error(`Address ${addr} is already a copy target`);
    }
    this.store.targets.push({ ...target, address: addr, addedAt: Date.now() });
    this.save();
  }

  remove(address: string): boolean {
    const addr = address.toLowerCase();
    const before = this.store.targets.length;
    this.store.targets = this.store.targets.filter((t) => t.address !== addr);
    if (this.store.targets.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  update(address: string, partial: Partial<Omit<CopyTarget, 'address' | 'addedAt'>>): boolean {
    const addr = address.toLowerCase();
    const target = this.store.targets.find((t) => t.address === addr);
    if (!target) return false;
    Object.assign(target, partial);
    if (partial.settings) target.settings = { ...target.settings, ...partial.settings };
    this.save();
    return true;
  }

  setEnabled(address: string, enabled: boolean): boolean {
    return this.update(address, { enabled });
  }

  count(): number {
    return this.store.targets.length;
  }

  enabledCount(): number {
    return this.getEnabled().length;
  }
}

// Singleton instance shared across the app.
export const copyTargetManager = new CopyTargetManager();
