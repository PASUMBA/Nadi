import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const bpmTargets = [72, 96];
const pageUrl = process.env.NADI_URL ?? "http://127.0.0.1:4173/";
const videoPaths = process.env.NADI_VIDEO_PATHS?.split(",") ?? [];

if (videoPaths.length !== bpmTargets.length) {
  throw new Error("Set NADI_VIDEO_PATHS to the 72 BPM and 96 BPM Y4M files, in that order.");
}

await mkdir("/home/ubuntu/repos/nadi_artifacts", { recursive: true });

for (let index = 0; index < bpmTargets.length; index += 1) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/home/ubuntu/.local/bin/google-chrome",
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      `--use-file-for-fake-video-capture=${videoPaths[index]}`,
    ],
  });
  try {
    const context = await browser.newContext({
      permissions: ["camera"],
      viewport: { width: 430, height: 900 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Start" }).click();
    await page.waitForFunction(
      () => {
        const value = document.querySelector("#bpm").textContent.trim();
        return value !== "--" && !document.querySelector("#status").textContent.includes(" s");
      },
      null,
      { timeout: 70_000 },
    );
    await delay(15_000);

    const reading = Number(await page.locator("#bpm").textContent());
    const status = await page.locator("#status").textContent();
    const snr = await page.locator("#status").getAttribute("data-snr");
    const screenshot = `/home/ubuntu/repos/nadi_artifacts/nadi-${bpmTargets[index]}-bpm.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(
      `${bpmTargets[index]} BPM video: ${reading} BPM; SNR ${snr} dB; status: ${status}; screenshot: ${screenshot}`,
    );
    assert.ok(Math.abs(reading - bpmTargets[index]) <= 3, `Expected ${bpmTargets[index]} ±3 BPM, got ${reading}`);
    assert.deepEqual(errors, [], `Browser errors: ${errors.join("; ")}`);
    await context.close();
  } finally {
    await browser.close();
  }
}
