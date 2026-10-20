// Fork-owned persistence for the project changelog. Not a numbered migration: a fork id would
// collide with a future upstream one, so the layer creates its own `fork_changelog_` tables with
// guarded DDL once upstream migrations have run. A fork home seeded from a nightly database just
// gains the tables, and a nightly build opening a fork database ignores them.
//
// Everything except summaries is a cache of GitHub, so a schema version this build does not know
// drops and rebuilds the tables.

import { ProjectId, ThreadId } from "@t3tools/contracts";
import { isProjectThreadId, PROJECT_THREAD_ID_PREFIX } from "@t3tools/shared/projectThread";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import {
  type ChangeUnit,
  type GitHubRepository,
  type Landing,
  type ProductionState,
  type RepositoryKey,
  summaryAfterFailure,
  type UnitKey,
} from "./changelogModel.ts";

const SCHEMA_VERSION = "1";

const TABLES = [
  "fork_changelog_entries",
  "fork_changelog_commits",
  "fork_changelog_repositories",
] as const;

const DDL = [
  `CREATE TABLE IF NOT EXISTS fork_changelog_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // One row per GitHub repository: a repository shared by several projects syncs once.
  `CREATE TABLE IF NOT EXISTS fork_changelog_repositories (
     repository_key TEXT PRIMARY KEY,
     host TEXT NOT NULL,
     owner TEXT NOT NULL,
     name TEXT NOT NULL,
     web_url TEXT NOT NULL,
     default_branch TEXT,
     head_sha TEXT,
     head_ordinal INTEGER,
     production_json TEXT,
     sync_json TEXT NOT NULL,
     next_sync_at INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   )`,
  // First-parent commits only, so the production watermark is one indexed lookup and an
  // unresolved commit can be retried by sha.
  `CREATE TABLE IF NOT EXISTS fork_changelog_commits (
     repository_key TEXT NOT NULL,
     sha TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     association TEXT NOT NULL CHECK (association IN ('pull-request', 'direct', 'unresolved')),
     association_attempts INTEGER NOT NULL DEFAULT 0,
     unit_key TEXT,
     commit_json TEXT NOT NULL,
     PRIMARY KEY (repository_key, sha)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS fork_changelog_commits_ordinal
     ON fork_changelog_commits (repository_key, ordinal)`,
  `CREATE INDEX IF NOT EXISTS fork_changelog_commits_ungrouped
     ON fork_changelog_commits (repository_key, ordinal) WHERE unit_key IS NULL`,
  `CREATE TABLE IF NOT EXISTS fork_changelog_entries (
     repository_key TEXT NOT NULL,
     unit_key TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('pull-request', 'direct-push')),
     first_ordinal INTEGER NOT NULL,
     last_ordinal INTEGER NOT NULL,
     head_sha TEXT NOT NULL,
     commit_count INTEGER NOT NULL,
     landed_at INTEGER NOT NULL,
     last_committed_at INTEGER NOT NULL,
     settles_at INTEGER NOT NULL,
     source_json TEXT NOT NULL,
     authors_json TEXT NOT NULL,
     content_hash TEXT NOT NULL,
     thread_refs_json TEXT NOT NULL DEFAULT '[]',
     summary_state TEXT NOT NULL CHECK (summary_state IN ('pending', 'ready', 'unavailable')),
     summary_title TEXT,
     summary_body TEXT,
     summary_category TEXT,
     summary_input_hash TEXT,
     summary_attempts INTEGER NOT NULL DEFAULT 0,
     next_summary_at INTEGER NOT NULL DEFAULT 0,
     summarized_at INTEGER,
     removed_at INTEGER,
     PRIMARY KEY (repository_key, unit_key)
   )`,
  `CREATE INDEX IF NOT EXISTS fork_changelog_entries_page
     ON fork_changelog_entries (repository_key, last_ordinal DESC) WHERE removed_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS fork_changelog_entries_pending
     ON fork_changelog_entries (repository_key, last_ordinal DESC)
     WHERE removed_at IS NULL AND summary_state = 'pending'`,
] as const;

/** Entries kept per repository; older entries and their commits are pruned after each sync. */
export const RETAINED_ENTRIES = 500;

const SyncProblemReason = Schema.Literals([
  "credentials",
  "not-found",
  "rate-limited",
  "unreachable",
]);

const RepositorySyncStatus = Schema.Union([
  Schema.TaggedStruct("NeverSynced", {}),
  Schema.TaggedStruct("Synced", { at: Schema.Number }),
  Schema.TaggedStruct("Failed", {
    at: Schema.Number,
    lastSyncedAt: Schema.NullOr(Schema.Number),
    reason: SyncProblemReason,
    retryAt: Schema.NullOr(Schema.Number),
  }),
]);
export type RepositorySyncStatus = typeof RepositorySyncStatus.Type;

const MergedPullRequestJson = Schema.Struct({
  number: Schema.Number,
  repository: Schema.String,
  title: Schema.String,
  bodyExcerpt: Schema.String,
  url: Schema.String,
  authorLogin: Schema.NullOr(Schema.String),
  mergedAt: Schema.NullOr(Schema.Number),
  mergeCommitSha: Schema.NullOr(Schema.String),
  headRef: Schema.String,
  baseRef: Schema.String,
});

const ChangeUnitSourceJson = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pull-request"),
    pullRequest: MergedPullRequestJson,
    commitSubjects: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("direct-push"),
    authorKey: Schema.String,
    commitSubjects: Schema.Array(Schema.String),
  }),
]);

const ProductionStateJson = Schema.Struct({
  signal: Schema.Union([
    Schema.Struct({
      source: Schema.Literal("deployment"),
      environment: Schema.String,
      deploymentId: Schema.Number,
      sha: Schema.String,
      at: Schema.Number,
      url: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({
      source: Schema.Literal("release"),
      tag: Schema.String,
      sha: Schema.String,
      at: Schema.NullOr(Schema.Number),
      url: Schema.String,
    }),
    Schema.Struct({ source: Schema.Literal("tag"), tag: Schema.String, sha: Schema.String }),
    Schema.Struct({ source: Schema.Literal("default-branch") }),
  ]),
  watermark: Schema.Union([Schema.Number, Schema.Literal("head"), Schema.Null]),
  stale: Schema.Boolean,
});

const CommitJson = Schema.Struct({
  subject: Schema.String,
  authorKey: Schema.String,
  authorDisplay: Schema.String,
  committedAt: Schema.Number,
  /** Kept until the commit is grouped, so a deferred commit regroups without a lookup. */
  pullRequest: Schema.optionalKey(MergedPullRequestJson),
});

const ThreadRef = Schema.Struct({ threadId: ThreadId, projectId: ProjectId, title: Schema.String });
export type ThreadRef = typeof ThreadRef.Type;

const SummaryCategory = Schema.Literals(["feature", "fix", "improvement", "maintenance"]);
export type SummaryCategory = typeof SummaryCategory.Type;

const json = <S extends Schema.Top>(schema: S) => {
  const codec = Schema.fromJsonString(schema);
  return {
    decode: Schema.decodeUnknownEffect(codec),
    encode: (value: S["Type"]) => JSON.stringify(value),
  };
};
const syncJson = json(RepositorySyncStatus);
const sourceJson = json(ChangeUnitSourceJson);
const productionJson = json(ProductionStateJson);
const commitJson = json(CommitJson);
const authorsJson = json(Schema.Array(Schema.String));
const threadRefsJson = json(Schema.Array(ThreadRef));

export interface RepositoryRow {
  readonly repository: GitHubRepository;
  readonly defaultBranch: string | null;
  readonly cursor: { readonly headSha: string; readonly headOrdinal: number } | null;
  readonly production: ProductionState | null;
  readonly sync: RepositorySyncStatus;
  readonly nextSyncAt: number;
}

export interface EntrySummary {
  readonly state: "pending" | "ready" | "unavailable";
  /** Kept while a grown unit waits for its new summary, so the entry never goes blank. */
  readonly title: string | null;
  readonly body: string | null;
  readonly category: SummaryCategory | null;
  readonly attempts: number;
}

export interface EntryRow {
  readonly unit: ChangeUnit;
  readonly summary: EntrySummary;
  readonly threadRefs: ReadonlyArray<ThreadRef>;
}

/**
 * Everything one sync learned, applied in one transaction so the cursor never runs ahead of the
 * rows it covers. A crash before commit re-reads the same landings and rewrites the same keys.
 */
export interface SyncWrite {
  readonly key: RepositoryKey;
  readonly defaultBranch: string;
  readonly cursor: { readonly headSha: string; readonly headOrdinal: number };
  /** History was rewritten: every commit is dropped and every entry hidden until re-ingested. */
  readonly reset: boolean;
  /** New commits, and earlier unresolved ones with their new association. */
  readonly commits: ReadonlyArray<{ readonly landing: Landing; readonly unitKey: UnitKey | null }>;
  /**
   * Upserted by (repository, unit key). A re-ingested key is revived with its summary. A changed
   * content hash sends the summary back to pending with its attempts reset; the old text stays
   * shown until the new one lands.
   */
  readonly units: ReadonlyArray<ChangeUnit>;
  readonly now: number;
}

export interface ThreadMatch extends ThreadRef {
  /** The thread's linked pull request that matched, as stored on the link. */
  readonly link: {
    readonly host: string;
    readonly repository: string;
    readonly number: number;
  } | null;
  readonly branch: string | null;
}

export type ChangelogStoreError = PersistenceSqlError | PersistenceDecodeError;

export class ChangelogStore extends Context.Service<
  ChangelogStore,
  {
    /** Registers the repository on first sight and returns its row. */
    readonly ensureRepository: (
      repository: GitHubRepository,
    ) => Effect.Effect<RepositoryRow, ChangelogStoreError>;
    readonly getRepository: (
      key: RepositoryKey,
    ) => Effect.Effect<Option.Option<RepositoryRow>, ChangelogStoreError>;
    /** The newest live unit, which new landings may extend. */
    readonly tail: (key: RepositoryKey) => Effect.Effect<ChangeUnit | null, ChangelogStoreError>;
    /**
     * Commits in no unit yet, oldest first: unresolved ones and every commit after the first
     * unresolved one, which grouping deferred. Parents are not stored.
     */
    readonly ungroupedCommits: (
      key: RepositoryKey,
    ) => Effect.Effect<ReadonlyArray<Landing>, ChangelogStoreError>;
    readonly ordinalOf: (
      key: RepositoryKey,
      sha: string,
    ) => Effect.Effect<number | null, ChangelogStoreError>;
    readonly applySync: (write: SyncWrite) => Effect.Effect<void, ChangelogStoreError>;
    /** Returns whether the stored state changed. */
    readonly setProduction: (
      key: RepositoryKey,
      production: ProductionState,
    ) => Effect.Effect<boolean, ChangelogStoreError>;
    readonly setSyncStatus: (
      key: RepositoryKey,
      status: RepositorySyncStatus,
      nextSyncAt: number,
    ) => Effect.Effect<void, ChangelogStoreError>;
    /** Keyset page: live entries with last_ordinal below `beforeOrdinal`, newest first. */
    readonly page: (input: {
      readonly key: RepositoryKey;
      readonly beforeOrdinal: number | null;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<EntryRow>, ChangelogStoreError>;
    /** Settled, due, pending entries, newest first. */
    readonly pendingSummaries: (input: {
      readonly key: RepositoryKey;
      readonly now: number;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<EntryRow>, ChangelogStoreError>;
    /**
     * Compare-and-set: a summary is written only while the entry's content hash still equals
     * the one the prompt was built from. A unit that grew while the model ran stays pending and
     * the stale answer is dropped. Returns the number written.
     */
    readonly writeSummaries: (input: {
      readonly key: RepositoryKey;
      readonly now: number;
      readonly summaries: ReadonlyArray<{
        readonly unitKey: UnitKey;
        readonly inputHash: string;
        readonly title: string;
        readonly body: string;
        readonly category: SummaryCategory;
      }>;
    }) => Effect.Effect<number, ChangelogStoreError>;
    /** Backs off each entry, or gives up on it at the attempt cap; compare-and-set as above. */
    readonly recordSummaryFailures: (input: {
      readonly key: RepositoryKey;
      readonly now: number;
      readonly entries: ReadonlyArray<{
        readonly unitKey: UnitKey;
        readonly inputHash: string;
        readonly attempts: number;
        readonly charged: boolean;
      }>;
    }) => Effect.Effect<void, ChangelogStoreError>;
    readonly setThreadRefs: (input: {
      readonly key: RepositoryKey;
      readonly refs: ReadonlyMap<UnitKey, ReadonlyArray<ThreadRef>>;
    }) => Effect.Effect<void, ChangelogStoreError>;
    /** Projects with a project thread, archived ones included. */
    readonly projectsWithProjectThread: Effect.Effect<ReadonlySet<ProjectId>, ChangelogStoreError>;
    /**
     * Non-deleted threads of `projectIds` linking one of `pullRequestNumbers`, or on one of
     * `branches`. Callers check the link's repository; archived threads are included because a
     * merged PR's thread is usually settled.
     */
    readonly findThreads: (input: {
      readonly projectIds: ReadonlyArray<ProjectId>;
      readonly pullRequestNumbers: ReadonlyArray<number>;
      readonly branches: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<ThreadMatch>, ChangelogStoreError>;
  }
>()("t3/projectChangelog/ChangelogStore") {}

const sqlError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(operation, cause)
    : new PersistenceSqlError({ operation, cause });

interface RepositorySqlRow {
  readonly repositoryKey: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly webUrl: string;
  readonly defaultBranch: string | null;
  readonly headSha: string | null;
  readonly headOrdinal: number | null;
  readonly productionJson: string | null;
  readonly syncJson: string;
  readonly nextSyncAt: number;
}

interface EntrySqlRow {
  readonly unitKey: string;
  readonly firstOrdinal: number;
  readonly lastOrdinal: number;
  readonly headSha: string;
  readonly commitCount: number;
  readonly landedAt: number;
  readonly lastCommittedAt: number;
  readonly settlesAt: number;
  readonly sourceJson: string;
  readonly authorsJson: string;
  readonly contentHash: string;
  readonly threadRefsJson: string;
  readonly summaryState: EntrySummary["state"];
  readonly summaryTitle: string | null;
  readonly summaryBody: string | null;
  readonly summaryCategory: string | null;
  readonly summaryAttempts: number;
}

const decodeCategory = Schema.decodeUnknownEffect(Schema.NullOr(SummaryCategory));

const decodeRepository = Effect.fnUntraced(function* (row: RepositorySqlRow) {
  return {
    repository: {
      key: row.repositoryKey as RepositoryKey,
      host: row.host,
      owner: row.owner,
      name: row.name,
      webUrl: row.webUrl,
    },
    defaultBranch: row.defaultBranch,
    cursor:
      row.headSha === null || row.headOrdinal === null
        ? null
        : { headSha: row.headSha, headOrdinal: row.headOrdinal },
    production:
      row.productionJson === null ? null : yield* productionJson.decode(row.productionJson),
    sync: yield* syncJson.decode(row.syncJson),
    nextSyncAt: row.nextSyncAt,
  } satisfies RepositoryRow;
});

// Per-row decoding inside a bounded page; the page read carries the span.
const decodeEntry = Effect.fnUntraced(function* (row: EntrySqlRow) {
  return {
    unit: {
      key: row.unitKey as UnitKey,
      source: yield* sourceJson.decode(row.sourceJson),
      firstOrdinal: row.firstOrdinal,
      lastOrdinal: row.lastOrdinal,
      headSha: row.headSha,
      commitCount: row.commitCount,
      authors: yield* authorsJson.decode(row.authorsJson),
      landedAt: row.landedAt,
      lastCommittedAt: row.lastCommittedAt,
      settlesAt: row.settlesAt,
      contentHash: row.contentHash,
    },
    summary: {
      state: row.summaryState,
      title: row.summaryTitle,
      body: row.summaryBody,
      category: yield* decodeCategory(row.summaryCategory),
      attempts: row.summaryAttempts,
    },
    threadRefs: yield* threadRefsJson.decode(row.threadRefsJson),
  } satisfies EntryRow;
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* Effect.gen(function* () {
    for (const statement of DDL) yield* sql.unsafe(statement);
    const version = yield* sql<{ readonly value: string }>`
      SELECT value FROM fork_changelog_meta WHERE key = 'schema_version'
    `;
    if (version[0]?.value === SCHEMA_VERSION) return;
    if (version.length > 0) {
      for (const table of TABLES) yield* sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
      for (const statement of DDL) yield* sql.unsafe(statement);
    }
    yield* sql`
      INSERT INTO fork_changelog_meta (key, value) VALUES ('schema_version', ${SCHEMA_VERSION})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `;
  }).pipe(sql.withTransaction, Effect.mapError(sqlError("ensureChangelogTables")), Effect.orDie);

  const selectRepository = (key: RepositoryKey) => sql<RepositorySqlRow>`
    SELECT repository_key AS "repositoryKey", host, owner, name, web_url AS "webUrl",
      default_branch AS "defaultBranch", head_sha AS "headSha", head_ordinal AS "headOrdinal",
      production_json AS "productionJson", sync_json AS "syncJson", next_sync_at AS "nextSyncAt"
    FROM fork_changelog_repositories
    WHERE repository_key = ${key}
  `;

  const getRepository: ChangelogStore["Service"]["getRepository"] = Effect.fn(
    "ChangelogStore.getRepository",
  )(
    function* (key) {
      const [row] = yield* selectRepository(key);
      return row === undefined ? Option.none() : Option.some(yield* decodeRepository(row));
    },
    Effect.mapError(sqlError("getChangelogRepository")),
  );

  const ensureRepository: ChangelogStore["Service"]["ensureRepository"] = Effect.fn(
    "ChangelogStore.ensureRepository",
  )(
    function* (repository) {
      yield* sql`
        INSERT INTO fork_changelog_repositories (
          repository_key, host, owner, name, web_url, sync_json, next_sync_at, updated_at
        )
        VALUES (
          ${repository.key}, ${repository.host}, ${repository.owner}, ${repository.name},
          ${repository.webUrl}, ${syncJson.encode({ _tag: "NeverSynced" })}, 0, 0
        )
        ON CONFLICT (repository_key) DO UPDATE SET
          owner = excluded.owner, name = excluded.name, web_url = excluded.web_url
      `;
      const [row] = yield* selectRepository(repository.key);
      if (row === undefined) {
        return yield* new PersistenceSqlError({
          operation: "ensureChangelogRepository",
          detail: "The repository row was not written.",
        });
      }
      return yield* decodeRepository(row);
    },
    Effect.mapError(sqlError("ensureChangelogRepository")),
  );

  const entryColumns = sql.literal(`
    unit_key AS "unitKey", first_ordinal AS "firstOrdinal", last_ordinal AS "lastOrdinal",
    head_sha AS "headSha", commit_count AS "commitCount", landed_at AS "landedAt",
    last_committed_at AS "lastCommittedAt", settles_at AS "settlesAt",
    source_json AS "sourceJson", authors_json AS "authorsJson", content_hash AS "contentHash",
    thread_refs_json AS "threadRefsJson", summary_state AS "summaryState",
    summary_title AS "summaryTitle", summary_body AS "summaryBody",
    summary_category AS "summaryCategory", summary_attempts AS "summaryAttempts"
  `);

  const tail: ChangelogStore["Service"]["tail"] = Effect.fn("ChangelogStore.tail")(
    function* (key) {
      const [row] = yield* sql<EntrySqlRow>`
        SELECT ${entryColumns} FROM fork_changelog_entries
        WHERE repository_key = ${key} AND removed_at IS NULL
        ORDER BY last_ordinal DESC LIMIT 1
      `;
      return row === undefined ? null : (yield* decodeEntry(row)).unit;
    },
    Effect.mapError(sqlError("getChangelogTail")),
  );

  const ungroupedCommits: ChangelogStore["Service"]["ungroupedCommits"] = Effect.fn(
    "ChangelogStore.ungroupedCommits",
  )(
    function* (key) {
      const rows = yield* sql<{
        readonly ordinal: number;
        readonly sha: string;
        readonly association: "pull-request" | "direct" | "unresolved";
        readonly attempts: number;
        readonly commitJson: string;
      }>`
        SELECT ordinal, sha, association, association_attempts AS attempts,
          commit_json AS "commitJson"
        FROM fork_changelog_commits
        WHERE repository_key = ${key} AND unit_key IS NULL
        ORDER BY ordinal ASC
      `;
      return yield* Effect.forEach(rows, (row) =>
        commitJson.decode(row.commitJson).pipe(
          Effect.map(({ pullRequest, ...commit }): Landing => ({
            ...commit,
            sha: row.sha,
            ordinal: row.ordinal,
            parentShas: [],
            association:
              row.association === "pull-request" && pullRequest !== undefined
                ? { _tag: "PullRequest", pullRequest }
                : row.association === "direct"
                  ? { _tag: "Direct" }
                  : { _tag: "Unresolved", attempts: row.attempts },
          })),
        ),
      );
    },
    Effect.mapError(sqlError("listUngroupedChangelogCommits")),
  );

  const ordinalOf: ChangelogStore["Service"]["ordinalOf"] = Effect.fn("ChangelogStore.ordinalOf")(
    function* (key, sha) {
      const [row] = yield* sql<{ readonly ordinal: number }>`
        SELECT ordinal FROM fork_changelog_commits WHERE repository_key = ${key} AND sha = ${sha}
      `;
      return row?.ordinal ?? null;
    },
    Effect.mapError(sqlError("getChangelogCommitOrdinal")),
  );

  const upsertCommit = (key: RepositoryKey, landing: Landing, unitKey: UnitKey | null) => {
    const association =
      landing.association._tag === "PullRequest"
        ? "pull-request"
        : landing.association._tag === "Direct"
          ? "direct"
          : "unresolved";
    const attempts = landing.association._tag === "Unresolved" ? landing.association.attempts : 0;
    // A grouped commit never changes; an ungrouped one is rewritten as it resolves and groups.
    return sql`
      INSERT INTO fork_changelog_commits (
        repository_key, sha, ordinal, association, association_attempts, unit_key, commit_json
      )
      VALUES (
        ${key}, ${landing.sha}, ${landing.ordinal}, ${association}, ${attempts}, ${unitKey},
        ${commitJson.encode({
          subject: landing.subject,
          authorKey: landing.authorKey,
          authorDisplay: landing.authorDisplay,
          committedAt: landing.committedAt,
          ...(landing.association._tag === "PullRequest"
            ? { pullRequest: landing.association.pullRequest }
            : {}),
        })}
      )
      ON CONFLICT (repository_key, sha) DO UPDATE SET
        association = excluded.association,
        association_attempts = excluded.association_attempts,
        unit_key = excluded.unit_key,
        commit_json = excluded.commit_json
      WHERE fork_changelog_commits.unit_key IS NULL
    `;
  };

  const upsertUnit = (key: RepositoryKey, unit: ChangeUnit, now: number) => sql`
    INSERT INTO fork_changelog_entries (
      repository_key, unit_key, kind, first_ordinal, last_ordinal, head_sha, commit_count,
      landed_at, last_committed_at, settles_at, source_json, authors_json, content_hash,
      summary_state, summary_attempts, next_summary_at
    )
    VALUES (
      ${key}, ${unit.key}, ${unit.source.kind}, ${unit.firstOrdinal}, ${unit.lastOrdinal},
      ${unit.headSha}, ${unit.commitCount}, ${unit.landedAt}, ${unit.lastCommittedAt},
      ${unit.settlesAt}, ${sourceJson.encode(unit.source)}, ${authorsJson.encode(unit.authors)},
      ${unit.contentHash}, 'pending', 0, 0
    )
    ON CONFLICT (repository_key, unit_key) DO UPDATE SET
      kind = excluded.kind,
      first_ordinal = excluded.first_ordinal,
      last_ordinal = excluded.last_ordinal,
      head_sha = excluded.head_sha,
      commit_count = excluded.commit_count,
      landed_at = excluded.landed_at,
      last_committed_at = excluded.last_committed_at,
      settles_at = excluded.settles_at,
      source_json = excluded.source_json,
      authors_json = excluded.authors_json,
      removed_at = NULL,
      summary_state = CASE
        WHEN fork_changelog_entries.summary_input_hash = excluded.content_hash THEN 'ready'
        WHEN fork_changelog_entries.content_hash = excluded.content_hash
          THEN fork_changelog_entries.summary_state
        ELSE 'pending' END,
      summary_attempts = CASE
        WHEN fork_changelog_entries.content_hash = excluded.content_hash
          THEN fork_changelog_entries.summary_attempts
        ELSE 0 END,
      next_summary_at = CASE
        WHEN fork_changelog_entries.content_hash = excluded.content_hash
          THEN fork_changelog_entries.next_summary_at
        ELSE ${now} END,
      content_hash = excluded.content_hash
  `;

  const applySync: ChangelogStore["Service"]["applySync"] = Effect.fn("ChangelogStore.applySync")(
    function* (write) {
      if (write.reset) {
        yield* sql`DELETE FROM fork_changelog_commits WHERE repository_key = ${write.key}`;
        yield* sql`
          UPDATE fork_changelog_entries SET removed_at = ${write.now}
          WHERE repository_key = ${write.key} AND removed_at IS NULL
        `;
      }
      for (const { landing, unitKey } of write.commits) {
        yield* upsertCommit(write.key, landing, unitKey);
      }
      for (const unit of write.units) yield* upsertUnit(write.key, unit, write.now);
      yield* sql`
        UPDATE fork_changelog_repositories SET
          default_branch = ${write.defaultBranch},
          head_sha = ${write.cursor.headSha},
          head_ordinal = ${write.cursor.headOrdinal},
          updated_at = ${write.now}
        WHERE repository_key = ${write.key}
      `;
      const [boundary] = yield* sql<{
        readonly lastOrdinal: number;
        readonly firstOrdinal: number;
      }>`
        SELECT last_ordinal AS "lastOrdinal", first_ordinal AS "firstOrdinal"
        FROM fork_changelog_entries
        WHERE repository_key = ${write.key} AND removed_at IS NULL
        ORDER BY last_ordinal DESC LIMIT 1 OFFSET ${RETAINED_ENTRIES - 1}
      `;
      if (boundary !== undefined) {
        yield* sql`
          DELETE FROM fork_changelog_entries
          WHERE repository_key = ${write.key} AND last_ordinal < ${boundary.lastOrdinal}
        `;
        yield* sql`
          DELETE FROM fork_changelog_commits
          WHERE repository_key = ${write.key} AND ordinal < ${boundary.firstOrdinal}
        `;
      }
    },
    sql.withTransaction,
    Effect.mapError(sqlError("applyChangelogSync")),
  );

  const setProduction: ChangelogStore["Service"]["setProduction"] = Effect.fn(
    "ChangelogStore.setProduction",
  )(
    function* (key, production) {
      const encoded = productionJson.encode(production);
      const changed = yield* sql<{ readonly repositoryKey: string }>`
        UPDATE fork_changelog_repositories SET production_json = ${encoded}
        WHERE repository_key = ${key} AND production_json IS NOT ${encoded}
        RETURNING repository_key AS "repositoryKey"
      `;
      return changed.length > 0;
    },
    Effect.mapError(sqlError("setChangelogProduction")),
  );

  const setSyncStatus: ChangelogStore["Service"]["setSyncStatus"] = Effect.fn(
    "ChangelogStore.setSyncStatus",
  )(
    function* (key, status, nextSyncAt) {
      yield* sql`
        UPDATE fork_changelog_repositories
        SET sync_json = ${syncJson.encode(status)}, next_sync_at = ${nextSyncAt}
        WHERE repository_key = ${key}
      `;
    },
    Effect.mapError(sqlError("setChangelogSyncStatus")),
  );

  const page: ChangelogStore["Service"]["page"] = Effect.fn("ChangelogStore.page")(
    function* (input) {
      const rows = yield* sql<EntrySqlRow>`
        SELECT ${entryColumns} FROM fork_changelog_entries
        WHERE repository_key = ${input.key} AND removed_at IS NULL
          AND last_ordinal < ${input.beforeOrdinal ?? Number.MAX_SAFE_INTEGER}
        ORDER BY last_ordinal DESC LIMIT ${input.limit}
      `;
      return yield* Effect.forEach(rows, decodeEntry);
    },
    Effect.mapError(sqlError("pageChangelogEntries")),
  );

  const pendingSummaries: ChangelogStore["Service"]["pendingSummaries"] = Effect.fn(
    "ChangelogStore.pendingSummaries",
  )(
    function* (input) {
      const rows = yield* sql<EntrySqlRow>`
        SELECT ${entryColumns} FROM fork_changelog_entries
        WHERE repository_key = ${input.key} AND removed_at IS NULL
          AND summary_state = 'pending'
          AND settles_at <= ${input.now} AND next_summary_at <= ${input.now}
        ORDER BY last_ordinal DESC LIMIT ${input.limit}
      `;
      return yield* Effect.forEach(rows, decodeEntry);
    },
    Effect.mapError(sqlError("listPendingChangelogSummaries")),
  );

  const writeSummaries: ChangelogStore["Service"]["writeSummaries"] = Effect.fn(
    "ChangelogStore.writeSummaries",
  )(
    function* (input) {
      let written = 0;
      for (const summary of input.summaries) {
        const rows = yield* sql<{ readonly unitKey: string }>`
          UPDATE fork_changelog_entries SET
            summary_state = 'ready',
            summary_title = ${summary.title},
            summary_body = ${summary.body},
            summary_category = ${summary.category},
            summary_input_hash = ${summary.inputHash},
            summary_attempts = 0,
            summarized_at = ${input.now}
          WHERE repository_key = ${input.key} AND unit_key = ${summary.unitKey}
            AND content_hash = ${summary.inputHash} AND removed_at IS NULL
          RETURNING unit_key AS "unitKey"
        `;
        written += rows.length;
      }
      return written;
    },
    sql.withTransaction,
    Effect.mapError(sqlError("writeChangelogSummaries")),
  );

  const recordSummaryFailures: ChangelogStore["Service"]["recordSummaryFailures"] = Effect.fn(
    "ChangelogStore.recordSummaryFailures",
  )(
    function* (input) {
      for (const entry of input.entries) {
        const next = summaryAfterFailure({
          attempts: entry.attempts,
          now: input.now,
          charged: entry.charged,
        });
        yield* sql`
          UPDATE fork_changelog_entries SET
            summary_state = ${next._tag === "Retry" ? "pending" : "unavailable"},
            summary_attempts = ${next.attempts},
            next_summary_at = ${next._tag === "Retry" ? next.nextAttemptAt : input.now}
          WHERE repository_key = ${input.key} AND unit_key = ${entry.unitKey}
            AND content_hash = ${entry.inputHash} AND removed_at IS NULL
        `;
      }
    },
    sql.withTransaction,
    Effect.mapError(sqlError("recordChangelogSummaryFailures")),
  );

  const setThreadRefs: ChangelogStore["Service"]["setThreadRefs"] = Effect.fn(
    "ChangelogStore.setThreadRefs",
  )(
    function* (input) {
      for (const [unitKey, refs] of input.refs) {
        yield* sql`
          UPDATE fork_changelog_entries SET thread_refs_json = ${threadRefsJson.encode(refs)}
          WHERE repository_key = ${input.key} AND unit_key = ${unitKey}
        `;
      }
    },
    sql.withTransaction,
    Effect.mapError(sqlError("setChangelogThreadRefs")),
  );

  const projectsWithProjectThread: ChangelogStore["Service"]["projectsWithProjectThread"] = sql<{
    readonly threadId: string;
    readonly projectId: string;
  }>`
    SELECT thread_id AS "threadId", project_id AS "projectId"
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND thread_id LIKE ${`${PROJECT_THREAD_ID_PREFIX}%`}
  `.pipe(
    Effect.map(
      (rows) =>
        new Set(
          rows
            .filter((row) => isProjectThreadId(ThreadId.make(row.threadId)))
            .map((row) => ProjectId.make(row.projectId)),
        ),
    ),
    Effect.mapError(sqlError("listProjectsWithProjectThread")),
    Effect.withSpan("ChangelogStore.projectsWithProjectThread"),
  );

  const decodeThreadMatch = Schema.decodeUnknownEffect(
    Schema.Struct({
      threadId: ThreadId,
      projectId: ProjectId,
      title: Schema.String,
      branch: Schema.NullOr(Schema.String),
      link: Schema.NullOr(
        Schema.fromJsonString(
          Schema.Struct({ host: Schema.String, repository: Schema.String, number: Schema.Number }),
        ),
      ),
    }),
  );

  const findThreads: ChangelogStore["Service"]["findThreads"] = Effect.fn(
    "ChangelogStore.findThreads",
  )(
    function* (input) {
      if (
        input.projectIds.length === 0 ||
        (input.pullRequestNumbers.length === 0 && input.branches.length === 0)
      ) {
        return [];
      }
      const numbers = input.pullRequestNumbers.length === 0 ? [-1] : input.pullRequestNumbers;
      const branches = input.branches.length === 0 ? [""] : input.branches;
      const rows = yield* sql`
        SELECT t.thread_id AS "threadId", t.project_id AS "projectId", t.title,
          json_extract(t.payload_json, '$.branch') AS branch,
          CASE WHEN json_extract(link.value, '$.number') IN ${sql.in(numbers)}
            THEN link.value END AS link
        FROM orchestration_v2_projection_threads AS t
        LEFT JOIN json_each(t.payload_json, '$.pullRequests') AS link
        WHERE t.deleted_at IS NULL AND ${sql.in("t.project_id", input.projectIds)}
          AND (
            (json_extract(link.value, '$.number') IN ${sql.in(numbers)}
              AND json_extract(link.value, '$.source') != 'stack-dismissed')
            OR json_extract(t.payload_json, '$.branch') IN ${sql.in(branches)}
          )
        ORDER BY t.updated_at DESC, t.thread_id ASC
      `;
      return yield* Effect.forEach(rows, (row) => decodeThreadMatch(row));
    },
    Effect.mapError(sqlError("findChangelogThreads")),
  );

  return ChangelogStore.of({
    ensureRepository,
    getRepository,
    tail,
    ungroupedCommits,
    ordinalOf,
    applySync,
    setProduction,
    setSyncStatus,
    page,
    pendingSummaries,
    writeSummaries,
    recordSummaryFailures,
    setThreadRefs,
    projectsWithProjectThread,
    findThreads,
  });
});

export const layer = Layer.effect(ChangelogStore, make);
