import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";

const APP_URL = process.env.APP_URL || "http://localhost:5201";
const DB_PATH =
  process.env.DATABASE_PATH || path.join(os.homedir(), ".cloudcli2", "auth.db");
const USERNAME = process.env.CLOUDCLI_TEST_USERNAME;
const PASSWORD = process.env.CLOUDCLI_TEST_PASSWORD;

function pickCopilotSession() {
  const db = new Database(DB_PATH, { readonly: true });
  const session = db
    .prepare(
      `SELECT session_id
       FROM sessions
      WHERE provider = 'copilot'
      ORDER BY updated_at DESC
      LIMIT 1 OFFSET 1`,
    )
    .get();
  db.close();
  return session;
}

async function loginAndOpenSession(page, sessionId) {
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#username").fill(USERNAME);
  await page.locator("#password").fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator("#password")).toHaveCount(0);

  await page.goto(`${APP_URL}/session/${sessionId}`, {
    waitUntil: "domcontentloaded",
  });
  const composer = page.locator("textarea").first();
  await expect(composer).toBeVisible({ timeout: 30_000 });
  return composer;
}

async function installFrameObserver(context) {
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__copilotFrames = [];

    class ObservedWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          try {
            const message = JSON.parse(event.data);
            window.__copilotFrames.push(message);
          } catch {
            // Ignore non-JSON frames.
          }
        });
      }
    }

    window.WebSocket = ObservedWebSocket;
  });
}

test.describe("Copilot live character integrity", () => {
  test.skip(
    !USERNAME || !PASSWORD,
    "Set CLOUDCLI_TEST_USERNAME and CLOUDCLI_TEST_PASSWORD to run live.",
  );
  test.setTimeout(180_000);

  test("live streamed text matches the text shown after refresh", async ({
    page,
    context,
  }) => {
    const session = pickCopilotSession();
    expect(session, "A pre-existing Copilot session is required").toBeTruthy();

    await installFrameObserver(context);
    const composer = await loginAndOpenSession(page, session.session_id);

    const markers = Array.from(
      { length: 60 },
      (_, index) => `SEG${String(index).padStart(2, "0")}`,
    );
    const requestedLine = markers.join("|");
    const prompt = `Reply with exactly this single line and nothing else: ${requestedLine}`;
    const frameStart = await page.evaluate(() => window.__copilotFrames.length);

    await composer.fill(prompt);
    await page.locator('button[type="submit"]').last().click();

    await page.waitForFunction(
      ({ start, sessionId }) =>
        window.__copilotFrames
          .slice(start)
          .some(
            (message) =>
              message.kind === "complete" && message.sessionId === sessionId,
          ),
      { start: frameStart, sessionId: session.session_id },
      { timeout: 150_000 },
    );

    const streamedText = await page.evaluate(
      ({ start, sessionId }) =>
        window.__copilotFrames
          .slice(start)
          .filter(
            (message) =>
              message.kind === "stream_delta" &&
              message.sessionId === sessionId,
          )
          .map((message) => message.content || "")
          .join(""),
      { start: frameStart, sessionId: session.session_id },
    );
    expect(streamedText).toBe(requestedLine);

    const lastAssistant = page.locator(".chat-message.assistant").last();
    await expect(lastAssistant).toBeVisible();
    const liveText = await lastAssistant.locator(".prose").last().innerText();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("textarea").first()).toBeVisible({
      timeout: 30_000,
    });
    const refreshedText = await page
      .locator(".chat-message.assistant")
      .last()
      .locator(".prose")
      .last()
      .innerText();

    console.log(
      JSON.stringify({
        streamedLength: streamedText.length,
        liveLength: liveText.length,
        refreshedLength: refreshedText.length,
      }),
    );

    expect(liveText).toBe(streamedText);
    expect(refreshedText).toBe(streamedText);
  });

  test("tool-interleaved assistant messages match their authoritative stream ends", async ({
    page,
    context,
  }) => {
    const session = pickCopilotSession();
    expect(session, "A pre-existing Copilot session is required").toBeTruthy();

    await installFrameObserver(context);
    const composer = await loginAndOpenSession(page, session.session_id);
    const marker = `TOOL_STREAM_${Date.now()}`;
    const frameStart = await page.evaluate(() => window.__copilotFrames.length);

    await composer.fill(
      `Use the PowerShell tool to run Write-Output "${marker}". ` +
        `After the tool finishes, reply with exactly: ${marker}|DONE`,
    );
    await page.locator('button[type="submit"]').last().click();

    await page.waitForFunction(
      ({ start, sessionId }) =>
        window.__copilotFrames
          .slice(start)
          .some(
            (message) =>
              message.kind === "complete" && message.sessionId === sessionId,
          ),
      { start: frameStart, sessionId: session.session_id },
      { timeout: 150_000 },
    );

    const frames = await page.evaluate(
      ({ start, sessionId }) =>
        window.__copilotFrames
          .slice(start)
          .filter((message) => message.sessionId === sessionId),
      { start: frameStart, sessionId: session.session_id },
    );
    expect(frames.some((message) => message.kind === "tool_use")).toBe(true);

    const finalSegments = frames
      .filter((message) => message.kind === "stream_end" && message.content)
      .map((message) => message.content);
    expect(finalSegments.length).toBeGreaterThan(0);

    const liveAssistantTexts = await page
      .locator(".chat-message.assistant .prose")
      .allInnerTexts();
    for (const segment of finalSegments) {
      expect(liveAssistantTexts).toContain(segment);
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("textarea").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(
        async () =>
          page.locator(".chat-message.assistant .prose").allInnerTexts(),
        { timeout: 30_000 },
      )
      .toEqual(expect.arrayContaining(finalSegments));
  });
});
