import * as dotenv from 'dotenv';
dotenv.config();
import { ethers } from 'ethers';
import { ClobClient, Side, OrderType, Chain } from '@polymarket/clob-client';

const HOST = 'https://clob.polymarket.com';

// Monkey-patch global fetch to log the /order request
const originalFetch = globalThis.fetch;
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.includes('/order') && init?.method === 'POST') {
    console.log('\n=== INTERCEPTED POST /order ===');
    console.log('URL:', url);
    console.log('Headers:', JSON.stringify(Object.fromEntries(new Headers(init?.headers ?? {}).entries()), null, 2));
    console.log('Body:', init?.body ? JSON.stringify(JSON.parse(init.body as string), null, 2) : '(none)');
  }
  return originalFetch(input, init);
};

async function main() {
  const privateKey = process.env.PRIVATE_KEY!;
  const rpcUrl = process.env.RPC_URL ?? 'https://polygon-rpc.com';
  const geoToken = process.env.POLYMARKET_GEO_TOKEN ?? undefined;

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const l1 = new ClobClient(HOST, Chain.POLYGON, wallet, undefined, undefined, undefined, geoToken);
  let raw: any = await l1.deriveApiKey().catch(() => null);
  if (!raw || raw.error) raw = await l1.createApiKey();
  const apiKey: string = raw?.apiKey ?? raw?.key;

  const client = new ClobClient(
    HOST, Chain.POLYGON, wallet,
    { key: apiKey, secret: raw.secret, passphrase: raw.passphrase },
    0, wallet.address, geoToken
  );

  const tokenId = '63234707295320507667894309258849048700632767113302157839265845777836046390818';
  const resp = await client.createAndPostOrder(
    { tokenID: tokenId, price: 0.01, size: 5, side: Side.BUY, feeRateBps: 0 },
    { tickSize: '0.01', negRisk: false },
    OrderType.GTC
  );
  console.log('\n=== RESPONSE ===\n', JSON.stringify(resp, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
