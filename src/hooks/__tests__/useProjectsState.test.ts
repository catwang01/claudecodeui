import { describe, expect, it } from "vitest";
import type { Project, ProjectSession } from "../../types/app";
import {
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
});
