import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from "docx";
import JSZip from "jszip";

import { previewDocumentArtifact } from "../../../lib/helpers/documentPreview.js";

function documentFixture(name = "report.docx") {
  const root = mkdtempSync(join(tmpdir(), "aperio-doc-preview-"));
  const path = join(root, name);
  writeFileSync(path, "docx bytes");
  return { root, path };
}

describe("previewDocumentArtifact", () => {
  test("previews a real generated DOCX with paragraphs and tables", async () => {
    const { root, path } = documentFixture("real.docx");
    const document = new Document({
      sections: [{ children: [
        new Paragraph("Quarterly report"),
        new Table({ rows: [new TableRow({ children: [
          new TableCell({ children: [new Paragraph("Revenue")] }),
          new TableCell({ children: [new Paragraph("42") ] }),
        ] })] }),
      ] }],
    });
    writeFileSync(path, await Packer.toBuffer(document));

    const preview = await previewDocumentArtifact("/scratch/session-123/real.docx", {
      root,
      resolveArtifact: () => path,
    });

    assert.match(preview.html, /<p>Quarterly report<\/p>/);
    assert.match(preview.html, /<table>/);
    assert.match(preview.html, /<td><p>Revenue<\/p><\/td>/);
    assert.match(preview.html, /<td><p>42<\/p><\/td>/);
  });

  test("converts a bounded generated DOCX and sanitizes active content", async () => {
    const { root, path } = documentFixture();
    let receivedBuffer;
    const preview = await previewDocumentArtifact("/scratch/session-123/report.docx", {
      root,
      resolveArtifact: () => path,
      // The fixture is plain text, not a real ZIP — checkDocxBounds is stubbed
      // out here because this test is exercising sanitization, not the DOCX
      // zip-bomb bound (that has its own dedicated tests below).
      checkDocxBounds: async () => {},
      convertToHtml: async ({ buffer }) => {
        receivedBuffer = buffer;
        return {
          value: '<h1>Report</h1><p>Hello <strong>world</strong>.</p><script>alert(1)</script><a href="javascript:alert(2)">bad link</a>',
          messages: [{ message: "A conversion warning" }],
        };
      },
    });

    assert.equal(receivedBuffer.toString(), "docx bytes");
    assert.equal(preview.path, path);
    assert.match(preview.html, /<h1>Report<\/h1>/);
    assert.match(preview.html, /<strong>world<\/strong>/);
    assert.doesNotMatch(preview.html, /<script|javascript:/i);
    assert.deepEqual(preview.warnings, ["A conversion warning"]);
  });

  test("rejects non-DOCX artifacts before conversion", async () => {
    await assert.rejects(
      previewDocumentArtifact("/scratch/session-123/report.pdf", {
        resolveArtifact: () => { throw new Error("must not resolve"); },
      }),
      error => error.status === 415 && /docx/i.test(error.message),
    );
  });

  test("turns malformed documents into a stable preview error", async () => {
    const { root, path } = documentFixture();
    await assert.rejects(
      previewDocumentArtifact("/scratch/session-123/report.docx", {
        root,
        resolveArtifact: () => path,
        checkDocxBounds: async () => {},
        convertToHtml: async () => { throw new Error("broken zip"); },
      }),
      error => error.status === 422 && /could not be parsed/i.test(error.message),
    );
  });

  // Review round 5, P2: the compressed-file-size check alone doesn't bound
  // what a crafted DOCX can expand to once unzipped — a small archive can
  // declare huge or numerous entries. previewDocumentArtifact must refuse
  // those before Mammoth ever inflates them, not just report a parse error
  // after the fact. Both cases below use the REAL default checkDocxBounds
  // (no stubbing) against a genuinely-generated archive, so this fails if the
  // bound is ever weakened or bypassed.
  describe("zip-bomb bound (review round 5, P2)", () => {
    test("rejects an archive whose declared uncompressed size vastly exceeds its on-disk size", async () => {
      const { root, path } = documentFixture();
      const zip = new JSZip();
      // Highly compressible content: ~60 KB on disk, but declares 60 MB
      // uncompressed in the central directory — the same shape a real
      // zip-bomb DOCX would have.
      zip.file("word/document.xml", "a".repeat(60 * 1024 * 1024), { compression: "DEFLATE" });
      writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));

      await assert.rejects(
        previewDocumentArtifact("/scratch/session-123/report.docx", {
          root,
          resolveArtifact: () => path,
          convertToHtml: async () => { throw new Error("must not be reached — bound check must reject first"); },
        }),
        error => error.status === 413 && /expands beyond/i.test(error.message),
      );
    });

    test("rejects an archive with an excessive number of entries", async () => {
      const { root, path } = documentFixture();
      const zip = new JSZip();
      for (let i = 0; i < 2001; i++) zip.file(`part/${i}.xml`, "x");
      writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));

      await assert.rejects(
        previewDocumentArtifact("/scratch/session-123/report.docx", {
          root,
          resolveArtifact: () => path,
          convertToHtml: async () => { throw new Error("must not be reached — bound check must reject first"); },
        }),
        error => error.status === 413 && /too many entries/i.test(error.message),
      );
    });

    test("a normal-sized real DOCX still passes the bound check", async () => {
      const { root, path } = documentFixture();
      const document = new Document({ sections: [{ children: [new Paragraph("fine")] }] });
      writeFileSync(path, await Packer.toBuffer(document));

      const preview = await previewDocumentArtifact("/scratch/session-123/report.docx", {
        root,
        resolveArtifact: () => path,
        convertToHtml: async ({ buffer }) => ({ value: "<p>fine</p>", messages: [] }),
      });

      assert.match(preview.html, /<p>fine<\/p>/);
    });
  });
});
