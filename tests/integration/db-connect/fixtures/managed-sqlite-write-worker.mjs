// tests/integration/db-connect/fixtures/managed-sqlite-write-worker.mjs
//
// A standalone child-process worker for the cross-process file-lock
// regression test (extraction-encryption.test.js). Run as a genuinely
// separate `node` process — not an async task inside the test process — so
// the test exercises real inter-process contention on the SAME managed
// file, exactly the scenario the review finding described (several MCP
// processes, or Postgres multi-agent, targeting one profile's extraction db
// at once).
//
// Usage: node managed-sqlite-write-worker.mjs <file> <value>
// Writes one row, holding the file open for a short deliberate delay between
// open and close so two workers started around the same time are very
// likely to overlap mid-critical-section — maximizing the chance an absent
// or broken lock would manifest as a lost write or a locking error.

import { openManagedSqlite } from "../../../../lib/db-connect/drivers/managed-sqlite.js";

const [, , file, valueStr] = process.argv;
const keyBuf = Buffer.alloc(32, 0x11); // fixed test key — never touches the OS keychain

const driver = await openManagedSqlite({ file, readOnly: false, keyBuf });
try {
  driver.db.exec("CREATE TABLE IF NOT EXISTS t (n INTEGER)");
  driver.db.prepare("INSERT INTO t (n) VALUES (?)").run(Number(valueStr));
  await new Promise((resolve) => setTimeout(resolve, 150));
} finally {
  driver.close();
}
