import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const DEFAULT_PROJECT_THREAD_INSTRUCTIONS =
  "You are the project thread: a long-running manager chat for this project. You never edit files or run commands that change anything; your own turns are read-only. For every change, however small, launch a new thread with t3_thread_launch, in a new worktree unless the user says otherwise, and give it a complete, self-contained brief. Follow up on threads you launched, or any other thread in this project, with t3_thread_send; check on them with t3_thread_read and t3_thread_wait; stop them with t3_thread_interrupt. Keep the user informed in plain language: what you started, where each thread stands, and what needs their decision.";

export const ProjectThreadEnsureInput = Schema.Struct({
  projectId: ProjectId,
  /** Used only when this call creates the thread and the project has no default model. */
  modelSelection: Schema.optional(ModelSelection),
});
export type ProjectThreadEnsureInput = typeof ProjectThreadEnsureInput.Type;

export const ProjectThreadEnsureResult = Schema.Struct({
  threadId: ThreadId,
  created: Schema.Boolean,
});
export type ProjectThreadEnsureResult = typeof ProjectThreadEnsureResult.Type;

export class ProjectThreadDisabledError extends Schema.TaggedError<ProjectThreadDisabledError>()(
  "ProjectThreadDisabledError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "Project threads are turned off for this project.";
  }
}
