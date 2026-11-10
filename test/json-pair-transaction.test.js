"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { getTestTempRoot } = require("./support/start-server");
const { commitJsonPair, recoverJsonPair } = require("../lib/json-pair-transaction");

test("paired JSON files commit together, rollback failures, and recover interrupted commits", t => {
  const dir = fs.mkdtempSync(path.join(getTestTempRoot(), "pair-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = [path.join(dir, "erp.json"), path.join(dir, "accounting.json")];
  const journal = path.join(dir, "journal.json");
  const write = (file, content) => { fs.writeFileSync(file + ".tmp", content); fs.renameSync(file + ".tmp", file); };
  const before = [{ status: "ordered" }, { invoices: [] }];
  const next = [{ status: "received" }, { invoices: ["invoice1"] }];
  before.forEach((value, i) => write(files[i], JSON.stringify(value)));
  let fail = true;
  assert.throws(() => commitJsonPair(files, journal, next, (file, content) => {
    if (file === files[1] && fail) { fail = false; throw new Error("disk write failure"); }
    write(file, content);
  }), /disk write failure/);
  assert.deepEqual(files.map(f => JSON.parse(fs.readFileSync(f))), before);
  assert.equal(fs.existsSync(journal), false);
  commitJsonPair(files, journal, next, write);
  assert.deepEqual(files.map(f => JSON.parse(fs.readFileSync(f))), next);
  assert.equal(fs.existsSync(journal), false);

  // Simulate process death after replacing only the first file.
  write(journal, JSON.stringify({ version: 1, before: before.map(JSON.stringify) }));
  write(files[0], JSON.stringify(next[0]));
  write(files[1], JSON.stringify(before[1]));
  assert.equal(recoverJsonPair(files, journal, write), true);
  assert.deepEqual(files.map(f => JSON.parse(fs.readFileSync(f))), before);
  assert.equal(recoverJsonPair(files, journal, write), false);

  // Incomplete rollback keeps the journal and prevents a new transaction.
  write(journal, JSON.stringify({ version: 1, before: before.map(JSON.stringify) }));
  assert.throws(() => recoverJsonPair(files, journal, () => { throw Error("still unavailable"); }));
  assert.equal(fs.existsSync(journal), true);
  assert.throws(() => commitJsonPair(files, journal, next, write), /recovery is required/);
  assert.equal(recoverJsonPair(files, journal, write), true);
});
