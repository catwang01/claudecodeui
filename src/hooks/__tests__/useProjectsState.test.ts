import { describe, expect, it } from "vitest";
import type { Project, ProjectSession } from "../../types/app";
import {
  mergeProjects,
  mergeSelectedSessionMetadata,
  projectsHaveChanges,
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
