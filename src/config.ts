import dotenv from 'dotenv';
dotenv.config();

function parseCsv(value?: string): string[] {
  if (!value) return [];
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

const useWebSocket = process.env.USE_WEBSOCKET !== 'false';

export const config = {
  targetWallet: process.env.TARGET_WALLET || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  aiReviewCron: process.env.AI_REVIEW_CRON || '0 2 * * *',
  aiMaxCopyTargets: parseInt(process.env.AI_MAX_COPY_TARGETS || '10'),
  discoveryRefreshCron: process.env.DISCOVERY_REFRESH_CRON || '0 3 * * 0',
  discoveryRefreshLimit: parseInt(process.env.DISCOVERY_REFRESH_LIMIT || '200'),
  privateKey: process.env.PRIVATE_KEY || '',
  polymarketGeoToken: process.env.POLYMARKET_GEO_TOKEN || '',
  rpcUrl: process.env.RPC_URL || 'https://polygon-rpc.com',
  chainId: 137,

  // Polygon mainnet contracts used for approvals and balance checks.
  contracts: {
    exchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
    ctf: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
    usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
    negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  },

  trading: {
    positionSizeMultiplier: parseFloat(process.env.POSITION_MULTIPLIER || '0.1'),
    maxTradeSize: parseFloat(process.env.MAX_TRADE_SIZE || '100'),
    minTradeSize: parseFloat(process.env.MIN_TRADE_SIZE || '1'),
    slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE || '0.02'),
    // LIMIT=GTC, FOK=fill-or-kill, FAK=fill-and-kill
    orderType: (process.env.ORDER_TYPE || 'FOK') as 'LIMIT' | 'FOK' | 'FAK',
  },

  risk: {
    maxSessionNotional: parseFloat(process.env.MAX_SESSION_NOTIONAL || '0'),
    maxPerMarketNotional: parseFloat(process.env.MAX_PER_MARKET_NOTIONAL || '0'),
  },

  monitoring: {
    pollInterval: parseInt(process.env.POLL_INTERVAL || '2000'),
    useWebSocket,
    useUserChannel: process.env.USE_USER_CHANNEL === 'true',
    wsAssetIds: parseCsv(process.env.WS_ASSET_IDS),
    wsMarketIds: parseCsv(process.env.WS_MARKET_IDS),
  },

  // Market keyword filters (case-insensitive, applied to market question/title).
  // BLOCK: skip any trade whose market contains any of these words.
  // ALLOW: if non-empty, ONLY copy trades whose market matches at least one word.
  // Both can be set simultaneously — ALLOW is evaluated first, then BLOCK.
  filters: {
    blockKeywords: parseCsv(process.env.MARKET_BLOCK_KEYWORDS),
    allowKeywords: parseCsv(process.env.MARKET_ALLOW_KEYWORDS),
  },
};

export function validateConfig(): void {
  const required = ['targetWallet', 'privateKey'];
  for (const key of required) {
    if (!config[key as keyof typeof config]) {
      throw new Error(`Missing required config: ${key}`);
    }
  }

  console.log('ℹ️  API credentials will be derived/generated from PRIVATE_KEY at startup');

  console.log('✅ Configuration validated');
  console.log(`   Auth: EOA (signature type 0)`);
}
