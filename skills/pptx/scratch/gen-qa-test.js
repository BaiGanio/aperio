import PptxGenJS from "pptxgenjs";

const prs = new PptxGenJS();
prs.defineLayout({ name: "LAYOUT1", width: 10, height: 7.5 });
prs.defineLayout({ name: "LAYOUT2", width: 10, height: 7.5 });

// Slide 1: Title slide
const slide1 = prs.addSlide("LAYOUT1");
slide1.background = { color: "1E2761" };
slide1.addText("Aperio QA Test", {
  x: 0.5,
  y: 3,
  w: 9,
  h: 1.5,
  fontSize: 54,
  bold: true,
  color: "FFFFFF",
  align: "center",
  fontFace: "Calibri",
});

// Slide 2: Content slide
const slide2 = prs.addSlide("LAYOUT2");
slide2.background = { color: "FFFFFF" };
slide2.addText("QA Overview", {
  x: 0.5,
  y: 0.5,
  w: 9,
  h: 0.6,
  fontSize: 36,
  bold: true,
  color: "1E2761",
  fontFace: "Calibri",
});
slide2.addShape(prs.ShapeType.rect, {
  x: 0.5,
  y: 1.2,
  w: 9,
  h: 0.05,
  fill: { color: "CADCFC" },
  line: { type: "none" },
});
slide2.addText("Verify presentation structure and content integrity", {
  x: 0.5,
  y: 1.5,
  w: 9,
  h: 1.5,
  fontSize: 18,
  color: "36454F",
  fontFace: "Calibri",
});

// Slide 3: Closing slide
const slide3 = prs.addSlide("LAYOUT1");
slide3.background = { color: "1E2761" };
slide3.addText("Thank You", {
  x: 0.5,
  y: 3,
  w: 9,
  h: 1,
  fontSize: 48,
  bold: true,
  color: "FFFFFF",
  align: "center",
  fontFace: "Calibri",
});

await prs.writeFile({
  fileName: "/Users/lk/Projects/BaiGanio/aperio/trash/qa-test.pptx",
});
