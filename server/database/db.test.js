// @vitest-environment node
import crypto from "crypto";
import { describe, expect, it } from "vitest";
import { sessionDb } from "./db.js";

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
