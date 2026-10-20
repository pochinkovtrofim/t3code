import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { makeProjectThreadId } from "@t3tools/shared/projectThread";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
  readonly id?: ThreadId;
}): OrchestrationV2AppThread {
  const threadId = input.id ?? ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    driverKind: ProviderDriverKind.make(instanceId),
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const makeLayerTest = (settings?: Parameters<typeof ServerSettings.layerTest>[0]) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(ServerSettings.layerTest(settings)),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeed(
            Option.some({
              projectId,
              title: "Project",
              workspaceRoot: "/project-root",
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-06-21T00:00:00.000Z",
              updatedAt: "2026-06-21T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
      }),
    ),
  );
const layerTest = makeLayerTest();

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );
});

const projectThreadId = makeProjectThreadId("runtime-policy");
const PROJECT_THREAD_READ_ONLY = {
  approvalPolicy: "never",
  sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
  allowT3Orchestration: true,
};
const orchestrationFields = (policy: ProviderAdapterV2RuntimePolicy) => ({
  approvalPolicy: policy.approvalPolicy,
  sandboxPolicy: policy.sandboxPolicy,
  allowT3Orchestration: policy.allowT3Orchestration,
});

it.layer(layerTest)("RuntimePolicyV2 for project threads", (it) => {
  it.effect("runs the project thread's own turns read-only where the provider enforces it", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      for (const instanceId of ["codex", "claudeAgent"]) {
        const resolved = yield* policy.resolve({
          thread: makeThread({ now, worktreePath: null, id: projectThreadId }),
          modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model: "test-model" },
        });
        assert.deepEqual(orchestrationFields(resolved), PROJECT_THREAD_READ_ONLY, instanceId);
        // The stored mode stays, so the threads it launches keep their full power.
        assert.equal(resolved.runtimeMode, "full-access", instanceId);
        assert.equal(resolved.cwd, "/project-root", instanceId);
      }
    }),
  );

  it.effect("leaves prompt-only providers and ordinary threads on their normal policy", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const unrestricted = {
        approvalPolicy: undefined,
        sandboxPolicy: undefined,
        allowT3Orchestration: undefined,
      };
      for (const instanceId of ["cursor", "grok", "opencode"]) {
        const resolved = yield* policy.resolve({
          thread: makeThread({ now, worktreePath: null, id: projectThreadId }),
          modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model: "test-model" },
        });
        assert.deepEqual(orchestrationFields(resolved), unrestricted, instanceId);
      }
      const ordinary = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.deepEqual(orchestrationFields(ordinary), unrestricted);
    }),
  );
});

it.effect("treats a project thread as ordinary once its project turns the feature off", () =>
  Effect.gen(function* () {
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    const now = yield* DateTime.now;
    const resolved = yield* policy.resolve({
      thread: makeThread({ now, worktreePath: null, id: projectThreadId }),
      modelSelection,
    });
    assert.isUndefined(resolved.sandboxPolicy);
    assert.isUndefined(resolved.allowT3Orchestration);
  }).pipe(
    Effect.provide(
      makeLayerTest({
        projectSettingsOverrides: { [projectId]: { projectThreadsEnabled: false } },
      }),
    ),
  ),
);
