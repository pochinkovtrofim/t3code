import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  type ProjectChangelogPage,
  ProjectId,
  type RepositoryIdentity,
  TextGenerationError,
} from "@t3tools/contracts";
import type { ChangelogSummaryGenerationInput } from "@t3tools/provider-core/server/changelogPrompt";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  type CommitPullsLookup,
  firstParentChain,
  type LandedCommit,
  type MergedPullRequest,
} from "./changelogModel.ts";
import * as GitHubLandings from "./GitHubLandings.ts";
import * as ProjectChangelog from "./ProjectChangelog.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const MINUTE = 60_000;

const identity: RepositoryIdentity = {
  canonicalKey: "github.com/acme/web",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "https://github.com/acme/web" },
  provider: "github",
  owner: "acme",
  name: "web",
};

const shell = (id: string): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: `Project ${id}`,
  workspaceRoot: `/work/${id}`,
  repositoryIdentity: identity,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const commit = (sha: string, parent: string | null, at: number, author: string, subject: string) =>
  ({
    sha,
    parentShas: parent === null ? [] : [parent],
    subject,
    authorKey: author,
    authorDisplay: author,
    committedAt: at,
  }) satisfies LandedCommit;

const pull = (number: number, mergeCommitSha: string, at: number): MergedPullRequest => ({
  number,
  repository: "acme/web",
  title: `Pull request ${number}`,
  bodyExcerpt: `Body of ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  authorLogin: "carol",
  mergedAt: at,
  mergeCommitSha,
  headRef: `feature-${number}`,
  baseRef: "main",
});

interface Gate {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

const makeGate = Effect.all({ entered: Deferred.make<void>(), release: Deferred.make<void>() });

/** A scripted GitHub: one repository whose history and answers a test can change. */
function makeGitHub() {
  const state = {
    commits: [
      commit("c1", null, NOW - 180 * MINUTE, "alice", "Fix typo in README"),
      commit("c2", "c1", NOW - 120 * MINUTE, "web-flow", "Add dark mode (#7)"),
      commit("c3", "c2", NOW - 60 * MINUTE, "bob", "Tweak the build"),
      commit("c4", "c3", NOW - 30 * MINUTE, "web-flow", "Speed up search (#8)"),
    ],
    pulls: [pull(7, "c2", NOW - 120 * MINUTE), pull(8, "c4", NOW - 30 * MINUTE)],
    lookups: new Map<string, CommitPullsLookup>(),
    production: {
      deployment: { _tag: "Absent" },
      release: {
        _tag: "Found",
        value: { source: "release", tag: "v1.0.0", sha: "c2", at: NOW - 100 * MINUTE, url: "u" },
      },
      tag: { _tag: "NotAsked" },
    } as GitHubLandings.ProductionObservations,
    calls: [] as Array<string>,
    /** Holds every head read until released, so a test can act while a sync is in flight. */
    headGate: null as Gate | null,
  };
  const layer = Layer.succeed(
    GitHubLandings.GitHubLandings,
    GitHubLandings.GitHubLandings.of({
      readHead: () =>
        Effect.gen(function* () {
          state.calls.push("readHead");
          if (state.headGate !== null) {
            yield* Deferred.succeed(state.headGate.entered, undefined);
            yield* Deferred.await(state.headGate.release);
          }
          return { defaultBranch: "main", headSha: state.commits.at(-1)!.sha };
        }),
      readHistory: (input) =>
        Effect.sync(() => {
          state.calls.push("readHistory");
          const walk = firstParentChain({
            headSha: input.headSha,
            stopAtSha: input.stopAtSha,
            commits: new Map(
              state.commits
                .filter((value) => input.since === null || value.committedAt >= input.since)
                .map((value) => [value.sha, value]),
            ),
            maxLength: input.maxCommits,
          });
          return { chain: walk.chain, reachedCursor: walk.end._tag === "Cursor" };
        }),
      readMergedPulls: () =>
        Effect.sync(() => {
          state.calls.push("readMergedPulls");
          return state.pulls;
        }),
      lookupCommitPulls: (input) =>
        Effect.sync(() => {
          for (const sha of input.shas) state.calls.push(`lookup:${sha}`);
          return new Map(
            input.shas.map((sha) => [
              sha,
              state.lookups.get(sha) ?? ({ _tag: "Answered", pullRequests: [] } as const),
            ]),
          );
        }),
      readProduction: () =>
        Effect.sync(() => {
          state.calls.push("readProduction");
          return state.production;
        }),
      mergeBase: () => Effect.succeed(null),
    }),
  );
  return { state, layer };
}

function makeModel() {
  const calls: Array<ChangelogSummaryGenerationInput> = [];
  const state = { failing: false, contested: new Set<string>() };
  const layer = Layer.mock(TextGeneration.TextGeneration)({
    generateChangelogSummaries: (input) =>
      // A real call suspends on a subprocess; yielding keeps the pass from finishing inside the sync.
      Effect.yieldNow.pipe(
        Effect.andThen(() => {
          calls.push(input);
          return state.failing
            ? Effect.fail(
                new TextGenerationError({
                  operation: "generateChangelogSummaries",
                  detail: "provider unavailable",
                }),
              )
            : Effect.succeed({
                entries: input.units
                  .filter((unit) => !state.contested.has(unit.key))
                  .map((unit) => ({
                    key: unit.key,
                    title: `Summary title for ${unit.key}`,
                    summary: `What ${unit.key} changed.`,
                    category: "improvement" as const,
                  })),
                contested: input.units
                  .filter((unit) => state.contested.has(unit.key))
                  .map((unit) => unit.key),
              });
        }),
      ),
  });
  return { calls, state, layer };
}

class Merges extends Context.Service<
  Merges,
  { readonly hub: PubSub.PubSub<PullRequestService.PullRequestMergeEvent> }
>()("t3/projectChangelog/ProjectChangelog.test/Merges") {}

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

function harness(
  options: {
    readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  } = {},
) {
  const github = makeGitHub();
  const model = makeModel();
  const projects = options.projects ?? [shell("p1")];
  const layer = ProjectChangelog.layerWithoutGitHub().pipe(
    Layer.provide(github.layer),
    Layer.provide(model.layer),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        listShells: () => Effect.succeed(projects),
        getShell: (projectId) =>
          Effect.succeed(Option.fromNullishOr(projects.find((p) => p.id === projectId))),
      }),
    ),
    Layer.provide(
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(identity),
      }),
    ),
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const { hub } = yield* Merges;
          return Layer.mock(PullRequestService.PullRequestService)({
            subscribeMerges: PubSub.subscribe(hub).pipe(Effect.map(Stream.fromSubscription)),
          });
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.effect(
        Merges,
        Effect.map(PubSub.unbounded<PullRequestService.PullRequestMergeEvent>(), (hub) => ({
          hub,
        })),
      ),
    ),
    Layer.provide(ServerSettings.layerTest(options.settings ?? {})),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return { github, model, layer };
}

const insertThread = (input: {
  readonly id: string;
  readonly project: string;
  readonly branch?: string | null;
  readonly pullRequests?: ReadonlyArray<number>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at, payload_json
      ) VALUES (
        ${input.id}, ${input.project}, ${`Thread ${input.id}`}, 'codex', 'full-access',
        'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL,
        ${JSON.stringify({
          branch: input.branch ?? null,
          pullRequests: (input.pullRequests ?? []).map((number) => ({
            host: "github.com",
            repository: "acme/web",
            number,
            source: "manual",
          })),
        })}
      )
    `;
  });

/** Takes pages off a watch until one satisfies `done`; each take waits for the next emission. */
const takeUntil = (
  pages: Queue.Queue<ProjectChangelogPage>,
  done: (page: ProjectChangelogPage) => boolean,
): Effect.Effect<ProjectChangelogPage> =>
  Queue.take(pages).pipe(
    Effect.flatMap((page) => (done(page) ? Effect.succeed(page) : takeUntil(pages, done))),
  );

const watchInto = (changelog: ProjectChangelog.ProjectChangelog["Service"], projectId: ProjectId) =>
  Effect.gen(function* () {
    const pages = yield* Queue.unbounded<ProjectChangelogPage>();
    const fiber = yield* changelog.watch({ projectId }).pipe(
      Stream.runForEach((page) => Queue.offer(pages, page)),
      Effect.forkChild,
    );
    return { pages, fiber };
  });

const p1 = ProjectId.make("p1");

/** Sets the clock before the layer starts its loop, which would otherwise wake for every minute
 * between the epoch and NOW. */
const atNow = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(NOW).pipe(Effect.andThen(effect));

describe("ProjectChangelog", () => {
  it.effect("reads landings, splits them at production, and summarizes them in one call", () => {
    const { github, model, layer } = harness();
    return Effect.gen(function* () {
      yield* insertThread({ id: "project-thread:one", project: "p1" });
      yield* insertThread({ id: "dark-mode", project: "p1", pullRequests: [7] });
      const changelog = yield* ProjectChangelog.ProjectChangelog;

      const first = yield* changelog.read({ projectId: p1 });
      assert.strictEqual(first.availability, "ready");
      assert.deepStrictEqual(
        first.entries.map((entry) => [entry.id, entry.inProduction]),
        [
          ["pr:8", false],
          ["push:c3", false],
          ["pr:7", true],
          ["push:c1", true],
        ],
      );
      assert.deepStrictEqual(first.production, {
        source: "release",
        label: "v1.0.0",
        sha: "c2",
        at: isoOf(NOW - 100 * MINUTE),
        url: "u",
        stale: false,
      });

      yield* changelog.drain;
      const summarized = yield* changelog.read({ projectId: p1 });
      assert.isTrue(summarized.entries.every((entry) => entry.summaryState === "ready"));
      assert.strictEqual(model.calls.length, 1);
      assert.deepStrictEqual(
        model.calls[0]!.units.map((unit) => unit.key),
        ["pr:8", "push:c3", "pr:7", "push:c1"],
      );
      assert.strictEqual(model.calls[0]!.cwd, "/work/p1");
      const darkMode = summarized.entries.find((entry) => entry.id === "pr:7")!;
      assert.strictEqual(darkMode.title, "Summary title for pr:7");
      assert.deepStrictEqual(
        darkMode.threads.map((thread) => thread.threadId),
        ["dark-mode"],
      );
      assert.strictEqual(github.state.calls.filter((call) => call === "readHistory").length, 1);

      // Nothing moved on GitHub: the next sync reads the head and production, and stops there.
      github.state.calls.length = 0;
      yield* TestClock.adjust(16 * MINUTE);
      const again = yield* changelog.read({ projectId: p1 });
      assert.deepStrictEqual(
        again.entries.map((entry) => entry.title),
        summarized.entries.map((entry) => entry.title),
      );
      assert.deepStrictEqual([...new Set(github.state.calls)].toSorted(), [
        "readHead",
        "readProduction",
      ]);
      assert.strictEqual(model.calls.length, 1);
    }).pipe(Effect.provide(layer), atNow);
  });

  it.effect("holds a repository's summaries after a failed model call", () => {
    const { model, layer } = harness();
    model.state.failing = true;
    return Effect.gen(function* () {
      yield* insertThread({ id: "project-thread:one", project: "p1" });
      const changelog = yield* ProjectChangelog.ProjectChangelog;
      yield* changelog.read({ projectId: p1 });
      yield* changelog.drain;
      assert.strictEqual(model.calls.length, 1);
      // The loop passes every minute; none of them calls the failing model again yet.
      yield* TestClock.adjust(3 * MINUTE);
      assert.strictEqual(model.calls.length, 1);
      const pending = yield* changelog.read({ projectId: p1 });
      assert.isTrue(pending.entries.every((entry) => entry.summaryState === "pending"));
      assert.isTrue(pending.entries.every((entry) => entry.summary === null));

      model.state.failing = false;
      yield* TestClock.adjust(30 * MINUTE);
      yield* changelog.drain;
      const ready = yield* changelog.read({ projectId: p1 });
      assert.isTrue(ready.entries.every((entry) => entry.summaryState === "ready"));
      assert.strictEqual(ready.entries[0]!.title, "Summary title for pr:8");
    }).pipe(Effect.provide(layer), atNow);
  });

  it.effect("rides out a provider outage without giving up on any entry", () => {
    const { model, layer } = harness();
    model.state.failing = true;
    return Effect.gen(function* () {
      yield* insertThread({ id: "project-thread:one", project: "p1" });
      const changelog = yield* ProjectChangelog.ProjectChangelog;
      yield* changelog.read({ projectId: p1 });
      yield* TestClock.adjust(40 * MINUTE);
      yield* changelog.drain;
      // The hold grows with each failed call, so forty minutes cost a handful of calls.
      assert.isAtMost(model.calls.length, 4);
      const during = yield* changelog.read({ projectId: p1 });
      assert.isTrue(during.entries.every((entry) => entry.summaryState === "pending"));

      model.state.failing = false;
      yield* TestClock.adjust(60 * MINUTE);
      yield* changelog.drain;
      const after = yield* changelog.read({ projectId: p1 });
      assert.isTrue(after.entries.every((entry) => entry.summaryState === "ready"));
    }).pipe(Effect.provide(layer), atNow);
  });

  it.effect("keeps retrying an entry the model answered twice instead of giving up on it", () => {
    const { model, layer } = harness();
    model.state.contested = new Set(["pr:8"]);
    return Effect.gen(function* () {
      yield* insertThread({ id: "project-thread:one", project: "p1" });
      const changelog = yield* ProjectChangelog.ProjectChangelog;
      yield* changelog.read({ projectId: p1 });
      yield* changelog.drain;
      // Three charged failures would give up by now; contested answers spend no attempt.
      yield* TestClock.adjust(6 * MINUTE);
      yield* TestClock.adjust(31 * MINUTE);
      yield* changelog.drain;
      const page = yield* changelog.read({ projectId: p1 });
      assert.deepStrictEqual(
        page.entries.map((entry) => [entry.id, entry.summaryState]),
        [
          ["pr:8", "pending"],
          ["push:c3", "ready"],
          ["pr:7", "ready"],
          ["push:c1", "ready"],
        ],
      );
      assert.isAtLeast(model.calls.length, 3);
    }).pipe(Effect.provide(layer), atNow);
  });

  it.effect("stops waiting on a commit whose pull request lookup keeps failing", () => {
    const { github, layer } = harness();
    github.state.lookups.set("c3", { _tag: "Failed" });
    return Effect.gen(function* () {
      yield* insertThread({ id: "project-thread:one", project: "p1" });
      const changelog = yield* ProjectChangelog.ProjectChangelog;
      const blocked = yield* changelog.read({ projectId: p1 });
      // Grouping never forms a unit across an unresolved commit, so #8 waits behind it.
      assert.deepStrictEqual(
        blocked.entries.map((entry) => entry.id),
        ["pr:7", "push:c1"],
      );
      // Waiting commits put the repository on the one-minute cadence: two more syncs, two more
      // failed lookups, and the commit counts as a direct push.
      yield* TestClock.adjust(MINUTE);
      yield* TestClock.adjust(MINUTE);
      yield* changelog.drain;
      const unblocked = yield* changelog.read({ projectId: p1 });
      assert.deepStrictEqual(
        unblocked.entries.map((entry) => entry.id),
        ["pr:8", "push:c3", "pr:7", "push:c1"],
      );
      assert.strictEqual(github.state.calls.filter((call) => call === "lookup:c3").length, 3);
    }).pipe(Effect.provide(layer), atNow);
  });

  it.effect("keeps the previous production answer when its source cannot be read", () => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      yield* insertThread({ id: "project-thread:one", project: "p1" });
      const changelog = yield* ProjectChangelog.ProjectChangelog;
      const before = yield* changelog.read({ projectId: p1 });
      assert.strictEqual(before.production?.label, "v1.0.0");

      github.state.production = {
        deployment: { _tag: "Absent" },
        release: { _tag: "Unavailable" },
        tag: {
          _tag: "Found",
          value: { source: "tag", tag: "v0.9.0", sha: "c1" },
        },
      };
      yield* TestClock.adjust(16 * MINUTE);
      const after = yield* changelog.read({ projectId: p1 });
      assert.deepStrictEqual(
        [after.production?.source, after.production?.label, after.production?.stale],
        ["release", "v1.0.0", true],
      );
      assert.deepStrictEqual(
        after.entries.map((entry) => entry.inProduction),
        before.entries.map((entry) => entry.inProduction),
      );
    }).pipe(Effect.provide(layer), atNow);
  });

  it.effect("does no background work for a project without a project thread", () => {
    const { github, model, layer } = harness();
    return Effect.gen(function* () {
      const changelog = yield* ProjectChangelog.ProjectChangelog;
      const page = yield* changelog.read({ projectId: p1 });
      assert.strictEqual(page.availability, "ready");
      assert.deepStrictEqual(page.entries, []);
      assert.isNull(page.sync.lastSyncedAt);
      assert.deepStrictEqual(github.state.calls, []);
      assert.strictEqual(model.calls.length, 0);
    }).pipe(Effect.provide(layer), atNow);
  });

  it.effect("syncs in the background a project whose shell has no identity yet", () => {
    // Right after startup the shell's identity cache is empty; the resolver still knows the remote.
    const { github, model, layer } = harness({
      projects: [{ ...shell("p1"), repositoryIdentity: null }],
    });
    return Effect.gen(function* () {
      yield* insertThread({ id: "project-thread:one", project: "p1" });
      yield* TestClock.adjust(MINUTE);
      yield* (yield* ProjectChangelog.ProjectChangelog).drain;
      assert.isTrue(github.state.calls.includes("readHistory"));
      assert.strictEqual(model.calls.length, 1);
    }).pipe(Effect.provide(layer), atNow);
  });

  it.effect("records the head of a repository with nothing in the backfill window", () => {
    const { github, model, layer } = harness();
    github.state.commits = github.state.commits.map((value) => ({
      ...value,
      committedAt: value.committedAt - 40 * 24 * 60 * MINUTE,
    }));
    return Effect.gen(function* () {
      yield* insertThread({ id: "project-thread:one", project: "p1" });
      const changelog = yield* ProjectChangelog.ProjectChangelog;
      const first = yield* changelog.read({ projectId: p1 });
      assert.deepStrictEqual(first.entries, []);
      assert.strictEqual(first.repository?.defaultBranch, "main");

      github.state.calls.length = 0;
      yield* TestClock.adjust(16 * MINUTE);
      yield* changelog.drain;
      const later = yield* changelog.read({ projectId: p1 });
      assert.notStrictEqual(later.sync.lastSyncedAt, first.sync.lastSyncedAt);
      assert.deepStrictEqual([...new Set(github.state.calls)].toSorted(), [
        "readHead",
        "readProduction",
      ]);
      assert.strictEqual(model.calls.length, 0);
    }).pipe(Effect.provide(layer), atNow);
  });

  it.effect("answers disabled, missing and unknown projects without reading GitHub", () => {
    const { github, layer } = harness({
      projects: [shell("p1"), shell("p2"), { ...shell("p3"), repositoryIdentity: null }],
      settings: {
        projectSettingsOverrides: { [ProjectId.make("p2")]: { projectThreadsEnabled: false } },
      },
    });
    return Effect.gen(function* () {
      const changelog = yield* ProjectChangelog.ProjectChangelog;
      const disabled = yield* changelog.read({ projectId: ProjectId.make("p2") });
      assert.strictEqual(disabled.availability, "disabled");
      const unknown = yield* Effect.flip(changelog.read({ projectId: ProjectId.make("nope") }));
      assert.strictEqual(unknown.reason, "project-not-found");
      assert.deepStrictEqual(github.state.calls, []);
    }).pipe(Effect.provide(layer), atNow);
  });

  it.effect("pages older entries with an opaque cursor", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* insertThread({ id: "project-thread:one", project: "p1" });
      const changelog = yield* ProjectChangelog.ProjectChangelog;
      const head = yield* changelog.read({ projectId: p1, limit: 3 });
      assert.deepStrictEqual(
        head.entries.map((entry) => entry.id),
        ["pr:8", "push:c3", "pr:7"],
      );
      assert.isNotNull(head.nextCursor);
      const rest = yield* changelog.read({ projectId: p1, limit: 3, cursor: head.nextCursor! });
      assert.deepStrictEqual(
        rest.entries.map((entry) => entry.id),
        ["push:c1"],
      );
      assert.isNull(rest.nextCursor);
    }).pipe(Effect.provide(layer), atNow);
  });

  it.effect("watches the head page and syncs right after a merge done in T3", () => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      yield* insertThread({ id: "project-thread:one", project: "p1" });
      const changelog = yield* ProjectChangelog.ProjectChangelog;
      const { hub: merges } = yield* Merges;
      yield* changelog.read({ projectId: p1 });

      github.state.commits.push(commit("c5", "c4", NOW, "web-flow", "Ship exports (#9)"));
      github.state.pulls.push(pull(9, "c5", NOW));
      const pages = yield* changelog.watch({ projectId: p1 }).pipe(
        Stream.tap((page) =>
          page.entries.length === 4
            ? PubSub.publish(merges, {
                projectId: p1,
                repository: "acme/web",
                number: 9,
                mergedAt: isoOf(NOW),
              })
            : Effect.void,
        ),
        Stream.takeUntil((page) => page.entries[0]?.id === "pr:9"),
        Stream.runCollect,
      );
      assert.strictEqual(pages.at(-1)!.entries.length, 5);
      assert.isFalse(pages.at(-1)!.entries[0]!.inProduction);
    }).pipe(Effect.provide(layer), atNow);
  });
  it.effect("waits five seconds for a sync, then answers with what it has", () => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      yield* insertThread({ id: "project-thread:one", project: "p1" });
      const changelog = yield* ProjectChangelog.ProjectChangelog;
      const gate = yield* makeGate;
      github.state.headGate = gate;
      const reading = yield* Effect.forkChild(changelog.read({ projectId: p1 }));
      yield* Deferred.await(gate.entered);
      yield* TestClock.adjust(4_999);
      assert.isUndefined(reading.pollUnsafe());
      yield* TestClock.adjust(1);
      const early = yield* Fiber.join(reading);
      assert.deepStrictEqual(early.entries, []);
      assert.isNull(early.sync.lastSyncedAt);
      assert.isTrue(early.sync.syncing);

      yield* Deferred.succeed(gate.release, undefined);
      yield* changelog.drain;
      const later = yield* changelog.read({ projectId: p1 });
      assert.strictEqual(later.entries.length, 4);
      assert.isFalse(later.sync.syncing);
    }).pipe(Effect.provide(layer), atNow);
  });

  it.effect("reads GitHub once for two projects on one repository", () => {
    const { github, layer } = harness({ projects: [shell("p1"), shell("p2")] });
    return Effect.gen(function* () {
      yield* insertThread({ id: "project-thread:one", project: "p1" });
      yield* insertThread({ id: "project-thread:two", project: "p2" });
      const changelog = yield* ProjectChangelog.ProjectChangelog;
      const gate = yield* makeGate;
      github.state.headGate = gate;
      const first = yield* Effect.forkChild(changelog.read({ projectId: p1 }));
      const second = yield* Effect.forkChild(changelog.read({ projectId: ProjectId.make("p2") }));
      yield* Deferred.await(gate.entered);
      yield* Deferred.succeed(gate.release, undefined);
      const pages = yield* Fiber.joinAll([first, second]);
      assert.deepStrictEqual(
        pages.map((page) => page.entries.length),
        [4, 4],
      );
      assert.strictEqual(github.state.calls.filter((call) => call === "readHead").length, 1);
    }).pipe(Effect.provide(layer), atNow);
  });

  it.effect("syncs every minute while any watch is open, and every fifteen after", () => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      yield* insertThread({ id: "project-thread:one", project: "p1" });
      const changelog = yield* ProjectChangelog.ProjectChangelog;
      yield* changelog.read({ projectId: p1 });
      yield* changelog.drain;
      const left = yield* watchInto(changelog, p1);
      const right = yield* watchInto(changelog, p1);
      yield* takeUntil(left.pages, (page) => page.entries.length === 4);
      yield* takeUntil(right.pages, (page) => page.entries.length === 4);

      github.state.commits.push(commit("c5", "c4", NOW + MINUTE, "web-flow", "Ship exports (#9)"));
      github.state.pulls.push(pull(9, "c5", NOW + MINUTE));
      yield* TestClock.adjust(MINUTE);
      yield* takeUntil(left.pages, (page) => page.entries[0]?.id === "pr:9");
      yield* takeUntil(right.pages, (page) => page.entries[0]?.id === "pr:9");

      // One watch closing leaves the other on the one-minute cadence.
      yield* Fiber.interrupt(left.fiber);
      github.state.commits.push(commit("c6", "c5", NOW + 2 * MINUTE, "web-flow", "Fix (#10)"));
      github.state.pulls.push(pull(10, "c6", NOW + 2 * MINUTE));
      yield* TestClock.adjust(MINUTE);
      yield* takeUntil(right.pages, (page) => page.entries[0]?.id === "pr:10");

      // With no watch left, the sync already scheduled runs, then the cadence is fifteen minutes.
      yield* Fiber.interrupt(right.fiber);
      yield* TestClock.adjust(MINUTE);
      yield* changelog.drain;
      github.state.calls.length = 0;
      yield* TestClock.adjust(10 * MINUTE);
      assert.deepStrictEqual(github.state.calls, []);
      yield* TestClock.adjust(6 * MINUTE);
      yield* changelog.drain;
      assert.isTrue(github.state.calls.includes("readHead"));
    }).pipe(Effect.provide(layer), atNow);
  });
});
