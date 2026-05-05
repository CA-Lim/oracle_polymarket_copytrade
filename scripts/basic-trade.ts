/**
 * Clean reference implementation: fetch a Polymarket market and place a trade via the CLOB.
 * Uses @polymarket/clob-client-v2 (required after Polymarket's V2 exchange upgrade April 2026).
 *
 * Usage: npx tsx scripts/basic-trade.ts [conditionId]
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { ethers } from 'ethers';
import { ClobClient, Side, OrderType, Chain, SignatureTypeV2 } from '@polymarket/clob-client-v2';

const HOST = 'https://clob.polymarket.com';

// Default: "Will OpenAI's market cap be $1.5T or greater at market close on IPO day?"
const conditionId =
  process.argv[2] ?? '0x4a8005d19b41af72c1cd5c619640d9d51da548dd7c3544b12ae0c520d9e6805b';

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL ?? 'https://polygon-rpc.com';
  const geoToken = process.env.POLYMARKET_GEO_TOKEN ?? undefined;

  if (!privateKey) throw new Error('PRIVATE_KEY not set in .env');

  // ── 1. Fetch market (no auth needed) ─────────────────────────────────────
  const publicClient = new ClobClient({ host: HOST, chain: Chain.POLYGON });

  console.log(`\n── Fetching market ──`);
  console.log(`conditionId: ${conditionId}`);
  const market = await publicClient.getMarket(conditionId);
  if (!market || (market as any).error) {
    throw new Error(`Market fetch failed: ${JSON.stringify(market)}`);
  }
  console.log(`Question : ${market.question}`);
  console.log(`Active   : ${market.active}  Closed: ${market.closed}`);
  console.log(`Tokens:`);
  for (const t of market.tokens as Array<{ token_id: string; outcome: string }>) {
    console.log(`  ${t.outcome}: ${t.token_id}`);
  }

  const yesToken = (market.tokens as Array<{ token_id: string; outcome: string }>)[0];
  const tokenId = yesToken.token_id;
  console.log(`\nTrading token: ${yesToken.outcome} (${tokenId})`);

  // ── 2. Tick size + order book ─────────────────────────────────────────────
  const [tickSize, book] = await Promise.all([
    publicClient.getTickSize(tokenId),
    publicClient.getOrderBook(tokenId),
  ]);

  const bestBidEntry = book.bids[0];
  const bestAskEntry = book.asks[0];
  const bestBid = bestBidEntry ? parseFloat(bestBidEntry.price) : 0;

  console.log(`\nTick size : ${tickSize}`);
  console.log(`Best bid  : ${bestBidEntry?.price ?? 'none'}  (${bestBidEntry?.size ?? 0} shares)`);
  console.log(`Best ask  : ${bestAskEntry?.price ?? 'none'}  (${bestAskEntry?.size ?? 0} shares)`);
  console.log(`Min size  : ${book.min_order_size} shares`);

  // Place a resting limit buy at the best bid price — won't fill immediately
  const buyPrice = bestBid > 0 ? bestBid : 0.45;
  const buySize = Math.max(parseFloat(book.min_order_size), 5);
  console.log(`\nPlanned order: BUY ${buySize} shares @ ${buyPrice} (GTC, resting limit)`);

  // ── 3. Auth: create wallet + derive API key ───────────────────────────────
  console.log(`\n── Authenticating ──`);
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  console.log(`Wallet: ${wallet.address}`);

  // Init without creds to derive key
  const l1Client = new ClobClient({
    host: HOST,
    chain: Chain.POLYGON,
    signer: wallet,
    signatureType: SignatureTypeV2.EOA,
    funderAddress: wallet.address,
  });

  let creds = await l1Client.deriveApiKey().catch(() => null);
  if (!creds || (creds as any).error) {
    console.log('deriveApiKey failed → trying createApiKey...');
    creds = await l1Client.createApiKey();
  }
  if (!creds?.key || !creds?.secret || !creds?.passphrase) {
    throw new Error(`Could not obtain API credentials: ${JSON.stringify(creds)}`);
  }
  console.log(`API key: ${creds.key.slice(0, 8)}...`);

  // ── 4. Re-init with full auth ─────────────────────────────────────────────
  const client = new ClobClient({
    host: HOST,
    chain: Chain.POLYGON,
    signer: wallet,
    creds: { key: creds.key, secret: creds.secret, passphrase: creds.passphrase },
    signatureType: SignatureTypeV2.EOA,
    funderAddress: wallet.address,
  });

  const keysResp = await client.getApiKeys();
  const keyCount = (keysResp as any)?.apiKeys?.length ?? '?';
  console.log(`Credentials valid (${keyCount} key(s) on account)`);

  // ── 5. Place GTC limit order ──────────────────────────────────────────────
  console.log(`\n── Placing order ──`);
  console.log(`  side      : BUY`);
  console.log(`  tokenId   : ${tokenId}`);
  console.log(`  price     : ${buyPrice}`);
  console.log(`  size      : ${buySize} shares`);
  console.log(`  orderType : GTC`);

  // V2 order — no feeRateBps, no taker, no expiration, no nonce
  const resp = await client.createAndPostOrder(
    { tokenID: tokenId, price: buyPrice, size: buySize, side: Side.BUY },
    { tickSize },
    OrderType.GTC,
  );

  console.log(`\n── Order Response ──`);
  console.log(JSON.stringify(resp, null, 2));

  if (resp?.orderID) {
    console.log(`\n✅ Order placed! ID: ${resp.orderID}  status: ${resp.status}`);
    console.log(`   Cancel: await client.cancelOrder({ orderID: '${resp.orderID}' })`);
  } else {
    console.log(`\n⚠️  No orderID — check response above for errors`);
  }
}

main().catch(err => {
  console.error('\n❌ Error:', (err as Error).message ?? err);
  process.exit(1);
});
