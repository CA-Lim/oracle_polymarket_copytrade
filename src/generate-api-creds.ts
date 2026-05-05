import dotenv from 'dotenv';
import { Wallet } from 'ethers';
import { ClobClient, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import * as fs from 'fs';

dotenv.config();

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('Missing PRIVATE_KEY in .env');
  }

  const signer = new Wallet(privateKey);
  const client = new ClobClient({
    host: HOST,
    chain: CHAIN_ID,
    signer,
    signatureType: SignatureTypeV2.EOA,
    funderAddress: signer.address,
  });

  let creds = await client.deriveApiKey().catch(() => null);
  if (!creds || (creds as any).error) {
    creds = await client.createApiKey();
  }

  const apiKey = (creds as any)?.key;
  const secret = (creds as any)?.secret;
  const passphrase = (creds as any)?.passphrase;

  if (!apiKey || !secret || !passphrase) {
    throw new Error('Could not generate API credentials');
  }

  const outputFile = '.polymarket-api-creds';
  const fileContents =
    'POLYMARKET_USER_API_KEY=' + apiKey + '\n' +
    'POLYMARKET_USER_SECRET=' + secret + '\n' +
    'POLYMARKET_USER_PASSPHRASE=' + passphrase + '\n';

  fs.writeFileSync(outputFile, fileContents, { mode: 0o600 });

  console.log(`✅ API credentials have been generated successfully and written to ${outputFile}. Handle them securely and do not log them in plaintext.`);
}

main().catch((error) => {
  console.error('❌ Failed to generate API credentials:', error.message || error);
  process.exit(1);
});
