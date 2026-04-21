import axios from 'axios';
import { config } from './config.js';

export type TradeOutcome = string;

export interface Trade {
  txHash: string;
  timestamp: number;
  market: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  outcome: TradeOutcome;
}

export class TradeMonitor {
  private lastProcessedTimestamp: number = 0;
  private processedTradeIds: Set<string> = new Set();
  private walletAddress: string;

  constructor(walletAddress?: string) {
    this.walletAddress = (walletAddress || config.targetWallet).toLowerCase();
  }

  async initialize(): Promise<void> {
    this.lastProcessedTimestamp = Date.now();
    console.log(`📊 Monitor initialised for ${this.walletAddress} at ${new Date(this.lastProcessedTimestamp).toISOString()}`);
  }

  private async fetchTradesFromDataApi(): Promise<Trade[]> {
    try {
      const startSeconds = Math.floor(this.lastProcessedTimestamp / 1000) + 1;
      const response = await axios.get(
        'https://data-api.polymarket.com/activity',
        {
          params: {
            user: this.walletAddress,
            type: 'TRADE',
            limit: 100,
            sortBy: 'TIMESTAMP',
            sortDirection: 'DESC',
            start: startSeconds,
          },
          headers: {
            'Accept': 'application/json',
          },
        }
      );

      if (Array.isArray(response.data)) {
        return response.data.map(this.parseDataApiTrade.bind(this));
      }

      return [];
    } catch (error: any) {
      console.log(`⚠️  Could not fetch trades: ${error.message || 'Unknown error'}`);
      return [];
    }
  }

  private parseDataApiTrade(apiTrade: any): Trade {
    return {
      txHash: apiTrade.transactionHash || apiTrade.id || `trade-${apiTrade.timestamp}`,
      timestamp: apiTrade.timestamp * 1000,
      market: apiTrade.title || apiTrade.conditionId || apiTrade.market,
      tokenId: apiTrade.asset,
      side: apiTrade.side.toUpperCase() as 'BUY' | 'SELL',
      price: parseFloat(apiTrade.price),
      size: parseFloat(apiTrade.usdcSize || apiTrade.size),
      outcome: this.normalizeOutcome(apiTrade.outcome),
    };
  }

  private normalizeOutcome(value: any): TradeOutcome {
    const s = String(value ?? '').trim();
    if (!s) return 'UNKNOWN';
    const upper = s.toUpperCase();
    if (upper === 'YES') return 'YES';
    if (upper === 'NO') return 'NO';
    return s;
  }
  
  async pollForNewTrades(callback: (trade: Trade) => Promise<void>): Promise<void> {
    try {
      const trades = await this.fetchTradesFromDataApi();

      if (trades.length === 0) {
        return;
      }

      const sortedTrades = trades.sort((a, b) => a.timestamp - b.timestamp);

      let newTradesCount = 0;

      for (const trade of sortedTrades) {
        const tradeId = trade.txHash;

        if (this.processedTradeIds.has(tradeId)) {
          continue;
        }

        if (trade.timestamp <= this.lastProcessedTimestamp) {
          continue;
        }

        this.processedTradeIds.add(tradeId);
        this.lastProcessedTimestamp = Math.max(this.lastProcessedTimestamp, trade.timestamp);
        newTradesCount++;

        console.log(`🎯 New trade detected: ${trade.side} ${trade.size} USDC @ ${trade.price.toFixed(3)}`);
        console.log(`   Time: ${new Date(trade.timestamp).toISOString()}`);
        await callback(trade);
      }

      if (newTradesCount > 0) {
        console.log(`🔍 Processed ${newTradesCount} new trade(s)`);
      }
    } catch (error: any) {
      console.error(`❌ Error polling for trades:`, error.message);
    }
  }

  pruneProcessedHashes(): void {
    if (this.processedTradeIds.size > 10000) {
      const entries = Array.from(this.processedTradeIds);
      this.processedTradeIds = new Set(entries.slice(-5000));
    }
  }
}
