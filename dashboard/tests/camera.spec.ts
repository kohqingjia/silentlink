import { test, expect, Page } from "@playwright/test";

// Synthetic API responses and Chromium's fake camera test UI behavior only.
// They are never sent to the production research service or used as ML evidence.
const ready = {
  ready: true,
  stage: "ready",
  percent: 100,
  message: "Ready",
  queue_depth: 0,
};
const baseJob = {
  id: "ui-fixture",
  mode: "test",
  reference: "hello world",
  retain: false,
  created: Date.now() / 1000,
  percent: null,
  eta_s: null,
  elapsed_s: 2,
  queue_position: 0,
};

async function setup(page: Page, key = true) {
  if (key)
    await page.addInitScript(() =>
      sessionStorage.setItem("silentlink-camera-key", "synthetic-ui-test-key"),
    );
  await page.route("**/api/vision/status", (route) =>
    route.fulfill({ json: ready }),
  );
  await page.route("**/api/vision/history", (route) =>
    route.fulfill({ json: { recordings: [] } }),
  );
  await page.goto("/");
  await expect(
    page.getByText("Lip-reading model ready", { exact: true }),
  ).toBeVisible();
}

test("connect, capture real browser video, show stage progress and score raw output", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(page, false);
  await page.getByRole("button", { name: "Connect workspace" }).click();
  await page.getByLabel("Dashboard key").fill("synthetic-ui-test-key");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("tab", { name: "Test accuracy" }).click();
  await page.getByLabel("What will you mouth?").fill("hello world");
  let phase = 0;
  await page.route("**/api/vision/jobs", async (route) => {
    expect(route.request().headers()["x-recording-mode"]).toBe("test");
    expect(route.request().headers()["x-reference-text"]).toBe("hello%20world");
    expect(route.request().postDataBuffer()!.length).toBeGreaterThan(100);
    expect(route.request().headers()["content-type"]).toContain("video/");
    await route.fulfill({
      status: 202,
      json: { ...baseJob, stage: "queued", queue_position: 1 },
    });
  });
  await page.route("**/api/vision/jobs/ui-fixture", (route) =>
    route.fulfill({
      json:
        phase === 0
          ? {
              ...baseJob,
              stage: "tracking_face",
              message: "Locating your face",
              percent: 45,
            }
          : {
              ...baseJob,
              stage: "complete",
              percent: 100,
              result: {
                text: "hello there",
                processing_s: 4,
                duration_s: 1,
                face_coverage_percent: 100,
                model: "UI fixture only",
                score: {
                  reference: "hello world",
                  reference_words: 2,
                  errors: 1,
                  wer_percent: 50,
                  exact_match: false,
                  substitutions: 1,
                  deletions: 0,
                  insertions: 0,
                },
              },
            },
    }),
  );
  await page.getByRole("button", { name: "Enable camera" }).click();
  await expect(page.getByText("Camera on · not recording")).toBeVisible();
  const audioTracks = await page
    .locator("video")
    .evaluate((video) =>
      (video as HTMLVideoElement).srcObject instanceof MediaStream
        ? (
            (video as HTMLVideoElement).srcObject as MediaStream
          ).getAudioTracks().length
        : -1,
    );
  expect(audioTracks).toBe(0);
  await page.getByRole("button", { name: "Record test" }).click();
  await expect(page.getByRole("button", { name: "Finish phrase" })).toBeEnabled(
    { timeout: 7000 },
  );
  await page.waitForTimeout(700); // Deliberately capture actual video frames.
  await page.getByRole("button", { name: "Finish phrase" }).click();
  await expect(page.getByText("45%", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Estimating time from first recordings…"),
  ).toBeVisible();
  phase = 1;
  await expect(page.getByLabel("Editable transcript")).toHaveValue(
    "hello there",
  );
  await expect(
    page.getByText("50% word error rate", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Editable transcript").fill("hello world");
  await expect(
    page.getByText("50% word error rate", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Speak text" })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("server readiness, cancellation, and mobile layout", async ({ page }) => {
  await setup(page);
  await page.route("**/api/vision/jobs", (route) =>
    route.fulfill({
      status: 202,
      json: { ...baseJob, stage: "encoding", message: "Reading lip movement" },
    }),
  );
  let cancelled = false;
  await page.route("**/api/vision/jobs/ui-fixture", (route) =>
    route.fulfill({
      json: {
        ...baseJob,
        stage: cancelled ? "cancelled" : "encoding",
        message: "Reading lip movement",
      },
    }),
  );
  await page.route("**/api/vision/jobs/ui-fixture/cancel", (route) => {
    cancelled = true;
    return route.fulfill({ json: { ...baseJob, stage: "cancelled" } });
  });
  await page.getByRole("button", { name: "Enable camera" }).click();
  await page.getByRole("button", { name: "Record a phrase" }).click();
  await expect(page.getByRole("button", { name: "Finish phrase" })).toBeEnabled(
    { timeout: 7000 },
  );
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Finish phrase" }).click();
  await expect(
    page.getByText("Reading lip movement", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Record a phrase" }),
  ).toBeEnabled();
  expect(cancelled).toBe(true);
  await page.getByRole("button", { name: "Turn camera off" }).click();
  await expect(
    page.getByRole("button", { name: "Enable camera" }),
  ).toBeVisible();
  if (process.env.SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.SCREENSHOT_DIR}/SilentLink-camera-desktop.png`,
      fullPage: true,
    });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  if (process.env.SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.SCREENSHOT_DIR}/SilentLink-camera-mobile.png`,
      fullPage: true,
    });
});

test("model startup disables capture and shows measured model progress", async ({
  page,
}) => {
  await page.route("**/api/vision/status", (route) =>
    route.fulfill({
      json: {
        ...ready,
        ready: false,
        stage: "verifying_model",
        percent: 37,
        message: "Checking model download integrity",
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByText("37%", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Record a phrase" }),
  ).toBeDisabled();
  await page.getByRole("tab", { name: "Teach words" }).click();
  await expect(
    page.getByText("No examples yet.", { exact: false }),
  ).toBeVisible();
});

test("camera denial is actionable and AirPods remains reachable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException("Denied", "NotAllowedError"));
  });
  await setup(page);
  await page.getByRole("button", { name: "Enable camera" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Camera permission" }),
  ).toContainText("Allow Camera");
  await page.getByRole("link", { name: "AirPods research" }).click();
  await expect(page).toHaveURL(/\/airpods/);
  await expect(
    page.getByRole("heading", { name: "Your research, in motion." }),
  ).toBeVisible();
});

test("teaching stores a private example and deletion updates vocabulary", async ({
  page,
}) => {
  await setup(page);
  let saved = false;
  const example = {
    ...baseJob,
    id: "teaching-fixture",
    mode: "teach",
    reference: "water",
    stage: "complete",
    result: { text: "", duration_s: 1.2, processing_s: 2 },
  };
  await page.route("**/api/vision/history", (route) =>
    route.fulfill({ json: { recordings: saved ? [example] : [] } }),
  );
  await page.route("**/api/vision/jobs", (route) => {
    expect(route.request().headers()["x-recording-mode"]).toBe("teach");
    expect(route.request().headers()["x-save-sample"]).toBe("no");
    expect(route.request().headers()["x-reference-text"]).toBe("water");
    return route.fulfill({
      status: 202,
      json: { ...example, stage: "queued" },
    });
  });
  await page.route("**/api/vision/jobs/teaching-fixture", (route) => {
    saved = route.request().method() !== "DELETE";
    return route.fulfill({ json: saved ? example : { deleted: true } });
  });
  await page.getByRole("tab", { name: "Teach words" }).click();
  await page.getByRole("button", { name: "water", exact: true }).click();
  await page.getByRole("button", { name: "Enable camera" }).click();
  await page.getByRole("button", { name: "Record example" }).click();
  await expect(page.getByRole("button", { name: "Finish phrase" })).toBeEnabled(
    { timeout: 7000 },
  );
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Finish phrase" }).click();
  await expect(
    page.getByRole("cell", { name: "water", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Features", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete water sample" }).click();
  await expect(
    page.getByRole("cell", { name: "water", exact: true }),
  ).toHaveCount(0);
});

test("live phrases waits for processing and can be stopped", async ({
  page,
}) => {
  await setup(page);
  let uploads = 0;
  await page.route("**/api/vision/jobs", (route) => {
    uploads++;
    return route.fulfill({
      status: 202,
      json: { ...baseJob, stage: "encoding", message: "Reading lip movement" },
    });
  });
  await page.route("**/api/vision/jobs/ui-fixture", (route) =>
    route.fulfill({
      json: { ...baseJob, stage: "encoding", message: "Reading lip movement" },
    }),
  );
  await page.route("**/api/vision/jobs/ui-fixture/cancel", (route) =>
    route.fulfill({ json: { ...baseJob, stage: "cancelled" } }),
  );
  await page.getByRole("button", { name: "Enable camera" }).click();
  await page.getByRole("button", { name: "Try live phrases" }).click();
  await expect(
    page.getByText("Reading lip movement", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    page.getByRole("button", { name: "Record a phrase" }),
  ).toBeDisabled();
  await page.waitForTimeout(1800);
  expect(uploads).toBe(1);
  await page.getByRole("button", { name: "Stop live phrases" }).click();
  await expect(
    page.getByRole("button", { name: "Try live phrases" }),
  ).toBeEnabled();
});
