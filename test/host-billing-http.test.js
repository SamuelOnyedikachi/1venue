'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {boot,client,signupPayload}=require('./helpers/server');
const db=require('../db');
const skip=process.env.DB_DRIVER!=='sqlite'&&!process.env.DATABASE_URL;
let s,host,id;
test.before(async()=>{if(skip)return;s=await boot();host=client(s.base);await host.post('/api/signup',signupPayload());id=(await host.get('/api/session')).body.user.id;});
test.after(async()=>{if(s)await s.stop();await db.close();});
test('guest and signed-in hosts can start the 20-minute free window; only one open meeting at a time',{skip},async()=>{
 const anon=client(s.base);const guest=await anon.post('/api/create',{name:'Guest free minutes',participantName:'Ada'});assert.equal(guest.status,200,JSON.stringify(guest.body)+' '+(s.output?s.output():''));assert.ok(guest.body.code);
 assert.equal((await host.get('/api/wallet')).body.balanceCredits,100);
 const outcomes=await Promise.all([host.post('/api/create',{name:'Funded A',participantName:'Ada'}),host.post('/api/create',{name:'Funded B',participantName:'Ada'})]);
 assert.deepEqual(outcomes.map(x=>x.status).sort(),[200,409]);
 const room=outcomes.find(x=>x.status===200).body;
 assert.equal((await anon.post('/api/join',{code:room.code,participantName:'Free guest'})).status,200);
 const wallet=(await host.get('/api/wallet')).body;assert.equal(wallet.balanceCredits,100);assert.equal(wallet.billing.code,room.code);
 const row=(await db.q('SELECT * FROM credit_billing_sessions WHERE user_id=$1',[id])).rows[0];
 assert.ok(row.media_room.startsWith('b-'));assert.notEqual(row.media_room,room.code);
 assert.ok(Number(row.free_until_ms)>Date.now()-1000);
});
test('after the free window, exhaustion closes the live application room and rejects new joins without another charge',{skip},async()=>{
 const row=(await db.q("SELECT * FROM credit_billing_sessions WHERE user_id=$1 AND state='active'",[id])).rows[0];assert.ok(row);
 const past=Date.now()-1000;
 await db.q('UPDATE credit_billing_sessions SET free_until_ms=$2, accounted_ms=$2 WHERE id=$1',[row.id,past]);
 await db.q('UPDATE credit_wallets SET balance_units=1 WHERE user_id=$1',[id]);
 await host.get('/api/wallet');
 let status;
 for(let i=0;i<40;i++) {status=(await host.get('/api/meeting/'+row.code)).status;if(status===404)break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(status,404);assert.equal((await client(s.base).post('/api/join',{code:row.code,participantName:'Ben'})).status,404);
 const ended=(await db.q('SELECT * FROM credit_billing_sessions WHERE id=$1',[row.id])).rows[0];assert.equal(ended.end_reason,'credits-exhausted');
 assert.equal((await host.get('/api/wallet')).body.balanceCredits,0);
});
test('an authorized venue starts host-funded billing like any other meeting',{skip},async()=>{
 const owner=client(s.base);await owner.post('/api/signup',signupPayload());
 const venue=await owner.post('/api/venues',{name:'Deferred billing venue'});assert.equal(venue.status,200,JSON.stringify(venue.body));
 const forbidden=await host.post('/api/create',{name:'Other owner',venue:venue.body.slug});assert.equal(forbidden.status,403);
 const opened=await owner.post('/api/create',{name:'Venue gathering',venue:venue.body.slug});assert.equal(opened.status,200,JSON.stringify(opened.body));
 assert.equal(opened.body.code,venue.body.code);const w=(await owner.get('/api/wallet')).body;assert.equal(w.balanceCredits,100);assert.ok(w.billing);assert.equal(w.billing.code,opened.body.code);
});
