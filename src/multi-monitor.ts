import { EventEmitter } from 'events';
import { TradeMonitor } from './monitor.js';
import type { Trade } from './monitor.js';
import type { CopyTarget } from './copy-target-manager.js';
import { config } from './config.js';

export interface TaggedTrade extends Trade {
  sourceAddress: string;
  copyTarget: CopyTarget;
}

export class MultiMonitor extends EventEmitter {
  private monitors: Map<string, TradeMonitor> = new Map();
  private intervals: Map<string, ReturnType<typeof setInterval>> = new Map();
  private targets: CopyTarget[] = [];
  private isRunning: boolean = false;

  async start(targets: CopyTarget[]): Promise<void> {
    this.targets = [...targets];
    this.isRunning = true;
    for (const target of targets.filter((t) => t.enabled)) {
      await this.startMonitor(target);
    }
  }

  private async startMonitor(target: CopyTarget): Promise<void> {
    if (this.monitors.has(target.address)) return; // already running

    const monitor = new TradeMonitor(target.address);
    await monitor.initialize();
    this.monitors.set(target.address, monitor);

    const interval = setInterval(async () => {
      if (!this.isRunning) return;
      try {
        await monitor.pollForNewTrades(async (trade: Trade) => {
          const tagged: TaggedTrade = { ...trade, sourceAddress: target.address, copyTarget: target };
          this.emit('trade', tagged);
        });
        monitor.pruneProcessedHashes();
      } catch (err: any) {
        console.error(`❌ MultiMonitor poll error for ${target.address}: ${err.message}`);
      }
    }, config.monitoring.pollInterval);

    this.intervals.set(target.address, interval);
    console.log(`📡 Monitor started for ${target.address} (${target.label})`);
  }

  private stopMonitor(address: string): void {
    const interval = this.intervals.get(address);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(address);
    }
    this.monitors.delete(address);
    console.log(`🔇 Monitor stopped for ${address}`);
  }

  /** Diff old vs new targets — stops removed monitors, starts new ones. */
  async reload(newTargets: CopyTarget[]): Promise<void> {
    const oldEnabled = new Set(this.targets.filter((t) => t.enabled).map((t) => t.address));
    const newEnabled = new Set(newTargets.filter((t) => t.enabled).map((t) => t.address));

    for (const addr of oldEnabled) {
      if (!newEnabled.has(addr)) this.stopMonitor(addr);
    }
    for (const target of newTargets.filter((t) => t.enabled)) {
      if (!oldEnabled.has(target.address)) await this.startMonitor(target);
    }

    this.targets = [...newTargets];
  }

  stop(): void {
    this.isRunning = false;
    for (const addr of [...this.monitors.keys()]) {
      this.stopMonitor(addr);
    }
  }

  getActiveAddresses(): string[] {
    return Array.from(this.monitors.keys());
  }
}
