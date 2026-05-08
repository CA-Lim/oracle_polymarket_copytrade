import * as dotenv from 'dotenv';
dotenv.config();

import { AutoRedeemer } from '../src/redeemer.js';
import { config } from '../src/config.js';
import { ethers } from 'ethers';

const wallet = new ethers.Wallet(config.privateKey);
console.log('Wallet:', wallet.address);

(async () => {
  const res = await fetch(
    `https://data-api.polymarket.com/positions?user=${wallet.address}&sizeThreshold=.01&limit=500`
  );
  const positions: any[] = await res.json();
  const redeemable = positions.filter(
    p => p.redeemable === true && parseFloat(p.curPrice ?? 0) >= 0.99
  );
  console.log(`Total positions: ${positions.length}, redeemable: ${redeemable.length}`);
  redeemable.forEach(p =>
    console.log(`  redeemable: ${p.title?.slice(0, 55)}  price=${p.curPrice}  val=$${parseFloat(p.currentValue).toFixed(2)}`)
  );
})().then(async () => {
  const redeemer = new AutoRedeemer();
  await redeemer.checkAndRedeem();
  console.log('Done.');
  process.exit(0);
}).catch(e => {
  console.error(e.message);
  process.exit(1);
});
