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

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    console.error("[DB] Unexpected client error:", err.message);
  });

  module.exports = pool;
}
