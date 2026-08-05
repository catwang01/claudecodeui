import { describe, expect, it } from "vitest";
import { preserveLiteralBackslashes } from "../chatFormatting";

describe("preserveLiteralBackslashes", () => {
  it("preserves Windows paths containing control-sequence prefixes", () => {
    const path = String.raw`workbench\scenarios\ai_browser_competitor\tests\test_config.py`;

    expect(preserveLiteralBackslashes(path)).toBe(path);
  });

  it("does not reinterpret literal escape sequences in assistant text", () => {
    const content = String.raw`Keep \new, \tests, and \release as literal path segments.`;

    expect(preserveLiteralBackslashes(content)).toBe(content);
  });

  it("preserves actual newlines and tabs already decoded by JSON parsing", () => {
    const content = "first line\n\tsecond line";

    expect(preserveLiteralBackslashes(content)).toBe(content);
  });
});
