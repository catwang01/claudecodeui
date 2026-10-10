import { describe, expect, it } from "vitest";
import { normalizeLatexDelimiters, preserveLiteralBackslashes } from "../chatFormatting";

describe("normalizeLatexDelimiters", () => {
  it("converts inline and display LaTeX delimiters for remark-math", () => {
    const content = String.raw`Use \(\Delta=2\), then:
\[
n = \frac{2\sigma^2}{\Delta^2}
\]`;

    expect(normalizeLatexDelimiters(content)).toBe(`Use $\\Delta=2$, then:
$$
n = \\frac{2\\sigma^2}{\\Delta^2}
$$`);
  });

  it("does not alter LaTeX-like text inside code spans or fenced code blocks", () => {
    const content = String.raw`Keep \(\alpha\), but preserve \`\(\beta\)\` and:
\`\`\`text
\[\gamma\]
\`\`\``.replace(/\\`/g, "`");

    expect(normalizeLatexDelimiters(content)).toBe(`Keep $\\alpha$, but preserve \`\\(\\beta\\)\` and:
\`\`\`text
\\[\\gamma\\]
\`\`\``);
  });
});

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
