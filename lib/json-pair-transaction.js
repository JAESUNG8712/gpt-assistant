"use strict";
const fs = require("node:fs");

// Single-process JSON mode only. The journal contains pre-images, never paths.
// A surviving journal means rollback, including a crash between file replacements.
function recoverJsonPair(paths, journal, writeAtomic) {
  if (!fs.existsSync(journal)) return false;
  const record = JSON.parse(fs.readFileSync(journal, "utf8"));
  if (record.version !== 1 || !Array.isArray(record.before) || record.before.length !== paths.length ||
      record.before.some(value => value !== null && typeof value !== "string")) {
    throw new Error("Invalid ERP/accounting recovery journal");
  }
  for (const value of record.before) if (value !== null) JSON.parse(value);
  for (let i = 0; i < paths.length; i++) {
    if (record.before[i] === null) {
      if (fs.existsSync(paths[i])) fs.unlinkSync(paths[i]);
    } else writeAtomic(paths[i], record.before[i]);
  }
  fs.unlinkSync(journal);
  return true;
}

function commitJsonPair(paths, journal, next, writeAtomic) {
  if (fs.existsSync(journal)) throw new Error("ERP/accounting recovery is required before another write");
  if (paths.length !== next.length) throw new Error("Invalid ERP/accounting transaction");
  const before = paths.map(file => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  for (const value of before) if (value !== null) JSON.parse(value);
  const content = next.map(value => JSON.stringify(value, null, 2));
  writeAtomic(journal, JSON.stringify({ version: 1, before }));
  try {
    for (let i = 0; i < paths.length; i++) writeAtomic(paths[i], content[i]);
    fs.unlinkSync(journal);
  } catch (error) {
    try { recoverJsonPair(paths, journal, writeAtomic); }
    catch (recoveryError) { error.recoveryError = recoveryError; }
    // Memory is published by the caller only after this function succeeds.
    throw error;
  }
}
module.exports = { commitJsonPair, recoverJsonPair };
