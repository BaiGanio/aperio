// tests/mockDb.js
// Shared pg.Pool mock used across tool and store tests.
// Import resetMockDb() in beforeEach to isolate each test.
// Import lastCall() to assert on the most recent query.

let mockRows = [];
let mockRowCount = 0;
let lastQuery = null;
let lastParams = null;

export const mockDb = {
  query(sql, params = []) {
    lastQuery = sql;
    lastParams = params;
    return Promise.resolve({ rows: mockRows, rowCount: mockRowCount });
  },
};

/**
 * Seed the mock for the next query and reset call tracking.
 * Call this in beforeEach or at the top of each test.
 *
 * @param {object[]} rows     - Rows the mock query should return.
 * @param {number}   rowCount - rowCount the mock query should return.
 */
export function resetMockDb(rows = [], rowCount = rows.length) {
  mockRows = rows;
  mockRowCount = rowCount;
  lastQuery = null;
  lastParams = null;
}

/**
 * Returns the SQL string and params array from the most recent query call.
 * Useful for asserting that the right query was built without coupling to
 * specific parameter indices.
 *
 * @returns {{ sql: string|null, params: any[]|null }}
 */
export function lastCall() {
  return { sql: lastQuery, params: lastParams };
}