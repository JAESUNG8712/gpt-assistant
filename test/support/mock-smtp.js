"use strict";
// 테스트용 최소 SMTP 서버(평문). 받은 메시지·인증 정보를 모아 두고, 일부 동작을 실패시킬 수 있다.
const net = require("net");

function startMockSmtp(opts = {}) {
  const received = [];
  const state = { rejectRcpt: !!opts.rejectRcpt, authMethods: opts.authMethods || "PLAIN LOGIN", requireAuth: !!opts.requireAuth };
  const server = net.createServer(socket => {
    socket.setEncoding("utf8");
    let buf = "", mode = "cmd", data = "", cur = { auth: null, from: null, to: [] }, loginStep = null;
    const send = line => socket.write(line + "\r\n");
    send("220 mock-smtp ready");
    socket.on("data", chunk => {
      buf += chunk;
      for (;;) {
        if (mode === "data") {
          const end = buf.indexOf("\r\n.\r\n");
          if (end === -1) return;
          data = buf.slice(0, end + 2); buf = buf.slice(end + 5);
          received.push({ ...cur, raw: data });
          cur = { auth: cur.auth, from: null, to: [] }; mode = "cmd";
          send("250 queued");
          continue;
        }
        const idx = buf.indexOf("\r\n");
        if (idx === -1) return;
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (loginStep) {
          const val = Buffer.from(line, "base64").toString("utf8");
          if (loginStep === "user") { cur.auth = { user: val }; loginStep = "pass"; send("334 UGFzc3dvcmQ6"); }
          else { cur.auth.pass = val; loginStep = null; send("235 ok"); }
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith("EHLO")) { socket.write(`250-mock\r\n250-AUTH ${state.authMethods}\r\n250 8BITMIME\r\n`); }
        else if (up.startsWith("AUTH PLAIN")) {
          const [, user, pass] = Buffer.from(line.slice(11), "base64").toString("utf8").split("\0");
          cur.auth = { user, pass }; send("235 ok");
        } else if (up === "AUTH LOGIN") { loginStep = "user"; send("334 VXNlcm5hbWU6"); }
        else if (up.startsWith("MAIL FROM:")) {
          if (state.requireAuth && !cur.auth) { send("530 auth required"); continue; }
          cur.from = line.slice(10).replace(/[<>]/g, ""); send("250 ok");
        } else if (up.startsWith("RCPT TO:")) {
          if (state.rejectRcpt) { send("550 no such user"); continue; }
          cur.to.push(line.slice(8).replace(/[<>]/g, "")); send("250 ok");
        } else if (up === "DATA") { mode = "data"; send("354 go"); }
        else if (up === "QUIT") { send("221 bye"); socket.end(); }
        else send("500 unknown");
      }
    });
    socket.on("error", () => {});
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => resolve({
      port: server.address().port, received, state,
      stop: () => new Promise(r => { server.close(() => r()); server.closeAllConnections && server.closeAllConnections(); }),
    }));
  });
}

// DATA 본문(헤더+base64 본문)에서 제목·본문을 복원한다.
function parseMessage(raw) {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const body = Buffer.from(rest.join("\r\n\r\n").replace(/\r\n/g, ""), "base64").toString("utf8");
  const subjectLine = (head.match(/^Subject: (.*)$/m) || [])[1] || "";
  const m = subjectLine.match(/^=\?UTF-8\?B\?(.*)\?=$/);
  const subject = m ? Buffer.from(m[1], "base64").toString("utf8") : subjectLine;
  return { head, subject, body };
}

module.exports = { startMockSmtp, parseMessage };
