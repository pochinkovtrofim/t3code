import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";

import { useManagedProjectGroups } from "../hooks/useManagedProjectGroups";
import { useNowMinute } from "../hooks/useNowMinute";
import { useOpenProjectThread } from "../hooks/useOpenProjectThread";
import { environmentAtomList, environmentIdsKey } from "../state/environmentAtomList";
import { projectEnvironment } from "../state/projects";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import { ProjectFavicon } from "./ProjectFavicon";
import { describeProjectThreadEntry } from "./projectThreadEntry.logic";
import type { ProjectGroupManager } from "./sidebar/projectGroups.logic";
import { useProjectThreadStatus } from "./sidebar/projectThreadStatus";

const ensurePermissionsAtom = environmentAtomList(
  "web-project-thread-ensure-permissions",
  (environmentId) => projectEnvironment.ensureThread.permissionAtom(environmentId),
);

export function useProjectThreadPaletteItem(): CommandPaletteSubmenuItem | null {
  const navigate = useNavigate();
  const navigateToThread = (threadRef: ScopedThreadRef) =>
    navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  const groups = useManagedProjectGroups();
  const projectThread = useOpenProjectThread(navigateToThread);
  const ensureEnvironmentIds = [
    ...new Set(
      groups.flatMap(({ manager }) =>
        manager.kind === "ensure" ? [manager.projectRef.environmentId] : [],
      ),
    ),
  ];
  const ensurePermissions = useAtomValue(
    ensurePermissionsAtom(environmentIdsKey(ensureEnvironmentIds)),
  );
  if (groups.length === 0) return null;

  const items = groups.map(({ project, manager }): CommandPaletteActionItem => {
    const canEnsure =
      manager.kind === "open" ||
      ensurePermissions[ensureEnvironmentIds.indexOf(manager.projectRef.environmentId)] === true;
    return {
      kind: "action",
      value: `open-project-thread:${project.projectKey}`,
      searchTerms: [project.displayName, project.title, project.workspaceRoot],
      title: project.displayName,
      description: <ProjectThreadPaletteDescription manager={manager} canEnsure={canEnsure} />,
      icon: <ProjectFavicon project={project} className={ITEM_ICON_CLASS} />,
      disabled: !canEnsure,
      run: async () => {
        if (manager.kind === "open") {
          await navigateToThread(scopeThreadRef(manager.thread.environmentId, manager.thread.id));
        } else {
          await projectThread.open(manager.projectRef);
        }
      },
    };
  });
  return {
    kind: "submenu",
    value: "action:open-project-thread",
    searchTerms: ["project thread", "manager", "open", "project"],
    title: "Open project thread...",
    icon: <MessagesSquareIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <MessagesSquareIcon className={ADDON_ICON_CLASS} />,
    groups: [{ value: "open-project-thread", label: "Projects", items }],
  };
}

function ProjectThreadPaletteDescription(props: {
  readonly manager: ProjectGroupManager;
  readonly canEnsure: boolean;
}) {
  const status = useProjectThreadStatus(props.manager);
  const nowMinute = useNowMinute();
  return describeProjectThreadEntry({
    manager: props.manager,
    statusLabel: status?.label ?? null,
    canEnsure: props.canEnsure,
    pending: false,
    nowMs: Date.parse(`${nowMinute}:00.000Z`),
  }).subLine;
}
