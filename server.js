'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const SECRET = process.env.WEBHOOK_SECRET || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_TO = process.env.NOTIFY_TO || '';
const NOTIFY_FROM = process.env.NOTIFY_FROM || '';
const ACCOUNT_ID = process.env.ALLOWED_ACCOUNT_ID || '';
const seen = new Set();

function sigOk(raw, sig) {
  if (!SECRET || !sig) return false;
  const want = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const a = Buffer.from(want), b = Buffer.from(String(sig).trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalise(ev) {
  if (ev && ev.data && typeof ev.data === 'object' && ev.data.chatId !== undefined) {
    const d = ev.data;
    return { id: d.messageId, chat: d.chatId, fromMe: !!d.fromMe, name: d.pushName, type: d.messageType, text: d.text };
  }
  const m = ev && ev.message ? ev.message : null;
  if (!m) return null;
  const k = m.key || {};
  const body = m.message || {};
  const text = body.conversation || (body.extendedTextMessage && body.extendedTextMessage.text) ||
    (body.imageMessage && body.imageMessage.caption) || null;
  const type = Object.keys(body)[0] || null;
  return { id: k.id, chat: k.remoteJid, fromMe: !!k.fromMe, name: m.pushName, type, text };
}

async function email(subject, text) {
  if (!RESEND_KEY || !NOTIFY_TO || !NOTIFY_FROM) { console.log('email skipped: missing env'); return false; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_KEY },
    body: JSON.stringify({ from: NOTIFY_FROM, to: [NOTIFY_TO], subject, text })
  });
  if (!r.ok) console.log('resend failed', r.status);
  return r.ok;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', service: 'wa-reply-receiver' }));
  }
  if (req.method !== 'POST' || req.url !== '/hook') { res.writeHead(404); return res.end(); }
  const chunks = [];
  req.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 1e6) req.destroy(); });
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!sigOk(raw, req.headers['x-webhook-signature'])) { res.writeHead(401); return res.end('bad signature'); }
    let ev;
    try { ev = JSON.parse(raw); } catch { res.writeHead(400); return res.end('bad json'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    try {
      if (ACCOUNT_ID && ev.waAccountId !== ACCOUNT_ID) return;
      const n = normalise(ev);
      if (!n || n.fromMe || !n.chat) return;
      if (n.chat === 'status@broadcast' || n.chat.endsWith('@g.us')) return;
      if (n.id && seen.has(n.id)) return;
      if (n.id) { seen.add(n.id); if (seen.size > 2000) seen.clear(); }
      const who = n.chat.replace(/@.*/, '');
      const subject = 'WhatsApp reply: ' + (n.name || who) + ' (' + who + ')';
      const body = ['New WhatsApp reply on the outreach number.', '',
        'From: ' + (n.name || '(no name)') + ' / ' + n.chat,
        'Type: ' + (n.type || 'unknown'), 'Time: ' + new Date().toISOString(), '',
        'Message:', n.text || '(no text - media or voice note, open WhatsApp to read)'].join('\n');
      await email(subject, body);
    } catch (e) { console.log('handler error', e && e.message); }
  });
});
server.listen(PORT, () => console.log('wa-reply-receiver listening on ' + PORT));
