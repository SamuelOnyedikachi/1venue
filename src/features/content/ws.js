/**
 * Content sharing over the room WebSocket (works without LiveKit).
 * Allowed types only:
 *   youtube - a YouTube video id; every viewer streams from YouTube, play/pause/seek follow the remote holder
 *   slides  - page images (a PDF rendered to images in the presenter's browser, uploaded to storage)
 *   image   - a single uploaded image
 *   doc     - a Word document or spreadsheet, extracted on the server into a paged JSON file in storage
 *             (see doc.js); page and scroll follow the presenter
 * Generic web pages (most sites refuse to be framed) and self-hosted video (would stream from this server)
 * are intentionally not supported.
 */
const { can } = require('../../lib/permissions');
const YT_ID = /^[\w-]{11}$/;
const { normalizeStoredFileUrl } = require('../../lib/file-url');
const log = require('../../lib/log');
// Local `/files/<id>/<name>` or the S3/R2 public URL (S3_PUBLIC_BASE_URL); see src/lib/file-url.js.
const okFile = (u) => normalizeStoredFileUrl(u) !== null;

function sanitizeContent(msg) {
  const type = msg.contentType;
  const title = String(msg.title || '').trim().slice(0, 80);
  if (type === 'youtube') {
    const id = String(msg.videoId || '');
    if (!YT_ID.test(id)) return null;
    return { type, videoId: id, url: `https://www.youtube.com/watch?v=${id}`, title: title || 'YouTube video', pages: null, fileMeta: null };
  }
  if (type === 'slides') {
    const pages = Array.isArray(msg.pages) ? msg.pages.map(normalizeStoredFileUrl).filter(Boolean).slice(0, 200) : [];
    if (!pages.length) return null;
    return { type, url: pages[0], pages, title: title || 'Slides', fileMeta: sanitizeMeta(msg.fileMeta) };
  }
  if (type === 'image') {
    const url = normalizeStoredFileUrl(msg.url);
    if (!url) return null;
    return { type, url, pages: null, title: title || 'Image', fileMeta: sanitizeMeta(msg.fileMeta) };
  }
  if (type === 'doc') {
    const url = normalizeStoredFileUrl(msg.url);
    if (!url) return null;
    const docKind = msg.docKind === 'table' ? 'table' : 'text';
    const pageCount = Math.max(1, Math.min(200, Math.round(Number(msg.pageCount)) || 1));
    return { type, url, pages: null, docKind, pageCount, title: title || 'Document', fileMeta: sanitizeMeta(msg.fileMeta) };
  }
  return null;
}
function sanitizeMeta(m) {
  if (!m || typeof m !== 'object') return null;
  return { name: String(m.name || '').slice(0, 120), size: Number(m.size) || 0, mime: String(m.mime || '').slice(0, 80) };
}

module.exports = {
  sanitizeContent,
  id: 'content',
  register(ctx) {
    const { broadcast, getContentState, getParticipantsList, clients, getClient } = ctx;

    ctx.onWs('content-start', ({ msg, participantId, meeting, meetingCode }) => {
      const p = meeting.participants.get(participantId);
      const tell = (error) => { try { ctx.sendToParticipant && ctx.sendToParticipant(participantId, { type: 'error', error, code: 'content-rejected' }); } catch (_) {} };
      if (!p || !can(meeting, p, 'screenShare')) {
        log.warn('content', 'start rejected', { reason: 'no screenShare permission', meeting: meetingCode, participant: participantId });
        tell('The host controls who can present'); return;
      }
      const c = sanitizeContent(msg);
      if (!c) {
        const sample = msg.contentType === 'image' ? msg.url : Array.isArray(msg.pages) ? msg.pages[0] : undefined;
        log.warn('content', 'start rejected', { reason: 'file url not from 1venue storage', type: msg.contentType, pages: Array.isArray(msg.pages) ? msg.pages.length : undefined, sample: sample ? String(sample).slice(0, 160) : undefined, meeting: meetingCode });
        tell('Could not present that file - it was not found in 1venue storage. Upload it again.'); return;
      }
      clearInterval(meeting.content?.slideshowTimer);
      meeting.content = {
        ...c,
        ownerId: participantId,
        remoteHolderId: participantId,
        scrollMode: 'uniform',
        scroll: null,
        page: 1,
        slideshow: false,
        media: c.type === 'youtube' ? { paused: true, t: 0, at: Date.now() } : null,
      };
      log.info('content', 'presenting', { type: c.type, pages: c.pages ? c.pages.length : undefined, meeting: meetingCode });
      broadcast(meetingCode, { type: 'content-state', content: getContentState(meeting) });
    });

    ctx.onWs('content-stop', ({ participantId, meeting, meetingCode }) => {
      if (!meeting.content) return;
      const isOwner = meeting.content.ownerId === participantId;
      const isHost = meeting.participants.get(participantId)?.isHost;
      if (!isOwner && !isHost) return;
      clearInterval(meeting.content.slideshowTimer);
      meeting.content = null;
      broadcast(meetingCode, { type: 'content-state', content: null });
    });

    ctx.onWs('content-update', ({ msg, participantId, meeting, meetingCode }) => {
      if (!meeting.content) return;
      const holder = meeting.content.remoteHolderId;
      const isHolder = holder === participantId;
      const isOwner = meeting.content.ownerId === participantId;
      if (!isHolder && !isOwner) return;
      if (msg.scroll) meeting.content.scroll = msg.scroll;
      if (msg.page != null) {
        const max = meeting.content.pages ? meeting.content.pages.length : meeting.content.pageCount || 1;
        meeting.content.page = Math.max(1, Math.min(max, Math.round(Number(msg.page)) || 1));
      }
      if (msg.slideshow != null && meeting.content.type === 'slides') {
        const c = meeting.content;
        clearInterval(c.slideshowTimer); c.slideshowTimer = null;
        c.slideshow = !!msg.slideshow && c.pages.length > 1;
        if (c.slideshow) {
          c.slideshowTimer = setInterval(() => {
            if (meeting.content !== c || (ctx.getMeeting && ctx.getMeeting(meetingCode) !== meeting)) {
              clearInterval(c.slideshowTimer); return;
            }
            c.page = (c.page % c.pages.length) + 1;
            broadcast(meetingCode, { type: 'content-update', content: getContentState(meeting) });
          }, 4000);
          c.slideshowTimer.unref?.();
        }
      }
      if (msg.media && typeof msg.media === 'object') {
        const m = msg.media;
        meeting.content.media = {
          paused: !!m.paused,
          t: Math.max(0, Number(m.t) || 0),
          at: Date.now(),
          rate: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(Number(m.rate)) ? Number(m.rate) : 1,
        };
      }
      if (msg.scrollMode) meeting.content.scrollMode = msg.scrollMode === 'free' ? 'free' : 'uniform';
      if (msg.title) meeting.content.title = String(msg.title).slice(0, 80);
      // Live deck edit: replace pages without stopping the share (owner/holder only).
      if (Array.isArray(msg.pages) && meeting.content.type === 'slides') {
        const pages = msg.pages.map(normalizeStoredFileUrl).filter(Boolean).slice(0, 200);
        if (pages.length) {
          meeting.content.pages = pages;
          meeting.content.url = pages[0];
          const max = pages.length;
          if (meeting.content.page > max) meeting.content.page = max;
          if (pages.length < Math.min(200, msg.pages.length)) log.warn('content', 'some pages dropped', { kept: pages.length, sent: msg.pages.length, meeting: meetingCode });
        } else {
          log.warn('content', 'pages update rejected', { reason: 'file url not from 1venue storage', sent: msg.pages.length, sample: String(msg.pages[0] || '').slice(0, 160), meeting: meetingCode });
          try { ctx.sendToParticipant && ctx.sendToParticipant(participantId, { type: 'error', error: 'Those images were not found in 1venue storage. Upload them again.', code: 'content-rejected' }); } catch (_) {}
        }
      }
      broadcast(
        meetingCode,
        { type: 'content-update', content: getContentState(meeting), from: participantId },
        meeting.content.type === 'slides' ? undefined : participantId
      );
    });

    ctx.onWs('remote-handoff', ({ msg, participantId, meeting, meetingCode }) => {
      if (!meeting.content) return;
      const targetId = msg.targetId;
      const isOwner = meeting.content.ownerId === participantId;
      const isHolder = meeting.content.remoteHolderId === participantId;
      const isHost = meeting.participants.get(participantId)?.isHost;
      if (!isOwner && !isHolder && !isHost) return;
      if (targetId && !meeting.participants.has(targetId)) return;
      meeting.content.remoteHolderId = targetId || meeting.content.ownerId;
      broadcast(meetingCode, { type: 'content-state', content: getContentState(meeting) });
    });

    ctx.onWs('remote-claim', ({ participantId, meeting, meetingCode }) => {
      if (!meeting.content) return;
      const holderId = meeting.content.remoteHolderId;
      const holderOnline =
        holderId && clients.has(holderId) && clients.get(holderId)?.readyState === 1;
      const isOwner = meeting.content.ownerId === participantId;
      if (isOwner || !holderOnline) {
        meeting.content.remoteHolderId = participantId;
        broadcast(meetingCode, { type: 'content-state', content: getContentState(meeting) });
      }
    });

    ctx.onRegister((ws, meeting) => {
      if (!meeting) return;
      try {
        ws.send(JSON.stringify({ type: 'content-state', content: getContentState(meeting) }));
      } catch (_) {}
    });
  },
};
