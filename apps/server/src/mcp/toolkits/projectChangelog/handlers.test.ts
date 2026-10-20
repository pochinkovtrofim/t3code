import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectChangelogError,
  type ProjectChangelogPage,
  type ProjectChangelogReadInput,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ProjectChangelog from "../../../projectChangelog/ProjectChangelog.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell, liveThreadsLayer } from "../../McpToolAccess.testkit.ts";

const caller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:changelog"),
  requestNamespace: "provider:changelog",
  thread: {
    threadId: ThreadId.make("thread:changelog"),
    providerSessionId: "provider:changelog",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

const callerProject = liveThreadShell(ThreadId.make("thread:changelog")).projectId;

const pageOf = (projectId: ProjectId): ProjectChangelogPage => ({
  projectId,
  availability: "ready",
  repository: {
    displayName: "pochinkovtrofim/t3code",
    url: "https://github.com/pochinkovtrofim/t3code",
    defaultBranch: "main",
  },
  sync: { lastSyncedAt: null, problem: null, syncing: false },
  production: null,
  entries: [],
  nextCursor: null,
});

const callTool = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name: "t3_project_changelog_read", arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
      Effect.provideService(
        McpSchema.McpServerClient,
        McpSchema.McpServerClient.of({
          clientId: 1,
          protocolVersion: "2025-06-18",
          clientCapabilities: {},
          clientInfo: { name: "changelog", version: "1" },
          initializePayload: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "changelog", version: "1" },
          },
          getClient: Effect.die("unused"),
        }),
      ),
    );
  });

const layerWith = (reads: Array<ProjectChangelogReadInput>) =>
  McpHttpServer.layerProjectChangelogToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(liveThreadsLayer),
    Layer.provide(
      Layer.mock(ProjectChangelog.ProjectChangelog)({
        read: (input) =>
          Effect.suspend(() => {
            reads.push(input);
            return input.projectId === ProjectId.make("missing")
              ? Effect.fail(
                  new ProjectChangelogError({
                    projectId: input.projectId,
                    reason: "project-not-found",
                  }),
                )
              : Effect.succeed(pageOf(input.projectId));
          }),
      }),
    ),
  );

it.effect("reads the calling thread's project when no project is named", () => {
  const reads: Array<ProjectChangelogReadInput> = [];
  return Effect.gen(function* () {
    const result = yield* callTool({ limit: 5 });
    assert.isFalse(result.isError);
    assert.deepStrictEqual(reads, [{ projectId: callerProject, limit: 5 }]);
    assert.strictEqual(
      (result.structuredContent as ProjectChangelogPage | undefined)?.projectId,
      callerProject,
    );
  }).pipe(Effect.provide(layerWith(reads)));
});

it.effect("answers an unknown project as an invalid request", () => {
  const reads: Array<ProjectChangelogReadInput> = [];
  return Effect.gen(function* () {
    const result = yield* callTool({ projectId: "missing" });
    assert.isTrue(result.isError);
    assert.include(JSON.stringify(result.content), "The project was not found.");
  }).pipe(Effect.provide(layerWith(reads)));
});
