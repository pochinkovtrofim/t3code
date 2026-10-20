import { formatRelativeTimeLabel } from "../timestampFormat";
import type { ProjectGroupManager } from "./sidebar/projectGroups.logic";

export interface ProjectThreadEntry {
  readonly subLine: string;
  readonly disabled: boolean;
}

export function describeProjectThreadEntry(input: {
  readonly manager: ProjectGroupManager;
  readonly statusLabel: string | null;
  readonly canEnsure: boolean;
  readonly pending: boolean;
  readonly nowMs: number;
}): ProjectThreadEntry {
  if (input.pending) return { subLine: "Opening project thread…", disabled: false };
  if (input.manager.kind === "ensure") {
    return input.canEnsure
      ? { subLine: "No project thread yet", disabled: false }
      : { subLine: "No project thread yet. This connection can't start one.", disabled: true };
  }
  const updated = formatRelativeTimeLabel(input.manager.thread.updatedAt, input.nowMs);
  return {
    subLine:
      input.statusLabel === null
        ? `Updated ${updated}`
        : `${input.statusLabel} · updated ${updated}`,
    disabled: false,
  };
}
