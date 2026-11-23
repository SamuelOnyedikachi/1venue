/**
 * Messages API (all signed in).
 *   GET    /api/messages/conversations?filter=all|dm|groups|meetings&archived=1
 *   GET    /api/messages/unread                          { total, conversations: { id: n } }
 *   POST   /api/messages/dm            { userId }        open or start a DM (allow-list applies)
 *   GET    /api/messages/can?userId=                     { ok } may I start a DM with this person
 *   GET    /api/messages/conversations/:id               detail (members, presence, active call)
 *   PATCH  /api/messages/conversations/:id { muted, archived, pinned, title }
 *   GET    /api/messages/conversations/:id/messages?before=&limit=
 *   POST   /api/messages/conversations/:id/messages      { text, attachment }
 *   PATCH  /api/messages/conversations/:id/messages/:mid { text }   (15 min, own, DMs and groups)
 *   DELETE /api/messages/conversations/:id/messages/:mid
 *   POST   /api/messages/conversations/:id/messages/:mid/reactions { emoji }   toggle
 *   POST   /api/messages/conversations/:id/read  { messageId }      POST .../clear (delete for me)
 *   POST   /api/messages/conversations/:id/members { userId }       DELETE .../members/:userId
 *   POST   /api/messages/groups        { title, memberIds }
 *   GET/POST /api/messages/blocks { userId }   DELETE /api/messages/blocks/:userId
 *   POST   /api/messages/reports       { conversationId, messageId, reason }
 *   GET/PUT /api/messages/settings     { dmPolicy: everyone|contacts|nobody, hidePresence }
 *   GET    /api/messages/push/config   POST /api/messages/push/subscribe | unsubscribe
 *   POST   /api/messages/conversations/:id/calls { kind }   GET /api/messages/calls/current
 *   POST   /api/messages/calls/:id/accept|decline|leave|video|token
 *   POST   /api/messages/conversations/:id/cards { type: meeting|venue, code, key, venueId }
 *   POST   /api/messages/conversations/:id/schedule { title, startsAt, durationMin, pattern?, count?, until? }
 *   POST   /api/messages/new { handle }   (username or email)   GET /api/messages/search?q=&from=me|them&has=file|image|voice|link&conversationId=
 *   POST|DELETE .../messages/:mid/pin   POST .../messages/:mid/forward { conversationId }   POST .../messages/:mid/analyse | transcribe   GET .../messages/:mid/table
 *   POST .../summary   GET .../contact   PUT .../note { body }   GET|POST .../scheduled   DELETE /api/messages/scheduled/:id
 *   GET|POST /api/messages/quick-replies   DELETE /api/messages/quick-replies/:id
 *   GET    /api/admin/message-reports?status=open|dismissed|actioned|all   POST /api/admin/message-reports/:id { status, note }
 */
const svc = require('./service');
const access = require('./access');
const push = require('./push');
const calls = require('./calls');
const meet = require('./meet');

module.exports = function routes(route, { requireUser, httpError, int, db }) {
  const me = (ctx) => requireUser(ctx.req, ctx.res);
  const C = '/api/messages/conversations/(\\d+)';
  route('GET', '/api/messages/conversations', async (ctx) => {
    const u = await me(ctx); const s = ctx.url.searchParams;
    return { conversations: await svc.listConversations(u.id, { filter: s.get('filter') || 'all', archived: s.get('archived') === '1', type: s.get('type') || '' }) };
  });
  route('GET', '/api/messages/unread', async (ctx) => svc.unreadSummary((await me(ctx)).id));
  route('POST', '/api/messages/dm', async (ctx) => { const u = await me(ctx); return { conversation: await svc.openDm(u, int((await ctx.body()).userId)) }; });
  route('GET', '/api/messages/can', async (ctx) => {
    const u = await me(ctx); const r = await access.canStartDm(u.id, int(ctx.url.searchParams.get('userId')));
    return { ok: r.ok, reason: r.ok ? null : r.reason };
  });
  route('GET', C, async (ctx, [id]) => {
    const u = await me(ctx);
    const out = await svc.getConversation(u.id, int(id));
    const call = await db.q("SELECT id, kind, state FROM calls WHERE conversation_id=$1 AND state <> 'ended' ORDER BY started_at DESC LIMIT 1", [out.id]);
    out.activeCall = call.rows[0] ? { id: call.rows[0].id, kind: call.rows[0].kind, state: call.rows[0].state } : null;
    return { conversation: out };
  });
  route('PATCH', C, async (ctx, [id]) => {
    const u = await me(ctx); const b = await ctx.body();
    if (b.title !== undefined) await svc.renameGroup(u, int(id), b.title);
    return { conversation: await svc.updateMember(u.id, int(id), b) };
  });
  route('GET', `${C}/messages`, async (ctx, [id]) => { const u = await me(ctx); const s = ctx.url.searchParams; return svc.listMessages(u.id, int(id), { before: s.get('before'), limit: s.get('limit') }); });
  route('POST', `${C}/messages`, async (ctx, [id]) => { const u = await me(ctx); return { $status: 201, $body: { message: await svc.sendMessage(u, int(id), await ctx.body(64 * 1024)) } }; });
  route('PATCH', `${C}/messages/(\\d+)`, async (ctx, [id, mid]) => { const u = await me(ctx); return { message: await svc.editMessage(u.id, int(id), int(mid), await ctx.body()) }; });
  route('DELETE', `${C}/messages/(\\d+)`, async (ctx, [id, mid]) => svc.deleteMessage((await me(ctx)).id, int(id), int(mid)));
  route('POST', `${C}/messages/(\\d+)/reactions`, async (ctx, [id, mid]) => { const u = await me(ctx); return svc.toggleReaction(u.id, int(id), int(mid), (await ctx.body()).emoji); });
  route('POST', `${C}/read`, async (ctx, [id]) => { const u = await me(ctx); return svc.markRead(u.id, int(id), int((await ctx.body()).messageId, 0)); });
  route('POST', `${C}/clear`, async (ctx, [id]) => svc.clearHistory((await me(ctx)).id, int(id)));
  route('POST', `${C}/members`, async (ctx, [id]) => { const u = await me(ctx); return { conversation: await svc.addMember(u, int(id), int((await ctx.body()).userId)) }; });
  route('DELETE', `${C}/members/(\\d+)`, async (ctx, [id, uid]) => svc.removeMember(await me(ctx), int(id), int(uid)));
  route('POST', '/api/messages/groups', async (ctx) => { const u = await me(ctx); return { $status: 201, $body: { conversation: await svc.createGroup(u, await ctx.body()) } }; });

  route('GET', '/api/messages/blocks', async (ctx) => ({ blocked: await access.listBlocked((await me(ctx)).id) }));
  route('POST', '/api/messages/blocks', async (ctx) => { const u = await me(ctx); return access.block(u.id, int((await ctx.body()).userId)); });
  route('DELETE', '/api/messages/blocks/(\\d+)', async (ctx, [uid]) => access.unblock((await me(ctx)).id, int(uid)));
  route('POST', '/api/messages/reports', async (ctx) => { const u = await me(ctx); return { $status: 201, $body: await svc.report(u, await ctx.body()) }; });
  route('GET', '/api/messages/settings', async (ctx) => { const p = await access.prefs((await me(ctx)).id); return { dmPolicy: p.dmPolicy, hidePresence: p.hidePresence, notifyPrompt: p.notifyPrompt, push: push.publicConfig() }; });
  route('PUT', '/api/messages/settings', async (ctx) => { const u = await me(ctx); const p = await access.savePrefs(u.id, await ctx.body()); return { dmPolicy: p.dmPolicy, hidePresence: p.hidePresence, notifyPrompt: p.notifyPrompt, push: push.publicConfig() }; });

  route('GET', '/api/messages/push/config', async () => push.publicConfig());
  route('POST', '/api/messages/push/subscribe', async (ctx) => { const u = await me(ctx); return push.subscribe(u.id, await ctx.body(8 * 1024), ctx.req.headers['user-agent']); });
  route('POST', '/api/messages/push/unsubscribe', async (ctx) => { const u = await me(ctx); return push.unsubscribe(u.id, (await ctx.body(8 * 1024)).endpoint); });

  route('POST', `${C}/calls`, async (ctx, [id]) => { const u = await me(ctx); return { $status: 201, $body: await calls.start(u, int(id), (await ctx.body()).kind) }; });
  route('GET', '/api/messages/calls/current', async (ctx) => calls.current(await me(ctx)));
  route('POST', '/api/messages/calls/([0-9a-f-]{36})/(accept|decline|leave|video|token)', async (ctx, [cid, action]) => {
    const u = await me(ctx);
    if (action === 'accept') return calls.accept(u, cid);
    if (action === 'decline') return calls.decline(u, cid);
    if (action === 'leave') return calls.leave(u, cid);
    if (action === 'video') return calls.upgradeVideo(u, cid);
    return calls.refreshToken(u, cid);
  });

  route('POST', `${C}/cards`, async (ctx, [id]) => {
    const u = await me(ctx); const b = await ctx.body();
    if (b.type === 'meeting') return { $status: 201, $body: { message: await meet.postMeeting(u, int(id), b) } };
    if (b.type === 'venue') return { $status: 201, $body: { message: await meet.postVenue(u, int(id), b) } };
    throw httpError(400, 'Choose a meeting or a venue');
  });
  route('POST', `${C}/schedule`, async (ctx, [id]) => { const u = await me(ctx); return { $status: 201, $body: await meet.schedule(u, int(id), await ctx.body(16 * 1024)) }; });

  // ---------------------------------------------------------------- power features (power.js)
  let P = null;
  try { P = require('./power'); } catch (e) { console.warn('[messages] power features unavailable:', e.message); }
  if (P) {
  route('POST', '/api/messages/new', async (ctx) => { const u = await me(ctx); return { conversation: await P.openByHandle(u, (await ctx.body(4 * 1024)).handle) }; });
  route('GET', '/api/messages/search', async (ctx) => {
    const u = await me(ctx); const s = ctx.url.searchParams;
    return P.search(u.id, { q: s.get('q') || '', conversationId: s.get('conversationId') ? int(s.get('conversationId')) : null, from: s.get('from') || '', has: s.get('has') || '' });
  });
  route('POST', `${C}/messages/(\\d+)/pin`, async (ctx, [id, mid]) => P.pin(await me(ctx), int(id), int(mid)));
  route('DELETE', `${C}/messages/(\\d+)/pin`, async (ctx, [id, mid]) => P.unpin(await me(ctx), int(id), int(mid)));
  route('POST', `${C}/messages/(\\d+)/forward`, async (ctx, [id, mid]) => { const u = await me(ctx); return { $status: 201, $body: await P.forward(u, int(id), int(mid), int((await ctx.body()).conversationId)) }; });
  route('POST', `${C}/messages/(\\d+)/analyse`, async (ctx, [id, mid]) => { const u = await me(ctx); return P.analyseFile(u, int(id), int(mid), { force: !!(await ctx.body().catch(() => ({}))).force }); });
  route('GET', `${C}/messages/(\\d+)/table`, async (ctx, [id, mid]) => P.tableData(await me(ctx), int(id), int(mid)));
  route('POST', `${C}/messages/(\\d+)/transcribe`, async (ctx, [id, mid]) => P.transcribe(await me(ctx), int(id), int(mid)));
  route('POST', `${C}/summary`, async (ctx, [id]) => P.summarize(await me(ctx), int(id)));
  route('GET', `${C}/contact`, async (ctx, [id]) => P.contact((await me(ctx)).id, int(id)));
  route('PUT', `${C}/note`, async (ctx, [id]) => { const u = await me(ctx); return P.saveNote(u.id, int(id), (await ctx.body(16 * 1024)).body); });
  route('GET', `${C}/scheduled`, async (ctx, [id]) => P.listScheduled(await me(ctx), int(id)));
  route('POST', `${C}/scheduled`, async (ctx, [id]) => { const u = await me(ctx); return { $status: 201, $body: await P.schedule(u, int(id), await ctx.body(64 * 1024)) }; });
  route('DELETE', '/api/messages/scheduled/(\\d+)', async (ctx, [sid]) => P.cancelScheduled(await me(ctx), int(sid)));
  route('GET', '/api/messages/quick-replies', async (ctx) => P.listQuick((await me(ctx)).id));
  route('POST', '/api/messages/quick-replies', async (ctx) => { const u = await me(ctx); return { $status: 201, $body: await P.addQuick(u.id, await ctx.body(8 * 1024)) }; });
  route('DELETE', '/api/messages/quick-replies/(\\d+)', async (ctx, [qid]) => P.delQuick((await me(ctx)).id, int(qid)));

  }

  let aiCalls = null;
  try { aiCalls = require('./ai-calls'); } catch (e) { console.warn('[messages] ai-calls unavailable:', e.message); }
  if (aiCalls) {
  route('GET', '/api/messages/ai-calls/settings', async () => aiCalls.publicSettings());
  route('POST', '/api/messages/ai-calls/([0-9a-f-]{36}|\\d+)/turn', async (ctx, [id]) => {
    const u = await me(ctx);
    const b = await ctx.body(6 * 1024 * 1024);
    return aiCalls.turn(u, id, { audio: b.audio, mime: b.mime, text: b.text, pendingQuestion: b.pendingQuestion });
  });
  route('POST', '/api/messages/ai-calls/request', async (ctx) => {
    const u = await me(ctx);
    const b = await ctx.body().catch(() => ({}));
    return aiCalls.requestCall(u.id, { reason: b.reason || 'You asked Notification to call you.', requested: true });
  });

  }

  const admin = async (ctx) => { const u = await me(ctx); if (!u.isAdmin) throw httpError(403, 'Admins only'); return u; };
  route('GET', '/api/admin/message-reports', async (ctx) => { await admin(ctx); return { reports: await svc.listReports(ctx.url.searchParams.get('status') || 'open') }; });
  route('POST', '/api/admin/message-reports/(\\d+)', async (ctx, [id]) => { const u = await admin(ctx); return svc.reviewReport(u.id, int(id), await ctx.body()); });
};
