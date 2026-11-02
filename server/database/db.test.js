// @vitest-environment node
import crypto from "crypto";
import { describe, expect, it, vi } from "vitest";
import { applyScheduledTaskOrigin, sessionDb } from "./db.js";
import { scheduledTasksDb } from "../modules/database/index.js";

describe("scheduled task session origins", () => {
  it.each(["claude", "copilot", "codex", "cursor", "gemini"])(
    "tags scheduled %s sessions for the existing conversation filters",
    (provider) => {
      const session = { id: crypto.randomUUID() };
      const lookup = vi.spyOn(scheduledTasksDb, "getSessionOrigins").mockReturnValue(
        new Map([[session.id, { taskId: "task-1", taskTitle: "Scheduled work" }]]),
      );
      try {
        applyScheduledTaskOrigin([session], provider);
        expect(session.scheduledTaskOrigin).toEqual({
          taskId: "task-1",
          taskTitle: "Scheduled work",
        });
      } finally {
        lookup.mockRestore();
      }
    },
  );
});

describe("sessionDb fork parents", () => {
  it("inserts and updates a provider-specific fork relationship", () => {
    const forkId = crypto.randomUUID();
    const firstParentId = crypto.randomUUID();
    const secondParentId = crypto.randomUUID();

    try {
      sessionDb.markForkParent(forkId, firstParentId, "copilot");
      expect(sessionDb.getForkParentMap([forkId], "copilot").get(forkId)).toBe(
        firstParentId,
      );

      sessionDb.markForkParent(forkId, secondParentId, "copilot");
      expect(sessionDb.getForkParentMap([forkId], "copilot").get(forkId)).toBe(
        secondParentId,
      );
    } finally {
      sessionDb.removeForkLinks(forkId, "copilot");
    }
  });
});
