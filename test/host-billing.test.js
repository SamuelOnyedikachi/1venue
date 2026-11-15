'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/server'); // isolated SQLite path when selected
const db = require('../db');
const skip = process.env.DB_DRIVER !== 'sqlite' && !process.env.DATABASE_URL;
let billing;
const now = Date.now();
async function payer(credits) {
  const id = (await db.q('INSERT INTO users(username,email) VALUES($1,$2) RETURNING id', ['bill'+Math.random().toString(36).slice(2), Math.random()+'@ex.test'])).rows[0].id;
  await db.q('INSERT INTO credit_wallets(user_id,balance_units) VALUES($1,$2)', [id, Math.round(credits*60000)]);
  return id;
}
test.before(async()=>{if(skip)return;await db.ensureReady();billing=require('../src/features/wallet/billing-data');});
test.after(async()=>{await db.close();});
const open = (id,at=now)=>billing.open({userId:id,code:Math.random().toString(36).slice(2,8),name:'Billing test',hostName:'Host',now:at,ownerId:'test-worker'});
test('opening enforces 30 credits atomically, and a second simultaneous room cannot claim a payer', {skip},async()=>{
  const poor=await payer(29.999);await assert.rejects(open(poor),e=>e.status===402);
  const id=await payer(30);const attempts=await Promise.allSettled([open(id),open(id)]);
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(attempts.find(x=>x.status==='rejected').reason.status,409);
});
test('90 seconds debits exactly 1.5 credits once, partial end stops later charges and ledger agrees', {skip},async()=>{
  const id=await payer(30);const {historyId}=await open(id);
  await Promise.all([billing.settle(historyId,{now:now+90000}),billing.settle(historyId,{now:now+90000})]);
  assert.equal((await billing.current(id,now+90000)).balanceCredits,28.5);
  await billing.settle(historyId,{now:now+90500,endReason:'host-ended'});
  await billing.settle(historyId,{now:now+200000});
  assert.equal((await billing.current(id,now+200000)).balanceCredits,28.5-0.5/60);
  const rows=(await db.q('SELECT SUM(delta_units) AS total FROM credit_ledger WHERE billing_session_id=$1',[historyId])).rows;
  assert.equal(Number(rows[0].total),-90500);
});
test('exhaustion clamps to zero and funded instant, warnings clear and rearm after top-ups', {skip},async()=>{
  const id=await payer(30);const {historyId}=await open(id);
  let row=await billing.settle(historyId,{now:now+1200000});assert.equal(row.low_credit, true);
  await db.q('UPDATE credit_wallets SET balance_units=balance_units+600000 WHERE user_id=$1',[id]);
  row=await billing.settle(historyId,{now:now+1200000});assert.equal(row.low_credit,false);
  row=await billing.settle(historyId,{now:now+1800000});assert.equal(row.low_credit,true);
  row=await billing.settle(historyId,{now:now+9999999});assert.equal(row.state,'closing');assert.equal(row.end_reason,'credits-exhausted');
  assert.equal(Number(row.ended_ms),now+2400000);assert.equal((await billing.current(id,now+9999999)).balanceCredits,0);
  await assert.rejects(open(id,now+9999999),e=>e.status===409);
  await assert.rejects(db.tx(c=>require('../src/features/wallet/data').assertCanDelete(c,id)),e=>e.status===409);
});
