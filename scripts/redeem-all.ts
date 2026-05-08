import * as dotenv from 'dotenv';
dotenv.config();

import { AutoRedeemer } from '../src/redeemer.js';

const redeemer = new AutoRedeemer();
redeemer.checkAndRedeem().then(() => {
  console.log('Done.');
  process.exit(0);
}).catch(e => {
  console.error(e.message);
  process.exit(1);
});
