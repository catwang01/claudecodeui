import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_URL = process.env.APP_URL || "http://localhost:5201";
const DB_PATH =
  process.env.DATABASE_PATH || path.join(os.homedir(), ".cloudcli2", "auth.db");
const USERNAME = process.env.CLOUDCLI_TEST_USERNAME;
const PASSWORD = process.env.CLOUDCLI_TEST_PASSWORD;
const PROMPT = "基于 perftest 里面我的 commit 总结一个 ppt";

function findAnalysisToolsProject() {
  const db = new Database(DB_PATH, { readonly: true });
  const project = db
    .prepare(
      `SELECT project_path
       FROM sessions
      WHERE lower(project_path) LIKE '%edgeinternal.analysistools%'
      ORDER BY updated_at DESC
      LIMIT 1`,
    )
    .get();
  db.close();
  return project;
}

async function readTurn(page) {
  return page.evaluate((prompt) => {
    const messages = Array.from(document.querySelectorAll(".chat-message"));
    const promptIndex = messages.findLastIndex(
      (message) =>
        message.classList.contains("user") &&
        (message.innerText || "").includes(prompt),
    );
    if (promptIndex < 0) return [];
    return messages
      .slice(promptIndex + 1)
      .filter((message) => message.classList.contains("assistant"))
      .map((message) => ({
        text: Array.from(message.querySelectorAll(".prose"))
          .map((node) => node.innerText)
          .join("\n"),
        fullText: message.innerText,
      }))
      .filter((message) => message.text.trim().length > 0);
  }, PROMPT);
}

test("analysisTools perftest PPT task preserves the complete rendered turn", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    !USERNAME || !PASSWORD,
    "Set CloudCLI test credentials to run this live test.",
  );
  test.setTimeout(900_000);

  const project = findAnalysisToolsProject();
  expect(
    project,
    "The edgeinternal.analysisTools project is required",
  ).toBeTruthy();

  await context.addInitScript((prompt) => {
    window.localStorage.setItem("selected-provider", "copilot");
    const NativeWebSocket = window.WebSocket;
    window.__copilotFrames = [];
    window.__streamEndDomSnapshots = [];

    const readCurrentTurnTexts = () => {
      const messages = Array.from(document.querySelectorAll(".chat-message"));
      const promptIndex = messages.findLastIndex(
        (message) =>
          message.classList.contains("user") &&
          (message.innerText || "").includes(prompt),
      );
      if (promptIndex < 0) return [];
      return messages
        .slice(promptIndex + 1)
        .filter((message) => message.classList.contains("assistant"))
        .map((message) =>
          Array.from(message.querySelectorAll(".prose"))
            .map((node) => node.innerText)
            .join("\n"),
        )
        .filter((text) => text.trim().length > 0);
    };

    class ObservedWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          try {
            const message = JSON.parse(event.data);
            window.__copilotFrames.push(message);
            if (message.kind === "stream_end") {
              const snapshot = {
                sessionId: message.sessionId,
                messageId: message.messageId,
                content: message.content,
                samples: [],
              };
              window.__streamEndDomSnapshots.push(snapshot);
              for (const delay of [0, 50, 250]) {
                setTimeout(() => {
                  snapshot.samples.push({
                    delay,
                    texts: readCurrentTurnTexts(),
                  });
                }, delay);
              }
            }
          } catch {
            // Ignore non-JSON frames.
          }
        });
      }
    }
    window.WebSocket = ObservedWebSocket;
  }, PROMPT);

  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#username").fill(USERNAME);
  await page.locator("#password").fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator("#password")).toHaveCount(0);

  const projectButton = page
    .locator("button")
    .filter({ hasText: "edgeinternal.analysisTools" })
    .first();
  await expect(projectButton).toBeVisible({ timeout: 30_000 });
  await projectButton.click();
  const newSessionButton = page
    .getByRole("button", { name: /New Session/i })
    .first();
  await expect(newSessionButton).toBeVisible({ timeout: 30_000 });
  await newSessionButton.click();

  const composer = page.locator("textarea").first();
  await expect(composer).toBeVisible({ timeout: 30_000 });

  const frameStart = await page.evaluate(() => window.__copilotFrames.length);
  await composer.fill(PROMPT);
  await page.locator('button[type="submit"]').last().click();

  await page.waitForFunction(
    ({ start }) => {
      const frames = window.__copilotFrames.slice(start);
      const created = frames.find(
        (message) => message.kind === "session_created",
      );
      return (
        created &&
        frames.some(
          (message) =>
            message.kind === "complete" &&
            message.sessionId === created.newSessionId,
        )
      );
    },
    { start: frameStart },
    { timeout: 780_000 },
  );
  await page.waitForTimeout(2_000);

  const captured = await page.evaluate(
    ({ start }) => {
      const allFrames = window.__copilotFrames.slice(start);
      const created = allFrames.find(
        (message) => message.kind === "session_created",
      );
      return {
        sessionId: created.newSessionId,
        frames: allFrames.filter(
          (message) => message.sessionId === created.newSessionId,
        ),
        streamEndDomSnapshots: window.__streamEndDomSnapshots.filter(
          (snapshot) => snapshot.sessionId === created.newSessionId,
        ),
      };
    },
    { start: frameStart },
  );
  const frames = captured.frames;
  const liveTurn = await readTurn(page);

  await page.goto(`${APP_URL}/session/${captured.sessionId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator("textarea").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Loading session messages...")).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect.poll(() => readTurn(page), { timeout: 60_000 }).not.toEqual([]);
  const refreshedTurn = await readTurn(page);

  const capture = {
    project,
    sessionId: captured.sessionId,
    prompt: PROMPT,
    frameKinds: frames.map((message) => ({
      kind: message.kind,
      messageId: message.messageId,
      content: message.kind === "stream_end" ? message.content : undefined,
      toolName: message.toolName,
    })),
    streamEndDomSnapshots: captured.streamEndDomSnapshots,
    liveTurn,
    refreshedTurn,
  };
  const capturePath = testInfo.outputPath("analysis-tools-ppt-capture.json");
  fs.writeFileSync(capturePath, JSON.stringify(capture, null, 2), "utf8");
  await testInfo.attach("analysis-tools-ppt-capture", {
    path: capturePath,
    contentType: "application/json",
  });

  expect(frames.some((message) => message.kind === "tool_use")).toBe(true);
  const liveTexts = liveTurn.map((message) => message.text);
  const refreshedTexts = refreshedTurn.map((message) => message.text);
  expect(liveTexts).toEqual(refreshedTexts);
  expect(captured.streamEndDomSnapshots).toHaveLength(refreshedTexts.length);

  for (let index = 0; index < refreshedTexts.length; index += 1) {
    const snapshot = captured.streamEndDomSnapshots[index];
    const settledSample = snapshot.samples.find(
      (sample) => sample.delay === 250,
    );
    expect(
      settledSample,
      `Missing 250ms DOM sample for segment ${index}`,
    ).toBeTruthy();
    expect(
      settledSample.texts,
      `Segment ${index} was not rendered completely within 250ms of stream_end`,
    ).toContain(refreshedTexts[index]);
  }
});
