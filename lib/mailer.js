'use strict';
// Outbound email through Gmail SMTP (Nodemailer). Server-side only.
//
// Credentials come from the environment and are used in exactly one place (createTransport below):
//   GMAIL_USER          the dedicated Gmail address that sends the codes
//   GMAIL_APP_PASSWORD  a Google App Password (16 characters; spaces are ignored). NEVER the account's normal password.
//   SMTP_PORT           465 (default, implicit TLS) or 587 (STARTTLS)
// The host is fixed to smtp.gmail.com. Credentials, and the text of provider errors that might echo them, are never logged or returned.
//
// sendMail() resolves ONLY when the SMTP server accepted the message for the recipient. Anything else throws a MailError whose
// `kind` is a safe, coarse category (no provider text) that callers can show or branch on.
const { log } = require('./log');

const HOST = 'smtp.gmail.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

class MailError extends Error {
  constructor(kind, detail) { super(MESSAGES[kind] || MESSAGES.unknown); this.kind = kind; this.detail = detail; }
}
// What a person may be told. Deliberately free of provider output and configuration details.
const MESSAGES = {
  not_configured: 'Email sending is not set up on this server yet.',
  auth: 'The server could not sign in to its email account.',
  timeout: 'The email service did not respond in time.',
  connection: 'The server could not reach the email service.',
  rejected: 'The email service did not accept that address.',
  quota: 'The email service has reached its sending limit for now.',
  unknown: 'The email could not be sent.'
};

let injected = null, cache = null;
const settings = () => {
  const user = String(process.env.GMAIL_USER || '').trim(), pass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  const port = Number(process.env.SMTP_PORT) === 587 ? 587 : 465;
  return { user, pass, port, baseUrl: String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '') };
};
const configured = () => { if (injected) return true; const s = settings(); return EMAIL_RE.test(s.user) && s.pass.length > 0; };
const senderAddress = () => settings().user;
const baseUrl = () => settings().baseUrl;

// Tests inject a fake transport ({ sendMail, verify }) so no real email is ever sent. Pass null to remove it.
function setTransport(t) { injected = t || null; }

function transport() {
  if (injected) return injected;
  const s = settings();
  if (!EMAIL_RE.test(s.user) || !s.pass) throw new MailError('not_configured');
  const key = `${s.user}|${s.port}|${s.pass.length}|${require('crypto').createHash('sha256').update(s.pass).digest('hex')}`;
  if (cache?.key !== key) {
    const nodemailer = require('nodemailer');
    cache = { key, t: nodemailer.createTransport({
      host: HOST, port: s.port, secure: s.port === 465, requireTLS: s.port !== 465,
      auth: { user: s.user, pass: s.pass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000, // never let a stuck SMTP connection hold a sign-in forever
      tls: { minVersion: 'TLSv1.2' }, logger: false, debug: false
    }) };
  }
  return cache.t;
}

// Maps a Nodemailer / SMTP error to a safe category.
function classify(e) {
  const code = String(e?.code || ''), rc = Number(e?.responseCode) || 0, msg = String(e?.message || e?.response || '');
  if (code === 'EAUTH' || rc === 535 || rc === 534 || rc === 530) return 'auth';
  if (/5\.4\.5|quota|sending limit|rate limit|too many/i.test(msg) || rc === 452 || rc === 421 || rc === 450) return 'quota';
  if (code === 'EENVELOPE' || rc === 550 || rc === 551 || rc === 553 || rc === 554) return 'rejected';
  if (/TIMEDOUT|TIMEOUT/i.test(code) || /timed? ?out/i.test(msg)) return 'timeout';
  if (['ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EDNS', 'ESOCKET', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'connection';
  return 'unknown';
}
// A short diagnostic for the SERVER log only. Secrets are scrubbed; nothing here is ever sent to a browser.
function scrub(e) {
  const s = settings(); let m = String(e?.message || '').slice(0, 200);
  for (const secret of [s.pass, s.user]) if (secret) m = m.split(secret).join('[redacted]');
  return m.replace(/[\r\n]+/g, ' ');
}
function wrap(e) {
  if (e instanceof MailError) return e;
  const kind = classify(e), me = new MailError(kind, scrub(e));
  log('error', 'mail send failed', { kind, code: e?.code || null, smtp: e?.responseCode || null, detail: me.detail });
  return me;
}

async function sendMail({ to, subject, text, html }) {
  to = String(to || '').trim();
  if (!EMAIL_RE.test(to)) throw new MailError('rejected');
  let info;
  try {
    const t = transport(), s = settings();
    info = await t.sendMail({
      from: { name: process.env.MAIL_FROM_NAME || 'Eagle Labs Exam Portal', address: s.user || 'noreply@invalid' },
      to, subject, text, html,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' }
    });
  } catch (e) { throw wrap(e); }
  // Success means the provider ACCEPTED this recipient. A resolved promise with the address in `rejected` is a failure.
  const lower = a => String(typeof a === 'string' ? a : a?.address || '').toLowerCase();
  const accepted = (info?.accepted || []).map(lower), rejected = (info?.rejected || []).map(lower);
  if (!accepted.includes(to.toLowerCase()) || rejected.includes(to.toLowerCase())) throw wrap(Object.assign(new Error('recipient rejected'), { code: 'EENVELOPE' }));
  return { messageId: info.messageId || null };
}

// Safe configuration check: opens an authenticated SMTP session and closes it without sending anything.
async function verify() {
  if (!configured()) return { ok: false, kind: 'not_configured', message: MESSAGES.not_configured };
  try { const t = transport(); if (typeof t.verify === 'function') await t.verify(); return { ok: true }; }
  catch (e) { const me = wrap(e); return { ok: false, kind: me.kind, message: me.message }; }
}
function close() { try { cache?.t?.close?.(); } catch {} cache = null; }

module.exports = { sendMail, verify, configured, senderAddress, baseUrl, setTransport, close, MailError, MESSAGES, EMAIL_RE };
