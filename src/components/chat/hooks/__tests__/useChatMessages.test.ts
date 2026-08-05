import { describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../../../stores/useSessionStore";
import { normalizedToChatMessages } from "../useChatMessages";

describe("normalizedToChatMessages", () => {
  it("keeps Windows paths intact in assistant messages", () => {
    const path = String.raw`workbench\scenarios\ai_browser_competitor\tests\test_config.py`;
    const messages: NormalizedMessage[] = [
      {
        id: "message-1",
        sessionId: "session-1",
        timestamp: "2026-08-05T09:00:00.000Z",
        provider: "copilot",
        kind: "text",
        role: "assistant",
        content: `Changed ${path}: added a regression test.`,
      },
    ];

    const converted = normalizedToChatMessages(messages);

    expect(converted).toHaveLength(1);
    expect(converted[0].content).toContain(path);
    expect(converted[0].content).not.toContain("\t");
  });
});
