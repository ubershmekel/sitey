import type { Page } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const SCREENSHOTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

const VIEWPORTS = [
  { tag: "wide", width: 1280 },
  { tag: "narrow", width: 375 },
] as const;

export class ScreenshotTaker {
  private n = 0;

  constructor(private page: Page) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }

  /** Navigate to a path and snap wide + narrow screenshots. */
  async goto(urlPath: string, label: string) {
    await this.page.goto(urlPath);
    await this.snap(label);
  }

  /** Snap the current page (wide + narrow) without navigating. */
  async snap(label: string) {
    this.n++;
    const prefix = String(this.n).padStart(2, "0");

    // Wait for network and any in-page loading spinners to settle.
    await this.page.waitForLoadState("networkidle");
    await this.page
      .waitForFunction(
        () =>
          [...document.querySelectorAll(".state-msg")].every(
            (el) => !/loading/i.test(el.textContent ?? ""),
          ),
        { timeout: 10_000 },
      )
      .catch(() => {
        // If the selector never appears or times out, proceed anyway.
      });

    for (const { tag, width } of VIEWPORTS) {
      await this.page.setViewportSize({ width, height: 800 });
      await this.page.screenshot({
        path: path.join(SCREENSHOTS_DIR, `${prefix}-${label}-${tag}.png`),
        fullPage: true,
      });
    }
  }
}
