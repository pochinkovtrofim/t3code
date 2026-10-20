import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { isProjectThreadId } from "@t3tools/shared/projectThread";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { legacyProjectCwdPreferenceKey, resolveProjectExpanded } from "../../uiStateStore";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";

export type ProjectGroupManager =
  | { readonly kind: "open"; readonly thread: EnvironmentThreadShell; readonly threadKey: string }
  | { readonly kind: "ensure"; readonly projectRef: ScopedProjectRef };

export interface ProjectGroupLift {
  readonly managerByGroupKey: ReadonlyMap<string, ProjectGroupManager>;
  /** Every thread except the open managers, which their group headers represent. */
  readonly rowThreads: readonly EnvironmentThreadShell[];
}

export type SidebarProjectGroupAttention = Extract<
  SidebarThreadStatus,
  "approval" | "input" | "failed" | "limited" | "working"
>;

export interface SidebarProjectGroup {
  readonly key: string;
  /** null for the "No project" tail when no scratch project exists. */
  readonly project: SidebarProjectSnapshot | null;
  readonly label: string;
  readonly manager: ProjectGroupManager | null;
  readonly expanded: boolean;
  readonly expansionKeys: readonly string[];
  readonly rows: readonly EnvironmentThreadShell[];
  readonly hiddenCount: number;
  readonly hiddenAttention: SidebarProjectGroupAttention | null;
  readonly newThreadTarget: ScopedProjectRef | null;
}

export interface SidebarProjectGroupList {
  readonly groups: readonly SidebarProjectGroup[];
  /** Rendered rows in screen order, for jump hints, traversal, range selection and sweeps. */
  readonly visibleThreads: readonly EnvironmentThreadShell[];
  readonly managerThreads: readonly EnvironmentThreadShell[];
  /** Changes only when a group or row appears, disappears or moves. */
  readonly layoutKey: string;
}

export const NO_PROJECT_GROUP_KEY = "sidebar-group:no-project";

const ATTENTION_RANK: Record<SidebarProjectGroupAttention, number> = {
  working: 1,
  limited: 2,
  failed: 3,
  input: 4,
  approval: 5,
};

function isAttention(status: SidebarThreadStatus): status is SidebarProjectGroupAttention {
  return Object.hasOwn(ATTENTION_RANK, status);
}

function memberKey(environmentId: string, projectId: string): string {
  return `${environmentId}:${projectId}`;
}

function threadKeyOf(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

// Same order as ProjectThreadService.findExisting, so the header opens the
// thread the server would return from ensure.
function oldestFirst(left: EnvironmentThreadShell, right: EnvironmentThreadShell): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Picks one manager per project group. A thread is lifted out of the rows if
 * and only if it is a group's open manager, so any other project thread (its
 * project has the feature off, its server predates it, or it belongs to a
 * second checkout) stays an ordinary, reachable row.
 */
export function liftProjectGroupManagers(input: {
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly threads: readonly EnvironmentThreadShell[];
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
}): ProjectGroupLift {
  const isManaged = (member: SidebarProjectGroupMember) => {
    if (member.isScratch) return false;
    const config = input.serverConfigs.get(member.environmentId);
    return (
      config?.environment.capabilities.projectThreads === true &&
      resolveProjectSettings(config.settings, member.id, member).settings.projectThreadsEnabled
    );
  };
  const managedGroups = input.groups.flatMap((group) => {
    const members = group.isScratch ? [] : group.memberProjects.filter(isManaged);
    return members.length === 0 ? [] : [{ group, members }];
  });
  const managerByGroupKey = new Map<string, ProjectGroupManager>();
  if (managedGroups.length === 0) return { managerByGroupKey, rowThreads: input.threads };

  const candidatesByMember = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of input.threads) {
    if (!isProjectThreadId(thread.id) || thread.archivedAt !== null || thread.deletedAt !== null) {
      continue;
    }
    const key = memberKey(thread.environmentId, thread.projectId);
    const candidates = candidatesByMember.get(key);
    if (candidates) candidates.push(thread);
    else candidatesByMember.set(key, [thread]);
  }
  const candidatesOf = (members: readonly SidebarProjectGroupMember[]) =>
    members.flatMap(
      (member) => candidatesByMember.get(memberKey(member.environmentId, member.id)) ?? [],
    );

  const liftedKeys = new Set<string>();
  for (const { group, members } of managedGroups) {
    const representative = members.find(
      (member) => member.environmentId === group.environmentId && member.id === group.id,
    );
    const [manager] = [
      ...(representative ? candidatesOf([representative]).toSorted(oldestFirst) : []),
      ...candidatesOf(members).toSorted(oldestFirst),
    ];
    if (manager !== undefined) {
      const threadKey = threadKeyOf(manager);
      liftedKeys.add(threadKey);
      managerByGroupKey.set(group.projectKey, { kind: "open", thread: manager, threadKey });
      continue;
    }
    const target = representative ?? members[0]!;
    managerByGroupKey.set(group.projectKey, {
      kind: "ensure",
      projectRef: scopeProjectRef(target.environmentId, target.id),
    });
  }
  return {
    managerByGroupKey,
    rowThreads:
      liftedKeys.size === 0
        ? input.threads
        : input.threads.filter((thread) => !liftedKeys.has(threadKeyOf(thread))),
  };
}

// fork: mirrors LegacySidebar.tsx projectExpansionPreferenceKeys; keep in sync
// so both sidebars read and write the same per-device collapse state.
function projectGroupExpansionKeys(group: SidebarProjectSnapshot): readonly string[] {
  return [
    group.projectKey,
    ...group.memberProjects.map((member) => member.physicalProjectKey),
    ...group.memberProjects.map((member) => legacyProjectCwdPreferenceKey(member.workspaceRoot)),
  ];
}

/**
 * Buckets the Active section by project in its existing order. Threads without
 * a known project join the scratch group, which always comes last. A group
 * shows when it has rows or an open manager, and a collapsed group still shows
 * the route row, like LegacySidebar and the collapsed shelves.
 */
export function layoutSidebarProjectGroups(input: {
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly managerByGroupKey: ReadonlyMap<string, ProjectGroupManager>;
  readonly projectScopeKey: string | null;
  readonly projectExpandedById: Readonly<Record<string, boolean>>;
  readonly routeRowThreadKey: string | null;
}): SidebarProjectGroupList {
  const scratch = input.projectGroups.find((group) => group.isScratch) ?? null;
  const tailKey = scratch?.projectKey ?? NO_PROJECT_GROUP_KEY;
  const groupKeyByMember = new Map<string, string>();
  for (const group of input.projectGroups) {
    if (group.isScratch) continue;
    for (const ref of group.memberProjectRefs) {
      groupKeyByMember.set(memberKey(ref.environmentId, ref.projectId), group.projectKey);
    }
  }
  const buckets = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of input.activeThreads) {
    const key = groupKeyByMember.get(memberKey(thread.environmentId, thread.projectId)) ?? tailKey;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(thread);
    else buckets.set(key, [thread]);
  }

  const groups: SidebarProjectGroup[] = [];
  for (const project of [...input.projectGroups.filter((group) => !group.isScratch), scratch]) {
    const key = project?.projectKey ?? NO_PROJECT_GROUP_KEY;
    if (input.projectScopeKey !== null && key !== input.projectScopeKey) continue;
    const bucket = buckets.get(key) ?? [];
    const manager = input.managerByGroupKey.get(key) ?? null;
    if (bucket.length === 0 && manager?.kind !== "open") continue;
    const expansionKeys =
      project === null ? [NO_PROJECT_GROUP_KEY] : projectGroupExpansionKeys(project);
    const expanded = resolveProjectExpanded(input.projectExpandedById, expansionKeys);
    const isRouteRow = (thread: EnvironmentThreadShell) =>
      threadKeyOf(thread) === input.routeRowThreadKey;
    const rows = expanded ? bucket : bucket.filter(isRouteRow);
    const hidden = expanded ? [] : bucket.filter((thread) => !isRouteRow(thread));
    const hiddenAttention = hidden.reduce<SidebarProjectGroupAttention | null>((top, thread) => {
      const status = resolveSidebarThreadStatus(thread);
      return isAttention(status) && (top === null || ATTENTION_RANK[status] > ATTENTION_RANK[top])
        ? status
        : top;
    }, null);
    groups.push({
      key,
      project,
      label: project?.displayName ?? "No project",
      manager,
      expanded,
      expansionKeys,
      rows,
      hiddenCount: hidden.length,
      hiddenAttention,
      newThreadTarget: project === null ? null : scopeProjectRef(project.environmentId, project.id),
    });
  }
  return {
    groups,
    visibleThreads: groups.flatMap((group) => group.rows),
    managerThreads: groups.flatMap((group) =>
      group.manager?.kind === "open" ? [group.manager.thread] : [],
    ),
    layoutKey: groups
      .map((group) => [group.key, ...group.rows.map(threadKeyOf)].join(","))
      .join("\n"),
  };
}
