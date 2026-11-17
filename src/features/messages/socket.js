/**
 * User socket (wss://…/ws/me): one connection per signed-in tab, separate from the meeting hub so a
 * dead meeting can never drop someone's inbox. Authenticated with the session cookie at upgrade.
 *
 * Client -> server: { type: 'visible', visible, conversationId }   { type: 'typing', conversationId }
 * Server -> client: ready, message, message-edited, message-deleted, reaction, read, typing,
 *                   conversation-updated, unread, call-ring, call-accepted, call-declined,
 *                   call-ended, call-upgraded, presence
 */
const { WebSocketServer } = require('ws');
const config = require('../../config');
const { getAuthUser } = require('../../lib/auth');
const { q, one } = require('../../core/db');

const sockets = new Map(); // userId -> Set<ws>
let wss = null;

function sendToUser(userId, payload) {
  const set = sockets.get(Number(userId));
  if (!set) return 0;
  const data = JSON.stringify(payload);
  let n = 0;
  for (const ws of set) { if (ws.readyState === 1) { try { ws.send(data); n++; } catch (_) {} } }
  return n;
}
const isOnline = (userId) => !!(sockets.get(Number(userId)) || new Set()).size;
/** True when one of the user's tabs is visible (optionally: showing that conversation). */
function hasVisible(userId, conversationId = null) {
  for (const ws of sockets.get(Number(userId)) || []) {
    if (ws.visible && (conversationId == null || Number(ws.activeConversation) === Number(conversationId))) return true;
  }
  return false;
}
async function touchPresence(userId) {
  await q(`INSERT INTO user_presence (user_id, last_seen_at) VALUES ($1, NOW())
    ON CONFLICT (user_id) DO UPDATE SET last_seen_at=NOW()`, [userId]).catch(() => {});
}

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients; the cookie still has to be valid
  try {
    const host = new URL(origin).host;
    if (host === req.headers.host) return true;
    if (config.PUBLIC_URL && host === new URL(config.PUBLIC_URL).host) return true;
  } catch (_) {}
  return false;
}

function create() {
  if (wss) return wss;
  wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, Math.max(10000, Number(config.MEMORY && config.MEMORY.wsHeartbeatMs) || 30000));
  beat.unref();
  wss.on('connection', (ws, req, user) => {
    const uid = Number(user.id);
    ws.isAlive = true; ws.userId = uid; ws.visible = true; ws.activeConversation = null;
    if (!sockets.has(uid)) sockets.set(uid, new Set());
    sockets.get(uid).add(ws);
    touchPresence(uid);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'visible') { ws.visible = !!msg.visible; ws.activeConversation = msg.conversationId ? Number(msg.conversationId) : null; return; }
      if (msg.type === 'typing' && msg.conversationId) {
        const now = Date.now();
        if (ws.lastTyping && now - ws.lastTyping < 1500) return;
        ws.lastTyping = now;
        require('./service').relayTyping(uid, Number(msg.conversationId)).catch(() => {});
      }
    });
    ws.on('close', () => {
      const set = sockets.get(uid);
      if (set) { set.delete(ws); if (!set.size) sockets.delete(uid); }
      touchPresence(uid);
    });
    try { ws.send(JSON.stringify({ type: 'ready', userId: uid })); } catch (_) {}
  });
  return wss;
}

/** Handle an HTTP upgrade for /ws/me. */
async function handleUpgrade(req, socket, head) {
  const reject = (code, text) => { try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch (_) {} socket.destroy(); };
  if (!originOk(req)) return reject(403, 'Forbidden');
  let user = null;
  try { user = await getAuthUser(req, null); } catch (_) { user = null; }
  if (!user) return reject(401, 'Unauthorized');
  const server = create();
  server.handleUpgrade(req, socket, head, (ws) => server.emit('connection', ws, req, user));
}

async function lastSeen(userId) {
  const r = await one('SELECT last_seen_at FROM user_presence WHERE user_id=$1', [userId]).catch(() => null);
  return r ? r.last_seen_at : null;
}
function closeAll() { if (wss) for (const ws of wss.clients) { try { ws.terminate(); } catch (_) {} } }

module.exports = { handleUpgrade, sendToUser, isOnline, hasVisible, lastSeen, closeAll, _sockets: sockets };
