"use strict";
// 의존성 없는 최소 SMTP 클라이언트 — HR 알림·채용 결과 통보 메일용.
//
// 환경변수
//  SMTP_HOST            (필수) 메일 서버 주소. 없으면 "미설정"으로 보고 발송하지 않는다.
//  SMTP_PORT            기본 587(STARTTLS) / SMTP_SECURE=true 이면 기본 465(암묵적 TLS)
//  SMTP_SECURE          "true"면 연결 즉시 TLS(보통 465)
//  SMTP_USER/SMTP_PASS  인증 정보(둘 다 있을 때만 AUTH). 비밀번호는 어디에도 노출·기록하지 않는다.
//  SMTP_FROM            보내는 사람 주소(없으면 SMTP_USER)
//  SMTP_ALLOW_PLAIN_AUTH "true"면 TLS 없이 평문으로 AUTH 허용(루프백 호스트는 항상 허용)
//  SMTP_TIMEOUT_MS      소켓 무응답 제한(기본 15000)
//
// 지원: EHLO, STARTTLS, AUTH PLAIN/LOGIN, 한글 제목(RFC2047)·본문(base64 UTF-8), dot-stuffing.
// 보안: 헤더 인젝션을 막기 위해 주소·제목의 CR/LF를 거부하고, TLS 없는 AUTH는 기본 거부한다.

const net = require("net");
const tls = require("tls");

const EMAIL_RE = /^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]+$/;

function isValidEmail(v) {
  return typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v.trim());
}

function _isLoopback(host) {
  const h = String(host || "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function getMailConfig(env = process.env) {
  const host = String(env.SMTP_HOST || "").trim();
  const secure = String(env.SMTP_SECURE || "").toLowerCase() === "true";
  const port = Number(env.SMTP_PORT) || (secure ? 465 : 587);
  const user = String(env.SMTP_USER || "");
  const pass = String(env.SMTP_PASS || "");
  const from = String(env.SMTP_FROM || user || "").trim();
  return {
    host, port, secure, user, pass, from,
    allowPlainAuth: String(env.SMTP_ALLOW_PLAIN_AUTH || "").toLowerCase() === "true",
    timeoutMs: Number(env.SMTP_TIMEOUT_MS) || 15000,
    configured: !!(host && isValidEmail(from)),
  };
}

// 화면·상태 API에 내보내도 되는 설정 요약(비밀번호·계정 제외).
function publicMailStatus(env = process.env) {
  const c = getMailConfig(env);
  return { configured: c.configured, host: c.host || null, port: c.port, secure: c.secure, from: c.from || null, auth: !!(c.user && c.pass) };
}

function _noCrlf(v, label) {
  const s = String(v == null ? "" : v);
  if (/[\r\n]/.test(s)) throw new Error(`${label}에 줄바꿈을 넣을 수 없습니다.`);
  return s;
}

function _encodeHeader(text) {
  const s = _noCrlf(text, "제목");
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function _wrapBase64(buf) {
  return buf.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

// SMTP DATA 본문 직렬화(메시지 전체: 헤더+빈 줄+본문). dot-stuffing은 전송 직전에 적용한다.
function buildMessage({ from, to, subject, text, date = new Date(), messageId }) {
  const fromAddr = _noCrlf(from, "보내는 사람").trim();
  const toAddr = _noCrlf(to, "받는 사람").trim();
  const id = messageId || `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@hr-mail>`;
  const headers = [
    `From: ${fromAddr}`,
    `To: ${toAddr}`,
    `Subject: ${_encodeHeader(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${id}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${_wrapBase64(Buffer.from(String(text || ""), "utf8"))}\r\n`;
}

function _dotStuff(message) {
  return message.replace(/(^|\r\n)\./g, "$1..");
}

// 한 줄/여러 줄 응답을 읽는 얇은 SMTP 세션.
class SmtpSession {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = "";
    this.waiters = [];
    this.closed = false;
    this.error = null;
    this._attach(socket);
  }
  _attach(socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.setTimeout(this.timeoutMs, () => this._fail(new Error("메일 서버 응답 시간이 초과되었습니다.")));
    socket.on("data", chunk => { this.buffer += chunk; this._drain(); });
    socket.on("error", e => this._fail(e));
    socket.on("close", () => this._fail(new Error("메일 서버 연결이 종료되었습니다.")));
  }
  _fail(err) {
    if (this.error) return;
    this.error = err; this.closed = true;
    const ws = this.waiters.splice(0);
    ws.forEach(w => w.reject(err));
  }
  _drain() {
    while (this.waiters.length) {
      const reply = this._takeReply();
      if (!reply) return;
      this.waiters.shift().resolve(reply);
    }
  }
  // 마지막 줄이 "NNN " (하이픈 아님)으로 끝나는 완전한 응답만 꺼낸다.
  _takeReply() {
    const lines = this.buffer.split("\r\n");
    if (lines.length < 2) return null;
    const complete = [];
    for (let i = 0; i < lines.length - 1; i++) {
      complete.push(lines[i]);
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        this.buffer = lines.slice(i + 1).join("\r\n");
        return { code: Number(lines[i].slice(0, 3)), lines: complete };
      }
    }
    return null;
  }
  read() {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this._drain();
    });
  }
  async cmd(line, expect) {
    if (this.error) throw this.error;
    this.socket.write(line + "\r\n");
    const reply = await this.read();
    if (expect && !expect.includes(reply.code)) {
      const e = new Error(`메일 서버가 요청을 거부했습니다(${reply.code}).`);
      e.smtpCode = reply.code;
      throw e;
    }
    return reply;
  }
  async upgradeToTls(host) {
    const raw = this.socket;
    raw.removeAllListeners("data"); raw.removeAllListeners("close"); raw.removeAllListeners("error"); raw.setTimeout(0);
    const secured = tls.connect({ socket: raw, servername: net.isIP(host) ? undefined : host });
    await new Promise((resolve, reject) => { secured.once("secureConnect", resolve); secured.once("error", reject); });
    secured.removeAllListeners("error");
    this.buffer = "";
    this._attach(secured);
  }
  end() { try { this.socket.destroy(); } catch (_) { /* ignore */ } }
}

function _connect(cfg) {
  return new Promise((resolve, reject) => {
    const onErr = e => reject(e);
    const sock = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: net.isIP(cfg.host) ? undefined : cfg.host }, () => { sock.removeListener("error", onErr); resolve(sock); })
      : net.connect({ host: cfg.host, port: cfg.port }, () => { sock.removeListener("error", onErr); resolve(sock); });
    sock.once("error", onErr);
    sock.setTimeout(cfg.timeoutMs, () => { sock.destroy(new Error("메일 서버에 연결하지 못했습니다(시간 초과).")); });
  });
}

// 메일 1통 발송. 성공 시 { ok:true }, 실패는 throw(메시지는 사용자 노출 가능한 안전한 문구).
async function sendMail({ to, subject, text }, env = process.env) {
  const cfg = getMailConfig(env);
  if (!cfg.configured) { const e = new Error("메일 서버가 설정되지 않았습니다."); e.code = "MAIL_NOT_CONFIGURED"; throw e; }
  if (!isValidEmail(to)) { const e = new Error("받는 사람 이메일 형식이 올바르지 않습니다."); e.code = "MAIL_BAD_RECIPIENT"; throw e; }
  const message = buildMessage({ from: cfg.from, to, subject, text });
  const fromAddr = cfg.from.replace(/^.*<([^>]+)>\s*$/, "$1");

  let session;
  try {
    const socket = await _connect(cfg);
    session = new SmtpSession(socket, cfg.timeoutMs);
    const greet = await session.read();
    if (greet.code !== 220) throw new Error("메일 서버가 연결을 받아들이지 않았습니다.");
    let ehlo = await session.cmd("EHLO hr-mailer", [250]);
    let encrypted = cfg.secure;
    const caps = () => ehlo.lines.join("\n").toUpperCase();
    if (!cfg.secure && /STARTTLS/.test(caps())) {
      await session.cmd("STARTTLS", [220]);
      await session.upgradeToTls(cfg.host);
      encrypted = true;
      ehlo = await session.cmd("EHLO hr-mailer", [250]);
    }
    if (cfg.user && cfg.pass) {
      if (!encrypted && !cfg.allowPlainAuth && !_isLoopback(cfg.host)) {
        const e = new Error("암호화되지 않은 연결에서는 인증을 보내지 않습니다."); e.code = "MAIL_INSECURE_AUTH"; throw e;
      }
      const authCaps = caps();
      if (/AUTH[^\n]*PLAIN/.test(authCaps)) {
        const token = Buffer.from(`\0${cfg.user}\0${cfg.pass}`, "utf8").toString("base64");
        await session.cmd(`AUTH PLAIN ${token}`, [235]);
      } else if (/AUTH[^\n]*LOGIN/.test(authCaps)) {
        await session.cmd("AUTH LOGIN", [334]);
        await session.cmd(Buffer.from(cfg.user, "utf8").toString("base64"), [334]);
        await session.cmd(Buffer.from(cfg.pass, "utf8").toString("base64"), [235]);
      } else {
        const e = new Error("메일 서버가 지원하는 인증 방식이 없습니다."); e.code = "MAIL_AUTH_UNSUPPORTED"; throw e;
      }
    }
    await session.cmd(`MAIL FROM:<${fromAddr}>`, [250]);
    await session.cmd(`RCPT TO:<${to.trim()}>`, [250, 251]);
    await session.cmd("DATA", [354]);
    session.socket.write(_dotStuff(message) + ".\r\n");
    const done = await session.read();
    if (done.code !== 250) throw new Error(`메일 서버가 메시지를 거부했습니다(${done.code}).`);
    try { await session.cmd("QUIT"); } catch (_) { /* 이미 닫힘 */ }
    return { ok: true };
  } finally {
    if (session) session.end();
  }
}

module.exports = { sendMail, getMailConfig, publicMailStatus, isValidEmail, buildMessage };
