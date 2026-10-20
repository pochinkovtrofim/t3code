import {
  CommandId,
  ProjectId,
  ProjectThreadDisabledError,
  type ProjectThreadEnsureInput,
  type ProjectThreadEnsureResult,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  isProjectThreadId,
  makeProjectThreadId,
  PROJECT_THREAD_ID_PREFIX,
} from "@t3tools/shared/projectThread";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

class ProjectThreadProjectNotFoundError extends Schema.TaggedError<ProjectThreadProjectNotFoundError>()(
  "ProjectThreadProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "The project was not found.";
  }
}

class ProjectThreadModelRequiredError extends Schema.TaggedError<ProjectThreadModelRequiredError>()(
  "ProjectThreadModelRequiredError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "Pass modelSelection: the project has no default model.";
  }
}

class ProjectThreadOperationError extends Schema.TaggedError<ProjectThreadOperationError>()(
  "ProjectThreadOperationError",
  {
    projectId: ProjectId,
    operation: Schema.Literals([
      "read-settings",
      "read-project",
      "find-thread",
      "unarchive",
      "disable-auto-settle",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project thread ${this.operation.replaceAll("-", " ")} failed.`;
  }
}

type ProjectThreadEnsureError =
  | ProjectThreadDisabledError
  | ProjectThreadProjectNotFoundError
  | ProjectThreadModelRequiredError
  | ProjectThreadOperationError
  | ThreadLaunch.ThreadLaunchError
  | ThreadManagement.ThreadManagementProviderInstanceDisabledError;

export class ProjectThreadService extends Context.Service<
  ProjectThreadService,
  {
    /**
     * Returns the project's one project thread, unarchiving it if needed, and
     * creates it when there is none. Calls are serialized so concurrent callers
     * get the same thread.
     */
    readonly ensure: (
      input: ProjectThreadEnsureInput,
    ) => Effect.Effect<ProjectThreadEnsureResult, ProjectThreadEnsureError>;
  }
>()("t3/orchestration-v2/ProjectThreadService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // One lock for every project: ensure is a lookup and at most one create, so
  // serializing across projects costs nothing a user could notice.
  const lock = yield* Semaphore.make(1);

  const operationError =
    (projectId: ProjectId, operation: ProjectThreadOperationError["operation"]) =>
    (cause: unknown) =>
      new ProjectThreadOperationError({ projectId, operation, cause });

  const findExisting = Effect.fn("ProjectThreadService.findExisting")(function* (
    projectId: ProjectId,
  ) {
    const rows = yield* sql<{ readonly threadId: string; readonly archivedAt: string | null }>`
      SELECT thread_id AS "threadId", archived_at AS "archivedAt"
      FROM orchestration_v2_projection_threads
      WHERE project_id = ${projectId}
        AND deleted_at IS NULL
        AND thread_id LIKE ${`${PROJECT_THREAD_ID_PREFIX}%`}
      ORDER BY archived_at IS NOT NULL, created_at ASC, thread_id ASC
    `.pipe(Effect.mapError(operationError(projectId, "find-thread")));
    const row = rows.find((candidate) => isProjectThreadId(ThreadId.make(candidate.threadId)));
    return row === undefined
      ? undefined
      : { threadId: ThreadId.make(row.threadId), archived: row.archivedAt !== null };
  });

  // The fixed command id makes this run once per thread: a retry after a crash
  // finishes it, and a later re-enable by the user is left alone.
  const disableAutoSettle = (projectId: ProjectId, threadId: ThreadId) =>
    threads
      .dispatch({
        type: "thread.auto-settle.set",
        commandId: CommandId.make(`${threadId}:auto-settle-off`),
        threadId,
        enabled: false,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchTags({ OrchestratorCommandPreviouslyRejectedError: () => Effect.void }),
        Effect.mapError(operationError(projectId, "disable-auto-settle")),
      );

  const ensure: ProjectThreadService["Service"]["ensure"] = Effect.fn(
    "ProjectThreadService.ensure",
  )(
    function* (input) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(operationError(input.projectId, "read-settings")),
      );
      const project = yield* projects.getById(input.projectId).pipe(
        Effect.mapError(operationError(input.projectId, "read-project")),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new ProjectThreadProjectNotFoundError({ projectId: input.projectId })),
            onSome: Effect.succeed,
          }),
        ),
      );
      const resolved = resolveProjectSettings(settings, project.id, project).settings;
      if (!resolved.projectThreadsEnabled) {
        return yield* new ProjectThreadDisabledError({ projectId: project.id });
      }

      const existing = yield* findExisting(project.id);
      if (existing !== undefined) {
        if (existing.archived) {
          yield* threads
            .dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make(`${existing.threadId}:unarchive:${yield* randomUuidV4}`),
              threadId: existing.threadId,
            })
            .pipe(Effect.mapError(operationError(project.id, "unarchive")));
        }
        yield* disableAutoSettle(project.id, existing.threadId);
        return { threadId: existing.threadId, created: false };
      }

      const modelSelection = resolved.defaultModelSelection ?? input.modelSelection;
      if (modelSelection === undefined) {
        return yield* new ProjectThreadModelRequiredError({ projectId: project.id });
      }
      const threadId = makeProjectThreadId(yield* randomUuidV4);
      yield* threadLaunch.launch({
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: project.id,
        title: project.title,
        modelSelection,
        runtimeMode: resolved.defaultRuntimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "system",
        creationSource: "server",
      });
      yield* disableAutoSettle(project.id, threadId);
      return { threadId, created: true };
    },
    (effect) => lock.withPermits(1)(effect),
  );

  return ProjectThreadService.of({ ensure });
});

export const layer = Layer.effect(ProjectThreadService, make);
