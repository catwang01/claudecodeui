export const WORKSPACE_EDITORS = [
  { id: "vscode", name: "Visual Studio Code", scheme: "vscode" },
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    scheme: "vscode-insiders",
  },
  { id: "cursor", name: "Cursor", scheme: "cursor" },
] as const;

export type WorkspaceEditor = (typeof WORKSPACE_EDITORS)[number];

export function buildEditorWorkspaceUri(
  editor: WorkspaceEditor,
  directory: string,
): string {
  const normalizedPath = directory.replace(/\\/g, "/");
  const absolutePath = normalizedPath.startsWith("/")
    ? normalizedPath
    : `/${normalizedPath}`;
  const encodedPath = encodeURIComponent(absolutePath)
    .replace(/%2F/gi, "/")
    .replace(/%3A/gi, ":");
  return `${editor.scheme}://file${encodedPath.replace(/\/?$/, "/")}`;
}
