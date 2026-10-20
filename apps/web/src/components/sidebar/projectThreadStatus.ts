import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  type LucideIcon,
} from "lucide-react";

import { useUiStateStore } from "../../uiStateStore";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveSidebarV2TopStatus,
  resolveThreadLastVisitedAt,
  type SidebarV2TopStatusKind,
} from "../Sidebar.logic";
import type { ProjectGroupManager } from "./projectGroups.logic";

export interface ProjectThreadStatusPresentation {
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly className: string;
}

export const PROJECT_THREAD_STATUS_PRESENTATION: Record<
  SidebarV2TopStatusKind,
  ProjectThreadStatusPresentation
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

export function useProjectThreadStatus(
  manager: ProjectGroupManager | null,
): ProjectThreadStatusPresentation | null {
  const openThread = manager?.kind === "open" ? manager.thread : null;
  const localLastVisitedAt = useUiStateStore((state) =>
    manager?.kind === "open" ? state.threadLastVisitedAtById[manager.threadKey] : undefined,
  );
  if (openThread === null) return null;
  const kind = resolveSidebarV2TopStatus({
    status: resolveSidebarThreadStatus(openThread),
    isUnread: hasUnseenCompletion({
      ...openThread,
      lastVisitedAt: resolveThreadLastVisitedAt(openThread.lastVisitedAt, localLastVisitedAt),
    }),
    isWoke: false,
  });
  return kind === null ? null : PROJECT_THREAD_STATUS_PRESENTATION[kind];
}
