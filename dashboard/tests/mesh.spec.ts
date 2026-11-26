import { test, expect, Page } from "@playwright/test";

// Deterministic synthetic worker/API fixtures test UI contracts only.
// Real MediaPipe tracking is checked separately with a video-fed browser camera.
async function setup(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem("silentlink-camera-key", "synthetic-ui-key");
    window.Worker = class {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      stopped = false;
      postMessage(data: {
        type: string;
        bitmap?: ImageBitmap;
        timestamp: number;
        width: number;
        height: number;
      }) {
        if (this.stopped) return;
        if (data.type === "init") {
          this.onmessage?.({
            data: {
              type: "progress",
              stage: "Downloading face tracker",
              percent: 42,
              eta: 3,
            },
          });
          setTimeout(() => {
            if (!this.stopped)
              this.onmessage?.({
                data: {
                  type: "ready",
                  edges: [{ start: 13, end: 14 }],
                  lips: [{ start: 13, end: 14 }],
                },
              });
          }, 1000);
        } else {
          data.bitmap?.close();
          const xyz = Array.from({ length: 478 }, (_, i) => [
            0.4 + (i % 15) / 100,
            0.4 + Math.floor(i / 15) / 100,
            Math.sin(data.timestamp / 400) / 100,
          ]).flat();
          this.onmessage?.({
            data: {
              ...data,
              type: "frame",
              bitmap: undefined,
              faces: 1,
              xyz,
              pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            },
          });
        }
      }
      terminate() {
        this.stopped = true;
      }
    } as unknown as typeof Worker;
    // The mesh flow must never instantiate a video recorder.
    window.MediaRecorder = class {
      constructor() {
        throw Error("Unexpected video recorder in mesh mode");
      }
    } as unknown as typeof MediaRecorder;
  });
  await page.route("**/api/vision/mesh/library", (route) =>
    route.fulfill({ json: { examples: [], tests: [] } }),
  );
  await page.goto("/mesh");
}

test("motion capture uploads only geometry, supports replay and deletion", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(page);
  let saved: {
    id: string;
    label: string;
    capture: { frames: { xyz: number[]; pose: number[] }[] };
  } | null = null;
  let deleted = false;
  await page.route("**/api/vision/mesh/library", (route) =>
    route.fulfill({
      json: {
        examples:
          saved && !deleted
            ? [
                {
                  id: saved.id,
                  label: saved.label,
                  duration_s: 1,
                  frames: saved.capture.frames.length,
                },
              ]
            : [],
        tests: [],
      },
    }),
  );
  await page.route("**/api/vision/mesh/examples", async (route) => {
    saved = route.request().postDataJSON();
    expect(Object.keys(saved!).sort()).toEqual(["capture", "id", "label"]);
    expect(Object.keys(saved!.capture).sort()).toEqual([
      "frames",
      "height",
      "schema_version",
      "width",
    ]);
    expect(saved!.capture.frames.length).toBeGreaterThanOrEqual(10);
    expect(saved!.capture.frames[0].xyz).toHaveLength(1434);
    expect(saved!.capture.frames[0].pose).toHaveLength(16);
    expect(Object.keys(saved!.capture.frames[0]).sort()).toEqual([
      "faces",
      "pose",
      "t",
      "xyz",
    ]);
    await route.fulfill({
      status: 201,
      json: { saved: true, id: saved!.id, label: saved!.label },
    });
  });
  await page.route("**/api/vision/mesh/examples/*", (route) => {
    deleted = route.request().method() === "DELETE";
    return route.fulfill({ json: deleted ? { deleted: true } : saved });
  });
  await page.getByRole("button", { name: "Enable camera & mesh" }).click();
  await expect(page.getByText("42%", { exact: true })).toBeVisible();
  await expect(
    page.getByText("About 3s remaining", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Face tracked · 478 points", { exact: true }),
  ).toBeVisible();
  expect(
    await page
      .locator("video")
      .evaluate(
        (v) =>
          ((v as HTMLVideoElement).srcObject as MediaStream).getAudioTracks()
            .length,
      ),
  ).toBe(0);
  await page
    .getByRole("button", { name: "Record sentence", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Finish motion", exact: true }),
  ).toBeEnabled({ timeout: 6000 });
  await page.waitForTimeout(1100);
  await page
    .getByRole("button", { name: "Finish motion", exact: true })
    .click();
  await page.getByRole("button", { name: "Replay mesh", exact: true }).click();
  await page.getByRole("slider").fill("30");
  await expect(
    page.getByText("Reconstructed from coordinates only"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save sentence motion", exact: true })
    .click();
  await expect(
    page.getByText("Saved training take · record a fresh test", {
      exact: true,
    }),
  ).toBeDisabled();
  // Replay survives a reload and does not need camera permission or the source video.
  await page.reload();
  await page
    .getByRole("button", {
      name: "Replay Please bring me a glass of water",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Reconstructed from coordinates only"),
  ).toBeVisible();
  expect(
    await page
      .locator("video")
      .evaluate((v) => (v as HTMLVideoElement).srcObject),
  ).toBeNull();
  await page
    .getByRole("button", {
      name: "Delete Please bring me a glass of water",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("No saved motion yet.", { exact: false }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("cancel startup and camera denial are recoverable; mesh fits mobile", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "Enable camera & mesh" }).click();
  await expect(page.getByText("42%", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel loading" }).click();
  await expect(
    page.getByRole("button", { name: "Enable camera & mesh" }),
  ).toBeEnabled();
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException("Denied", "NotAllowedError"));
  });
  await page.getByRole("button", { name: "Enable camera & mesh" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Allow Camera" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
