// Independent samples rendered by PFx/Hokusai for native MyPaint comparison.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const PORT = process.env.PFX_TEST_URL || "http://127.0.0.1:8732/";
const CHROME = process.argv[2] || "/usr/bin/google-chrome";
await mkdir("test-artifacts", { recursive: true });
const browser = await chromium.launch({executablePath:CHROME,headless:true,
  args:["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"]});
try {
  const page=await browser.newPage();
  await page.goto(PORT,{waitUntil:"domcontentloaded"});
  for (const preset of ["pencil","dry_brush","pastel","watercolor_glazing"]) {
    const pixels=await page.evaluate(async brushName=>{
      const pkg=await import("./pkg/hokusai_wasm.js");
      const memory=await pkg.default();
      const raw=await (await fetch("./public/brushes/"+brushName+".myb")).text();
      const brush=new pkg.HokusaiBrush(raw);
      brush.setColorHsv(0.6,0.7,0.8);
      const canvas=new pkg.HokusaiCanvas(320,180);
      canvas.resetStroke();
      for(let i=0;i<=40;i++) {
        const x=24+i*6;
        const y=90+12*Math.sin(i*0.25);
        const pressure=Math.max(0,Math.min(1,0.25+0.6*Math.abs(Math.sin(i*0.09))));
        canvas.strokeTo(brush,x,y,pressure,0,0,i?0.015:0.01);
      }
      canvas.finishStroke(brush);
      canvas.flush_pixels();
      const rgba=new Uint8Array(memory.memory.buffer,canvas.pixelsPtr(),canvas.pixelsLen());
      const rgb=new Array(320*180*3);
      for(let i=0,j=0;i<rgba.length;i+=4) {
        rgb[j++]=rgba[i];rgb[j++]=rgba[i+1];rgb[j++]=rgba[i+2];
      }
      brush.free();canvas.free();
      return rgb;
    },preset);
    const h=Buffer.from("P6\n320 180\n255\n");
    await writeFile("test-artifacts/hokusai_"+preset+".ppm",
      Buffer.concat([h,Buffer.from(pixels)]));
    console.log("REFERENCE_PFX_RENDERED",preset);
  }
} finally { await browser.close(); }
