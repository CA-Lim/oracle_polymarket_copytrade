/**
 * Debug script: sign a negRisk market order, verify the signature locally,
 * then post it and log the full API response.
 *
 * Usage:
 *   npx tsx scripts/debug-neg-risk.ts [tokenId]
 *
 * Defaults to the AZ vs FC Twente token from the failing log.
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';

const TOKEN_ID = process.argv[2]
  || '74867206855377225286224886279868253663121097889820662922720444658980358548570';

const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const EXCHANGE          = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  console.log('Wallet:', wallet.address);

  // ── Step 1: derive API creds ───────────────────────────────────────────────
  let clob = new ClobClient('https://clob.polymarket.com', 137, wallet);
  let creds: any = await clob.deriveApiKey().catch(() => null);
  if (!creds || creds.error) creds = await clob.createApiKey();
  const apiKey    = creds?.apiKey || creds?.key;
  const { secret, passphrase } = creds;
  if (!apiKey || !secret || !passphrase) throw new Error('Could not get API creds');
  console.log('API key:', apiKey);

  clob = new ClobClient(
    'https://clob.polymarket.com', 137, wallet,
    { key: apiKey, secret, passphrase },
    0,               // EOA signature type
    wallet.address,  // funderAddress
  );

  // ── Step 2: inspect token ──────────────────────────────────────────────────
  const negRisk    = await clob.getNegRisk(TOKEN_ID);
  const tickSize   = await clob.getTickSize(TOKEN_ID);
  const feeRateBps = await clob.getFeeRateBps(TOKEN_ID);
  console.log(`\nnegRisk:   ${negRisk}`);
  console.log(`tickSize:  ${tickSize}`);
  console.log(`feeRateBps: ${feeRateBps}`);

  // ── Step 3: build the order (don't post yet) ───────────────────────────────
  const price = 0.99;
  const order = await clob.createMarketOrder(
    {
      tokenID:    TOKEN_ID,
      amount:     3,
      price,
      side:       Side.BUY,
      feeRateBps,
    },
    { tickSize: tickSize as any, negRisk },
  );

  console.log('\n─── Signed order ───────────────────────────────────────────────');
  console.log(JSON.stringify(order, null, 2));

  // ── Step 4: verify signature locally ─────────────────────────────────────
  const domain = {
    name: 'Polymarket CTF Exchange',
    version: '1',
    chainId: 137,
    verifyingContract: negRisk ? NEG_RISK_EXCHANGE : EXCHANGE,
  };
  const types = {
    Order: [
      { name: 'salt',          type: 'uint256' },
      { name: 'maker',         type: 'address' },
      { name: 'signer',        type: 'address' },
      { name: 'taker',         type: 'address' },
      { name: 'tokenId',       type: 'uint256' },
      { name: 'makerAmount',   type: 'uint256' },
      { name: 'takerAmount',   type: 'uint256' },
      { name: 'expiration',    type: 'uint256' },
      { name: 'nonce',         type: 'uint256' },
      { name: 'feeRateBps',    type: 'uint256' },
      { name: 'side',          type: 'uint8'   },
      { name: 'signatureType', type: 'uint8'   },
    ],
  };
  const message = {
    salt:          order.salt,
    maker:         order.maker,
    signer:        order.signer,
    taker:         order.taker,
    tokenId:       order.tokenId,
    makerAmount:   order.makerAmount,
    takerAmount:   order.takerAmount,
    expiration:    order.expiration,
    nonce:         order.nonce,
    feeRateBps:    order.feeRateBps,
    side:          order.side,
    signatureType: order.signatureType,
  };

  const recovered = ethers.utils.verifyTypedData(domain, types, message, order.signature);
  console.log('\n─── Local verification ─────────────────────────────────────────');
  console.log(`Expected signer: ${wallet.address}`);
  console.log(`Recovered signer: ${recovered}`);
  console.log(`Match: ${recovered.toLowerCase() === wallet.address.toLowerCase()}`);
  console.log(`Exchange used:   ${domain.verifyingContract}`);

  // ── Step 5: post and log full response ────────────────────────────────────
  console.log('\n─── Posting order ───────────────────────────────────────────────');
  const resp = await clob.postOrder(order, OrderType.FOK);
  console.log('Full API response:');
  console.log(JSON.stringify(resp, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
