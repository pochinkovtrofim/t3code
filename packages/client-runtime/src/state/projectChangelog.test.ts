import { describe, expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  type ProjectChangelogPage,
  ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createProjectChangelogEnvironmentAtoms } from "./projectChangelog.ts";

const environment = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("changelog-environment"),
  label: "Changelog environment",
  httpBaseUrl: "https://changelog.example.test",
  wsBaseUrl: "wss://changelog.example.test",
});

const projectId = ProjectId.make("project-1");

const page: ProjectChangelogPage = {
  projectId,
  availability: "ready",
  repository: null,
  sync: { lastSyncedAt: null, problem: null, syncing: false },
  production: null,
  entries: [],
  nextCursor: null,
};

describe("project changelog atoms", () => {
  it.effect("ends the server watch soon after the last view of the head page closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        const closed = yield* Deferred.make<void>();
        let openWatches = 0;
        const client = {
          [WS_METHODS.projectChangelogWatch]: () =>
            Stream.concat(Stream.succeed(page), Stream.never).pipe(
              Stream.onStart(Effect.sync(() => (openWatches += 1))),
              Stream.ensuring(
                Effect.sync(() => (openWatches -= 1)).pipe(
                  Effect.andThen(Deferred.succeed(closed, undefined)),
                ),
              ),
            ),
        } as unknown as RpcSession.RpcSession["client"];
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: environment,
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            network: "online",
            phase: "connected",
            attempt: 1,
            generation: 1,
          }),
          session: yield* SubscriptionRef.make(
            Option.some({ client } as unknown as RpcSession.RpcSession),
          ),
          prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const runtime = Atom.runtime(
          Layer.succeed(
            EnvironmentRegistry.EnvironmentRegistry,
            EnvironmentRegistry.EnvironmentRegistry.of({
              followStream: (_environmentId: EnvironmentId, stream: Stream.Stream<unknown>) =>
                Stream.provideService(
                  stream,
                  EnvironmentSupervisor.EnvironmentSupervisor,
                  supervisor,
                ),
            } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
          ),
        );
        const head = createProjectChangelogEnvironmentAtoms(runtime).head({
          environmentId: environment.environmentId,
          input: { projectId },
        });
        const registry = AtomRegistry.make({ timeoutResolution: 1_000 });
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const firstPage = yield* Deferred.make<void>();
        const unsubscribe = registry.subscribe(
          head,
          (result) => {
            if (AsyncResult.isSuccess(result)) Deferred.doneUnsafe(firstPage, Effect.void);
          },
          { immediate: true },
        );
        yield* Deferred.await(firstPage);
        expect(openWatches).toBe(1);

        unsubscribe();
        yield* Effect.yieldNow;
        vi.advanceTimersByTime(30_000);
        yield* Deferred.await(closed);
        expect(openWatches).toBe(0);
      }),
    ),
  );
});
