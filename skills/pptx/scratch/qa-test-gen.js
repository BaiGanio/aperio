import PptxGenJS from 'pptxgenjs';

const prs = new PptxGenJS();
prs.defineLayout({ name: 'LAYOUT1', width: 10, height: 7.5 });
prs.defineLayout({ name: 'LAYOUT2', width: 10, height: 7.5 });

// Slide 1: Title slide
const slide1 = prs.addSlide('LAYOUT1');
slide1.background = { color: '1E2761' }; // navy
slide1.addText('Aperio QA Test', {
  x: 0.5,
  y: 2.5,
  w: 9,
  h: 1.5,
  fontSize: 54,
  bold: true,
  color: 'FFFFFF',
  align: 'center',
});
slide1.addText('Smoke test for the pptx skill', {
  x: 0.5,
  y: 4.2,
  w: 9,
  h: 0.8,
  fontSize: 24,
  color: 'CADCFC',
  align: 'center',
});

// Slide 2: Stat callout
const slide2 = prs.addSlide('LAYOUT2');
slide2.background = { color: 'F5F5F5' };
slide2.addText('42', {
  x: 2,
  y: 2.5,
  w: 6,
  h: 1.8,
  fontSize: 96,
  bold: true,
  color: '1E2761',
  align: 'center',
});
slide2.addText('answer to everything', {
  x: 2,
  y: 4.5,
  w: 6,
  h: 0.6,
  fontSize: 18,
  color: '666666',
  align: 'center',
  italic: true,
});

// Slide 3: List of scripts
const slide3 = prs.addSlide('LAYOUT2');
slide3.background = { color: 'F5F5F5' };
slide3.addText('PPTX Scripts', {
  x: 0.5,
  y: 0.5,
  w: 9,
  h: 0.6,
  fontSize: 36,
  bold: true,
  color: '1E2761',
  align: 'left',
});

const scripts = ['read.js', 'pack.js', 'verify.js'];
let yPos = 1.5;
scripts.forEach((script, idx) => {
  slide3.addShape('ellipse', {
    x: 0.8,
    y: yPos + 0.1,
    w: 0.4,
    h: 0.4,
    fill: { color: 'CADCFC' },
  });
  slide3.addText((idx + 1).toString(), {
    x: 0.8,
    y: yPos + 0.08,
    w: 0.4,
    h: 0.4,
    fontSize: 16,
    bold: true,
    color: '1E2761',
    align: 'center',
    valign: 'middle',
  });
  slide3.addText(script, {
    x: 1.5,
    y: yPos,
    w: 7,
    h: 0.5,
    fontSize: 18,
    color: '36454F',
    align: 'left',
    valign: 'middle',
  });
  yPos += 1.2;
});

prs.writeFile({ fileName: '/Users/lk/Projects/BaiGanio/aperio/trash/qa-test.pptx' });
console.log('✅ Deck generated');
