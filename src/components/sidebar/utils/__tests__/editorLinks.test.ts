import { describe, expect, it } from "vitest";
import { buildEditorWorkspaceUri, WORKSPACE_EDITORS } from "../editorLinks";

describe("buildEditorWorkspaceUri", () => {
  it("builds a VS Code URI for a Windows workspace", () => {
    expect(
      buildEditorWorkspaceUri(
        WORKSPACE_EDITORS[0],
        String.raw`C:\Users\example\source repo`,
      ),
    ).toBe("vscode://file/C:/Users/example/source%20repo/");
  });

  it("builds a Cursor URI for a Unix workspace", () => {
    expect(
      buildEditorWorkspaceUri(WORKSPACE_EDITORS[2], "/home/example/source"),
    ).toBe("cursor://file/home/example/source/");
  });

  it("encodes URL-significant characters in workspace names", () => {
    expect(
      buildEditorWorkspaceUri(
        WORKSPACE_EDITORS[0],
        String.raw`C:\source\repo#1`,
      ),
    ).toBe("vscode://file/C:/source/repo%231/");
  });
});
