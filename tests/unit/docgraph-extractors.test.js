// tests/lib/docgraph/extractors.test.js
// Phase 3 extractors: HTML (pure string), DOCX (real fixture via the `docx`
// lib → mammoth), PDF (real fixture via pdf-lib → pdfjs-dist). Each asserts the
// shared shape { title, sections, refs } with heading-based sectioning.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { extract as extractHtml } from "../../lib/docgraph/extract-html.js";
import { extract as extractDocx } from "../../lib/docgraph/extract-docx.js";
import { extract as extractPdf } from "../../lib/docgraph/extract-pdf.js";
import { extract as extractXlsx } from "../../lib/docgraph/extract-xlsx.js";
import { extract as extractPptx } from "../../lib/docgraph/extract-pptx.js";
import { extract as extractEml } from "../../lib/docgraph/extract-eml.js";

describe("extract-html", () => {
  test("sections on h1–h6, strips tags/entities, nests by level", async () => {
    const html = `
      <html><head><title>My Page</title></head><body>
        <p>Intro &amp; preamble.</p>
        <h1>Overview</h1><p>Top level.</p>
        <h2>Details</h2><p>Nested &lt;detail&gt;.</p>
        <script>ignore()</script>
      </body></html>`;
    const { title, sections } = await extractHtml(html, "page.html");
    assert.equal(title, "My Page");

    const byHeading = Object.fromEntries(sections.filter(s => s.heading).map(s => [s.heading, s]));
    assert.equal(byHeading["Details"].level, 2);
    assert.equal(byHeading["Details"].parentLocalId, byHeading["Overview"].localId);
    assert.match(byHeading["Details"].text, /Nested <detail>\./); // entities decoded
    assert.ok(!/ignore\(\)/.test(JSON.stringify(sections)), "script content stripped");

    const preamble = sections.find(s => s.level === 0);
    assert.match(preamble.text, /Intro & preamble/);
  });
});

describe("extract-docx", () => {
  test("Word heading styles become sections", async () => {
    const { Document, Packer, Paragraph, HeadingLevel } = await import("docx");
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ text: "Project Plan", heading: HeadingLevel.HEADING_1 }),
          new Paragraph("Opening summary of the plan."),
          new Paragraph({ text: "Timeline", heading: HeadingLevel.HEADING_2 }),
          new Paragraph("Ship in Q3."),
        ],
      }],
    });
    const buffer = await Packer.toBuffer(doc);

    const { sections } = await extractDocx(buffer, "plan.docx");
    const headings = sections.filter(s => s.heading).map(s => s.heading);
    assert.ok(headings.includes("Project Plan"), `got ${headings}`);
    assert.ok(headings.includes("Timeline"), `got ${headings}`);
    const timeline = sections.find(s => s.heading === "Timeline");
    assert.match(timeline.text, /Ship in Q3/);
  });
});

describe("extract-pdf", () => {
  test("one section per page; page text extracted", async () => {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const p1 = pdf.addPage([400, 400]);
    p1.drawText("Quarterly report covering marketing and engineering spend.", { x: 20, y: 350, size: 11, font });
    const p2 = pdf.addPage([400, 400]);
    p2.drawText("Second page about vector embeddings and semantic search recall.", { x: 20, y: 350, size: 11, font });
    const bytes = await pdf.save();

    const { title, sections, summary } = await extractPdf(Buffer.from(bytes), "report.pdf");
    assert.ok(typeof title === "string");
    assert.equal(sections.length, 2, "two text pages → two sections");
    assert.deepEqual(sections.map(s => s.heading), ["Page 1", "Page 2"]);
    assert.match(sections[0].text, /marketing/i);
    assert.match(sections[1].text, /embeddings/i);
    assert.equal(summary, null, "no scanned pages → no summary");
  });
});

describe("extract-xlsx", () => {
  test("one section per sheet; rows keep label+value together", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Budget");
    sheet.addRow(["Category", "Amount"]);
    sheet.addRow(["Marketing", 5000]);
    sheet.addRow(["Engineering", 12000]);
    const buffer = await wb.xlsx.writeBuffer();

    const { sections } = await extractXlsx(buffer, "q3.xlsx");
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, "Budget");
    assert.match(sections[0].text, /Marketing \| 5000/);
    assert.match(sections[0].text, /Engineering \| 12000/);
  });
});

describe("extract-pptx", () => {
  test("one section per slide with slide text", async () => {
    const PptxGenJS = (await import("pptxgenjs")).default;
    const p = new PptxGenJS();
    const s1 = p.addSlide();
    s1.addText("Quarterly Review", { x: 1, y: 1, w: 8, h: 1 });
    const s2 = p.addSlide();
    s2.addText("Marketing grew this quarter", { x: 1, y: 1, w: 8, h: 1 });
    const buffer = await p.write({ outputType: "nodebuffer" });

    const { sections } = await extractPptx(buffer, "deck.pptx");
    assert.equal(sections.length, 2);
    assert.deepEqual(sections.map(s => s.heading), ["Slide 1", "Slide 2"]);
    assert.match(sections[0].text, /Quarterly Review/);
    assert.match(sections[1].text, /Marketing grew/);
  });
});

describe("extract-eml", () => {
  test("decodes encoded-word subject and quoted-printable body", async () => {
    const eml = [
      "From: Alice <alice@example.com>",
      "To: bob@example.com",
      "Subject: =?utf-8?Q?Q3_Budget_Review?=",
      "Date: Mon, 1 Jun 2026 10:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Marketing spend rose by 20=25 this quarter.",
    ].join("\r\n");

    const { title, sections } = await extractEml(eml, "mail.eml");
    assert.equal(title, "Q3 Budget Review");
    assert.equal(sections.length, 1);
    assert.match(sections[0].text, /From: Alice/);
    assert.match(sections[0].text, /Marketing spend rose by 20% this quarter\./);
  });

  test("extracts text/plain from a multipart/alternative body", async () => {
    const eml = [
      "Subject: Multipart test",
      'Content-Type: multipart/alternative; boundary="BND"',
      "",
      "--BND",
      "Content-Type: text/plain",
      "",
      "Plain version here.",
      "--BND",
      "Content-Type: text/html",
      "",
      "<p>HTML <b>version</b></p>",
      "--BND--",
    ].join("\r\n");

    const { sections } = await extractEml(eml, "mp.eml");
    assert.match(sections[0].text, /Plain version here\./);
    assert.ok(!/<p>/.test(sections[0].text), "did not include raw HTML when plain text exists");
  });
});
