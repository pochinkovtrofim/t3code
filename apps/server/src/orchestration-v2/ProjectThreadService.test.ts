import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { isProjectThreadId } from "@t3tools/shared/projectThread";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProjectThread from "./ProjectThreadService.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:project-thread-test");
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
};
const project = {
  id: projectId,
  title: "Alpha app",
  workspaceRoot: "/repo/alpha",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in project thread tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeLayer(
  options: {
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
    readonly projectDefaultModel?: ModelSelection | null;
    readonly beforeLaunch?: Effect.Effect<void>;
  } = {},
) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "project-thread" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest(options.settings);
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(Layer.mergeAll(layerOrchestrator, layerServerSettings, layerReceipts)),
  );
  const layerProjects = Layer.mock(ProjectService.ProjectService)({
    getById: (id) =>
      Effect.succeed(
        id === projectId
          ? Option.some({
              ...project,
              defaultModelSelection:
                options.projectDefaultModel === undefined
                  ? project.defaultModelSelection
                  : options.projectDefaultModel,
            })
          : Option.none(),
      ),
  });
  const layerLaunchExternals = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
      get: () => (options.beforeLaunch ?? Effect.void).pipe(Effect.as(null)),
    }),
    Layer.mock(TerminalManager.TerminalManager)({}),
    Layer.mock(GitWorkflow.GitWorkflowService)({}),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
    Layer.mock(TextGeneration.TextGeneration)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
      folderForThread: () => Effect.succeedNone,
    }),
    ProviderRegistryMock.layer(),
    layerProjects,
    layerServerSettings,
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(layerLaunchExternals, layerThreadManagement, layerReceipts, IdAllocator.layer),
    ),
  );
  const layerProjectThreads = ProjectThread.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerLaunch,
        layerThreadManagement,
        layerProjects,
        layerServerSettings,
        layerDatabase,
      ),
    ),
  );
  return Layer.mergeAll(layerProjectThreads, layerThreadManagement);
}

const projectThreadIds = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const active = yield* threads.getShellSnapshot({ location: "active" });
  const archived = yield* threads.getShellSnapshot({ location: "archive" });
  return [...active.threads, ...archived.threads]
    .filter((thread) => thread.projectId === projectId && isProjectThreadId(thread.id))
    .map((thread) => thread.id);
});

it.effect("creates one root-checkout project thread with the project's defaults", () =>
  Effect.gen(function* () {
    const projectThreads = yield* ProjectThread.ProjectThreadService;
    const threads = yield* ThreadManagement.ThreadManagementService;

    const result = yield* projectThreads.ensure({ projectId });

    assert.isTrue(result.created);
    assert.isTrue(isProjectThreadId(result.threadId));
    const projection = yield* threads.getThreadProjection(result.threadId);
    assert.equal(projection.thread.title, "Alpha app");
    assert.isNull(projection.thread.worktreePath);
    assert.deepEqual(projection.thread.modelSelection, modelSelection);
    assert.equal(projection.thread.runtimeMode, "auto-accept-edits");
    assert.equal(projection.thread.interactionMode, "default");
    assert.isNotNull(projection.thread.autoSettleDisabledAt ?? null);
    assert.lengthOf(projection.messages, 0);
    assert.lengthOf(projection.runs, 0);
  }).pipe(Effect.provide(makeLayer({ settings: { defaultRuntimeMode: "auto-accept-edits" } }))),
);

it.effect("returns the existing project thread instead of creating another", () =>
  Effect.gen(function* () {
    const projectThreads = yield* ProjectThread.ProjectThreadService;

    const first = yield* projectThreads.ensure({ projectId });
    const second = yield* projectThreads.ensure({ projectId });

    assert.isTrue(first.created);
    assert.deepEqual(second, { threadId: first.threadId, created: false });
    assert.deepEqual(yield* projectThreadIds, [first.threadId]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("brings an archived project thread back rather than creating a second one", () =>
  Effect.gen(function* () {
    const projectThreads = yield* ProjectThread.ProjectThreadService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const first = yield* projectThreads.ensure({ projectId });
    yield* threads.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("command:archive-project-thread"),
      threadId: first.threadId,
    });

    const second = yield* projectThreads.ensure({ projectId });

    assert.deepEqual(second, { threadId: first.threadId, created: false });
    const projection = yield* threads.getThreadProjection(first.threadId);
    assert.isNull(projection.thread.archivedAt);
    assert.deepEqual(yield* projectThreadIds, [first.threadId]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("starts a fresh project thread after the previous one was deleted", () =>
  Effect.gen(function* () {
    const projectThreads = yield* ProjectThread.ProjectThreadService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const first = yield* projectThreads.ensure({ projectId });
    yield* threads.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("command:delete-project-thread"),
      threadId: first.threadId,
    });

    const second = yield* projectThreads.ensure({ projectId });

    assert.isTrue(second.created);
    assert.notEqual(second.threadId, first.threadId);
    assert.deepEqual(yield* projectThreadIds, [second.threadId]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("creates exactly one thread when two callers ensure at the same time", () => {
  const firstLaunch = Deferred.makeUnsafe<void>();
  const resumeFirstLaunch = Deferred.makeUnsafe<void>();
  let launches = 0;
  // Hold the first caller between its lookup and its create, the window a
  // second caller must not slip through.
  const beforeLaunch = Effect.suspend(() =>
    ++launches === 1
      ? Deferred.succeed(firstLaunch, undefined).pipe(
          Effect.andThen(Deferred.await(resumeFirstLaunch)),
        )
      : Effect.void,
  );
  return Effect.gen(function* () {
    const projectThreads = yield* ProjectThread.ProjectThreadService;

    const first = yield* projectThreads.ensure({ projectId }).pipe(Effect.forkChild);
    yield* Deferred.await(firstLaunch);
    const second = yield* projectThreads.ensure({ projectId }).pipe(Effect.forkChild);
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));
    yield* Deferred.succeed(resumeFirstLaunch, undefined);
    const results = [yield* Fiber.join(first), yield* Fiber.join(second)];

    assert.equal(results[0]!.threadId, results[1]!.threadId);
    assert.deepEqual(
      results.map((result) => result.created),
      [true, false],
    );
    assert.deepEqual(yield* projectThreadIds, [results[0]!.threadId]);
  }).pipe(Effect.provide(makeLayer({ beforeLaunch })));
});

it.effect("refuses, and creates nothing, when the project has project threads turned off", () =>
  Effect.gen(function* () {
    const projectThreads = yield* ProjectThread.ProjectThreadService;

    const error = yield* projectThreads.ensure({ projectId }).pipe(Effect.flip);

    assert.equal(error._tag, "ProjectThreadDisabledError");
    assert.deepEqual(yield* projectThreadIds, []);
  }).pipe(
    Effect.provide(
      makeLayer({
        settings: { projectSettingsOverrides: { [projectId]: { projectThreadsEnabled: false } } },
      }),
    ),
  ),
);

it.effect("uses the caller's model only when the project has no default", () =>
  Effect.gen(function* () {
    const projectThreads = yield* ProjectThread.ProjectThreadService;
    const threads = yield* ThreadManagement.ThreadManagementService;

    const missing = yield* projectThreads.ensure({ projectId }).pipe(Effect.flip);
    assert.equal(missing._tag, "ProjectThreadModelRequiredError");

    const fallback = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
    const result = yield* projectThreads.ensure({ projectId, modelSelection: fallback });
    const projection = yield* threads.getThreadProjection(result.threadId);
    assert.deepEqual(projection.thread.modelSelection, fallback);
  }).pipe(Effect.provide(makeLayer({ projectDefaultModel: null }))),
);
