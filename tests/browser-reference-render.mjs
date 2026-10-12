// Render exactly the same pointer events and fixed tail as the native C reference.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const PORT = process.env.PFX_TEST_URL || "http://127.0.0.1:8732/";
const CHROME = process.argv[2] || "/usr/bin/google-chrome";
const PRESETS = ["pencil", "dry_brush", "pastel", "watercolor_glazing"];
const SCENARIOS = ["baseline", "reverse", "zigzag", "primed"];
await mkdir("test-artifacts", { recursive: true });
const browser = await chromium.launch({executablePath: CHROME, headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]});
try {
  const page = await browser.newPage();
  await page.goto(PORT, {waitUntil: "domcontentloaded"});
  for (const preset of PRESETS) {
    for (const scenario of SCENARIOS) {
      const pixels = await page.evaluate(async ({brushName, scenario}) => {
        const pkg = await import("./pkg/hokusai_wasm.js");
        const wasm = await pkg.default();
        const response = await fetch("./public/brushes/" + brushName + ".myb");
        if (!response.ok) throw Error("Unable to load brush " + brushName);
        const brush = new pkg.HokusaiBrush(await response.text());
        const canvas = new pkg.HokusaiCanvas(320, 180);
        try {
          brush.setColorHsv(0.6, 0.7, 0.8);
          canvas.resetStroke();
          // Match the two zero-pressure hover samples in the native harness.
          if (scenario === "primed") {
            for (let k = 0; k < 2; k++) {
              canvas.strokeTo(brush, 24, 90, 0, 0, 0, 0.09);
            }
          }
          let x = 24, y = 90, pressure = 0.2;
          for (let i = 0; i <= 40; i++) {
            x = scenario === "reverse" ? 280 - i*6 : 24 + i*6;
            y = 90 + (scenario === "zigzag"
              ? 24*Math.sin(i*0.43) : 12*Math.sin(i*0.25));
            pressure = Math.max(0, Math.min(1, scenario === "zigzag"
              ? 0.12 + 0.8*Math.abs(Math.sin(i*0.19))
              : 0.25 + 0.6*Math.abs(Math.sin(i*0.09))));
            canvas.strokeTo(brush, x, y, pressure, 0, 0, i ? 0.015 : 0.01);
          }
          // Unlike finishStroke(), the C reference always feeds all 8 idle
          // samples. Use identical samples to isolate actual engine drift.
          for (let i = 0; i < 8; i++) {
            canvas.strokeTo(brush, x, y, pressure, 0, 0, 0.016);
          }
          canvas.flush_pixels();
          const rgba = new Uint8Array(wasm.memory.buffer,
            canvas.pixelsPtr(), canvas.pixelsLen());
          const rgb = new Array(320*180*3);
          for (let i = 0, j = 0; i < rgba.length; i += 4) {
            rgb[j++] = rgba[i]; rgb[j++] = rgba[i+1]; rgb[j++] = rgba[i+2];
          }
          return rgb;
        } finally {
          canvas.free();
          brush.free();
        }
      }, {brushName: preset, scenario});
      const suffix = scenario === "baseline" ? "" : "_" + scenario;
      const header = Buffer.from("P6\n320 180\n255\n");
      await writeFile("test-artifacts/hokusai_" + preset + suffix + ".ppm",
        Buffer.concat([header, Buffer.from(pixels)]));
      console.log("REFERENCE_PFX_RENDERED", preset, scenario);
    }
  }
} finally {
  await browser.close();
}
