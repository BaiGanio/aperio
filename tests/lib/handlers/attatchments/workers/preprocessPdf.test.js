// tests/lib/handlers/attatchments/workers/preprocessPdf.test.js
// Tests for extractPdfText in lib/handlers/attachments/workers/preprocessPdf.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractPdfText } from "../../../../../lib/handlers/attachments/workers/preprocessPdf.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockPdf({ pages = [], title = "" } = {}) {
  return {
    promise: Promise.resolve({
      numPages: pages.length,
      getMetadata: async () => ({ info: { Title: title } }),
      getPage: async (i) => ({
        getTextContent: async () => ({
          items: pages[i - 1] != null ? [{ str: pages[i - 1] }] : [],
        }),
      }),
    }),
  };
}

function mockGetDocument(fixture) {
  return () => fixture;
}

const richText = "This page has rich extractable text content that easily exceeds the thirty character minimum threshold.";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("extractPdfText", () => {
  test("extracts text from a single-page PDF", async () => {
    const result = await extractPdfText(
      Buffer.from("fake"),
      { _getDocument: mockGetDocument(makeMockPdf({ pages: [richText], title: "Test Doc" })) }
    );

    assert.equal(result.type, "text");
    assert.ok(result.text.includes("rich extractable text"));
    assert.equal(result.pageCount, 1);
    assert.deepEqual(result.scannedPages, []);
    assert.equal(result.title, "Test Doc");
    assert.equal(result.truncated, false);
  });

  test("detects a scanned page when text is too sparse", async () => {
    const result = await extractPdfText(
      Buffer.from("fake"),
      { _getDocument: mockGetDocument(makeMockPdf({ pages: ["short"] })) }
    );

    assert.equal(result.type, "scanned");
    assert.deepEqual(result.scannedPages, [1]);
    assert.equal(result.pageCount, 1);
  });

  test("returns type 'empty' when PDF has no pages", async () => {
    const result = await extractPdfText(
      Buffer.from("fake"),
      { _getDocument: mockGetDocument(makeMockPdf({ pages: [] })) }
    );

    assert.equal(result.type, "empty");
    assert.equal(result.text, "");
    assert.equal(result.pageCount, 0);
  });

  test("returns type 'mixed' when some pages are scanned and some have text", async () => {
    const result = await extractPdfText(
      Buffer.from("fake"),
      { _getDocument: mockGetDocument(makeMockPdf({ pages: [richText, "tiny", richText] })) }
    );

    assert.equal(result.type, "mixed");
    assert.deepEqual(result.scannedPages, [2]);
    assert.equal(result.pageCount, 3);
  });

  test("identifies all scanned pages by 1-based index", async () => {
    const result = await extractPdfText(
      Buffer.from("fake"),
      { _getDocument: mockGetDocument(makeMockPdf({ pages: ["x", richText, "y", richText, "z"] })) }
    );

    assert.equal(result.type, "mixed");
    assert.deepEqual(result.scannedPages, [1, 3, 5]);
  });

  test("truncates text exceeding 80,000 characters and sets truncated flag", async () => {
    const bigPage = "A".repeat(90_000);
    const result = await extractPdfText(
      Buffer.from("fake"),
      { _getDocument: mockGetDocument(makeMockPdf({ pages: [bigPage] })) }
    );

    assert.equal(result.truncated, true);
    assert.equal(result.text.length, 80_000);
  });

  test("does not set truncated flag when text fits within limit", async () => {
    const result = await extractPdfText(
      Buffer.from("fake"),
      { _getDocument: mockGetDocument(makeMockPdf({ pages: [richText] })) }
    );

    assert.equal(result.truncated, false);
    assert.ok(result.text.length < 80_000);
  });

  test("joins multiple pages with double newlines", async () => {
    const page1 = "First page text that is long enough to exceed the minimum threshold check.";
    const page2 = "Second page text that is long enough to exceed the minimum threshold check.";
    const result = await extractPdfText(
      Buffer.from("fake"),
      { _getDocument: mockGetDocument(makeMockPdf({ pages: [page1, page2] })) }
    );

    assert.ok(result.text.includes("\n\n"));
    assert.ok(result.text.includes("First page"));
    assert.ok(result.text.includes("Second page"));
  });

  test("returns empty title when metadata has no Title field", async () => {
    const fixture = {
      promise: Promise.resolve({
        numPages: 1,
        getMetadata: async () => ({ info: {} }),
        getPage: async () => ({
          getTextContent: async () => ({ items: [{ str: richText }] }),
        }),
      }),
    };

    const result = await extractPdfText(Buffer.from("fake"), { _getDocument: () => fixture });

    assert.equal(result.title, "");
  });

  test("handles metadata fetch failure gracefully", async () => {
    const fixture = {
      promise: Promise.resolve({
        numPages: 1,
        getMetadata: async () => { throw new Error("no metadata"); },
        getPage: async () => ({
          getTextContent: async () => ({ items: [{ str: richText }] }),
        }),
      }),
    };

    const result = await extractPdfText(Buffer.from("fake"), { _getDocument: () => fixture });

    assert.equal(result.title, "");
  });

  test("ignores items without a str property", async () => {
    const fixture = {
      promise: Promise.resolve({
        numPages: 1,
        getMetadata: async () => ({ info: { Title: "" } }),
        getPage: async () => ({
          getTextContent: async () => ({
            items: [
              { str: "Real text that is long enough to pass the threshold here." },
              { notStr: "ignored" },
              { str: " more text" },
            ],
          }),
        }),
      }),
    };

    const result = await extractPdfText(Buffer.from("fake"), { _getDocument: () => fixture });

    assert.equal(result.type, "text");
    assert.ok(result.text.includes("Real text"));
    assert.ok(!result.text.includes("ignored"));
  });

  test("throws when PDF cannot be parsed", async () => {
    const fixture = { promise: Promise.reject(new Error("invalid PDF structure")) };

    await assert.rejects(
      () => extractPdfText(Buffer.from("bad"), { _getDocument: () => fixture }),
      /PDF could not be parsed/
    );
  });
});
