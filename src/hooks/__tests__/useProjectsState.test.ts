import { describe, expect, it } from "vitest";
import type { Project, ProjectSession } from "../../types/app";
import {
  mergeProjects,
  mergeSelectedSessionMetadata,
  projectsHaveChanges,
  removeSessionFromProjects,
} from "../useProjectsState";

describe("useProjectsState metadata synchronization", () => {
  it("detects Copilot-only project changes", () => {
    const previous: Project[] = [
      {
        name: "project",
        displayName: "Project",
        fullPath: "C:\\project",
        copilotSessions: [{ id: "session-1", summary: "New Session" }],
      },
    ];
    const updated: Project[] = [
      {
        ...previous[0],
        copilotSessions: [
          { id: "session-1", summary: "Investigate histogram sending logic" },
        ],
      },
    ];

    expect(projectsHaveChanges(previous, updated, true)).toBe(true);
  });

  it("refreshes title metadata while preserving navigation metadata", () => {
    const selected: ProjectSession = {
      id: "session-1",
      summary: "New Session",
      __provider: "copilot",
      __projectName: "project",
      __searchTargetTimestamp: "2026-08-10T00:00:00.000Z",
    };
    const latest: ProjectSession = {
      id: "session-1",
      summary: "Investigate histogram sending logic",
      messageCount: 6,
    };

    expect(mergeSelectedSessionMetadata(selected, latest, "copilot")).toEqual({
      ...selected,
      ...latest,
      __provider: "copilot",
    });
  });

  it("keeps the selected session reference when metadata is unchanged", () => {
    const selected: ProjectSession = {
      id: "session-1",
      summary: "Investigate histogram sending logic",
      __provider: "copilot",
    };

    expect(mergeSelectedSessionMetadata(selected, selected, "copilot")).toBe(
      selected,
    );
  });

  it("converges after merging a non-first session change (no render loop)", () => {
    const previous: Project[] = [
      {
        name: "project",
        displayName: "Project",
        fullPath: "/project",
        sessions: [
          { id: "session-1", title: "Untouched", messageCount: 3 },
          { id: "session-2", title: "Changed", messageCount: 5, isRead: true },
        ],
      },
    ];
    const updated: Project[] = [
      {
        ...previous[0],
        sessions: [
          { id: "session-1", title: "Untouched", messageCount: 3 },
          { id: "session-2", title: "Changed", messageCount: 5, isRead: false },
        ],
      },
    ];

    const merged = mergeProjects(previous, updated);
    expect(merged).not.toBe(previous);

    // A second pass over the same payload must return the merged array unchanged,
    // otherwise the projects_updated effect re-renders forever.
    expect(mergeProjects(merged, updated)).toBe(merged);
  });

  it("reuses unchanged project and session references", () => {
    const untouched: Project = {
      name: "other",
      displayName: "Other",
      fullPath: "/other",
      sessions: [{ id: "s", title: "keep", messageCount: 1 }],
    };
    const changed: Project = {
      name: "project",
      displayName: "Project",
      fullPath: "/project",
      sessions: [
        { id: "a", title: "A", messageCount: 1 },
        { id: "b", title: "B", messageCount: 5, isRead: true },
      ],
    };
    const updated: Project[] = [
      untouched,
      {
        ...changed,
        sessions: [
          changed.sessions![0],
          { id: "b", title: "B", messageCount: 5, isRead: false },
        ],
      },
    ];

    const merged = mergeProjects([untouched, changed], updated);
    expect(merged[0]).toBe(untouched);
    expect(merged[1].sessions![0]).toBe(changed.sessions![0]);
    expect(merged[1].sessions![1].isRead).toBe(false);
  });
});

describe("removeSessionFromProjects", () => {
  const makeProject = (
    name: string,
    collections: Partial<Pick<Project, "sessions" | "codexSessions" | "cursorSessions" | "geminiSessions" | "copilotSessions">>,
    total: number,
  ): Project => ({
    name,
    displayName: name,
    fullPath: `/${name}`,
    sessionMeta: { total },
    ...collections,
  });

  it("only decrements the owning project's session total", () => {
    const owner = makeProject("owner", { sessions: [{ id: "target" }, { id: "keep" }] }, 2);
    const other = makeProject("other", { sessions: [{ id: "unrelated" }] }, 5);
    const emptyTotal = makeProject("empty-total", {}, 0);

    const next = removeSessionFromProjects([owner, other, emptyTotal], "target");

    expect(next[0].sessions).toEqual([{ id: "keep" }]);
    expect(next[0].sessionMeta?.total).toBe(1);
    // Non-owning projects keep both their count and their reference.
    expect(next[1]).toBe(other);
    expect(next[1].sessionMeta?.total).toBe(5);
    expect(next[2]).toBe(emptyTotal);
    expect(next[2].sessionMeta?.total).toBe(0);
  });

  it.each([
    "sessions",
    "codexSessions",
    "cursorSessions",
    "geminiSessions",
    "copilotSessions",
  ] as const)("finds the session in %s", (collection) => {
    const owner = makeProject("owner", { [collection]: [{ id: "target" }] } as Partial<Project>, 3);
    const other = makeProject("other", { sessions: [{ id: "unrelated" }] }, 4);

    const next = removeSessionFromProjects([owner, other], "target");

    expect(next[0].sessionMeta?.total).toBe(2);
    expect(next[0][collection]).toEqual([]);
    expect(next[1]).toBe(other);
  });

  it("never drops the total below zero", () => {
    const owner = makeProject("owner", { sessions: [{ id: "target" }] }, 0);

    const next = removeSessionFromProjects([owner], "target");

    expect(next[0].sessionMeta?.total).toBe(0);
  });

  it("leaves every project untouched when no project contains the session", () => {
    const first = makeProject("first", { sessions: [{ id: "a" }] }, 1);
    const second = makeProject("second", { codexSessions: [{ id: "b" }] }, 2);

    const next = removeSessionFromProjects([first, second], "missing");

    expect(next[0]).toBe(first);
    expect(next[1]).toBe(second);
  });
});
