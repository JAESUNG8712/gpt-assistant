// db.js — PostgreSQL pool (only loaded when DATABASE_URL is set)
// When DATABASE_URL is absent, server.js uses JSON file storage instead.

if (!process.env.DATABASE_URL) {
  // No database configured — return a dummy pool so imports don't crash.
  // server.js detects USE_JSON_FILE and never actually calls these methods.
  module.exports = {
    query:   () => Promise.reject(new Error("No DATABASE_URL — running in file mode")),
    connect: () => Promise.reject(new Error("No DATABASE_URL — running in file mode")),
    on:      () => {},
  };
} else {
  const { Pool } = require("pg");
  // GitHub Actions의 services: postgres와 로컬 PostgreSQL은 보통 TLS를 제공하지
  // 않는다. 기존처럼 모든 DATABASE_URL에 ssl을 강제하면 "The server does not
  // support SSL connections"로 서버가 부팅하지 못한다. 운영 DB가 TLS를 요구할 때만
  // URL의 ?sslmode=require 또는 PGSSLMODE=require로 명시적으로 활성화한다.
  const parsedUrl = new URL(process.env.DATABASE_URL);
  const sslMode = String(process.env.PGSSLMODE || parsedUrl.searchParams.get("sslmode") || "").toLowerCase();
  const useSsl = ["require", "verify-ca", "verify-full"].includes(sslMode);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    console.error("[DB] Unexpected client error:", err.message);
  });

  module.exports = pool;
}
