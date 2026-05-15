import { ethers } from 'ethers';
import { ClobClient, Side, OrderType, AssetType, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import type { CreateOrderOptions, TickSize } from '@polymarket/clob-client-v2';
import { config } from './config.js';
import type { Trade } from './monitor.js';

interface MarketMetadata {
  tickSize: number;
  tickSizeStr: string;
  negRisk: boolean | null;
  conditionId?: string;
  timestamp: number;
}

interface RetryConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

export interface CopyExecutionResult {
  orderId: string;
  copyNotional: number;
  copyShares: number;
  price: number;
  side: 'BUY' | 'SELL';
  tokenId: string;
}

export class TradeExecutor {
  private wallet: ethers.Wallet;
  private provider: ethers.providers.StaticJsonRpcProvider;
  private clobClient: ClobClient;
  private apiCreds?: { key: string; secret: string; passphrase: string };
  private marketCache: Map<string, MarketMetadata> = new Map();
  private readonly CACHE_TTL = 3600000;
  private readonly RETRY_CONFIG: RetryConfig = {
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffMultiplier: 2,
  };
  private approvalsChecked = false;
  private readonly ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
  ];
  private readonly MIN_PRIORITY_FEE_GWEI = parseFloat(process.env.MIN_PRIORITY_FEE_GWEI || '30');
  private readonly MIN_MAX_FEE_GWEI = parseFloat(process.env.MIN_MAX_FEE_GWEI || '60');

  constructor() {
    this.provider = new ethers.providers.StaticJsonRpcProvider(config.rpcUrl, { chainId: 137, name: 'matic' });
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);

    this.clobClient = new ClobClient({
      host: 'https://clob.polymarket.com',
      chain: 137,
      signer: this.wallet,
      signatureType: SignatureTypeV2.EOA,
      funderAddress: this.wallet.address,
    });
  }
  
  async initialize(): Promise<void> {
    console.log(`🔧 Initializing trader...`);
    console.log(`   Signing wallet (EOA): ${this.wallet.address}`);
    const funderAddress = this.wallet.address;
    console.log(`   Funder wallet: ${funderAddress}`);
    console.log(`   Signature type: EOA (V2)`);

    try {
      await this.deriveAndReinitApiKeys(funderAddress);
      await this.validateApiCredentials();
    } catch (error: any) {
      console.error(`❌ Failed to initialize API credentials:`, error.message);
      throw error;
    }

    await this.ensureApprovals();

    console.log(`✅ Trader initialized`);
    console.log(`   Market cache: Enabled (TTL: ${this.CACHE_TTL / 1000}s)`);
  }

  private isApiError(resp: any): boolean {
    return resp && typeof resp === 'object' && 'error' in resp;
  }

  private getApiErrorMessage(resp: any): string {
    if (!resp) return 'Unknown error';
    if (typeof resp === 'string') return resp;
    if (resp.error) return resp.error;
    return JSON.stringify(resp);
  }

  private async validateApiCredentials(): Promise<void> {
    const result: any = await this.clobClient.getApiKeys();
    if (result?.error || result?.status >= 400) {
      throw new Error(`Invalid generated API credentials: ${result?.error || `status ${result?.status}`}`);
    }
    console.log(`✅ Generated API credentials validated`);
  }

  private async deriveAndReinitApiKeys(funderAddress: string): Promise<void> {
    console.log(`   Generating API credentials programmatically...`);
    let creds = await this.clobClient.deriveApiKey().catch(() => null);
    if (!creds || this.isApiError(creds)) {
      creds = await this.clobClient.createApiKey();
    }

    const apiKey = (creds as any)?.key;
    if (this.isApiError(creds) || !apiKey || !creds?.secret || !creds?.passphrase) {
      const errMsg = this.getApiErrorMessage(creds);
      throw new Error(`Could not create/derive API key: ${errMsg}`);
    }

    console.log(`✅ API credentials generated!`);
    console.log(`   Credentials loaded in memory for this session`);
    console.log(`   To export reusable values, run: npm run generate-api-creds (writes .polymarket-api-creds)`);

    this.apiCreds = {
      key: apiKey,
      secret: creds.secret,
      passphrase: creds.passphrase,
    };

    this.clobClient = new ClobClient({
      host: 'https://clob.polymarket.com',
      chain: 137,
      signer: this.wallet,
      creds: { key: apiKey, secret: creds.secret, passphrase: creds.passphrase },
      signatureType: SignatureTypeV2.EOA,
      funderAddress,
    });
  }

  getWsAuth(): { key: string; secret: string; passphrase: string } | undefined {
    return this.apiCreds;
  }

  getCacheStats(): { size: number; items: string[] } {
    return {
      size: this.marketCache.size,
      items: Array.from(this.marketCache.keys()),
    };
  }

  clearCache(): void {
    this.marketCache.clear();
    console.log('🗑️  Market cache cleared');
  }
  
  calculateCopySize(originalSize: number): number {
    const { positionSizeMultiplier, maxTradeSize, minTradeSize, orderType } = config.trading;
    let size = originalSize * positionSizeMultiplier;
    size = Math.min(size, maxTradeSize);
    // FOK/FAK orders have a $1 minimum enforced by the Polymarket CLOB.
    // Return 0 if the scaled size is below the exchange floor so the caller can skip.
    const exchangeMin = (orderType === 'FOK' || orderType === 'FAK') ? 1 : minTradeSize;
    if (size < exchangeMin) return 0;
    return Math.round(size * 100) / 100;
  }
  
  calculateCopyShares(originalSizeUsdc: number, price: number): number {
    const notional = this.calculateCopySize(originalSizeUsdc);
    return this.calculateSharesFromNotional(notional, price);
  }

  calculateSharesFromNotional(notional: number, price: number, tickSize: number = 0.01): number {
    const shares = notional / price;
    const precision = Math.round(1 / tickSize);
    // Floor (not round) to avoid submitting more shares than notional covers
    return Math.floor(shares * precision) / precision;
  }

  async getMarketMetadata(tokenId: string): Promise<MarketMetadata> {
    const cached = this.marketCache.get(tokenId);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
      return cached;
    }

    try {
      const [tickSizeStr, negRisk] = await Promise.all([
        this.clobClient.getTickSize(tokenId).catch((): string => '0.01'),
        this.clobClient.getNegRisk(tokenId).catch(() => null),
      ]);

      const tickSize = parseFloat(tickSizeStr);

      const metadata: MarketMetadata = {
        tickSize,
        tickSizeStr,
        negRisk,
        timestamp: now,
      };

      // Only cache when negRisk is confirmed — if null we'd lock in a wrong
      // value for 1 h and every trade would silently fall back to regular exchange.
      if (negRisk !== null) {
        this.marketCache.set(tokenId, metadata);
      }

      return metadata;
    } catch (error) {
      console.log(`⚠️  Could not fetch market metadata for ${tokenId}, using defaults`);
      // Do not cache — let the next trade attempt a fresh fetch.
      return {
        tickSize: 0.01,
        tickSizeStr: '0.01',
        negRisk: null,
        timestamp: now,
      };
    }
  }

  async getTickSize(tokenId: string): Promise<number> {
    const metadata = await this.getMarketMetadata(tokenId);
    return metadata.tickSize;
  }

  roundToTickSize(price: number, tickSize: number): number {
    return Math.round(price / tickSize) * tickSize;
  }

  async validatePrice(price: number, tokenId: string): Promise<number> {
    const tickSize = await this.getTickSize(tokenId);
    const roundedPrice = this.roundToTickSize(price, tickSize);

    const validPrice = Math.max(0.01, Math.min(0.99, roundedPrice));

    if (Math.abs(validPrice - price) > 0.001) {
      console.log(`   Price adjusted: ${price.toFixed(4)} → ${validPrice.toFixed(4)} (tick size: ${tickSize})`);
    }

    return validPrice;
  }

  async checkPriceDrift(
    tokenId: string,
    side: 'BUY' | 'SELL',
    sourcePrice: number,
    maxDriftPct: number = 0.30,
  ): Promise<{ drifted: boolean; currentPrice: number; driftPct: number }> {
    // Use CLOB midpoint — much more reliable than best ask which can sit at 0.99
    // in thin markets even when the true price is 0.40
    const currentPrice = await this.getMidpoint(tokenId, sourcePrice);
    const driftPct = (currentPrice - sourcePrice) / sourcePrice;
    // For BUY: positive drift means price rose (worse entry). For SELL: negative drift means price fell.
    const adverseDrift = side === 'BUY' ? driftPct : -driftPct;
    return { drifted: adverseDrift > maxDriftPct, currentPrice, driftPct };
  }

  private async getMidpoint(tokenId: string, fallback: number): Promise<number> {
    try {
      const res = await fetch(`https://clob.polymarket.com/midpoint?token_id=${tokenId}`);
      if (res.ok) {
        const data = await res.json();
        const mid = parseFloat(data.mid);
        if (mid > 0 && mid < 1) return mid;
      }
    } catch {}
    // Fallback: derive mid from orderbook bid/ask spread
    try {
      const orderbook = await this.clobClient.getOrderBook(tokenId);
      const bestAsk = parseFloat(orderbook.asks[0]?.price || '0');
      const bestBid = parseFloat(orderbook.bids[0]?.price || '0');
      if (bestAsk > 0 && bestBid > 0) return (bestAsk + bestBid) / 2;
      if (bestBid > 0) return bestBid;
      if (bestAsk > 0) return bestAsk;
    } catch {}
    return fallback;
  }

  private getBestPrice(orderbook: any, side: 'BUY' | 'SELL', fallback: number): number {
    if (side === 'BUY') return Number(orderbook.asks[0]?.price || fallback);
    return Number(orderbook.bids[0]?.price || fallback);
  }

  getWalletAddress(): string {
    return this.wallet.address;
  }

  private applySlippage(price: number, side: 'BUY' | 'SELL', slippage: number): number {
    if (side === 'BUY') {
      return Math.min(price * (1 + slippage), 0.99);
    }
    return Math.max(price * (1 - slippage), 0.01);
  }

  private ensureLiquidity(orderbook: any, side: 'BUY' | 'SELL'): void {
    if (side === 'BUY' && orderbook.asks.length === 0) {
      throw new Error('No asks available in orderbook');
    }
    if (side === 'SELL' && orderbook.bids.length === 0) {
      throw new Error('No bids available in orderbook');
    }
  }
  
  async executeCopyTrade(
    originalTrade: Trade,
    copyNotionalOverride?: number
  ): Promise<CopyExecutionResult> {
    const orderType = config.trading.orderType;
    const copyNotional = copyNotionalOverride ?? this.calculateCopySize(originalTrade.size);

    console.log(`📈 Executing copy trade (${orderType}):`);
    console.log(`   Market: ${originalTrade.market}`);
    console.log(`   Side: ${originalTrade.side}`);
    console.log(`   Original size: ${originalTrade.size} USDC`);
    console.log(`   Token ID: ${originalTrade.tokenId}`);
    console.log(`   Copy notional: ${copyNotional} USDC`);

    const meta = await this.getMarketMetadata(originalTrade.tokenId);
    console.log(`   negRisk: ${meta.negRisk} | tickSize: ${meta.tickSizeStr}`);

    try {
      return await this.executeWithRetry(async () => {
        if (orderType === 'FOK' || orderType === 'FAK') {
          return this.executeMarketOrder(originalTrade, orderType, copyNotional);
        } else {
          return this.executeLimitOrder(originalTrade, copyNotional);
        }
      });
    } catch (err: any) {
      if ((err?.message ?? '').includes('order_version_mismatch')) {
        this.marketCache.delete(originalTrade.tokenId);
      }
      throw err;
    }
  }

  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    attempt: number = 1
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      const isRetryable = this.isRetryableError(error);

      if (!isRetryable || attempt >= this.RETRY_CONFIG.maxAttempts) {
        console.error(`❌ Failed after ${attempt} attempt(s): ${error.message}`);
        if (error?.response?.data) {
          console.error('   Response data:', error.response.data);
        }
        throw error;
      }

      const delay = Math.min(
        this.RETRY_CONFIG.initialDelay * Math.pow(this.RETRY_CONFIG.backoffMultiplier, attempt - 1),
        this.RETRY_CONFIG.maxDelay
      );

      console.log(`⚠️  Attempt ${attempt} failed: ${error.message}`);
      if (error?.response?.data) {
        console.log('   Response data:', error.response.data);
      }
      console.log(`   Retrying in ${delay}ms... (${attempt + 1}/${this.RETRY_CONFIG.maxAttempts})`);

      await this.sleep(delay);
      return this.executeWithRetry(fn, attempt + 1);
    }
  }

  private isRetryableError(error: any): boolean {
    const errorMsg = error?.message?.toLowerCase() || '';
    const responseData = error?.response?.data?.error?.toLowerCase() || '';
    const responseStatus = error?.response?.status;

    if (responseStatus === 401 || errorMsg.includes('unauthorized') || responseData.includes('unauthorized')) {
      console.log('   ⚠️  Unauthorized/Invalid API key - skipping trade');
      return false;
    }
    if (responseStatus === 403 || errorMsg.includes('cloudflare') || responseData.includes('cloudflare') || responseData.includes('blocked')) {
      console.log('   ⚠️  Access blocked (Cloudflare/geo restriction) - skipping trade');
      return false;
    }

    if (errorMsg.includes('network') || errorMsg.includes('timeout') || errorMsg.includes('econnreset')) {
      return true;
    }

    if (errorMsg.includes('rate limit') || responseData.includes('rate limit')) {
      return true;
    }

    if (errorMsg.includes('502') || errorMsg.includes('503') || errorMsg.includes('504')) {
      return true;
    }

    if (
      errorMsg.includes('insufficient') ||
      responseData.includes('insufficient') ||
      errorMsg.includes('not enough balance') ||
      responseData.includes('not enough balance') ||
      errorMsg.includes('allowance') ||
      responseData.includes('allowance')
    ) {
      console.log('   ⚠️  Not enough balance/allowance - skipping trade');
      return false;
    }

    if (
      errorMsg.includes('invalid') ||
      responseData.includes('invalid') ||
      responseData.includes('bad request')
    ) {
      console.log('   ⚠️  Invalid order parameters - skipping trade');
      return false;
    }

    if (errorMsg.includes('duplicate') || responseData.includes('duplicate')) {
      console.log('   ⚠️  Duplicate order - skipping');
      return false;
    }

    if (errorMsg.includes('order_version_mismatch') || responseData.includes('order_version_mismatch')) {
      console.log('   ⚠️  order_version_mismatch — negRisk flag may have been wrong; cache cleared');
      return false;
    }

    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async executeLimitOrder(originalTrade: Trade, copyNotional: number): Promise<CopyExecutionResult> {
    await this.validateBalance(copyNotional, originalTrade.tokenId);

    const [orderbook, orderOpts, metadata] = await Promise.all([
      this.clobClient.getOrderBook(originalTrade.tokenId),
      this.getOrderOptions(originalTrade.tokenId),
      this.getMarketMetadata(originalTrade.tokenId),
    ]);

    this.ensureLiquidity(orderbook, originalTrade.side);

    const { slippageTolerance } = config.trading;
    const bestPrice = this.getBestPrice(orderbook, originalTrade.side, originalTrade.price);
    const limitPrice = this.applySlippage(bestPrice, originalTrade.side, slippageTolerance);
    const validatedPrice = await this.validatePrice(limitPrice, originalTrade.tokenId);
    const copyShares = this.calculateSharesFromNotional(copyNotional, validatedPrice, metadata.tickSize);

    console.log(`   Limit price: ${validatedPrice.toFixed(4)}`);
    console.log(`   Copy shares: ${copyShares}`);

    const response = await this.clobClient.createAndPostOrder(
      {
        tokenID: originalTrade.tokenId,
        price: validatedPrice,
        size: copyShares,
        side: originalTrade.side as Side,
      },
      orderOpts,
      OrderType.GTC
    );

    if (response.success) {
      console.log(`✅ Limit order placed: ${response.orderID}`);
      // Use midpoint as the recorded price — validatedPrice is the limit ceiling we
      // submitted, but fills happen at lower asks. Midpoint reflects actual fill price.
      const fillPrice = await this.getMidpoint(originalTrade.tokenId, validatedPrice);
      const fillShares = this.calculateSharesFromNotional(copyNotional, fillPrice, metadata.tickSize);
      console.log(`   Fill price (mid): ${fillPrice.toFixed(4)}, shares: ${fillShares}`);
      return {
        orderId: response.orderID,
        copyNotional,
        copyShares: fillShares,
        price: fillPrice,
        side: originalTrade.side,
        tokenId: originalTrade.tokenId,
      };
    } else {
      const errorMsg = response.errorMsg || response.error || 'Unknown error';
      console.log(`❌ Order failed: ${errorMsg}`);
      console.log(`   negRisk=${orderOpts.negRisk} tickSize=${orderOpts.tickSize} price=${validatedPrice} shares=${copyShares} side=${originalTrade.side}`);
      throw new Error(`Order placement failed: ${errorMsg}`);
    }
  }

  private async executeMarketOrder(
    originalTrade: Trade,
    orderType: 'FOK' | 'FAK',
    copyNotional: number
  ): Promise<CopyExecutionResult> {
    await this.validateBalance(copyNotional, originalTrade.tokenId);

    const [orderbook, orderOpts, metadata] = await Promise.all([
      this.clobClient.getOrderBook(originalTrade.tokenId),
      this.getOrderOptions(originalTrade.tokenId),
      this.getMarketMetadata(originalTrade.tokenId),
    ]);

    this.ensureLiquidity(orderbook, originalTrade.side);

    const { slippageTolerance } = config.trading;
    const bestPrice = this.getBestPrice(orderbook, originalTrade.side, originalTrade.price);
    const marketPrice = this.applySlippage(bestPrice, originalTrade.side, slippageTolerance);
    const validatedPrice = await this.validatePrice(marketPrice, originalTrade.tokenId);
    const copyShares = this.calculateSharesFromNotional(copyNotional, validatedPrice, metadata.tickSize);
    console.log(`   Market price: ${validatedPrice.toFixed(4)}`);
    console.log(`   Copy shares: ${copyShares}`);

    const orderTypeEnum = orderType === 'FOK' ? OrderType.FOK : OrderType.FAK;
    const response = await this.clobClient.createAndPostMarketOrder(
      {
        tokenID: originalTrade.tokenId,
        amount: originalTrade.side === 'BUY' ? copyNotional : copyShares,
        price: validatedPrice,
        side: originalTrade.side as Side,
        orderType: orderTypeEnum,
      },
      orderOpts,
      orderTypeEnum
    );

    if (response.success) {
      console.log(`✅ ${orderType} order executed: ${response.orderID}`);
      if (response.status === 'LIVE') {
        console.log(`   ⚠️  Order posted to book (no immediate match)`);
      }
      const fillPrice = await this.getMidpoint(originalTrade.tokenId, validatedPrice);
      const fillShares = this.calculateSharesFromNotional(copyNotional, fillPrice, metadata.tickSize);
      console.log(`   Fill price (mid): ${fillPrice.toFixed(4)}, shares: ${fillShares}`);
      return {
        orderId: response.orderID,
        copyNotional,
        copyShares: fillShares,
        price: fillPrice,
        side: originalTrade.side,
        tokenId: originalTrade.tokenId,
      };
    } else {
      const errorMsg = response.errorMsg || response.error || 'Unknown error';
      console.log(`❌ Order failed: ${errorMsg}`);
      console.log(`   negRisk=${orderOpts.negRisk} tickSize=${orderOpts.tickSize} price=${validatedPrice} amount=${originalTrade.side === 'BUY' ? copyNotional : copyShares} side=${originalTrade.side}`);
      throw new Error(`Order placement failed: ${errorMsg}`);
    }
  }

  private async validateBalance(requiredAmount: number, tokenId: string): Promise<void> {
    try {
      const metadata = await this.getMarketMetadata(tokenId);
      const exchangeAddress = metadata.negRisk === true
        ? config.contracts.negRiskExchangeV2
        : config.contracts.exchangeV2;

      const pusd = new ethers.Contract(config.contracts.pusd, this.ERC20_ABI, this.wallet);
      const decimals = await pusd.decimals();
      // Floor to token decimals — parseUnits throws if fractional digits exceed decimals
      const safeAmount = (Math.floor(requiredAmount * 1e6) / 1e6).toFixed(6);
      const required = ethers.utils.parseUnits(safeAmount, decimals);

      const balance = await pusd.balanceOf(this.wallet.address);
      if (balance.lt(required)) {
        const bal = ethers.utils.formatUnits(balance, decimals);
        throw new Error(`not enough pUSD balance (${bal} < required ${requiredAmount})`);
      }

      const allowanceEx = await pusd.allowance(this.wallet.address, exchangeAddress);
      if (allowanceEx.lt(required)) {
        const allow = ethers.utils.formatUnits(allowanceEx, decimals);
        throw new Error(`not enough pUSD allowance to Exchange (${allow} < required ${requiredAmount})`);
      }

      console.log(`   Balance/allowance check passed`);
    } catch (error) {
      throw error;
    }
  }
  
  
  /** Place a FOK market-sell for all shares of a position. */
  async exitPosition(tokenId: string, shares: number): Promise<CopyExecutionResult> {
    console.log(`🔴 Exiting position: ${shares} shares of token ${tokenId}`);

    const [orderbook, orderOpts] = await Promise.all([
      this.clobClient.getOrderBook(tokenId),
      this.getOrderOptions(tokenId),
    ]);

    const bids = (orderbook.bids ?? []) as Array<{ price: string }>;
    if (!bids.length) throw new Error('No bids available — cannot exit position right now');

    const bestBid = parseFloat(bids[0].price);
    const withSlippage = bestBid * (1 - config.trading.slippageTolerance);
    const validatedPrice = await this.validatePrice(withSlippage, tokenId);
    console.log(`   Best bid: ${bestBid.toFixed(4)}, exit price: ${validatedPrice.toFixed(4)}, shares: ${shares}`);

    const response = await this.clobClient.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount: shares,
        price: validatedPrice,
        side: Side.SELL,
        orderType: OrderType.FOK,
      },
      orderOpts,
      OrderType.FOK,
    );

    if (response.success) {
      const received = shares * validatedPrice;
      console.log(`✅ Exit order executed: ${response.orderID} (~$${received.toFixed(2)} USDC.e)`);
      return {
        orderId: response.orderID,
        copyNotional: received,
        copyShares: shares,
        price: validatedPrice,
        side: 'SELL',
        tokenId,
      };
    }
    const errMsg = response.errorMsg || response.error || 'Unknown error';
    throw new Error(`Exit order failed: ${errMsg}`);
  }

  async getPositions(): Promise<any[]> {
    try {
      const res = await fetch(`https://data-api.polymarket.com/positions?user=${this.wallet.address}&sizeThreshold=.01&limit=500`);
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }
  
  async cancelAllOrders(): Promise<void> {
    try {
      await this.clobClient.cancelAll();
      console.log('✅ All orders cancelled');
    } catch (error) {
      console.error('Error cancelling orders:', error);
    }
  }

  private async getOrderOptions(tokenId: string): Promise<Partial<CreateOrderOptions>> {
    const metadata = await this.getMarketMetadata(tokenId);
    const opts: Partial<CreateOrderOptions> = { tickSize: metadata.tickSizeStr as TickSize };
    if (metadata.negRisk !== null) opts.negRisk = metadata.negRisk;
    return opts;
  }
  private async ensureApprovals(): Promise<void> {
    if (this.approvalsChecked) return;
    this.approvalsChecked = true;

    console.log('🔐 Checking required pUSD approvals (V2)...');

    const pusd = new ethers.Contract(config.contracts.pusd, this.ERC20_ABI, this.wallet);

    const maticBal = await this.provider.getBalance(this.wallet.address);
    const maticAmount = parseFloat(ethers.utils.formatEther(maticBal));
    if (maticAmount < 0.05) {
      console.log(`   ⚠️  Low POL/MATIC for gas: ${maticAmount.toFixed(4)}`);
    }

    const decimals = await pusd.decimals();
    const minAllowance = ethers.utils.parseUnits(config.trading.maxTradeSize.toString(), decimals);
    const gasOverrides = await this.getGasOverrides();

    const pusdSpenders = [
      { name: 'V2 Exchange',         address: config.contracts.exchangeV2 },
      { name: 'V2 NegRisk Exchange', address: config.contracts.negRiskExchangeV2 },
      { name: 'NegRisk Adapter',     address: config.contracts.negRiskAdapter },
    ];

    for (const spender of pusdSpenders) {
      const allowance = await pusd.allowance(this.wallet.address, spender.address);
      if (allowance.lt(minAllowance)) {
        console.log(`   Approving pUSD to ${spender.name} (${spender.address})...`);
        const tx = await pusd.approve(spender.address, ethers.constants.MaxUint256, gasOverrides);
        console.log(`   Tx: ${tx.hash}`);
        await tx.wait();
        console.log(`   ✅ pUSD approved to ${spender.name}`);
      } else {
        console.log(`   ✅ pUSD already approved to ${spender.name}`);
      }
    }

    console.log('   Syncing balance/allowance with CLOB...');
    await this.clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    await this.clobClient.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL });
    console.log('   ✅ CLOB balance/allowance synced');
  }

  private async getGasOverrides(): Promise<ethers.providers.TransactionRequest> {
    const feeData = await this.provider.getFeeData();
    const minPriority = ethers.utils.parseUnits(this.MIN_PRIORITY_FEE_GWEI.toString(), 'gwei');
    const minMaxFee = ethers.utils.parseUnits(this.MIN_MAX_FEE_GWEI.toString(), 'gwei');

    let maxPriority = feeData.maxPriorityFeePerGas || feeData.gasPrice || minPriority;
    let maxFee = feeData.maxFeePerGas || feeData.gasPrice || minMaxFee;

    const latestBlock = await this.provider.getBlock('latest');
    const baseFee = latestBlock?.baseFeePerGas;
    if (baseFee) {
      const targetMaxFee = baseFee.mul(2).add(maxPriority);
      if (maxFee.lt(targetMaxFee)) {
        maxFee = targetMaxFee;
      }
    }

    if (maxPriority.lt(minPriority)) maxPriority = minPriority;
    if (maxFee.lt(minMaxFee)) maxFee = minMaxFee;
    if (maxFee.lt(maxPriority)) maxFee = maxPriority;

    return {
      maxPriorityFeePerGas: maxPriority,
      maxFeePerGas: maxFee,
    };
  }
}
