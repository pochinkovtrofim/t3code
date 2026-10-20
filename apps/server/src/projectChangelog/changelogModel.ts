// The domain of the project changelog: what landed on a repository's default branch, how it
// groups into the change units one entry stands for, and what is in production. Pure functions
// and types only, so every rule that decides what the user sees is tested without GitHub or a
// database.

// @effect-diagnostics-next-line nodeBuiltinImport:off -- the pure model hashes synchronously; Effect's Crypto is effectful.
import * as NodeCrypto from "node:crypto";

import type { ProjectId, RepositoryIdentity } from "@t3tools/contracts";
import type * as Brand from "effect/Brand";

/** `host/owner/name`, lower-cased. One per GitHub repository, shared by every project on it. */
export type RepositoryKey = string & Brand.Brand<"ChangelogRepositoryKey">;

export interface GitHubRepository {
  readonly key: RepositoryKey;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly webUrl: string;
}

export type RepositoryResolution =
  | { readonly _tag: "GitHub"; readonly repository: GitHubRepository }
  | { readonly _tag: "NoRepository" }
  | { readonly _tag: "NotGitHub" };

export function repositoryKeyOf(host: string, fullName: string): RepositoryKey {
  return `${host}/${fullName}`.toLowerCase() as RepositoryKey;
}

export function resolveGitHubRepository(
  identity: RepositoryIdentity | null | undefined,
): RepositoryResolution {
  if (identity == null) return { _tag: "NoRepository" };
  if (identity.provider !== "github") return { _tag: "NotGitHub" };
  const [host, owner, name, ...rest] = identity.canonicalKey.toLowerCase().split("/");
  if (!host || !owner || !name || rest.length > 0) return { _tag: "NotGitHub" };
  // The canonical key is lower-cased; keep the remote's own casing for display.
  const displayOwner = identity.owner?.toLowerCase() === owner ? identity.owner : owner;
  const displayName = identity.name?.toLowerCase() === name ? identity.name : name;
  return {
    _tag: "GitHub",
    repository: {
      key: repositoryKeyOf(host, `${owner}/${name}`),
      host,
      owner: displayOwner,
      name: displayName,
      webUrl: identity.webUrl ?? `https://${host}/${displayOwner}/${displayName}`,
    },
  };
}

export interface LandedCommit {
  readonly sha: string;
  readonly parentShas: ReadonlyArray<string>;
  readonly subject: string;
  /** The GitHub login when GitHub matched the author to an account, else the author email. */
  readonly authorKey: string;
  readonly authorDisplay: string;
  /** Committer date, epoch ms. Push grouping only; ordering never compares dates. */
  readonly committedAt: number;
}

export interface MergedPullRequest {
  readonly number: number;
  /** The base repository's `owner/name`, lower-cased. A fork's commits can come from its parent. */
  readonly repository: string;
  readonly title: string;
  /** Untrusted text from the repository. */
  readonly bodyExcerpt: string;
  readonly url: string;
  readonly authorLogin: string | null;
  readonly mergedAt: number | null;
  readonly mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
}

export const PULL_REQUEST_BODY_EXCERPT_CHARS = 1_500;

/** How a first-parent commit reached the default branch. */
export type CommitAssociation =
  | { readonly _tag: "PullRequest"; readonly pullRequest: MergedPullRequest }
  | { readonly _tag: "Direct" }
  /** Not looked up yet, or every lookup so far failed. Grouping never crosses one. */
  | { readonly _tag: "Unresolved"; readonly attempts: number };

/** A failed lookup this many times over is treated as a direct push, so it cannot hide newer work. */
export const MAX_ASSOCIATION_ATTEMPTS = 3;

export type CommitPullsLookup =
  | { readonly _tag: "Answered"; readonly pullRequests: ReadonlyArray<MergedPullRequest> }
  | { readonly _tag: "Failed" };

export interface AssociatedCommit extends LandedCommit {
  readonly association: CommitAssociation;
}

/**
 * A commit on the default branch's first-parent chain with its position. Side-branch commits of
 * a merge-commit PR never become landings: the merge commit stands for them.
 *
 * Invariant: ordinals strictly increase toward the head within a repository. "Landed before X"
 * is `ordinal <= ordinal(X)`; nothing else in the changelog compares dates.
 */
export interface Landing extends AssociatedCommit {
  readonly ordinal: number;
}

export type ChainEnd =
  /** Reached the stored cursor. */
  | { readonly _tag: "Cursor" }
  /** Reached the repository's first commit. */
  | { readonly _tag: "Root" }
  /** Collected `maxLength` commits. */
  | { readonly _tag: "Limit" }
  /** Needs this commit, which the pages read so far do not hold. */
  | { readonly _tag: "Missing"; readonly sha: string };

/** Walks parents[0] from `headSha` through `commits` and returns the chain oldest first. */
export function firstParentChain(input: {
  readonly headSha: string;
  readonly stopAtSha: string | null;
  readonly commits: ReadonlyMap<string, LandedCommit>;
  readonly maxLength: number;
}): { readonly chain: ReadonlyArray<LandedCommit>; readonly end: ChainEnd } {
  const chain: Array<LandedCommit> = [];
  let sha: string | undefined = input.headSha;
  let end: ChainEnd;
  for (;;) {
    if (sha === undefined) {
      end = { _tag: "Root" };
      break;
    }
    if (sha === input.stopAtSha) {
      end = { _tag: "Cursor" };
      break;
    }
    if (chain.length >= input.maxLength) {
      end = { _tag: "Limit" };
      break;
    }
    const commit = input.commits.get(sha);
    if (commit === undefined) {
      end = { _tag: "Missing", sha };
      break;
    }
    chain.push(commit);
    sha = commit.parentShas[0];
  }
  return { chain: chain.toReversed(), end };
}

export function assignOrdinals(
  baseOrdinal: number,
  commits: ReadonlyArray<AssociatedCommit>,
): ReadonlyArray<Landing> {
  return commits.map((commit, index) => ({ ...commit, ordinal: baseOrdinal + index + 1 }));
}

function mergedPullsBySha(
  mergedPulls: ReadonlyArray<MergedPullRequest>,
): ReadonlyMap<string, MergedPullRequest> {
  const bySha = new Map<string, MergedPullRequest>();
  for (const pull of mergedPulls) {
    if (pull.mergeCommitSha !== null && pull.mergedAt !== null)
      bySha.set(pull.mergeCommitSha, pull);
  }
  return bySha;
}

/**
 * The commits worth a `commits/{sha}/pulls` call: not matched by the merged-PR list, oldest
 * first so resolution advances contiguously from the cursor, at most `budget`.
 */
export function commitsNeedingLookup(input: {
  readonly commits: ReadonlyArray<Pick<LandedCommit, "sha">>;
  readonly mergedPulls: ReadonlyArray<MergedPullRequest>;
  readonly budget: number;
}): ReadonlyArray<string> {
  const bySha = mergedPullsBySha(input.mergedPulls);
  return input.commits
    .filter((commit) => !bySha.has(commit.sha))
    .slice(0, input.budget)
    .map((commit) => commit.sha);
}

/**
 * Matches each commit to the pull request that landed it. The merged-PR list catches squash and
 * merge commits through `mergeCommitSha`; `lookups` holds per-commit answers for the rest
 * (rebase merges, PRs outside the list window, a fork's commits from its parent).
 */
export function associateLandings(input: {
  readonly commits: ReadonlyArray<LandedCommit>;
  readonly defaultBranch: string;
  readonly mergedPulls: ReadonlyArray<MergedPullRequest>;
  readonly lookups: ReadonlyMap<string, CommitPullsLookup>;
  readonly previousAttempts?: ReadonlyMap<string, number>;
}): ReadonlyArray<AssociatedCommit> {
  const bySha = mergedPullsBySha(input.mergedPulls);
  return input.commits.map((commit): AssociatedCommit => {
    const listed = bySha.get(commit.sha);
    if (listed !== undefined) {
      return { ...commit, association: { _tag: "PullRequest", pullRequest: listed } };
    }
    const attempts = input.previousAttempts?.get(commit.sha) ?? 0;
    const lookup = input.lookups.get(commit.sha);
    if (lookup === undefined) {
      return { ...commit, association: { _tag: "Unresolved", attempts } };
    }
    if (lookup._tag === "Failed") {
      return {
        ...commit,
        association:
          attempts + 1 >= MAX_ASSOCIATION_ATTEMPTS
            ? { _tag: "Direct" }
            : { _tag: "Unresolved", attempts: attempts + 1 },
      };
    }
    const pullRequest = lookup.pullRequests.find(
      (pull) => pull.mergedAt !== null && pull.baseRef === input.defaultBranch,
    );
    return {
      ...commit,
      association:
        pullRequest === undefined ? { _tag: "Direct" } : { _tag: "PullRequest", pullRequest },
    };
  });
}

/** `pr:<n>`, `pr:<owner/name>#<n>` for another repository's PR, or `push:<first sha>`. */
export type UnitKey = string & Brand.Brand<"ChangelogUnitKey">;

export const PUSH_GROUP_GAP_MS = 15 * 60_000;
export const MAX_COMMIT_SUBJECTS = 20;
export const MAX_UNIT_AUTHORS = 5;

export function pullRequestUnitKey(
  repository: Pick<GitHubRepository, "owner" | "name">,
  pullRequest: Pick<MergedPullRequest, "number" | "repository">,
): UnitKey {
  const own = `${repository.owner}/${repository.name}`.toLowerCase();
  return (
    pullRequest.repository === own
      ? `pr:${pullRequest.number}`
      : `pr:${pullRequest.repository}#${pullRequest.number}`
  ) as UnitKey;
}

export function pushUnitKey(firstSha: string): UnitKey {
  return `push:${firstSha}` as UnitKey;
}

export type ChangeUnitSource =
  | {
      readonly kind: "pull-request";
      readonly pullRequest: MergedPullRequest;
      /** Oldest first, at most MAX_COMMIT_SUBJECTS; `commitCount` carries the true count. */
      readonly commitSubjects: ReadonlyArray<string>;
    }
  | {
      readonly kind: "direct-push";
      readonly authorKey: string;
      readonly commitSubjects: ReadonlyArray<string>;
    };

export interface ChangeUnit {
  readonly key: UnitKey;
  readonly source: ChangeUnitSource;
  readonly firstOrdinal: number;
  /** The landing commit's ordinal. In production iff it is at or below the watermark. */
  readonly lastOrdinal: number;
  readonly headSha: string;
  readonly commitCount: number;
  readonly authors: ReadonlyArray<string>;
  readonly landedAt: number;
  readonly lastCommittedAt: number;
  /**
   * When no later commit can join the unit. Summaries wait for it, so a burst of pushes costs
   * one model call rather than one per sync.
   */
  readonly settlesAt: number;
  /**
   * Hash of what the prompt says about the unit. Thread digests are left out: they keep changing
   * after a merge and must not re-trigger a summary.
   */
  readonly contentHash: string;
}

export function contentHashOf(source: ChangeUnitSource, commitCount: number): string {
  const facts =
    source.kind === "pull-request"
      ? [
          "pull-request",
          source.pullRequest.repository,
          source.pullRequest.number,
          source.pullRequest.title,
          source.pullRequest.bodyExcerpt,
          source.commitSubjects,
          commitCount,
        ]
      : ["direct-push", source.authorKey, source.commitSubjects, commitCount];
  return NodeCrypto.createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

interface OpenUnit {
  key: UnitKey;
  source: ChangeUnitSource;
  firstOrdinal: number;
  lastOrdinal: number;
  headSha: string;
  commitCount: number;
  authors: Array<string>;
  landedAt: number;
  lastCommittedAt: number;
}

function openFrom(unit: ChangeUnit): OpenUnit {
  return {
    key: unit.key,
    source: unit.source,
    firstOrdinal: unit.firstOrdinal,
    lastOrdinal: unit.lastOrdinal,
    headSha: unit.headSha,
    commitCount: unit.commitCount,
    authors: [...unit.authors],
    landedAt: unit.landedAt,
    lastCommittedAt: unit.lastCommittedAt,
  };
}

function withAuthor(authors: ReadonlyArray<string>, author: string): Array<string> {
  return authors.includes(author) || authors.length >= MAX_UNIT_AUTHORS
    ? [...authors]
    : [...authors, author];
}

function withSubject(source: ChangeUnitSource, subject: string): ChangeUnitSource {
  return source.commitSubjects.length >= MAX_COMMIT_SUBJECTS
    ? source
    : { ...source, commitSubjects: [...source.commitSubjects, subject] };
}

function startUnit(repository: GitHubRepository, landing: Landing): OpenUnit {
  const base = {
    firstOrdinal: landing.ordinal,
    lastOrdinal: landing.ordinal,
    headSha: landing.sha,
    commitCount: 1,
    lastCommittedAt: landing.committedAt,
  };
  if (landing.association._tag === "PullRequest") {
    const pullRequest = landing.association.pullRequest;
    return {
      ...base,
      key: pullRequestUnitKey(repository, pullRequest),
      source: { kind: "pull-request", pullRequest, commitSubjects: [landing.subject] },
      authors: [pullRequest.authorLogin ?? landing.authorDisplay],
      landedAt: pullRequest.mergedAt ?? landing.committedAt,
    };
  }
  return {
    ...base,
    key: pushUnitKey(landing.sha),
    source: {
      kind: "direct-push",
      authorKey: landing.authorKey,
      commitSubjects: [landing.subject],
    },
    authors: [landing.authorDisplay],
    landedAt: landing.committedAt,
  };
}

function joins(repository: GitHubRepository, open: OpenUnit, landing: Landing): boolean {
  if (landing.ordinal !== open.lastOrdinal + 1) return false;
  if (landing.association._tag === "PullRequest") {
    return (
      open.source.kind === "pull-request" &&
      open.key === pullRequestUnitKey(repository, landing.association.pullRequest)
    );
  }
  return (
    open.source.kind === "direct-push" &&
    open.source.authorKey === landing.authorKey &&
    Math.abs(landing.committedAt - open.lastCommittedAt) < PUSH_GROUP_GAP_MS
  );
}

function extend(open: OpenUnit, landing: Landing): void {
  open.source = withSubject(open.source, landing.subject);
  open.lastOrdinal = landing.ordinal;
  open.headSha = landing.sha;
  open.commitCount += 1;
  open.lastCommittedAt = landing.committedAt;
  open.authors =
    open.source.kind === "direct-push"
      ? withAuthor(open.authors, landing.authorDisplay)
      : open.authors;
  if (open.source.kind === "direct-push") open.landedAt = landing.committedAt;
}

function finish(open: OpenUnit, closed: boolean): ChangeUnit {
  // A push group stays open until a later commit closes it or the gap passes.
  const settlesAt =
    open.source.kind === "direct-push" && !closed
      ? open.lastCommittedAt + PUSH_GROUP_GAP_MS
      : open.landedAt;
  return {
    ...open,
    authors: [...open.authors],
    settlesAt,
    contentHash: contentHashOf(open.source, open.commitCount),
  };
}

/**
 * Deterministic grouping over the first-parent history. Run over the same landings in one
 * batch or split across syncs, it yields the same keys and members:
 *
 * - Consecutive landings of one PR form `pr:<n>` (a rebase merge lands several).
 * - A direct landing joins the previous unit when that is a direct push by the same author, the
 *   ordinals are adjacent and the commit times are under PUSH_GROUP_GAP_MS apart. Otherwise it
 *   starts `push:<its sha>`.
 * - An Unresolved landing stops grouping: it and everything after it come back in `deferred`,
 *   because a unit formed across it could change key once it resolves.
 *
 * Returns whole replacement units, the tail included once landings touch it, for an upsert keyed
 * by (repository, unit key).
 */
export function groupChangeUnits(input: {
  readonly repository: GitHubRepository;
  readonly tail: ChangeUnit | null;
  readonly landings: ReadonlyArray<Landing>;
}): { readonly units: ReadonlyArray<ChangeUnit>; readonly deferred: ReadonlyArray<Landing> } {
  const units: Array<ChangeUnit> = [];
  let open: OpenUnit | null = null;
  let deferred: ReadonlyArray<Landing> = [];
  for (const [index, landing] of input.landings.entries()) {
    if (landing.association._tag === "Unresolved") {
      deferred = input.landings.slice(index);
      break;
    }
    if (open === null && index === 0 && input.tail !== null) open = openFrom(input.tail);
    if (open !== null && joins(input.repository, open, landing)) {
      extend(open, landing);
      continue;
    }
    if (open !== null) units.push(finish(open, true));
    open = startUnit(input.repository, landing);
  }
  if (open !== null) units.push(finish(open, false));
  return { units, deferred };
}

/** Title shown before a summary exists, or when none can be written. */
export function fallbackTitle(source: ChangeUnitSource): string {
  if (source.kind === "pull-request") return source.pullRequest.title;
  return source.commitSubjects[0] ?? "Direct push";
}

/** The commit that is in production for a repository, and where that came from. */
export type ProductionSignal =
  | {
      readonly source: "deployment";
      readonly environment: string;
      readonly deploymentId: number;
      readonly sha: string;
      readonly at: number;
      readonly url: string | null;
    }
  | {
      readonly source: "release";
      readonly tag: string;
      readonly sha: string;
      readonly at: number | null;
      readonly url: string;
    }
  | { readonly source: "tag"; readonly tag: string; readonly sha: string }
  /** No deployments, releases or tags: landing on the default branch counts as shipping. */
  | { readonly source: "default-branch" };

export type DeploymentSignal = Extract<ProductionSignal, { readonly source: "deployment" }>;
export type ReleaseSignal = Extract<ProductionSignal, { readonly source: "release" }>;
export type TagSignal = Extract<ProductionSignal, { readonly source: "tag" }>;

/** What one production source said this sync. */
export type SourceObservation<A> =
  | { readonly _tag: "Found"; readonly value: A }
  /** Asked; this repository does not use the mechanism. */
  | { readonly _tag: "Absent" }
  /** Could not ask or got no usable answer: no access, rate limited, offline, still deploying. */
  | { readonly _tag: "Unavailable" }
  /** A stronger source answered first, so this one was not read. */
  | { readonly _tag: "NotAsked" };

const SOURCE_RANK = { deployment: 0, release: 1, tag: 2, "default-branch": 3 } as const;

/**
 * Picks the production signal in the required order: a production deployment, else the latest
 * published release, else the latest tag, else the default branch. Flap guard: when a source is
 * Unavailable and the previous answer came from it or a stronger one, the previous answer is
 * kept (and shown as stale) instead of falling to a weaker source for one sync.
 */
export function chooseProductionSource(input: {
  readonly deployment: SourceObservation<DeploymentSignal>;
  readonly release: SourceObservation<ReleaseSignal>;
  readonly tag: SourceObservation<TagSignal>;
  readonly previous: ProductionSignal | null;
}): ProductionSignal | "keep-previous" {
  const ordered = [
    ["deployment", input.deployment],
    ["release", input.release],
    ["tag", input.tag],
  ] as const;
  for (const [source, observation] of ordered) {
    if (observation._tag === "Found") return observation.value;
    if (
      observation._tag === "Unavailable" &&
      input.previous !== null &&
      SOURCE_RANK[input.previous.source] <= SOURCE_RANK[source]
    ) {
      return "keep-previous";
    }
  }
  return { source: "default-branch" };
}

const NOT_PRODUCTION_WORDS = /\b(preview|staging|stage|dev|development|test|testing|qa)\b/i;
const PRODUCTION_NAME = /^(production|prod|live)(?![a-z0-9])/i;

/**
 * GitHub's own production_environment flag, or a name that starts with production/prod/live as
 * a word ("Production", "production-eu", "Production – web"). Transient environments (per-PR
 * previews) and names that also say preview/staging/dev/test/qa never count.
 */
export function isProductionEnvironment(input: {
  readonly name: string;
  readonly productionFlag: boolean | null;
  readonly transient: boolean | null;
}): boolean {
  if (input.transient === true) return false;
  if (input.productionFlag === true) return true;
  const name = input.name.trim();
  return PRODUCTION_NAME.test(name) && !NOT_PRODUCTION_WORDS.test(name);
}

interface SemanticVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: ReadonlyArray<string>;
}

function parseSemver(tag: string): SemanticVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag);
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function comparePrerelease(left: ReadonlyArray<string>, right: ReadonlyArray<string>): number {
  if (left.length === 0 || right.length === 0) return right.length - left.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const numericA = /^\d+$/.test(a);
    const numericB = /^\d+$/.test(b);
    if (numericA && numericB && Number(a) !== Number(b)) return Number(a) - Number(b);
    if (numericA !== numericB) return numericA ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function compareSemver(left: SemanticVersion, right: SemanticVersion): number {
  for (let index = 0; index < 3; index++) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference !== 0) return difference;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * The tags endpoint does not order by date. The highest semantic version wins, prereleases
 * included since this is already the fallback below published releases; with no parseable tag,
 * the first one listed.
 */
export function pickLatestTag(
  tags: ReadonlyArray<{ readonly name: string; readonly sha: string }>,
): { readonly name: string; readonly sha: string } | null {
  let best: { readonly tag: (typeof tags)[number]; readonly version: SemanticVersion } | null =
    null;
  for (const tag of tags) {
    const version = parseSemver(tag.name);
    if (version !== null && (best === null || compareSemver(version, best.version) > 0)) {
      best = { tag, version };
    }
  }
  return best?.tag ?? tags[0] ?? null;
}

/**
 * Per repository. `watermark` is the ordinal of the production commit, or of its merge base
 * with the default branch when it is not on the first-parent chain (a deploy from a release
 * branch). `head` means everything landed is in production; null means production predates the
 * ingested history, so nothing shown is in production yet. `stale` marks an answer kept by the
 * flap guard.
 *
 * Entries store no production flag: moving the watermark flips every affected entry at once.
 */
export interface ProductionState {
  readonly signal: ProductionSignal;
  readonly watermark: number | "head" | null;
  readonly stale: boolean;
  readonly resolvedAt: number;
}

export function isInProduction(
  unit: Pick<ChangeUnit, "lastOrdinal">,
  production: ProductionState | null,
): boolean {
  if (production === null || production.watermark === null) return false;
  return production.watermark === "head" || unit.lastOrdinal <= production.watermark;
}

/** An enabled repository nobody is looking at. */
export const IDLE_SYNC_INTERVAL_MS = 15 * 60_000;
/** While a watch is open, or while commits still wait for their pull request. */
export const ACTIVE_SYNC_INTERVAL_MS = 60_000;

export function nextSyncAt(input: {
  readonly now: number;
  readonly watched: boolean;
  readonly backlog: boolean;
  readonly retryAt?: number | null | undefined;
}): number {
  const interval = input.watched || input.backlog ? ACTIVE_SYNC_INTERVAL_MS : IDLE_SYNC_INTERVAL_MS;
  return Math.max(input.now + interval, input.retryAt ?? 0);
}

export const SUMMARY_BATCH_UNITS = 12;
export const SUMMARY_BATCH_PROMPT_BYTES = 32_000;
export const SUMMARY_MAX_ATTEMPTS = 3;
const SUMMARY_RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000] as const;

/** Where a failed summary goes next: retried after a backoff, or given up on at the cap. */
export function summaryAfterFailure(input: {
  readonly attempts: number;
  readonly now: number;
}):
  | { readonly _tag: "Retry"; readonly attempts: number; readonly nextAttemptAt: number }
  | { readonly _tag: "Unavailable"; readonly attempts: number } {
  const attempts = input.attempts + 1;
  if (attempts >= SUMMARY_MAX_ATTEMPTS) return { _tag: "Unavailable", attempts };
  const delay =
    SUMMARY_RETRY_DELAYS_MS[Math.min(attempts - 1, SUMMARY_RETRY_DELAYS_MS.length - 1)]!;
  return { _tag: "Retry", attempts, nextAttemptAt: input.now + delay };
}

/**
 * The next batch for one repository from settled, due candidates ordered newest first, cut at
 * either cap. Newest first so a fresh backfill summarizes what the user looks at first. The
 * first candidate always fits, so an oversized unit cannot stall the queue.
 */
export function selectSummaryBatch<U extends { readonly promptBytes: number }>(
  candidates: ReadonlyArray<U>,
): ReadonlyArray<U> {
  const batch: Array<U> = [];
  let bytes = 0;
  for (const candidate of candidates) {
    if (batch.length >= SUMMARY_BATCH_UNITS) break;
    if (batch.length > 0 && bytes + candidate.promptBytes > SUMMARY_BATCH_PROMPT_BYTES) break;
    batch.push(candidate);
    bytes += candidate.promptBytes;
  }
  return batch;
}

/** The project whose model and directory summaries use when one repository backs several. */
export function ownerProject<P extends { readonly id: ProjectId }>(
  projects: ReadonlyArray<P>,
): P | null {
  return projects.reduce<P | null>(
    (lowest, project) => (lowest === null || project.id < lowest.id ? project : lowest),
    null,
  );
}
