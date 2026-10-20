import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import { describeProjectThreadEntry } from "./projectThreadEntry.logic";
import type { ProjectGroupManager } from "./sidebar/projectGroups.logic";

const environmentId = EnvironmentId.make("env-primary");
const projectId = ProjectId.make("acme");
const nowMs = Date.parse("2026-03-01T12:00:00.000Z");

const openManager: ProjectGroupManager = {
  kind: "open",
  thread: makeThreadFixture({
    id: ThreadId.make("project-thread:acme"),
    environmentId,
    projectId,
    updatedAt: "2026-03-01T11:55:00.000Z",
  }),
  threadKey: "env-primary:project-thread:acme",
};
const ensureManager: ProjectGroupManager = {
  kind: "ensure",
  projectRef: { environmentId, projectId },
};

function describeEntry(
  manager: ProjectGroupManager,
  overrides: { statusLabel?: string | null; canEnsure?: boolean; pending?: boolean } = {},
) {
  return describeProjectThreadEntry({
    manager,
    statusLabel: overrides.statusLabel ?? null,
    canEnsure: overrides.canEnsure ?? true,
    pending: overrides.pending ?? false,
    nowMs,
  });
}

describe("describeProjectThreadEntry", () => {
  it("shows when an existing project thread was last updated", () => {
    expect(describeEntry(openManager)).toEqual({ subLine: "Updated 5m ago", disabled: false });
  });

  it("leads with the project thread's status", () => {
    expect(describeEntry(openManager, { statusLabel: "Working" }).subLine).toBe(
      "Working · updated 5m ago",
    );
  });

  it("says there is no project thread yet when clicking would create one", () => {
    expect(describeEntry(ensureManager)).toEqual({
      subLine: "No project thread yet",
      disabled: false,
    });
  });

  it("disables creating one and says why when the connection cannot", () => {
    expect(describeEntry(ensureManager, { canEnsure: false })).toEqual({
      subLine: "No project thread yet. This connection can't start one.",
      disabled: true,
    });
  });

  it("keeps an existing project thread openable without permission to create one", () => {
    expect(describeEntry(openManager, { canEnsure: false }).disabled).toBe(false);
  });

  it("says it is opening while the project thread is being created", () => {
    expect(describeEntry(ensureManager, { pending: true })).toEqual({
      subLine: "Opening project thread…",
      disabled: false,
    });
  });
});
