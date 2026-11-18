"use strict";
const test = require("node:test");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");
const checkPartialFulfillment = require("./support/erp-partial-fulfillment");

test("ERP 부분 출고·입고·반품 — JSON 파일 모드", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const { token } = await bootstrapAdminAndLogin(server, { loginId: "pfadmin", pw: "PartialPassw0rd!" });
  await checkPartialFulfillment(server.baseUrl, token, "pfjson");
});

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("ERP 부분 출고·입고·반품 — PostgreSQL (skipped: no test DB)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");
  test("ERP 부분 출고·입고·반품 — PostgreSQL", async t => {
    const dbName = `hrtest_erp_partial_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const base = ADMIN_DATABASE_URL.replace(/\/[^/]*(\?.*)?$/, "");
    const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    let server;
    t.after(async () => {
      try {
        if (server) await server.stop();
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [dbName]);
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally { await admin.end(); }
    });
    server = await startServer({ env: { DATABASE_URL: `${base}/${dbName}` } });
    const response = await fetch(server.baseUrl + "/api/companies/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: "부분처리 회사", adminName: "관리자", loginId: "pf_admin", password: "AdminPassw0rd1" }),
    });
    const body = await response.json();
    if (!body.ok) throw new Error(JSON.stringify(body));
    await checkPartialFulfillment(server.baseUrl, body.token, "pfpg");
  });
}
