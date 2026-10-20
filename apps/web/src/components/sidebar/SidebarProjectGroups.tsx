import { useAtomValue } from "@effect/atom-react";
import { scopedProjectKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import {
  AlarmClockIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  FolderIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
  ShieldQuestionIcon,
  type LucideIcon,
} from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useOpenProjectThread } from "../../hooks/useOpenProjectThread";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "../../lib/utils";
import { projectEnvironment } from "../../state/projects";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  hasUnseenCompletion,
  isTrailingDoubleClick,
  resolveSidebarThreadStatus,
  resolveSidebarV2TopStatus,
  resolveThreadLastVisitedAt,
  type SidebarV2TopStatusKind,
} from "../Sidebar.logic";
import { createSidebarListMotion } from "../Sidebar.motion";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type {
  ProjectGroupManager,
  SidebarProjectGroup,
  SidebarProjectGroupList,
} from "./projectGroups.logic";

// The header shows the statuses rows derive, in its own compact form.
const STATUS_PRESENTATION: Record<
  SidebarV2TopStatusKind,
  { readonly label: string; readonly Icon: LucideIcon; readonly className: string }
> = {
  working: { label: "Working", Icon: CircleDashedIcon, className: "text-info" },
  waiting: { label: "Waiting", Icon: CircleDotDashedIcon, className: "text-muted-foreground" },
  approval: { label: "Approval", Icon: ShieldQuestionIcon, className: "text-warning-foreground" },
  input: {
    label: "Input",
    Icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  failed: { label: "Failed", Icon: CircleAlertIcon, className: "text-error" },
  limited: { label: "Limited", Icon: CircleAlertIcon, className: "text-warning" },
  done: { label: "Done", Icon: CircleCheckIcon, className: "text-success" },
  woke: { label: "Woke", Icon: AlarmClockIcon, className: "text-warning" },
};

/**
 * The grouped Active section. It is one non-sortable item in the sidebar's
 * sortable list, so the drag machinery treats it as the gap before the first
 * shelf and resolves drops over it to Active.
 */
export function SidebarProjectGroups(props: {
  readonly list: SidebarProjectGroupList;
  readonly routeRowThreadKey: string | null;
  readonly motionPaused: boolean;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => unknown;
  readonly renderRow: (thread: EnvironmentThreadShell) => ReactNode;
}) {
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const handleNewThread = useNewThreadHandler();
  const { isMobile, setOpenMobile } = useSidebar();
  const projectThread = useOpenProjectThread(props.onOpenThread);
  const motionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const attachListMotion = (node: HTMLUListElement | null) => {
    motionRef.current?.dispose();
    motionRef.current = node === null ? null : createSidebarListMotion(node);
    motionRef.current?.update(false);
  };
  const motionPass = { layoutKey: props.list.layoutKey, animate: !props.motionPaused };
  useLayoutEffect(() => {
    motionRef.current?.update(motionPass.animate);
  }, [motionPass]);

  const toggleGroup = useStableCallback((group: SidebarProjectGroup) =>
    setProjectExpanded(group.expansionKeys, !group.expanded),
  );
  const openManager = useStableCallback((manager: ProjectGroupManager) => {
    if (manager.kind === "open") {
      props.onOpenThread(scopeThreadRef(manager.thread.environmentId, manager.thread.id));
    } else {
      void projectThread.open(manager.projectRef);
    }
  });
  const startThread = useStableCallback((target: ScopedProjectRef) => {
    if (isMobile) setOpenMobile(false);
    void handleNewThread(target).catch((error: unknown) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      ),
    );
  });

  if (props.list.groups.length === 0) return null;
  return (
    <li className="list-none">
      <ul ref={attachListMotion} role="presentation" className="relative flex flex-col gap-px">
        {props.list.groups.flatMap((group) => [
          <SidebarProjectGroupHeader
            key={`group:${group.key}`}
            group={group}
            isActive={
              group.manager?.kind === "open" && group.manager.threadKey === props.routeRowThreadKey
            }
            pending={
              group.manager?.kind === "ensure" &&
              projectThread.pendingProjectKeys.has(scopedProjectKey(group.manager.projectRef))
            }
            onOpenManager={openManager}
            onToggle={toggleGroup}
            onNewThread={startThread}
          />,
          ...group.rows.map((thread) => props.renderRow(thread)),
        ])}
      </ul>
    </li>
  );
}

function SidebarProjectGroupHeader(props: {
  readonly group: SidebarProjectGroup;
  readonly isActive: boolean;
  readonly pending: boolean;
  readonly onOpenManager: (manager: ProjectGroupManager) => void;
  readonly onToggle: (group: SidebarProjectGroup) => void;
  readonly onNewThread: (target: ScopedProjectRef) => void;
}) {
  const { group } = props;
  const manager = group.manager;
  const openThread = manager?.kind === "open" ? manager.thread : null;
  const localLastVisitedAt = useUiStateStore((state) =>
    manager?.kind === "open" ? state.threadLastVisitedAtById[manager.threadKey] : undefined,
  );
  // Without the scope to ensure, the header stays a plain project header
  // instead of offering a click the server would refuse.
  const canEnsure = useAtomValue(
    projectEnvironment.ensureThread.permissionAtom(
      manager?.kind === "ensure" ? manager.projectRef.environmentId : null,
    ),
  );
  const opensManager = manager !== null && (manager.kind === "open" || canEnsure);
  const statusKind =
    openThread === null
      ? null
      : resolveSidebarV2TopStatus({
          status: resolveSidebarThreadStatus(openThread),
          isUnread: hasUnseenCompletion({
            ...openThread,
            lastVisitedAt: resolveThreadLastVisitedAt(openThread.lastVisitedAt, localLastVisitedAt),
          }),
          isWoke: false,
        });
  const status = statusKind === null ? null : STATUS_PRESENTATION[statusKind];
  const collapsedSummary =
    !group.expanded && group.hiddenCount > 0
      ? {
          count: group.hiddenCount,
          attention:
            group.hiddenAttention === null ? null : STATUS_PRESENTATION[group.hiddenAttention],
        }
      : null;
  const accessibleLabel = [
    group.label,
    opensManager ? "project thread" : null,
    status?.label ?? null,
    collapsedSummary
      ? `${collapsedSummary.count} hidden${collapsedSummary.attention ? `, ${collapsedSummary.attention.label}` : ""}`
      : null,
  ]
    .filter((part) => part !== null)
    .join(", ");

  const activate = () => {
    if (opensManager) props.onOpenManager(manager);
    else props.onToggle(group);
  };
  const handleClick = (event: ReactMouseEvent) => {
    if (!isTrailingDoubleClick(event.detail)) activate();
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activate();
  };
  const newThreadTarget = group.newThreadTarget;

  return (
    <li className="list-none" data-testid="sidebar-project-group">
      <div
        role="button"
        tabIndex={0}
        aria-label={accessibleLabel}
        aria-current={props.isActive ? "page" : undefined}
        aria-expanded={opensManager ? undefined : group.expanded}
        aria-busy={props.pending || undefined}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
          props.pending && "cursor-progress",
        )}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-expanded={group.expanded}
          aria-label={`${group.expanded ? "Collapse" : "Expand"} ${group.label}`}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggle(group);
          }}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 transition-transform", !group.expanded && "-rotate-90")}
          />
        </Button>
        {group.project ? (
          <ProjectFavicon project={group.project} className="size-4 shrink-0" />
        ) : (
          <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span aria-hidden className="min-w-0 flex-1 truncate text-sm font-medium">
          {group.label}
        </span>
        {status ? (
          <status.Icon aria-hidden className={cn("size-4 shrink-0", status.className)} />
        ) : null}
        {collapsedSummary ? (
          <span
            aria-hidden
            className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-secondary-label"
          >
            {collapsedSummary.attention ? (
              <collapsedSummary.attention.Icon
                className={cn("size-3.5", collapsedSummary.attention.className)}
              />
            ) : null}
            {collapsedSummary.count}
          </span>
        ) : null}
        {newThreadTarget ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`New thread in ${group.label}`}
            onClick={(event) => {
              event.stopPropagation();
              props.onNewThread(newThreadTarget);
            }}
          >
            <PlusIcon aria-hidden className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </li>
  );
}
