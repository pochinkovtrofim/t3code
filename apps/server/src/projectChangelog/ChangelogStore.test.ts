import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChangelogStore from "./ChangelogStore.ts";
import {
  assignOrdinals,
  type AssociatedCommit,
  type ChangeUnit,
  type GitHubRepository,
  groupChangeUnits,
  type Landing,
  type MergedPullRequest,
  type RepositoryKey,
} from "./changelogModel.ts";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const MINUTE = 60_000;

const repository: GitHubRepository = {
  key: "github.com/acme/web" as RepositoryKey,
  host: "github.com",
  owner: "acme",
  name: "web",
  webUrl: "https://github.com/acme/web",
};
const key = repository.key;

const pull = (number: number): MergedPullRequest => ({
  number,
  repository: "acme/web",
  title: `PR ${number}`,
  bodyExcerpt: "",
  url: `https://github.com/acme/web/pull/${number}`,
  authorLogin: "bob",
  mergedAt: T0,
  mergeCommitSha: null,
  headRef: `feature-${number}`,
  baseRef: "main",
});

const landed = (sha: string, association: AssociatedCommit["association"]): AssociatedCommit => ({
  sha,
  parentShas: [],
  subject: `subject ${sha}`,
  authorKey: "alice",
  authorDisplay: "alice",
  committedAt: T0,
  association,
});

/** Groups `commits` after `base` and returns the write a sync would make. */
const syncWrite = (
  commits: ReadonlyArray<AssociatedCommit>,
  options: {
    readonly base?: number;
    readonly tail?: ChangeUnit | null;
    readonly reset?: boolean;
  } = {},
): ChangelogStore.SyncWrite => {
  const landings = assignOrdinals(options.base ?? 0, commits);
  const { units } = groupChangeUnits({ repository, tail: options.tail ?? null, landings });
  const unitOf = new Map<string, ChangeUnit["key"]>();
  for (const unit of units) {
    for (let ordinal = unit.firstOrdinal; ordinal <= unit.lastOrdinal; ordinal++) {
      unitOf.set(String(ordinal), unit.key);
    }
  }
  const head = landings.at(-1)!;
  return {
    key,
    defaultBranch: "main",
    cursor: { headSha: head.sha, headOrdinal: head.ordinal },
    reset: options.reset ?? false,
    commits: landings.map((landing: Landing) => ({
      landing,
      unitKey: unitOf.get(String(landing.ordinal)) ?? null,
    })),
    units,
    now: T0,
  };
};

const pageKeys = (store: ChangelogStore.ChangelogStore["Service"]) =>
  store
    .page({ key, beforeOrdinal: null, limit: 50 })
    .pipe(Effect.map((rows) => rows.map((row) => [row.unit.key, row.summary.state])));

const layer = it.layer(
  ChangelogStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
);

const fresh = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "fork_changelog_entries",
    "fork_changelog_commits",
    "fork_changelog_repositories",
    "orchestration_v2_projection_threads",
  ]) {
    yield* sql.unsafe(`DELETE FROM ${table}`);
  }
  const store = yield* ChangelogStore.ChangelogStore;
  yield* store.ensureRepository(repository);
  return store;
});

layer("ChangelogStore", (it) => {
  it.effect("creates its tables idempotently and rebuilds them for an unknown schema version", () =>
    Effect.gen(function* () {
      const store = yield* fresh;
      yield* store.applySync(syncWrite([landed("a", { _tag: "Direct" })]));
      const sql = yield* SqlClient.SqlClient;

      const again = yield* Effect.provide(
        ChangelogStore.ChangelogStore,
        Layer.fresh(ChangelogStore.layer),
      );
      assert.deepEqual(yield* pageKeys(again), [["push:a", "pending"]]);

      yield* sql`UPDATE fork_changelog_meta SET value = '999' WHERE key = 'schema_version'`;
      const rebuilt = yield* Effect.provide(
        ChangelogStore.ChangelogStore,
        Layer.fresh(ChangelogStore.layer),
      );
      assert.isTrue(Option.isNone(yield* rebuilt.getRepository(key)));
      const [version] = yield* sql<{ readonly value: string }>`
        SELECT value FROM fork_changelog_meta WHERE key = 'schema_version'
      `;
      assert.equal(version?.value, "1");
    }),
  );

  it.effect("applies a sync atomically: a failing write leaves the cursor and rows untouched", () =>
    Effect.gen(function* () {
      const store = yield* fresh;
      yield* store.applySync(syncWrite([landed("a", { _tag: "Direct" })]));
      const clash = syncWrite([landed("b", { _tag: "Direct" })], { base: 1 });
      // Ordinal 1 already belongs to "a", so the second commit row violates the ordinal index.
      const failing: ChangelogStore.SyncWrite = {
        ...clash,
        commits: [
          ...clash.commits,
          { landing: { ...clash.commits[0]!.landing, sha: "c", ordinal: 1 }, unitKey: null },
        ],
      };
      const result = yield* store.applySync(failing).pipe(Effect.result);
      assert.isTrue(result._tag === "Failure");

      const row = Option.getOrThrow(yield* store.getRepository(key));
      assert.deepEqual(row.cursor, { headSha: "a", headOrdinal: 1 });
      assert.deepEqual(yield* pageKeys(store), [["push:a", "pending"]]);
      assert.equal(yield* store.ordinalOf(key, "b"), null);
    }),
  );

  it.effect("rewrites the same rows when a sync runs twice", () =>
    Effect.gen(function* () {
      const store = yield* fresh;
      const write = syncWrite([
        landed("a", { _tag: "PullRequest", pullRequest: pull(1) }),
        landed("b", { _tag: "Direct" }),
      ]);
      yield* store.applySync(write);
      const once = yield* store.page({ key, beforeOrdinal: null, limit: 50 });
      yield* store.applySync(write);
      assert.deepEqual(yield* store.page({ key, beforeOrdinal: null, limit: 50 }), once);
    }),
  );

  it.effect("rewrites an unresolved commit once resolved, but never a resolved one", () =>
    Effect.gen(function* () {
      const store = yield* fresh;
      yield* store.applySync(
        syncWrite([
          landed("a", { _tag: "Direct" }),
          landed("b", { _tag: "Unresolved", attempts: 1 }),
        ]),
      );
      assert.deepEqual(
        (yield* store.unresolvedCommits(key)).map((commit) => [commit.sha, commit.attempts]),
        [["b", 1]],
      );

      const resolved = syncWrite([
        landed("a", { _tag: "Unresolved", attempts: 0 }),
        landed("b", { _tag: "Direct" }),
      ]);
      yield* store.applySync(resolved);
      assert.deepEqual(yield* store.unresolvedCommits(key), []);
    }),
  );

  it.effect("writes a summary only for the content it was generated from", () =>
    Effect.gen(function* () {
      const store = yield* fresh;
      const first = syncWrite([landed("a", { _tag: "Direct" })]);
      yield* store.applySync(first);
      const unit = first.units[0]!;
      const summary = { title: "Title", body: "Body.", category: "fix" as const };

      const stale = yield* store.writeSummaries({
        key,
        now: T0,
        summaries: [{ unitKey: unit.key, inputHash: "older", ...summary }],
      });
      assert.equal(stale, 0);
      assert.deepEqual(yield* pageKeys(store), [["push:a", "pending"]]);

      assert.equal(
        yield* store.writeSummaries({
          key,
          now: T0,
          summaries: [{ unitKey: unit.key, inputHash: unit.contentHash, ...summary }],
        }),
        1,
      );
      assert.deepEqual(yield* pageKeys(store), [["push:a", "ready"]]);

      const grown = syncWrite([{ ...landed("b", { _tag: "Direct" }), committedAt: T0 + MINUTE }], {
        base: 1,
        tail: unit,
      });
      yield* store.applySync(grown);
      const [entry] = yield* store.page({ key, beforeOrdinal: null, limit: 50 });
      assert.equal(entry?.unit.commitCount, 2);
      assert.equal(entry?.summary.state, "pending");
      assert.equal(entry?.summary.title, "Title");
    }),
  );

  it.effect("hides entries on a history reset and revives a re-ingested one with its summary", () =>
    Effect.gen(function* () {
      const store = yield* fresh;
      const first = syncWrite([
        landed("a", { _tag: "PullRequest", pullRequest: pull(1) }),
        landed("b", { _tag: "PullRequest", pullRequest: pull(2) }),
      ]);
      yield* store.applySync(first);
      const prOne = first.units[0]!;
      yield* store.writeSummaries({
        key,
        now: T0,
        summaries: [
          {
            unitKey: prOne.key,
            inputHash: prOne.contentHash,
            title: "T",
            body: "B.",
            category: "feature",
          },
        ],
      });

      yield* store.applySync(
        syncWrite(
          [
            landed("a", { _tag: "PullRequest", pullRequest: pull(1) }),
            landed("c", { _tag: "Direct" }),
          ],
          { reset: true },
        ),
      );
      assert.deepEqual(yield* pageKeys(store), [
        ["push:c", "pending"],
        ["pr:1", "ready"],
      ]);
      assert.equal(yield* store.ordinalOf(key, "b"), null);
    }),
  );

  it.effect("pages newest first with a keyset cursor", () =>
    Effect.gen(function* () {
      const store = yield* fresh;
      yield* store.applySync(
        syncWrite(
          [1, 2, 3, 4, 5].map((n) =>
            landed(`s${n}`, { _tag: "PullRequest", pullRequest: pull(n) }),
          ),
        ),
      );
      const first = yield* store.page({ key, beforeOrdinal: null, limit: 2 });
      assert.deepEqual(
        first.map((row) => row.unit.key),
        ["pr:5", "pr:4"],
      );
      const next = yield* store.page({
        key,
        beforeOrdinal: first.at(-1)!.unit.lastOrdinal,
        limit: 2,
      });
      assert.deepEqual(
        next.map((row) => row.unit.key),
        ["pr:3", "pr:2"],
      );
    }),
  );

  it.effect("queues only settled, due summaries and backs failures off until it gives up", () =>
    Effect.gen(function* () {
      const store = yield* fresh;
      const write = syncWrite([
        landed("a", { _tag: "PullRequest", pullRequest: pull(1) }),
        landed("b", { _tag: "Direct" }),
      ]);
      yield* store.applySync(write);
      const due = (now: number) =>
        store
          .pendingSummaries({ key, now, limit: 12 })
          .pipe(Effect.map((rows) => rows.map((row) => row.unit.key)));
      // The trailing push group stays open for the gap, so only the PR is due at once.
      assert.deepEqual(yield* due(T0), ["pr:1"]);
      assert.deepEqual(yield* due(T0 + 15 * MINUTE), ["push:b", "pr:1"]);

      const prOne = write.units[0]!;
      const fail = (attempts: number, now: number) =>
        store.recordSummaryFailures({
          key,
          now,
          entries: [{ unitKey: prOne.key, inputHash: prOne.contentHash, attempts }],
        });
      yield* fail(0, T0);
      assert.deepEqual(yield* due(T0 + MINUTE), []);
      assert.deepEqual(yield* due(T0 + 5 * MINUTE), ["pr:1"]);
      yield* fail(1, T0);
      yield* fail(2, T0);
      assert.deepEqual(yield* pageKeys(store), [
        ["push:b", "pending"],
        ["pr:1", "unavailable"],
      ]);
    }),
  );

  it.effect("stores production only when it changes", () =>
    Effect.gen(function* () {
      const store = yield* fresh;
      const production = {
        signal: { source: "tag" as const, tag: "v1.0.0", sha: "a" },
        watermark: 3,
        stale: false,
      };
      assert.isTrue(yield* store.setProduction(key, production));
      assert.isFalse(yield* store.setProduction(key, production));
      assert.isTrue(yield* store.setProduction(key, { ...production, stale: true }));
      assert.deepEqual(Option.getOrThrow(yield* store.getRepository(key)).production, {
        ...production,
        stale: true,
      });
    }),
  );

  it.effect(
    "finds a change's threads by linked PR or branch, and projects with a project thread",
    () =>
      Effect.gen(function* () {
        const store = yield* fresh;
        const sql = yield* SqlClient.SqlClient;
        const insertThread = (input: {
          readonly id: string;
          readonly project: string;
          readonly branch: string | null;
          readonly pullRequests: ReadonlyArray<{
            readonly number: number;
            readonly source?: string;
          }>;
          readonly deleted?: boolean;
        }) =>
          sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, deleted_at, payload_json
          ) VALUES (
            ${input.id}, ${input.project}, ${`Thread ${input.id}`}, 'codex', 'full-access',
            'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
            ${input.deleted === true ? "2026-10-02T00:00:00.000Z" : null},
            ${JSON.stringify({
              branch: input.branch,
              pullRequests: input.pullRequests.map((link) => ({
                host: "github.com",
                repository: "acme/web",
                number: link.number,
                source: link.source ?? "manual",
              })),
            })}
          )
        `;
        yield* insertThread({
          id: "linked",
          project: "p1",
          branch: null,
          pullRequests: [{ number: 7 }],
        });
        yield* insertThread({
          id: "by-branch",
          project: "p1",
          branch: "feature-7",
          pullRequests: [],
        });
        yield* insertThread({
          id: "dismissed",
          project: "p1",
          branch: null,
          pullRequests: [{ number: 7, source: "stack-dismissed" }],
        });
        yield* insertThread({
          id: "other-project",
          project: "p2",
          branch: "feature-7",
          pullRequests: [],
        });
        yield* insertThread({
          id: "project-thread:abc",
          project: "p1",
          branch: null,
          pullRequests: [],
        });
        yield* insertThread({
          id: "project-thread:gone",
          project: "p3",
          branch: null,
          pullRequests: [],
          deleted: true,
        });

        const matches = yield* store.findThreads({
          projectIds: [ProjectId.make("p1")],
          pullRequestNumbers: [7],
          branches: ["feature-7"],
        });
        assert.deepEqual(
          matches
            .map((match) => [match.threadId, match.link?.number ?? null, match.branch])
            .toSorted(),
          [
            ["by-branch", null, "feature-7"],
            ["linked", 7, null],
          ],
        );
        assert.deepEqual([...(yield* store.projectsWithProjectThread)], ["p1"]);
      }),
  );
});
