import { useAtomValue } from "@effect/atom-react";
import { scopedProjectKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useManagedProjectGroups } from "~/hooks/useManagedProjectGroups";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useOpenProjectThread } from "~/hooks/useOpenProjectThread";
import { cn } from "~/lib/utils";
import { projectEnvironment } from "~/state/projects";
import { buildThreadRouteParams } from "~/threadRoutes";
import { ProjectFavicon } from "../ProjectFavicon";
import { describeProjectThreadEntry } from "../projectThreadEntry.logic";
import type { ManagedProjectGroup } from "../sidebar/projectGroups.logic";
import { useProjectThreadStatus } from "../sidebar/projectThreadStatus";

const HEADING_SAFE_LIST_HEIGHT = "max-h-[min(9rem,calc(50dvh-12rem))]";

export function DraftHeroProjectThreads() {
  const navigate = useNavigate();
  const groups = useManagedProjectGroups();
  const navigateToThread = (threadRef: ScopedThreadRef) =>
    navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  const projectThread = useOpenProjectThread(navigateToThread);

  if (groups.length === 0) return null;
  return (
    <nav aria-label="Project threads" className="mx-auto mt-4 w-full max-w-md">
      <ul className={cn("flex flex-col gap-px overflow-y-auto", HEADING_SAFE_LIST_HEIGHT)}>
        {groups.map((group) => (
          <DraftHeroProjectThreadItem
            key={group.project.projectKey}
            group={group}
            pending={
              group.manager.kind === "ensure" &&
              projectThread.pendingProjectKeys.has(scopedProjectKey(group.manager.projectRef))
            }
            onOpen={() => {
              const { manager } = group;
              if (manager.kind === "open") {
                void navigateToThread(
                  scopeThreadRef(manager.thread.environmentId, manager.thread.id),
                );
              } else {
                void projectThread.open(manager.projectRef);
              }
            }}
          />
        ))}
      </ul>
    </nav>
  );
}

function DraftHeroProjectThreadItem(props: {
  readonly group: ManagedProjectGroup;
  readonly pending: boolean;
  readonly onOpen: () => void;
}) {
  const { manager, project } = props.group;
  const status = useProjectThreadStatus(manager);
  const canEnsure = useAtomValue(
    projectEnvironment.ensureThread.permissionAtom(
      manager.kind === "ensure" ? manager.projectRef.environmentId : null,
    ),
  );
  const nowMinute = useNowMinute();
  const entry = describeProjectThreadEntry({
    manager,
    statusLabel: status?.label ?? null,
    canEnsure,
    pending: props.pending,
    nowMs: Date.parse(`${nowMinute}:00.000Z`),
  });

  return (
    <li>
      <button
        type="button"
        aria-disabled={entry.disabled || undefined}
        aria-busy={props.pending || undefined}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          entry.disabled ? "cursor-not-allowed opacity-64" : "cursor-pointer hover:bg-accent",
          props.pending && "cursor-progress",
        )}
        onClick={() => {
          if (!entry.disabled && !props.pending) props.onOpen();
        }}
      >
        <ProjectFavicon project={project} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">{project.displayName}</span>
          <span className="block truncate text-xs text-muted-foreground">{entry.subLine}</span>
        </span>
        {status ? (
          <status.Icon aria-hidden className={cn("size-4 shrink-0", status.className)} />
        ) : null}
      </button>
    </li>
  );
}
