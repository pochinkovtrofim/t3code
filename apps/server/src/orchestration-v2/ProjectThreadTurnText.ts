import { ProjectId, type OrchestrationV2AppThread } from "@t3tools/contracts";
import {
  isProjectThreadId,
  projectThreadTurnText,
  resolveProjectThread,
} from "@t3tools/shared/projectThread";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

class ProjectThreadTurnProjectMissingError extends Schema.TaggedError<ProjectThreadTurnProjectMissingError>()(
  "ProjectThreadTurnProjectMissingError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "The project thread's project was not found.";
  }
}

/**
 * Builds the provider-facing text for a turn. A project thread gets its
 * project's instructions on every turn, read fresh so an edit applies to the
 * next message; every other thread's text passes through.
 */
export const makeProjectThreadTurnText = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  return Effect.fn("ProjectThreadTurnText.forProvider")(function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "projectId">,
    text: string,
  ) {
    if (!isProjectThreadId(thread.id)) return text;
    const projectThread = resolveProjectThread(yield* serverSettings.getSettings, thread);
    if (projectThread === null) return text;
    const project = yield* projects.getById(thread.projectId);
    if (Option.isNone(project)) {
      return yield* new ProjectThreadTurnProjectMissingError({ projectId: thread.projectId });
    }
    return projectThreadTurnText({
      text,
      instructions: projectThread.instructions,
      project: project.value,
    });
  });
});
