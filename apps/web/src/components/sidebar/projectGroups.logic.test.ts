import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import type { Project, Thread } from "../../types";
import { legacyProjectCwdPreferenceKey } from "../../uiStateStore";
import {
  layoutSidebarProjectGroups,
  liftProjectGroupManagers,
  listManagedProjectGroups,
  NO_PROJECT_GROUP_KEY,
} from "./projectGroups.logic";

const primary = EnvironmentId.make("env-primary");
const remote = EnvironmentId.make("env-remote");

function makeProject(overrides: Partial<Project> & Pick<Project, "id">): Project {
  return {
    environmentId: primary,
    title: overrides.id,
    workspaceRoot: `/repos/${overrides.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

const sharedRepository = {
  canonicalKey: "github.com/example/acme",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/acme.git",
  },
};
const acme = makeProject({ id: ProjectId.make("acme"), repositoryIdentity: sharedRepository });
const acmeRemote = makeProject({
  id: ProjectId.make("acme-remote"),
  environmentId: remote,
  repositoryIdentity: sharedRepository,
});
const billing = makeProject({ id: ProjectId.make("billing") });
const scratch = makeProject({
  id: ProjectId.make("scratch"),
  title: "No project",
  isScratch: true,
});

function groupsOf(projects: readonly Project[]) {
  return buildSidebarProjectSnapshots({
    projects,
    groupScratchProjects: true,
    settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: primary,
    resolveEnvironmentLabel: () => null,
  });
}

function thread(
  id: string,
  project: Pick<Project, "id" | "environmentId">,
  overrides: ThreadFixtureOverrides = {},
): Thread {
  return makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: project.environmentId,
    projectId: project.id,
    ...overrides,
  });
}

function runtime(status: ThreadRuntimeSummary["status"]): ThreadRuntimeSummary {
  return {
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function serverConfig(
  options: { projectThreads?: boolean; disabledProjects?: readonly ProjectId[] } = {},
): EnvironmentServerConfig {
  return {
    environment: { capabilities: { projectThreads: options.projectThreads ?? true } },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        (options.disabledProjects ?? []).map((id) => [id, { projectThreadsEnabled: false }]),
      ),
    },
  } as unknown as EnvironmentServerConfig;
}

const bothEnvironments = new Map([
  [primary, serverConfig()],
  [remote, serverConfig()],
]);

function ids(threads: readonly Thread[]) {
  return threads.map((entry) => entry.id);
}

function layout(input: {
  readonly projects: readonly Project[];
  readonly threads: readonly Thread[];
  readonly serverConfigs?: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly projectScopeKey?: string | null;
  readonly projectExpandedById?: Record<string, boolean>;
  readonly routeRowThreadKey?: string | null;
}) {
  const projectGroups = groupsOf(input.projects);
  const lift = liftProjectGroupManagers({
    groups: projectGroups,
    threads: input.threads,
    serverConfigs: input.serverConfigs ?? bothEnvironments,
  });
  return {
    projectGroups,
    lift,
    list: layoutSidebarProjectGroups({
      projectGroups,
      activeThreads: lift.rowThreads,
      managerByGroupKey: lift.managerByGroupKey,
      projectScopeKey: input.projectScopeKey ?? null,
      projectExpandedById: input.projectExpandedById ?? {},
      routeRowThreadKey: input.routeRowThreadKey ?? null,
    }),
  };
}

describe("liftProjectGroupManagers", () => {
  it("opens the oldest live project thread and keeps a younger one as a row", () => {
    const older = thread("project-thread:old", billing, { createdAt: "2026-01-01T00:00:00.000Z" });
    const younger = thread("project-thread:new", billing, {
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const archived = thread("project-thread:archived", billing, {
      createdAt: "2025-12-01T00:00:00.000Z",
      archivedAt: "2026-03-01T00:00:00.000Z",
    });
    const { lift, projectGroups } = layout({
      projects: [billing],
      threads: [younger, archived, older],
    });

    expect(lift.managerByGroupKey.get(projectGroups[0]!.projectKey)).toMatchObject({
      kind: "open",
      thread: { id: older.id },
    });
    expect(ids(lift.rowThreads)).toEqual([younger.id, archived.id]);
  });

  it("prefers the representative checkout and leaves the other checkout's project thread as a row", () => {
    const remoteManager = thread("project-thread:remote", acmeRemote, {
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    const localManager = thread("project-thread:local", acme, {
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const { lift, list } = layout({
      projects: [acme, acmeRemote],
      threads: [remoteManager, localManager],
    });

    expect(list.groups).toHaveLength(1);
    expect(list.groups[0]?.manager).toMatchObject({
      kind: "open",
      thread: { id: localManager.id },
    });
    expect(ids(lift.rowThreads)).toEqual([remoteManager.id]);
    expect(ids(list.visibleThreads)).toEqual([remoteManager.id]);
  });

  it("asks the server to ensure one on the representative checkout when none exists", () => {
    const { list } = layout({
      projects: [acme, acmeRemote],
      threads: [thread("ordinary", acme)],
    });

    expect(list.groups[0]?.manager).toEqual({
      kind: "ensure",
      projectRef: { environmentId: primary, projectId: acme.id },
    });
  });

  it("falls back to a managed checkout when the representative has the feature off", () => {
    const { list } = layout({
      projects: [acme, acmeRemote],
      threads: [thread("ordinary", acme)],
      serverConfigs: new Map([
        [primary, serverConfig({ projectThreads: false })],
        [remote, serverConfig()],
      ]),
    });

    expect(list.groups[0]?.manager).toEqual({
      kind: "ensure",
      projectRef: { environmentId: remote, projectId: acmeRemote.id },
    });
  });

  it.each([
    ["the project turned project threads off", serverConfig({ disabledProjects: [billing.id] })],
    ["the server lacks the capability", serverConfig({ projectThreads: false })],
  ])("keeps a project thread as an ordinary row when %s", (_case, config) => {
    const projectThread = thread("project-thread:billing", billing);
    const { lift, list } = layout({
      projects: [billing],
      threads: [projectThread],
      serverConfigs: new Map([[primary, config]]),
    });

    expect(lift.managerByGroupKey.size).toBe(0);
    expect(ids(lift.rowThreads)).toEqual([projectThread.id]);
    expect(list.groups[0]?.manager).toBeNull();
    expect(ids(list.groups[0]?.rows ?? [])).toEqual([projectThread.id]);
  });

  it("never gives the scratch group a manager", () => {
    const scratchThread = thread("project-thread:scratch", scratch);
    const { lift } = layout({ projects: [scratch], threads: [scratchThread] });

    expect(lift.managerByGroupKey.size).toBe(0);
    expect(ids(lift.rowThreads)).toEqual([scratchThread.id]);
  });
});

describe("layoutSidebarProjectGroups", () => {
  it("shows a group with an open manager and no rows, and hides one that would only ensure", () => {
    const manager = thread("project-thread:billing", billing);
    const { list } = layout({ projects: [acme, billing], threads: [manager] });

    expect(list.groups.map((group) => group.label)).toEqual(["billing"]);
    expect(list.groups[0]?.rows).toEqual([]);
    expect(ids(list.managerThreads)).toEqual([manager.id]);
  });

  it("puts the scratch group last and sends threads of unknown projects to it", () => {
    const orphan = thread("orphan", { id: ProjectId.make("gone"), environmentId: primary });
    const { list } = layout({
      projects: [scratch, billing],
      threads: [thread("scratch-work", scratch), orphan, thread("billing-work", billing)],
    });

    expect(list.groups.map((group) => [group.label, ids(group.rows)])).toEqual([
      ["billing", ["billing-work"]],
      ["No project", ["scratch-work", "orphan"]],
    ]);
    expect(list.groups[1]?.newThreadTarget).toEqual({
      environmentId: primary,
      projectId: scratch.id,
    });
  });

  it("collects unknown projects in a plain No project group when there is no scratch project", () => {
    const orphan = thread("orphan", { id: ProjectId.make("gone"), environmentId: primary });
    const { list } = layout({ projects: [billing], threads: [orphan] });

    expect(list.groups).toEqual([
      expect.objectContaining({
        key: NO_PROJECT_GROUP_KEY,
        label: "No project",
        project: null,
        manager: null,
        newThreadTarget: null,
      }),
    ]);
  });

  it("keeps only the route row of a collapsed group and counts the rest as hidden", () => {
    const routeRow = thread("route", billing);
    const { projectGroups, list } = layout({
      projects: [billing],
      threads: [thread("first", billing), routeRow, thread("third", billing)],
      projectExpandedById: { [groupsOf([billing])[0]!.projectKey]: false },
      routeRowThreadKey: `${primary}:route`,
    });

    expect(projectGroups).toHaveLength(1);
    expect(list.groups[0]).toMatchObject({ expanded: false, hiddenCount: 2 });
    expect(ids(list.groups[0]?.rows ?? [])).toEqual([routeRow.id]);
    expect(ids(list.visibleThreads)).toEqual([routeRow.id]);
  });

  it("honors a collapse LegacySidebar saved under the checkout path", () => {
    const { list } = layout({
      projects: [billing],
      threads: [thread("work", billing)],
      projectExpandedById: { [legacyProjectCwdPreferenceKey(billing.workspaceRoot)]: false },
    });

    expect(list.groups[0]).toMatchObject({ expanded: false, rows: [], hiddenCount: 1 });
  });

  it("shows only the scoped project", () => {
    const projectGroups = groupsOf([acme, billing]);
    const billingKey = projectGroups.find((group) => group.displayName === "billing")!.projectKey;
    const { list } = layout({
      projects: [acme, billing],
      threads: [thread("acme-work", acme), thread("billing-work", billing)],
      projectScopeKey: billingKey,
    });

    expect(list.groups.map((group) => group.key)).toEqual([billingKey]);
  });

  it("surfaces the most urgent hidden status: approval, then input, failed, working", () => {
    const hiddenAttention = (threads: readonly Thread[]) =>
      layout({
        projects: [billing],
        threads,
        projectExpandedById: { [legacyProjectCwdPreferenceKey(billing.workspaceRoot)]: false },
      }).list.groups[0]?.hiddenAttention;
    const working = thread("working", billing, { runtime: runtime("running") });
    const failed = thread("failed", billing, { runtime: runtime("failed") });
    const input = thread("input", billing, { hasPendingUserInput: true });
    const approval = thread("approval", billing, { hasPendingApprovals: true });
    const ready = thread("ready", billing);

    expect(hiddenAttention([ready])).toBeNull();
    expect(hiddenAttention([ready, working])).toBe("working");
    expect(hiddenAttention([working, failed])).toBe("failed");
    expect(hiddenAttention([failed, input, working])).toBe("input");
    expect(hiddenAttention([input, approval, failed])).toBe("approval");
  });

  it("keeps its layout key while rows only change status, and changes it when rows move", () => {
    const first = thread("first", billing);
    const second = thread("second", billing);
    const base = layout({ projects: [billing], threads: [first, second] }).list.layoutKey;

    expect(
      layout({
        projects: [billing],
        threads: [{ ...first, runtime: runtime("running") }, second],
      }).list.layoutKey,
    ).toBe(base);
    expect(layout({ projects: [billing], threads: [second, first] }).list.layoutKey).not.toBe(base);
    expect(
      layout({
        projects: [billing],
        threads: [first, second],
        projectExpandedById: { [legacyProjectCwdPreferenceKey(billing.workspaceRoot)]: false },
      }).list.layoutKey,
    ).not.toBe(base);
  });
});

describe("listManagedProjectGroups", () => {
  const docs = makeProject({ id: ProjectId.make("docs") });

  it("lists managed projects in sidebar order with the manager the sidebar header opens", () => {
    const acmeManager = thread("project-thread:acme", acme);
    const projects = [billing, acme, acmeRemote, scratch, docs];
    const threads = [acmeManager, thread("ordinary", billing)];
    const serverConfigs = new Map([
      [primary, serverConfig({ disabledProjects: [docs.id] })],
      [remote, serverConfig()],
    ]);

    const managed = listManagedProjectGroups({
      groups: groupsOf(projects),
      threads,
      serverConfigs,
    });

    expect(managed.map(({ project }) => project.displayName)).toEqual(["billing", "acme"]);
    expect(managed.map(({ manager }) => manager)).toEqual([
      { kind: "ensure", projectRef: { environmentId: primary, projectId: billing.id } },
      expect.objectContaining({
        kind: "open",
        thread: expect.objectContaining({ id: acmeManager.id }),
      }),
    ]);
    const { list } = layout({ projects, threads, serverConfigs });
    expect(list.groups.find((group) => group.label === "acme")?.manager).toEqual(
      managed[1]?.manager,
    );
  });

  it("lists nothing when no environment offers project threads", () => {
    expect(
      listManagedProjectGroups({
        groups: groupsOf([acme, billing]),
        threads: [thread("project-thread:acme", acme)],
        serverConfigs: new Map([[primary, serverConfig({ projectThreads: false })]]),
      }),
    ).toEqual([]);
  });
});
