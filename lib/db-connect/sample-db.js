// lib/db-connect/sample-db.js
//
// A disposable "practice shop" SQLite database for non-technical users. The
// databases tour (docs/tours/databases.html) walks through real questions like
// "how many customers signed up last month" — but a brand-new user has no data
// to ask them against, and pointing Aperio at a real database to learn is how
// accidents happen. This builds a self-contained sample so every prompt in the
// tour just works, and registers two connections so the read-only vs writable
// behaviour can be felt firsthand:
//   • sample     — read-only (the safe default)
//   • sample-rw  — writable (to rehearse the confirm-before-write flow)
// Both point at the same file, which lives next to the app's own SQLite store
// and can be wiped + rebuilt at any time from the Databases panel.

import Database from "better-sqlite3";
import { existsSync, mkdirSync, rmSync } from "fs";
import { dirname, resolve } from "path";
import { SETTINGS_KEY, saveConnections } from "./registry.js";

export const SAMPLE_RO = "sample";
export const SAMPLE_RW = "sample-rw";

/** Absolute path of the sample file — alongside the app's own aperio.db. */
export function sampleDbPath() {
  const base = process.env.SQLITE_PATH || "./.sqlite/aperio.db";
  return resolve(dirname(base), "sample-shop.db");
}

/** The two connection configs that front the sample file. */
function sampleConnections() {
  const file = sampleDbPath();
  return [
    { name: SAMPLE_RO, engine: "sqlite", file, readOnly: true, sample: true },
    { name: SAMPLE_RW, engine: "sqlite", file, readOnly: false, sample: true },
  ];
}

// ── Seed data (dates are relative to "now" so "last month"/"this quarter"
//    stay correct whenever the sample is built) ───────────────────────────────

const now = new Date();
const stamp = (d) => d.toISOString().slice(0, 19).replace("T", " ");
const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return stamp(d); };
// Mid-month, n whole months back: monthsAgo(1) ⇒ last month, monthsAgo(2) ⇒ the month before.
const monthsAgo = (n) => stamp(new Date(now.getFullYear(), now.getMonth() - n, 15, 12, 0, 0));

const CUSTOMERS = [
  "Ava Reyes", "Noah Patel", "Mia Chen", "Liam Novak", "Sofia Rossi",
  "Ethan Brooks", "Olivia Haddad", "Lucas Meyer", "Emma Tanaka", "Daniel Okoro",
  "Grace Lindqvist", "Ben Schneider", "Zoe Alvarez", "Hugo Marchetti",
].map((name, i) => ({
  id: i + 1,
  name,
  email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
  // Spread signups: a few last month, a few the month before, the rest older.
  signed_up: i < 4 ? monthsAgo(1) : i < 8 ? monthsAgo(2) : monthsAgo(3 + (i % 9)),
}));

// Last three are intentionally never sold (for the "which products have never
// been sold?" prompt).
const PRODUCTS = [
  "Aurora Desk Lamp", "Tidal Water Bottle", "Nimbus Hoodie", "Pixel Notebook",
  "Ember Travel Mug", "Drift Tote Bag", "Halo Earbuds", "Cedar Phone Stand",
  "Lumen Wall Clock", "Verdant Plant Pot",
].map((name, i) => ({
  id: i + 1,
  name,
  price: 9.5 + i * 6.25,
  added_on: monthsAgo(2 + (i % 8)),
}));
const NEVER_SOLD = new Set([8, 9, 10]); // Cedar Phone Stand, Lumen Wall Clock, Verdant Plant Pot

const STATUSES = ["paid", "shipped", "paid", "delivered", "paid", "shipped"];

// 24 orders, ids 4801..4824, so the tour's "order #4821" is a real, refundable
// row. Each gets 1–3 line items drawn from the sellable products.
function buildOrders() {
  const sellable = PRODUCTS.filter((p) => !NEVER_SOLD.has(p.id));
  const orders = [];
  const items = [];
  let itemId = 1;
  for (let k = 0; k < 24; k++) {
    const id = 4801 + k;
    const customerId = (k % CUSTOMERS.length) + 1;
    const ordered_at = daysAgo((k * 7) % 175); // spread across ~6 months
    const lineCount = (k % 3) + 1;
    let total = 0;
    for (let j = 0; j < lineCount; j++) {
      const product = sellable[(k + j) % sellable.length];
      const quantity = ((k + j) % 3) + 1;
      const unit_price = Number(product.price.toFixed(2));
      total += unit_price * quantity;
      items.push({ id: itemId++, order_id: id, product_id: product.id, quantity, unit_price });
    }
    orders.push({
      id,
      customer_id: customerId,
      status: STATUSES[k % STATUSES.length], // none start "refunded"
      total: Number(total.toFixed(2)),
      ordered_at,
    });
  }
  return { orders, items };
}

function seed(db) {
  db.exec(`
    CREATE TABLE customers (
      id        INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      email     TEXT NOT NULL,
      signed_up TEXT NOT NULL
    );
    CREATE TABLE products (
      id       INTEGER PRIMARY KEY,
      name     TEXT NOT NULL,
      price    REAL NOT NULL,
      added_on TEXT NOT NULL
    );
    CREATE TABLE orders (
      id          INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      status      TEXT NOT NULL,
      total       REAL NOT NULL,
      ordered_at  TEXT NOT NULL
    );
    CREATE TABLE order_items (
      id         INTEGER PRIMARY KEY,
      order_id   INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity   INTEGER NOT NULL,
      unit_price REAL NOT NULL
    );
  `);

  const { orders, items } = buildOrders();
  const insC = db.prepare("INSERT INTO customers (id,name,email,signed_up) VALUES (?,?,?,?)");
  const insP = db.prepare("INSERT INTO products (id,name,price,added_on) VALUES (?,?,?,?)");
  const insO = db.prepare("INSERT INTO orders (id,customer_id,status,total,ordered_at) VALUES (?,?,?,?,?)");
  const insI = db.prepare("INSERT INTO order_items (id,order_id,product_id,quantity,unit_price) VALUES (?,?,?,?,?)");

  db.transaction(() => {
    for (const c of CUSTOMERS) insC.run(c.id, c.name, c.email, c.signed_up);
    for (const p of PRODUCTS) insP.run(p.id, p.name, Number(p.price.toFixed(2)), p.added_on);
    for (const o of orders) insO.run(o.id, o.customer_id, o.status, o.total, o.ordered_at);
    for (const it of items) insI.run(it.id, it.order_id, it.product_id, it.quantity, it.unit_price);
  })();
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Build (or rebuild) the sample file fresh and register both connections. */
export async function createSampleDatabase(store) {
  const file = sampleDbPath();
  mkdirSync(dirname(file), { recursive: true });
  removeFile(file); // deterministic rebuild — the sample is disposable

  const db = new Database(file);
  try {
    db.pragma("journal_mode = WAL");
    seed(db);
  } finally {
    db.close();
  }

  const list = (await store.getSetting(SETTINGS_KEY)) || [];
  const kept = list.filter((c) => c.name !== SAMPLE_RO && c.name !== SAMPLE_RW);
  return saveConnections(store, [...kept, ...sampleConnections()]);
}

/** Drop both connections and delete the file — resets the workbench. */
export async function deleteSampleDatabase(store) {
  const list = (await store.getSetting(SETTINGS_KEY)) || [];
  const kept = list.filter((c) => c.name !== SAMPLE_RO && c.name !== SAMPLE_RW);
  if (kept.length !== list.length) await saveConnections(store, kept);
  removeFile(sampleDbPath());
}

function removeFile(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    if (existsSync(f)) rmSync(f);
  }
}
