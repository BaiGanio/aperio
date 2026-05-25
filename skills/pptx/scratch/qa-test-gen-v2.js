import PptxGenJS from "pptxgenjs";

const prs = new PptxGenJS();
prs.defineLayout({ name: "LAYOUT1", width: 10, height: 7.5 });
prs.defineLayout({ name: "LAYOUT2", width: 10, height: 7.5 });
prs.defineLayout({ name: "LAYOUT3", width: 10, height: 7.5 });

// Slide 1: Title slide with two-column layout
const slide1 = prs.addSlide("LAYOUT1");
slide1.background = { color: "F5F5F5" };
slide1.addShape("rect", {
  x: 0,
  y: 0,
  w: 4,
  h: 7.5,
  fill: { color: "1E2761" },
  line: { type: "none" }
});
slide1.addText("Aperio QA Test", {
  x: 0.5,
  y: 2.5,
  w: 3,
  h: 1,
  fontSize: 36,
  bold: true,
  color: "FFFFFF",
  align: "center",
  valign: "middle",
  fontFace: "Arial"
});
slide1.addText("Smoke test for the pptx skill", {
  x: 0.5,
  y: 3.7,
  w: 3,
  h: 0.8,
  fontSize: 14,
  color: "FFFFFF",
  align: "center",
  valign: "top",
  fontFace: "Arial"
});

// Slide 2: Large stat with caption
const slide2 = prs.addSlide("LAYOUT2");
slide2.background = { color: "F5F5F5" };
slide2.addText("42", {
  x: 2,
  y: 2.5,
  w: 6,
  h: 1.5,
  fontSize: 88,
  bold: true,
  color: "36454F",
  align: "center",
  valign: "middle",
  fontFace: "Arial"
});
slide2.addText("answer to everything", {
  x: 2,
  y: 4.2,
  w: 6,
  h: 0.6,
  fontSize: 14,
  color: "666666",
  align: "center",
  valign: "top",
  fontFace: "Arial"
});

// Slide 3: Numbered list with circles
const slide3 = prs.addSlide("LAYOUT3");
slide3.background = { color: "F5F5F5" };
slide3.addText("PPTX Scripts", {
  x: 0.5,
  y: 0.5,
  w: 9,
  h: 0.6,
  fontSize: 32,
  bold: true,
  color: "36454F",
  align: "left",
  valign: "top",
  fontFace: "Arial"
});

const scripts = [
  { num: "1", text: "read.js" },
  { num: "2", text: "pack.js" },
  { num: "3", text: "verify.js" }
];

scripts.forEach((item, idx) => {
  const yPos = 1.8 + idx * 1.2;
  
  // Circle
  slide3.addShape("ellipse", {
    x: 0.8,
    y: yPos,
    w: 0.4,
    h: 0.4,
    fill: { color: "CADCFC" },
    line: { color: "1E2761", width: 1 }
  });
  
  // Number inside circle
  slide3.addText(item.num, {
    x: 0.8,
    y: yPos,
    w: 0.4,
    h: 0.4,
    fontSize: 16,
    bold: true,
    color: "1E2761",
    align: "center",
    valign: "middle",
    fontFace: "Arial"
  });
  
  // Script name label
  slide3.addText(item.text, {
    x: 1.4,
    y: yPos,
    w: 3,
    h: 0.4,
    fontSize: 16,
    color: "36454F",
    align: "left",
    valign: "middle",
    fontFace: "Arial"
  });
});

prs.writeFile({ fileName: "/Users/lk/Projects/BaiGanio/aperio/trash/qa-test-v2.pptx" });
console.log("✅ Deck generated");
