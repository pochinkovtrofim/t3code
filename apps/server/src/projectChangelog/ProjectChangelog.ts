// The project changelog capability. Two public methods: `read` (one bounded page) and `watch`
// (the head page again on every change). ws.ts and the MCP tool call these and nothing else;
// reading GitHub, resolving production, matching threads and writing summaries run behind
// them, so no caller can drive a stage.
//
// Background work is bounded: a repository is read and summarized only while one of its
// projects has project threads on and has a project thread, every 15 minutes, every minute
// while a watch is open, and right after a merge done in T3. Each repository has at most one
// sync and one summary pass in flight, each in its own fiber, so a slow model call for one
// repository never delays another's GitHub reads.

import {
  type OrchestrationProjectShell,
  type OrchestrationV2TurnItem,
  PROJECT_CHANGELOG_HEAD_PAGE,
  ProjectChangelogCursor,
  ProjectChangelogEntryId,
  ProjectChangelogError,
  type ProjectChangelogPage,
  type ProjectChangelogReadInput,
  type ProjectChangelogWatchInput,
  type ProjectId,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import {
  type ChangelogPromptUnit,
  changelogUnitPromptBytes,
  generateChangelogSummariesWith,
} from "@t3tools/provider-core/server/changelogPrompt";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ChangelogStore from "./ChangelogStore.ts";
import {
  ACTIVE_SYNC_INTERVAL_MS,
  assignOrdinals,
  associateLandings,
  type ChangeUnit,
  chooseProductionSource,
  commitsNeedingLookup,
  fallbackTitle,
  type GitHubRepository,
  groupChangeUnits,
  IDLE_SYNC_INTERVAL_MS,
  isInProduction,
  type LandedCommit,
  type Landing,
  MAX_UNIT_AUTHORS,
  nextSyncAt,
  ownerProject,
  type ProductionState,
  type RepositoryKey,
  resolveGitHubRepository,
  selectSummaryBatch,
  SUMMARY_BATCH_UNITS,
  summaryHoldUntil,
  type UnitKey,
} from "./changelogModel.ts";
import * as GitHubLandings from "./GitHubLandings.ts";

export interface ProjectChangelogOptions {
  /** How far back a repository's first sync reads. */
  readonly backfillMs?: number;
  /** The most first-parent commits one sync ingests. */
  readonly maxSyncCommits?: number;
}

const DEFAULT_BACKFILL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_SYNC_COMMITS = 500;
/** `commits/{sha}/pulls` calls per sync; the rest wait for the next one. */
const LOOKUP_BUDGET = 30;
const READ_WAIT_MS = 5_000;
const DEFAULT_READ_LIMIT = 20;
const MIN_TICK_MS = 5_000;
const MAX_TICK_MS = 60_000;
/** Model calls across every repository: each spawns a provider CLI for up to three minutes. */
const MODEL_CALL_CONCURRENCY = 1;
const MAX_ENTRY_THREADS = 5;
const PROMPT_THREADS = 2;
const DIGEST_REQUEST_CHARS = 700;
const DIGEST_REPLY_CHARS = 1_200;

export class ProjectChangelog extends Context.Service<
  ProjectChangelog,
  {
    /**
     * One page, newest landing first. When the stored data is older than the idle cadence it
     * waits up to five seconds for a fresh read of GitHub, then answers with what it has;
     * `sync.syncing` says a fresher page is still coming.
     */
    readonly read: (
      input: ProjectChangelogReadInput,
    ) => Effect.Effect<ProjectChangelogPage, ProjectChangelogError>;
    /**
     * The head page now, then again whenever it changes. While open, the repository is read
     * every minute. Opened only by a visible Changelog tab; never part of the shell stream.
     */
    readonly watch: (
      input: ProjectChangelogWatchInput,
    ) => Stream.Stream<ProjectChangelogPage, ProjectChangelogError>;
    /** Waits until no sync or summary pass is running. Tests await it instead of sleeping. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/projectChangelog/ProjectChangelog") {}

/** One repository and the projects on this server backed by it. */
interface RepositoryTarget {
  readonly repository: GitHubRepository;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  /** Projects with project threads on and a project thread: background work runs for these. */
  readonly eligible: ReadonlyArray<OrchestrationProjectShell>;
}

type ProjectTarget =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Disabled" }
  | { readonly _tag: "NoRepository" }
  | { readonly _tag: "NotGitHub" }
  | { readonly _tag: "Ready"; readonly repository: GitHubRepository; readonly eligible: boolean };

const AVAILABILITY = {
  Disabled: "disabled",
  NoRepository: "no-repository",
  NotGitHub: "not-github",
} as const;

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

function encodeCursor(ordinal: number): ProjectChangelogCursor {
  return ProjectChangelogCursor.make(`o${ordinal}`);
}

/** A cursor this server did not issue reads from the head. */
function decodeCursor(cursor: string | undefined): number | null {
  const match = cursor === undefined ? null : /^o(\d+)$/.exec(cursor);
  return match === null ? null : Number(match[1]);
}

/** A defect while reading or applying a sync, kept so the page says the sync failed. */
interface SyncCrash {
  readonly _tag: "SyncCrash";
  readonly defect: unknown;
}

function lastAttemptAt(sync: ChangelogStore.RepositorySyncStatus): number | null {
  return sync._tag === "NeverSynced" ? null : sync.at;
}

function lastSyncedAt(sync: ChangelogStore.RepositorySyncStatus): number | null {
  return sync._tag === "Synced" ? sync.at : sync._tag === "Failed" ? sync.lastSyncedAt : null;
}

function syncProblemOf(
  error: GitHubLandings.GitHubLandingsError | SyncCrash,
): Pick<
  Extract<ChangelogStore.RepositorySyncStatus, { readonly _tag: "Failed" }>,
  "reason" | "retryAt"
> {
  switch (error._tag) {
    case "GitHubApiAuthenticationError":
    case "GitHubCliFailedError":
    case "GitHubCliMissingError":
    case "GitHubHostDisabledError":
    case "GitHubNotSignedInError":
      return { reason: "credentials", retryAt: null };
    case "GitHubApiNotFoundError":
      return { reason: "not-found", retryAt: null };
    case "GitHubApiRateLimitError":
      return { reason: "rate-limited", retryAt: error.retryAt ?? null };
    case "SourceControlRateLimitPausedError":
      return { reason: "rate-limited", retryAt: error.retryAt };
    case "SyncCrash":
      return { reason: "internal", retryAt: null };
    default:
      return { reason: "unreachable", retryAt: null };
  }
}

/** What the request was and how it ended: the two parts of a thread worth a changelog. */
function threadDigest(items: ReadonlyArray<{ readonly item: OrchestrationV2TurnItem }>): string {
  const clip = (text: string, max: number) =>
    text.length <= max ? text : `${text.slice(0, max).trimEnd()} [truncated]`;
  const request = items.find(({ item }) => item.type === "user_message")?.item;
  const reply = items.findLast(({ item }) => item.type === "assistant_message")?.item;
  return [
    request?.type === "user_message"
      ? `Request: ${clip(request.text.trim(), DIGEST_REQUEST_CHARS)}`
      : "",
    reply?.type === "assistant_message"
      ? `Outcome: ${clip(reply.text.trim(), DIGEST_REPLY_CHARS)}`
      : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function unitKeyByOrdinal(units: ReadonlyArray<ChangeUnit>): (ordinal: number) => UnitKey | null {
  return (ordinal) =>
    units.find((unit) => unit.firstOrdinal <= ordinal && ordinal <= unit.lastOrdinal)?.key ?? null;
}

const make = Effect.fn("ProjectChangelog.make")(function* (options: ProjectChangelogOptions = {}) {
  const backfillMs = options.backfillMs ?? DEFAULT_BACKFILL_MS;
  const maxSyncCommits = options.maxSyncCommits ?? DEFAULT_MAX_SYNC_COMMITS;
  const store = yield* ChangelogStore.ChangelogStore;
  const github = yield* GitHubLandings.GitHubLandings;
  const projects = yield* ProjectService.ProjectService;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const pullRequests = yield* PullRequestService.PullRequestService;

  const syncs = yield* FiberMap.make<RepositoryKey, void, never>();
  const summaryPasses = yield* FiberMap.make<RepositoryKey, void, never>();
  const modelSlots = yield* Semaphore.make(MODEL_CALL_CONCURRENCY);
  /** A repository's page may have changed. Sliding: a slow watcher re-reads, it never lags. */
  const changes = yield* PubSub.sliding<RepositoryKey>(256);
  /** A repository's sync finished, successfully or not. */
  const syncsDone = yield* PubSub.unbounded<RepositoryKey>();
  const wake = yield* Queue.dropping<void>(1);
  const nudged = yield* Ref.make<ReadonlySet<RepositoryKey>>(new Set());
  const watchers = yield* Ref.make<ReadonlyMap<RepositoryKey, number>>(new Map());
  const targets = yield* Ref.make<ReadonlyMap<RepositoryKey, RepositoryTarget>>(new Map());
  /** Repositories whose last model calls failed outright, and how many in a row. */
  const summaryHolds = yield* Ref.make<
    ReadonlyMap<RepositoryKey, { readonly until: number; readonly failures: number }>
  >(new Map());

  const publishChange = (key: RepositoryKey) => PubSub.publish(changes, key).pipe(Effect.asVoid);
  const nudge = (key: RepositoryKey) =>
    Ref.update(nudged, (keys) => new Set(keys).add(key)).pipe(
      Effect.andThen(Queue.offer(wake, undefined)),
      Effect.asVoid,
    );
  const holdSummaries = (key: RepositoryKey, now: number) =>
    Ref.update(summaryHolds, (holds) => {
      const failures = (holds.get(key)?.failures ?? 0) + 1;
      return new Map(holds).set(key, { failures, until: summaryHoldUntil({ failures, now }) });
    });
  const isWatched = (key: RepositoryKey) =>
    Ref.get(watchers).pipe(Effect.map((counts) => (counts.get(key) ?? 0) > 0));

  const projectThreadsEnabled = (settings: ServerSettingsValue, shell: OrchestrationProjectShell) =>
    resolveProjectSettings(settings, shell.id, shell).settings.projectThreadsEnabled;

  // The shell's identity comes from a cache that is empty right after startup.
  const identityOf = (shell: OrchestrationProjectShell) =>
    shell.repositoryIdentity === null
      ? identities.resolve(shell.workspaceRoot)
      : Effect.succeed(shell.repositoryIdentity);

  const listTargets = Effect.fn("ProjectChangelog.listTargets")(function* () {
    const settings = yield* serverSettings.getSettings;
    const shells = yield* projects.listShells();
    const withProjectThread = yield* store.projectsWithProjectThread;
    const byKey = new Map<
      RepositoryKey,
      {
        repository: GitHubRepository;
        projects: Array<OrchestrationProjectShell>;
        eligible: Array<OrchestrationProjectShell>;
      }
    >();
    for (const shell of shells) {
      const resolution = resolveGitHubRepository(yield* identityOf(shell));
      if (resolution._tag !== "GitHub") continue;
      const target = byKey.get(resolution.repository.key) ?? {
        repository: resolution.repository,
        projects: [],
        eligible: [],
      };
      target.projects.push(shell);
      if (withProjectThread.has(shell.id) && projectThreadsEnabled(settings, shell)) {
        target.eligible.push(shell);
      }
      byKey.set(resolution.repository.key, target);
    }
    return byKey as ReadonlyMap<RepositoryKey, RepositoryTarget>;
  });

  const resolveTarget = Effect.fn("ProjectChangelog.resolveTarget")(function* (
    projectId: ProjectId,
  ) {
    const shell = yield* projects.getShell(projectId);
    if (Option.isNone(shell)) return { _tag: "NotFound" } satisfies ProjectTarget;
    const settings = yield* serverSettings.getSettings;
    if (!projectThreadsEnabled(settings, shell.value)) {
      return { _tag: "Disabled" } satisfies ProjectTarget;
    }
    const resolution = resolveGitHubRepository(yield* identityOf(shell.value));
    if (resolution._tag !== "GitHub") return resolution satisfies ProjectTarget;
    const known = (yield* Ref.get(targets)).get(resolution.repository.key);
    const eligible =
      (known !== undefined && known.eligible.length > 0) ||
      (yield* store.projectsWithProjectThread).has(projectId);
    return {
      _tag: "Ready",
      repository: resolution.repository,
      eligible,
    } satisfies ProjectTarget;
  });

  const watermarkOf = Effect.fn("ProjectChangelog.watermarkOf")(function* (
    repository: GitHubRepository,
    sha: string,
    headSha: string,
  ) {
    const onChain = yield* store.ordinalOf(repository.key, sha);
    if (onChain !== null) return onChain;
    // Deployed from a release branch or a PR branch: what it shares with the default branch.
    const base = yield* github.mergeBase({ repository, sha, headSha });
    return base === null ? null : yield* store.ordinalOf(repository.key, base);
  });

  /** Reads GitHub once and applies what it learned. `backlog`: commits still wait. */
  const readGitHub = Effect.fn("ProjectChangelog.readGitHub")(function* (
    repository: GitHubRepository,
    row: ChangelogStore.RepositoryRow,
  ) {
    const key = repository.key;
    const now = yield* Clock.currentTimeMillis;
    const head = yield* github.readHead(repository);
    const cursor = row.cursor;
    const backfill = () =>
      github
        .readHistory({
          repository,
          headSha: head.headSha,
          stopAtSha: null,
          since: now - backfillMs,
          maxCommits: maxSyncCommits,
        })
        .pipe(Effect.map((history) => history.chain));

    let reset = false;
    let base = cursor?.headOrdinal ?? 0;
    let fresh: ReadonlyArray<LandedCommit> = [];
    if (cursor === null) {
      fresh = yield* backfill();
    } else if (row.defaultBranch !== head.defaultBranch) {
      // A renamed or switched default branch is a different history.
      reset = true;
    } else if (cursor.headSha !== head.headSha) {
      const history = yield* github.readHistory({
        repository,
        headSha: head.headSha,
        stopAtSha: cursor.headSha,
        since: null,
        maxCommits: maxSyncCommits,
      });
      // Not reaching the cursor is a force push or more history than one sync reads. Both
      // re-read the window: re-ingested entries come back with their summaries by key.
      if (history.reachedCursor) fresh = history.chain;
      else reset = true;
    }
    if (reset) {
      base = 0;
      fresh = yield* backfill();
    }

    const ungrouped = reset ? [] : yield* store.ungroupedCommits(key);
    const unresolved = ungrouped.filter((commit) => commit.association._tag === "Unresolved");
    const needing: ReadonlyArray<LandedCommit> = [...unresolved, ...fresh];
    const resolved = new Map<string, Landing["association"]>();
    if (needing.length > 0) {
      const mergedPulls = yield* github.readMergedPulls({
        repository,
        defaultBranch: head.defaultBranch,
        since: Math.min(...needing.map((commit) => commit.committedAt)),
      });
      const lookups = yield* github.lookupCommitPulls({
        repository,
        shas: commitsNeedingLookup({ commits: needing, mergedPulls, budget: LOOKUP_BUDGET }),
      });
      const previousAttempts = new Map(
        unresolved.map((commit) => [
          commit.sha,
          commit.association._tag === "Unresolved" ? commit.association.attempts : 0,
        ]),
      );
      for (const commit of associateLandings({
        commits: needing,
        defaultBranch: head.defaultBranch,
        mergedPulls,
        lookups,
        previousAttempts,
      })) {
        resolved.set(commit.sha, commit.association);
      }
    }

    const landings: ReadonlyArray<Landing> = [
      ...ungrouped.map((commit) => ({
        ...commit,
        association: resolved.get(commit.sha) ?? commit.association,
      })),
      ...assignOrdinals(
        base,
        fresh.map((commit) => ({
          ...commit,
          association: resolved.get(commit.sha) ?? { _tag: "Unresolved" as const, attempts: 0 },
        })),
      ),
    ];
    let backlog = false;
    // A first sync with nothing in the window still records the head, or every later sync
    // would read the history again.
    if (reset || cursor === null || landings.length > 0) {
      const tail = reset ? null : yield* store.tail(key);
      const { units, deferred } = groupChangeUnits({ repository, tail, landings });
      const unitKeyOf = unitKeyByOrdinal(units);
      yield* store.applySync({
        key,
        defaultBranch: head.defaultBranch,
        cursor: { headSha: head.headSha, headOrdinal: base + fresh.length },
        reset,
        commits: landings.map((landing) => ({ landing, unitKey: unitKeyOf(landing.ordinal) })),
        units,
        now,
      });
      backlog = deferred.length > 0;
    }

    const previous = row.production;
    const choice = chooseProductionSource({
      ...(yield* github.readProduction(repository)),
      previous: previous?.signal ?? null,
    });
    let production: ProductionState;
    if (choice === "keep-previous") {
      production = { ...previous!, stale: true };
    } else if (choice.source === "default-branch") {
      production = { signal: choice, watermark: "head", stale: false };
    } else if (
      !reset &&
      previous !== null &&
      previous.signal.source === choice.source &&
      "sha" in previous.signal &&
      previous.signal.sha === choice.sha
    ) {
      production = { signal: choice, watermark: previous.watermark, stale: false };
    } else {
      const watermark = yield* watermarkOf(repository, choice.sha, head.headSha);
      production = { signal: choice, watermark, stale: false };
    }
    yield* store.setProduction(key, production);
    return { backlog };
  });

  /** Up to five threads per entry: linked to the entry's pull request, or on its branch. */
  const matchThreads = Effect.fn("ProjectChangelog.matchThreads")(function* (
    target: RepositoryTarget,
    entries: ReadonlyArray<ChangelogStore.EntryRow>,
  ) {
    const pulls = entries.flatMap((entry) =>
      entry.unit.source.kind === "pull-request"
        ? [{ key: entry.unit.key, pull: entry.unit.source.pullRequest }]
        : [],
    );
    const matches = yield* store.findThreads({
      projectIds: target.projects.map((project) => project.id),
      pullRequestNumbers: [...new Set(pulls.map(({ pull }) => pull.number))],
      // A PR from another repository's default branch would match every thread on it.
      branches: [
        ...new Set(
          pulls.flatMap(({ pull }) => (pull.headRef === pull.baseRef ? [] : [pull.headRef])),
        ),
      ],
    });
    const refs = new Map<UnitKey, ReadonlyArray<ChangelogStore.ThreadRef>>();
    for (const { key, pull } of pulls) {
      const linked = matches.filter(
        (match) =>
          (match.link !== null &&
            match.link.number === pull.number &&
            match.link.repository.toLowerCase() === pull.repository &&
            match.link.host.toLowerCase() === target.repository.host) ||
          (match.branch !== null && match.branch === pull.headRef && pull.headRef !== pull.baseRef),
      );
      const unique = [...new Map(linked.map((match) => [match.threadId, match])).values()];
      refs.set(
        key,
        unique.slice(0, MAX_ENTRY_THREADS).map(({ threadId, projectId, title }) => ({
          threadId,
          projectId,
          title,
        })),
      );
    }
    return refs;
  });

  const promptUnitOf = Effect.fn("ProjectChangelog.promptUnitOf")(function* (
    entry: ChangelogStore.EntryRow,
    threads: ReadonlyArray<ChangelogStore.ThreadRef>,
  ) {
    const digests = yield* Effect.forEach(threads.slice(0, PROMPT_THREADS), (thread) =>
      projections.getThreadProjection(thread.threadId).pipe(
        Effect.map((projection) => ({
          title: thread.title,
          digest: threadDigest(projection.visibleTurnItems),
        })),
        Effect.orElseSucceed(() => null),
      ),
    );
    const source = entry.unit.source;
    const unit: ChangelogPromptUnit = {
      key: entry.unit.key,
      pullRequest:
        source.kind === "pull-request"
          ? {
              number: source.pullRequest.number,
              title: source.pullRequest.title,
              body: source.pullRequest.bodyExcerpt,
              author: source.pullRequest.authorLogin,
            }
          : null,
      commitSubjects: source.commitSubjects,
      commitCount: entry.unit.commitCount,
      authors: entry.unit.authors,
      threads: digests.flatMap((digest) =>
        digest === null || digest.digest === "" ? [] : [digest],
      ),
    };
    return { entry, unit, promptBytes: changelogUnitPromptBytes(unit) };
  });

  /** Summarizes every settled, due entry, newest first, one model call per batch. */
  const summarizeRepository = Effect.fn("ProjectChangelog.summarizeRepository")(
    function* (target: RepositoryTarget) {
      const key = target.repository.key;
      const owner = ownerProject(target.eligible);
      if (owner === null) return;
      const heldUntil = (yield* Ref.get(summaryHolds)).get(key)?.until ?? 0;
      if (heldUntil > (yield* Clock.currentTimeMillis)) return;
      for (;;) {
        const pending = yield* store.pendingSummaries({
          key,
          now: yield* Clock.currentTimeMillis,
          limit: SUMMARY_BATCH_UNITS,
        });
        if (pending.length === 0) return;
        const refs = yield* matchThreads(target, pending);
        yield* store.setThreadRefs({ key, refs });
        const batch = selectSummaryBatch(
          yield* Effect.forEach(pending, (entry) =>
            promptUnitOf(entry, refs.get(entry.unit.key) ?? []),
          ),
        );
        const settings = yield* serverSettings.getSettings;
        const modelSelection = resolveProjectSettings(settings, owner.id, owner).settings
          .textGenerationModelSelection;
        const generated = yield* modelSlots
          .withPermits(1)(
            generateChangelogSummariesWith(textGeneration, {
              repository: `${target.repository.owner}/${target.repository.name}`,
              units: batch.map(({ unit }) => unit),
              // CLIs need a directory to run in; nothing reads the checkout.
              cwd: owner.workspaceRoot,
              modelSelection,
            }),
          )
          .pipe(Effect.result);
        const now = yield* Clock.currentTimeMillis;
        if (generated._tag === "Failure") {
          yield* Effect.logWarning("project changelog summaries failed", {
            repository: key,
            detail: generated.failure.detail,
          });
          // The provider failed, not the entries: hold the repository and spend no attempts.
          yield* holdSummaries(key, now);
          return;
        }
        yield* Ref.update(summaryHolds, (holds) => {
          const next = new Map(holds);
          next.delete(key);
          return next;
        });
        const answers = new Map(generated.success.entries.map((answer) => [answer.key, answer]));
        const contested = new Set(generated.success.contested);
        yield* store.writeSummaries({
          key,
          now,
          summaries: batch.flatMap(({ entry }) => {
            const answer = answers.get(entry.unit.key);
            return answer === undefined
              ? []
              : [
                  {
                    unitKey: entry.unit.key,
                    inputHash: entry.unit.contentHash,
                    title: answer.title,
                    body: answer.summary,
                    category: answer.category,
                  },
                ];
          }),
        });
        yield* store.recordSummaryFailures({
          key,
          now,
          entries: batch.flatMap(({ entry }) =>
            answers.has(entry.unit.key)
              ? []
              : [
                  {
                    unitKey: entry.unit.key,
                    inputHash: entry.unit.contentHash,
                    attempts: entry.summary.attempts,
                    charged: !contested.has(entry.unit.key),
                  },
                ],
          ),
        });
        yield* publishChange(key);
      }
    },
    (effect, target) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("project changelog summaries could not be stored", {
            repository: target.repository.key,
            errorTag: error._tag,
          }),
        ),
        // Held like a failed call, so a defect that repeats does not rerun the model every tick.
        Effect.catchDefect((defect) =>
          Effect.logError("project changelog summaries crashed", {
            repository: target.repository.key,
            defect,
          }).pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.flatMap((now) => holdSummaries(target.repository.key, now)),
          ),
        ),
      ),
  );

  const syncRepository = Effect.fn("ProjectChangelog.syncRepository")(
    function* (target: RepositoryTarget) {
      const key = target.repository.key;
      const row = yield* store.ensureRepository(target.repository);
      const outcome = yield* readGitHub(target.repository, row).pipe(
        Effect.result,
        Effect.catchDefect((defect) =>
          Effect.succeed(Result.fail({ _tag: "SyncCrash", defect } satisfies SyncCrash)),
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      const watched = yield* isWatched(key);
      if (outcome._tag === "Success") {
        yield* store.setSyncStatus(
          key,
          { _tag: "Synced", at: now },
          nextSyncAt({ now, watched, backlog: outcome.success.backlog }),
        );
        return;
      }
      const failure = outcome.failure;
      if (failure._tag === "PersistenceSqlError" || failure._tag === "PersistenceDecodeError") {
        return yield* failure;
      }
      const problem = syncProblemOf(failure);
      yield* failure._tag === "SyncCrash"
        ? Effect.logError("project changelog sync crashed", {
            repository: key,
            defect: failure.defect,
          })
        : Effect.logWarning("project changelog sync failed", {
            repository: key,
            errorTag: failure._tag,
          });
      yield* store.setSyncStatus(
        key,
        { _tag: "Failed", at: now, lastSyncedAt: lastSyncedAt(row.sync), ...problem },
        nextSyncAt({ now, watched, backlog: false, retryAt: problem.retryAt }),
      );
    },
    (effect, target) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("project changelog sync could not be stored", {
            repository: target.repository.key,
            errorTag: error._tag,
          }),
        ),
        // Nothing joins these fibers, so a defect would end them without a trace.
        Effect.catchDefect((defect) =>
          Effect.logError("project changelog sync crashed", {
            repository: target.repository.key,
            defect,
          }),
        ),
        // The summary pass is registered before readers hear the sync finished, so a drain
        // that follows a read also waits for it.
        Effect.ensuring(
          FiberMap.run(summaryPasses, target.repository.key, summarizeRepository(target), {
            onlyIfMissing: true,
          }).pipe(
            Effect.andThen(publishChange(target.repository.key)),
            Effect.andThen(PubSub.publish(syncsDone, target.repository.key)),
          ),
        ),
      ),
  );

  /** One pass of the background loop. Returns when the next repository falls due. */
  const tick = Effect.fn("ProjectChangelog.tick")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* listTargets();
    yield* Ref.set(targets, current);
    const asked = yield* Ref.getAndSet(nudged, new Set());
    let wakeAt = now + MAX_TICK_MS;
    for (const target of current.values()) {
      if (target.eligible.length === 0) continue;
      const key = target.repository.key;
      const row = yield* store.ensureRepository(target.repository);
      const attempted = lastAttemptAt(row.sync);
      const retryAt = row.sync._tag === "Failed" ? (row.sync.retryAt ?? 0) : 0;
      const dueAt =
        (yield* isWatched(key)) && attempted !== null
          ? Math.max(Math.min(row.nextSyncAt, attempted + ACTIVE_SYNC_INTERVAL_MS), retryAt)
          : row.nextSyncAt;
      if (asked.has(key) || dueAt <= now) {
        // The sync starts the summary pass once it has applied what it read.
        yield* FiberMap.run(syncs, key, syncRepository(target), { onlyIfMissing: true });
        yield* publishChange(key);
        continue;
      }
      wakeAt = Math.min(wakeAt, dueAt);
      yield* FiberMap.run(summaryPasses, key, summarizeRepository(target), {
        onlyIfMissing: true,
      });
    }
    return Math.min(Math.max(wakeAt - now, MIN_TICK_MS), MAX_TICK_MS);
  });

  const drain = Effect.gen(function* () {
    while ((yield* FiberMap.size(syncs)) + (yield* FiberMap.size(summaryPasses)) > 0) {
      yield* FiberMap.awaitEmpty(syncs);
      yield* FiberMap.awaitEmpty(summaryPasses);
    }
  });

  const loop = Effect.gen(function* () {
    for (;;) {
      const delay = yield* tick().pipe(
        Effect.catch((error) =>
          Effect.logWarning("project changelog pass failed", { errorTag: error._tag }).pipe(
            Effect.as(MAX_TICK_MS),
          ),
        ),
        Effect.catchDefect((defect) =>
          Effect.logError("project changelog pass crashed", { defect }).pipe(
            Effect.as(MAX_TICK_MS),
          ),
        ),
      );
      yield* Effect.race(Effect.sleep(delay), Queue.take(wake));
    }
  });
  yield* ServerActivation.forkParked(loop);

  // A merge done in T3 has just landed on a default branch; merges elsewhere wait for cadence.
  const merges = yield* pullRequests.subscribeMerges;
  yield* ServerActivation.forkParked(
    Stream.runForEach(merges, (merge) =>
      resolveTarget(merge.projectId).pipe(
        Effect.flatMap((target) =>
          target._tag === "Ready" && target.eligible ? nudge(target.repository.key) : Effect.void,
        ),
        Effect.ignore,
        Effect.catchDefect((defect) =>
          Effect.logError("project changelog merge handling crashed", { defect }),
        ),
      ),
    ),
  );

  /** The only place that derives `inProduction`. */
  const toPage = (input: {
    readonly projectId: ProjectId;
    readonly row: ChangelogStore.RepositoryRow;
    readonly entries: ReadonlyArray<ChangelogStore.EntryRow>;
    readonly limit: number;
    readonly syncing: boolean;
  }): ProjectChangelogPage => {
    const { row } = input;
    const repository = row.repository;
    const visible = input.entries.slice(0, input.limit);
    const signal = row.production?.signal ?? null;
    const synced = lastSyncedAt(row.sync);
    return {
      projectId: input.projectId,
      availability: "ready",
      repository: {
        displayName: `${repository.owner}/${repository.name}`,
        url: repository.webUrl,
        defaultBranch: row.defaultBranch,
      },
      sync: {
        lastSyncedAt: synced === null ? null : isoOf(synced),
        problem:
          row.sync._tag === "Failed"
            ? {
                reason: row.sync.reason,
                retryAt: row.sync.retryAt === null ? null : isoOf(row.sync.retryAt),
              }
            : null,
        syncing: input.syncing,
      },
      production:
        signal === null
          ? null
          : {
              source: signal.source,
              label:
                signal.source === "deployment"
                  ? signal.environment
                  : signal.source === "default-branch"
                    ? null
                    : signal.tag,
              sha: "sha" in signal ? signal.sha : null,
              at:
                signal.source === "deployment" || signal.source === "release"
                  ? signal.at === null
                    ? null
                    : isoOf(signal.at)
                  : null,
              url:
                signal.source === "deployment" || signal.source === "release"
                  ? signal.url || null
                  : null,
              stale: row.production?.stale ?? false,
            },
      entries: visible.map(({ unit, summary, threadRefs }) => {
        const source = unit.source;
        return {
          id: ProjectChangelogEntryId.make(unit.key),
          kind: source.kind,
          title:
            (summary.state === "unavailable" ? null : summary.title)?.trim() ||
            fallbackTitle(source).trim() ||
            "Untitled change",
          summary: summary.state === "unavailable" ? null : summary.body,
          category: summary.state === "unavailable" ? null : summary.category,
          summaryState: summary.state,
          landedAt: isoOf(unit.landedAt),
          inProduction: isInProduction(unit, row.production),
          pullRequest:
            source.kind === "pull-request"
              ? {
                  repository: source.pullRequest.repository,
                  number: source.pullRequest.number,
                  url: source.pullRequest.url,
                  title: source.pullRequest.title.trim() || `#${source.pullRequest.number}`,
                  author: source.pullRequest.authorLogin,
                }
              : null,
          commits: {
            count: unit.commitCount,
            headSha: unit.headSha,
            url: `${repository.webUrl}/commit/${unit.headSha}`,
          },
          authors: unit.authors.slice(0, MAX_UNIT_AUTHORS),
          threads: threadRefs.slice(0, MAX_ENTRY_THREADS),
        };
      }),
      nextCursor:
        input.entries.length > input.limit
          ? encodeCursor(visible[visible.length - 1]!.unit.lastOrdinal)
          : null,
    };
  };

  const emptyPage = (
    projectId: ProjectId,
    availability: ProjectChangelogPage["availability"],
  ): ProjectChangelogPage => ({
    projectId,
    availability,
    repository: null,
    sync: { lastSyncedAt: null, problem: null, syncing: false },
    production: null,
    entries: [],
    nextCursor: null,
  });

  /** Asks the loop for a sync and waits for one to finish, at most READ_WAIT_MS. */
  const syncAndWait = Effect.fn("ProjectChangelog.syncAndWait")(function* (key: RepositoryKey) {
    const done = yield* PubSub.subscribe(syncsDone);
    yield* nudge(key);
    yield* Stream.fromSubscription(done).pipe(
      Stream.filter((finished) => finished === key),
      Stream.take(1),
      Stream.runDrain,
      Effect.timeoutOption(READ_WAIT_MS),
    );
  }, Effect.scoped);

  const readTarget = Effect.fn("ProjectChangelog.readTarget")(function* (
    input: ProjectChangelogReadInput,
    readOptions: { readonly waitForSync: boolean },
  ) {
    const target = yield* resolveTarget(input.projectId);
    if (target._tag === "NotFound") {
      return yield* new ProjectChangelogError({
        projectId: input.projectId,
        reason: "project-not-found",
      });
    }
    if (target._tag !== "Ready") {
      return { page: emptyPage(input.projectId, AVAILABILITY[target._tag]), key: null };
    }
    const key = target.repository.key;
    let row = yield* store.ensureRepository(target.repository);
    const now = yield* Clock.currentTimeMillis;
    const attempted = lastAttemptAt(row.sync);
    const retryAt = row.sync._tag === "Failed" ? (row.sync.retryAt ?? 0) : 0;
    if (
      readOptions.waitForSync &&
      target.eligible &&
      (attempted === null || attempted + IDLE_SYNC_INTERVAL_MS <= now) &&
      retryAt <= now
    ) {
      yield* syncAndWait(key);
      row = Option.getOrElse(yield* store.getRepository(key), () => row);
    }
    const limit = input.limit ?? DEFAULT_READ_LIMIT;
    const entries = yield* store.page({
      key,
      beforeOrdinal: decodeCursor(input.cursor),
      limit: limit + 1,
    });
    const syncing = yield* FiberMap.has(syncs, key);
    return {
      page: toPage({ projectId: input.projectId, row, entries, limit, syncing }),
      key: target.eligible ? key : null,
    };
  });

  const readPage = (
    input: ProjectChangelogReadInput,
    readOptions: { readonly waitForSync: boolean },
  ) =>
    readTarget(input, readOptions).pipe(
      Effect.mapError((cause) =>
        cause._tag === "ProjectChangelogError"
          ? cause
          : new ProjectChangelogError({ projectId: input.projectId, reason: "storage", cause }),
      ),
    );

  const read: ProjectChangelog["Service"]["read"] = Effect.fn("ProjectChangelog.read")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({ "project.id": input.projectId });
      return (yield* readPage(input, { waitForSync: true })).page;
    },
  );

  const watch: ProjectChangelog["Service"]["watch"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the first read, so a change in between is not lost.
        const changed = yield* PubSub.subscribe(changes);
        const settingsChanged = yield* serverSettings.subscribeChanges;
        const leased = yield* Ref.make<RepositoryKey | null>(null);
        const lease = (next: RepositoryKey | null) =>
          Ref.getAndSet(leased, next).pipe(
            Effect.flatMap((previous) =>
              previous === next
                ? Effect.void
                : Ref.update(watchers, (counts) => {
                    const updated = new Map(counts);
                    if (previous !== null) {
                      const left = (updated.get(previous) ?? 1) - 1;
                      if (left > 0) updated.set(previous, left);
                      else updated.delete(previous);
                    }
                    if (next !== null) updated.set(next, (updated.get(next) ?? 0) + 1);
                    return updated;
                  }).pipe(
                    Effect.andThen(next === null ? Effect.void : Queue.offer(wake, undefined)),
                  ),
            ),
            Effect.asVoid,
          );
        yield* Effect.addFinalizer(() => lease(null));
        const emit = readPage(
          { projectId: input.projectId, limit: PROJECT_CHANGELOG_HEAD_PAGE },
          { waitForSync: false },
        ).pipe(
          Effect.tap(({ key }) => lease(key)),
          Effect.map(({ page }) => page),
        );
        const triggers = Stream.merge(
          Stream.fromSubscription(changed).pipe(
            Stream.filterEffect((key) =>
              Ref.get(leased).pipe(Effect.map((current) => current === key)),
            ),
          ),
          settingsChanged,
        );
        return Stream.concat(
          Stream.fromEffect(emit),
          Stream.mapEffect(triggers, () => emit),
        ).pipe(Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)));
      }),
    );

  return ProjectChangelog.of({ read, watch, drain });
});

/** Everything but GitHub, so tests can script GitHub's answers. */
export const layerWithoutGitHub = (options: ProjectChangelogOptions = {}) =>
  Layer.effect(ProjectChangelog, make(options)).pipe(
    Layer.provide(ChangelogStore.layer),
    Layer.provide(ProjectionStore.layer),
  );

/**
 * Provided once in server.ts, so ws.ts and the MCP server share one instance. GitHubRest comes
 * from the server, so changelog reads share PR sync's quota view and request slots.
 */
export const layerWith = (options: ProjectChangelogOptions = {}) =>
  layerWithoutGitHub(options).pipe(Layer.provide(GitHubLandings.layer));

export const layer = layerWith();
