import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { projectThreadEnforcement } from "@t3tools/shared/projectThread";
import { ScrollTextIcon } from "lucide-react";

import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { useServerConfigs } from "../../state/entities";
import { canShowProjectChangelog } from "../projectChangelog/projectChangelogPanel.logic";
import { isActiveProjectThread } from "../sidebar/projectGroups.logic";
import { Badge } from "../ui/badge";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ENFORCEMENT_BADGES = {
  "read-only": {
    label: "read-only manager",
    explanation:
      "This provider runs project-thread turns read-only. The thread launches and steers other threads but cannot change files itself.",
  },
  "prompt-only": {
    label: "manager · guidance only",
    explanation:
      "This provider does not run turns read-only. The project thread is told not to change files, but that is guidance, not a guarantee.",
  },
} as const;

export function ProjectThreadHeaderBadges(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly driver: ProviderDriverKind;
}) {
  const config = useServerConfigs().get(props.environmentId);
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const changelogOpen = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, threadRef) === "changelog",
  );
  if (props.projectId === null) return null;
  const thread = { id: props.threadId, projectId: props.projectId };
  if (!isActiveProjectThread(config, thread)) return null;
  const enforcement = ENFORCEMENT_BADGES[projectThreadEnforcement(props.driver)];
  return (
    <div className="ml-2 flex shrink-0 items-center gap-1.5">
      <Badge variant="info">Project thread</Badge>
      <Tooltip>
        <TooltipTrigger render={<Badge variant="outline">{enforcement.label}</Badge>} />
        <TooltipPopup side="bottom" className="max-w-72">
          {enforcement.explanation}
        </TooltipPopup>
      </Tooltip>
      {canShowProjectChangelog(config, thread) ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                pressed={changelogOpen}
                onPressedChange={() => useRightPanelStore.getState().toggle(threadRef, "changelog")}
                aria-label="Toggle project changelog"
                variant="ghost"
                size="sm"
              >
                <ScrollTextIcon className="size-4" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">Project changelog</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
