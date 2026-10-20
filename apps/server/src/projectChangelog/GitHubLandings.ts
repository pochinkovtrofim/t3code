// The only module that knows GitHub's REST shapes for the changelog. It reads through the shared
// GitHubRest client, so it shares PR sync's request slots, quota view and credentials, and
// returns changelogModel types; the wire schemas stay private.
//
// Every read is background work, so every request passes `allowReserve: false`: even a caller
// running under SourceControlRateLimit.Interactive cannot spend the reserve kept for users.
// Every GET revalidates a cached answer with If-None-Match, so an unchanged repository costs
// 304s, which GitHub does not count against the primary rate limit.

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import type { GitHubApiError } from "@t3tools/source-control-github/server/GitHubRequestPolicy";

import {
  type CommitPullsLookup,
  type DeploymentSignal,
  firstParentChain,
  type GitHubRepository,
  isProductionEnvironment,
  type LandedCommit,
  type MergedPullList,
  type MergedPullRequest,
  pickLatestTag,
  PULL_REQUEST_BODY_EXCERPT_CHARS,
  type ReleaseSignal,
  type SourceObservation,
  type TagSignal,
} from "./changelogModel.ts";

const COMMIT_PAGE_SIZE = 100;
const MAX_COMMIT_PAGES = 5;
const PULL_PAGE_SIZE = 100;
const MAX_PULL_PAGES = 3;
/** The merged-PR list is sorted by update time, so it reads a little past the oldest commit. */
const PULL_LIST_SLACK_MS = 24 * 60 * 60_000;
const DEPLOYMENT_CANDIDATES = 5;
const MAX_ENVIRONMENT_QUERIES = 5;
const ENVIRONMENT_PAGE_SIZE = 100;
const RECENT_DEPLOYMENTS = 30;
/** Asked when the repository's environment list cannot be read. */
const PRODUCTION_ENVIRONMENT_NAMES = ["production", "Production"];
const CACHED_ANSWERS_PER_OPERATION = 256;
const LATEST_RELEASE_MISS_MS = 60 * 60_000;
const LOOKUP_CONCURRENCY = 4;
const SHA_ACCEPT = "application/vnd.github.sha";
// GitHub text has no useful bound (a commit's first line can be a megabyte) and reaches every
// page, watch and MCP answer.
const MAX_SUBJECT_CHARS = 200;
const MAX_PULL_TITLE_CHARS = 256;
const MAX_AUTHOR_CHARS = 100;

export class GitHubLandingsDecodeError extends Schema.TaggedError<GitHubLandingsDecodeError>()(
  "GitHubLandingsDecodeError",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `GitHub returned an unexpected answer to ${this.operation}.`;
  }
}

export type GitHubLandingsError = GitHubApiError | GitHubLandingsDecodeError;

export interface ProductionObservations {
  readonly deployment: SourceObservation<DeploymentSignal>;
  readonly release: SourceObservation<ReleaseSignal>;
  readonly tag: SourceObservation<TagSignal>;
}

export class GitHubLandings extends Context.Service<
  GitHubLandings,
  {
    /** The default branch and its head. Unchanged costs two 304s. */
    readonly readHead: (
      repository: GitHubRepository,
    ) => Effect.Effect<
      { readonly defaultBranch: string; readonly headSha: string },
      GitHubLandingsError
    >;
    /**
     * The first-parent chain from `headSha` back to `stopAtSha`, oldest first. `reachedCursor`
     * is false when the walk did not meet `stopAtSha`: a force push, a merge that made it a
     * second parent, or more history than the page budget. Without a cursor it backfills to
     * `since` or `maxCommits`.
     */
    readonly readHistory: (input: {
      readonly repository: GitHubRepository;
      readonly headSha: string;
      readonly stopAtSha: string | null;
      readonly since: number | null;
      readonly maxCommits: number;
    }) => Effect.Effect<
      { readonly chain: ReadonlyArray<LandedCommit>; readonly reachedCursor: boolean },
      GitHubLandingsError
    >;
    readonly readMergedPulls: (input: {
      readonly repository: GitHubRepository;
      readonly defaultBranch: string;
      readonly since: number;
    }) => Effect.Effect<MergedPullList, GitHubLandingsError>;
    /**
     * `commits/{sha}/pulls` for each sha. GitHub refusing the question about one commit is a
     * Failed lookup. A sha whose request never got an answer (rate limit, network, credential)
     * is left out, so the commit stays Unresolved without spending one of its attempts.
     */
    readonly lookupCommitPulls: (input: {
      readonly repository: GitHubRepository;
      readonly shas: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyMap<string, CommitPullsLookup>>;
    /**
     * What each production source says, strongest first, stopping at the first one found: the
     * newest production deployment whose latest status is success, `releases/latest` (GitHub's
     * own non-draft, non-prerelease latest), then the highest tag. A source that could not be
     * read is Unavailable, never a failed sync.
     */
    readonly readProduction: (input: {
      readonly repository: GitHubRepository;
      readonly previousEnvironment: string | null;
    }) => Effect.Effect<ProductionObservations>;
    /** The merge base of two commits; null when they share no history. */
    readonly mergeBase: (input: {
      readonly repository: GitHubRepository;
      readonly sha: string;
      readonly headSha: string;
    }) => Effect.Effect<string | null, GitHubLandingsError>;
    readonly headContains: (input: {
      readonly repository: GitHubRepository;
      readonly sha: string;
      readonly headSha: string;
    }) => Effect.Effect<boolean, GitHubLandingsError>;
  }
>()("t3/projectChangelog/GitHubLandings") {}

const RestRepository = Schema.Struct({ default_branch: Schema.String });

const RestCommit = Schema.Struct({
  sha: Schema.String,
  parents: Schema.Array(Schema.Struct({ sha: Schema.String })),
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  commit: Schema.Struct({
    message: Schema.String,
    author: Schema.NullOr(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        email: Schema.optional(Schema.String),
      }),
    ),
    committer: Schema.NullOr(Schema.Struct({ date: Schema.String })),
  }),
});

const RestPull = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  updated_at: Schema.String,
  merged_at: Schema.NullOr(Schema.String),
  merge_commit_sha: Schema.NullOr(Schema.String),
  head: Schema.Struct({ ref: Schema.String }),
  base: Schema.Struct({
    ref: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
});

const RestDeployment = Schema.Struct({
  id: Schema.Int,
  sha: Schema.String,
  environment: Schema.String,
  production_environment: Schema.optional(Schema.Boolean),
  transient_environment: Schema.optional(Schema.Boolean),
});

const RestEnvironments = Schema.Struct({
  total_count: Schema.Int,
  environments: Schema.Array(Schema.Struct({ name: Schema.String })),
});

const RestDeploymentStatus = Schema.Struct({
  state: Schema.String,
  created_at: Schema.String,
  environment_url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RestRelease = Schema.Struct({
  tag_name: Schema.String,
  html_url: Schema.String,
  published_at: Schema.NullOr(Schema.String),
});

const RestTag = Schema.Struct({
  name: Schema.String,
  commit: Schema.Struct({ sha: Schema.String }),
});

const RestCompare = Schema.Struct({
  status: Schema.String,
  merge_base_commit: Schema.Struct({ sha: Schema.String }),
});

function bounded(text: string | null | undefined, maxChars: number): string | null {
  const value = (text ?? "").trim().slice(0, maxChars).trimEnd();
  return value === "" ? null : value;
}

function toLandedCommit(commit: typeof RestCommit.Type): LandedCommit {
  const login = bounded(commit.author?.login, MAX_AUTHOR_CHARS);
  const name = bounded(commit.commit.author?.name, MAX_AUTHOR_CHARS);
  const email = bounded(commit.commit.author?.email, MAX_AUTHOR_CHARS);
  return {
    sha: commit.sha,
    parentShas: commit.parents.map((parent) => parent.sha),
    subject: bounded(commit.commit.message.split("\n", 1)[0], MAX_SUBJECT_CHARS) ?? "",
    authorKey: login ?? email ?? name ?? "unknown",
    authorDisplay: login ?? name ?? email ?? "unknown",
    committedAt: Date.parse(commit.commit.committer?.date ?? "") || 0,
  };
}

function toMergedPullRequest(
  repository: GitHubRepository,
  pull: typeof RestPull.Type,
): MergedPullRequest {
  return {
    number: pull.number,
    repository: (
      pull.base.repo?.full_name ?? `${repository.owner}/${repository.name}`
    ).toLowerCase(),
    title: bounded(pull.title, MAX_PULL_TITLE_CHARS) ?? "",
    bodyExcerpt: (pull.body ?? "").slice(0, PULL_REQUEST_BODY_EXCERPT_CHARS),
    url: pull.html_url,
    authorLogin: bounded(pull.user?.login, MAX_AUTHOR_CHARS),
    mergedAt: pull.merged_at === null ? null : Date.parse(pull.merged_at),
    mergeCommitSha: pull.merge_commit_sha,
    headRef: pull.head.ref,
    baseRef: pull.base.ref,
  };
}

const repoPath = (repository: GitHubRepository, rest = "") =>
  `repos/${repository.owner}/${repository.name}${rest === "" ? "" : `/${rest}`}`;

const decodeJson =
  <S extends Schema.Top, A>(operation: string, schema: S, toDomain: (value: S["Type"]) => A) =>
  (body: string) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(
      Effect.map(toDomain),
      Effect.mapError((cause) => new GitHubLandingsDecodeError({ operation, cause })),
    );

const decodeSha = (operation: string) => (body: string) => {
  const sha = body.trim();
  return /^[0-9a-f]{40,64}$/.test(sha)
    ? Effect.succeed(sha)
    : Effect.fail(new GitHubLandingsDecodeError({ operation }));
};

const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;

  /**
   * One GET operation that revalidates its last answer per path. The decoded domain value is
   * cached rather than the body, since a page of commits or pull requests is mostly fields
   * nothing reads. Lost on restart, which costs one full read per path.
   */
  const conditionalGet = <A>(
    operation: string,
    decode: (body: string) => Effect.Effect<A, GitHubLandingsDecodeError>,
    accept?: string,
  ) => {
    const answers = new Map<string, { readonly etag: string; readonly value: A }>();
    return Effect.fnUntraced(function* (repository: GitHubRepository, path: string) {
      const cacheKey = `${repository.host} ${path}`;
      const cached = answers.get(cacheKey);
      const response = yield* api.rest({
        host: repository.host,
        operation,
        path,
        allowReserve: false,
        ...(accept === undefined ? {} : { accept }),
        ...(cached === undefined ? {} : { ifNoneMatch: cached.etag }),
      });
      answers.delete(cacheKey);
      if (response.status === 304 && cached !== undefined) {
        answers.set(cacheKey, cached);
        return cached.value;
      }
      if (response.truncated || response.invalidUtf8) {
        return yield* new GitHubLandingsDecodeError({ operation });
      }
      const value = yield* decode(response.body);
      const etag = response.headers.etag;
      if (etag !== undefined) {
        answers.set(cacheKey, { etag, value });
        if (answers.size > CACHED_ANSWERS_PER_OPERATION) {
          answers.delete(answers.keys().next().value!);
        }
      }
      return value;
    });
  };

  const getDefaultBranch = conditionalGet(
    "changelogRepository",
    decodeJson("changelogRepository", RestRepository, (repo) => repo.default_branch),
  );
  const getRefSha = conditionalGet("changelogRefSha", decodeSha("changelogRefSha"), SHA_ACCEPT);
  const getCommitPage = conditionalGet(
    "changelogCommits",
    decodeJson("changelogCommits", Schema.Array(RestCommit), (rows) => rows.map(toLandedCommit)),
  );
  const getClosedPulls = conditionalGet(
    "changelogClosedPulls",
    decodeJson("changelogClosedPulls", Schema.Array(RestPull), (rows) => ({
      rowCount: rows.length,
      oldestUpdatedAt: rows.length === 0 ? null : Date.parse(rows[rows.length - 1]!.updated_at),
      merged: rows.filter((row) => row.merged_at !== null),
    })),
  );
  const getCommitPulls = conditionalGet(
    "changelogCommitPulls",
    decodeJson("changelogCommitPulls", Schema.Array(RestPull), (rows) => rows),
  );
  const getDeployments = conditionalGet(
    "changelogDeployments",
    decodeJson("changelogDeployments", Schema.Array(RestDeployment), (rows) => ({
      count: rows.length,
      production: rows.filter((deployment) =>
        isProductionEnvironment({
          name: deployment.environment,
          productionFlag: deployment.production_environment ?? null,
          transient: deployment.transient_environment ?? null,
        }),
      ),
    })),
  );
  const getEnvironments = conditionalGet(
    "changelogEnvironments",
    decodeJson("changelogEnvironments", RestEnvironments, (answer) => ({
      names: answer.environments.map((environment) => environment.name),
      complete: answer.total_count <= answer.environments.length,
    })),
  );
  const getLatestStatus = conditionalGet(
    "changelogDeploymentStatus",
    decodeJson(
      "changelogDeploymentStatus",
      Schema.Array(RestDeploymentStatus),
      (rows) => rows[0] ?? null,
    ),
  );
  const getHasReleases = conditionalGet(
    "changelogReleases",
    decodeJson("changelogReleases", Schema.Array(Schema.Unknown), (rows) => rows.length > 0),
  );
  const getLatestRelease = conditionalGet(
    "changelogLatestRelease",
    decodeJson("changelogLatestRelease", RestRelease, (release) => release),
  );
  const getLatestTag = conditionalGet(
    "changelogTags",
    decodeJson("changelogTags", Schema.Array(RestTag), (tags) =>
      pickLatestTag(tags.map((tag) => ({ name: tag.name, sha: tag.commit.sha }))),
    ),
  );
  const getCompare = conditionalGet(
    "changelogCompare",
    decodeJson("changelogCompare", RestCompare, (compare) => ({
      status: compare.status,
      mergeBase: compare.merge_base_commit.sha,
    })),
  );
  // Page 2 of one commit each: the same status and merge base, without the changed files and
  // patches that page 1 adds.
  const compare = (repository: GitHubRepository, baseSha: string, headSha: string) =>
    getCompare(
      repository,
      repoPath(repository, `compare/${baseSha}...${headSha}?per_page=1&page=2`),
    );

  const readHead: GitHubLandings["Service"]["readHead"] = Effect.fn("GitHubLandings.readHead")(
    function* (repository) {
      const defaultBranch = yield* getDefaultBranch(repository, repoPath(repository));
      const headSha = yield* getRefSha(
        repository,
        repoPath(repository, `commits/${encodeURIComponent(defaultBranch)}`),
      );
      return { defaultBranch, headSha };
    },
  );

  const readHistory: GitHubLandings["Service"]["readHistory"] = Effect.fn(
    "GitHubLandings.readHistory",
  )(function* (input) {
    const commits = new Map<string, LandedCommit>();
    const since =
      input.stopAtSha === null && input.since !== null
        ? `&since=${DateTime.formatIso(DateTime.makeUnsafe(input.since))}`
        : "";
    for (let page = 1; ; page++) {
      const rows = yield* getCommitPage(
        input.repository,
        repoPath(
          input.repository,
          `commits?sha=${input.headSha}&per_page=${COMMIT_PAGE_SIZE}&page=${page}${since}`,
        ),
      );
      for (const row of rows) commits.set(row.sha, row);
      const walk = firstParentChain({
        headSha: input.headSha,
        stopAtSha: input.stopAtSha,
        commits,
        maxLength: input.maxCommits,
      });
      // Other branches' commits interleave by date, so a missing parent may be on a later page.
      if (
        walk.end._tag !== "Missing" ||
        rows.length < COMMIT_PAGE_SIZE ||
        page >= MAX_COMMIT_PAGES
      ) {
        return { chain: walk.chain, reachedCursor: walk.end._tag === "Cursor" };
      }
    }
  });

  const readMergedPulls: GitHubLandings["Service"]["readMergedPulls"] = Effect.fn(
    "GitHubLandings.readMergedPulls",
  )(function* (input) {
    const merged: Array<MergedPullRequest> = [];
    let incompleteBefore: number | null = null;
    for (let page = 1; page <= MAX_PULL_PAGES; page++) {
      const answer = yield* getClosedPulls(
        input.repository,
        repoPath(
          input.repository,
          `pulls?state=closed&base=${encodeURIComponent(input.defaultBranch)}&sort=updated&direction=desc&per_page=${PULL_PAGE_SIZE}&page=${page}`,
        ),
      );
      for (const row of answer.merged) merged.push(toMergedPullRequest(input.repository, row));
      if (
        answer.rowCount < PULL_PAGE_SIZE ||
        answer.oldestUpdatedAt === null ||
        answer.oldestUpdatedAt < input.since - PULL_LIST_SLACK_MS
      ) {
        return { pullRequests: merged, incompleteBefore: null };
      }
      // Sorted by update time, and a merge updates a pull request: none merged since is missing.
      incompleteBefore = answer.oldestUpdatedAt;
    }
    return { pullRequests: merged, incompleteBefore };
  });

  const lookupCommitPulls: GitHubLandings["Service"]["lookupCommitPulls"] = Effect.fn(
    "GitHubLandings.lookupCommitPulls",
  )(function* (input) {
    const failed = () => Effect.succeed<CommitPullsLookup | null>({ _tag: "Failed" });
    const answers = yield* Effect.forEach(
      input.shas,
      (sha) =>
        getCommitPulls(input.repository, repoPath(input.repository, `commits/${sha}/pulls`)).pipe(
          Effect.map((rows): CommitPullsLookup | null => ({
            _tag: "Answered",
            pullRequests: rows.map((row) => toMergedPullRequest(input.repository, row)),
          })),
          Effect.catchTags({
            GitHubApiNotFoundError: failed,
            GitHubApiResponseError: failed,
            GitHubLandingsDecodeError: failed,
          }),
          Effect.orElseSucceed(() => null),
          Effect.map((lookup) => [sha, lookup] as const),
        ),
      { concurrency: LOOKUP_CONCURRENCY },
    );
    const lookups = new Map<string, CommitPullsLookup>();
    for (const [sha, lookup] of answers) if (lookup !== null) lookups.set(sha, lookup);
    return lookups;
  });

  const observeEnvironment = Effect.fnUntraced(function* (
    repository: GitHubRepository,
    environment: string,
  ) {
    const { production } = yield* getDeployments(
      repository,
      repoPath(
        repository,
        `deployments?environment=${encodeURIComponent(environment)}&per_page=${DEPLOYMENT_CANDIDATES}`,
      ),
    );
    if (production.length === 0) return { _tag: "Empty" } as const;
    for (const deployment of production) {
      const status = yield* getLatestStatus(
        repository,
        repoPath(repository, `deployments/${deployment.id}/statuses?per_page=1`),
      );
      if (status?.state === "success") {
        const signal: DeploymentSignal = {
          source: "deployment",
          environment: deployment.environment,
          deploymentId: deployment.id,
          sha: deployment.sha,
          at: Date.parse(status.created_at),
          url: status.environment_url || null,
        };
        return { _tag: "Found", value: signal } as const;
      }
    }
    return { _tag: "NoSuccess" } as const;
  });

  /**
   * Each production environment is asked by name, since preview deployments can fill any page of
   * all of them. Absent only when every production environment was asked and none has deployed.
   */
  const observeDeployment = Effect.fnUntraced(function* (
    repository: GitHubRepository,
    previousEnvironment: string | null,
  ) {
    const listed = yield* getEnvironments(
      repository,
      repoPath(repository, `environments?per_page=${ENVIRONMENT_PAGE_SIZE}`),
    ).pipe(
      Effect.catchTags({
        GitHubApiNotFoundError: () => Effect.succeed(null),
        GitHubApiResponseError: (error) =>
          error.status === 403 ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
    const recent = yield* getDeployments(
      repository,
      repoPath(repository, `deployments?per_page=${RECENT_DEPLOYMENTS}`),
    );
    // Only MAX_ENVIRONMENT_QUERIES are asked, so the environments of the newest production
    // deployments go first: one of them holds the newest deployment unless RECENT_DEPLOYMENTS newer
    // ones bury it.
    // The environment list carries no production flag; the newest deployments do.
    const candidates = [
      ...new Set([
        ...recent.production.map((deployment) => deployment.environment),
        ...(previousEnvironment === null ? [] : [previousEnvironment]),
        ...(listed === null
          ? PRODUCTION_ENVIRONMENT_NAMES
          : listed.names.filter((name) =>
              isProductionEnvironment({ name, productionFlag: null, transient: null }),
            )),
      ]),
    ];
    const asked = candidates.slice(0, MAX_ENVIRONMENT_QUERIES);
    const answers = yield* Effect.forEach(asked, (environment) =>
      observeEnvironment(repository, environment),
    );
    const newest = answers.reduce<DeploymentSignal | null>(
      (best, answer) =>
        answer._tag === "Found" && (best === null || answer.value.at > best.at)
          ? answer.value
          : best,
      null,
    );
    if (newest !== null) return { _tag: "Found", value: newest } as const;
    const everyEnvironmentAsked =
      (listed === null ? recent.count < RECENT_DEPLOYMENTS : listed.complete) &&
      asked.length === candidates.length;
    return everyEnvironmentAsked && answers.every((answer) => answer._tag === "Empty")
      ? ({ _tag: "Absent" } as const)
      : ({ _tag: "Unavailable" } as const);
  });

  // `releases/latest` is a 404 while a repository has only drafts and prereleases, and a 404
  // carries no ETag to revalidate, so each sync would spend a counted request on it.
  const latestReleaseMissedAt = new Map<GitHubRepository["key"], number>();

  const observeRelease = Effect.fnUntraced(function* (repository: GitHubRepository) {
    // The list answers [] with an ETag, so a repository without releases costs a 304.
    if (!(yield* getHasReleases(repository, repoPath(repository, "releases?per_page=1")))) {
      return { _tag: "Absent" } as const;
    }
    const now = yield* Clock.currentTimeMillis;
    const missedAt = latestReleaseMissedAt.get(repository.key);
    if (missedAt !== undefined && now - missedAt < LATEST_RELEASE_MISS_MS) {
      return { _tag: "Absent" } as const;
    }
    const release = yield* getLatestRelease(
      repository,
      repoPath(repository, "releases/latest"),
    ).pipe(Effect.catchTags({ GitHubApiNotFoundError: () => Effect.succeed(null) }));
    if (release === null) {
      latestReleaseMissedAt.set(repository.key, now);
      return { _tag: "Absent" } as const;
    }
    latestReleaseMissedAt.delete(repository.key);
    const sha = yield* getRefSha(
      repository,
      repoPath(repository, `commits/${encodeURIComponent(release.tag_name)}`),
    );
    const signal: ReleaseSignal = {
      source: "release",
      tag: release.tag_name,
      sha,
      at: release.published_at === null ? null : Date.parse(release.published_at),
      url: release.html_url,
    };
    return { _tag: "Found", value: signal } as const;
  });

  const observeTag = Effect.fnUntraced(function* (repository: GitHubRepository) {
    const latest = yield* getLatestTag(repository, repoPath(repository, "tags?per_page=100"));
    if (latest === null) return { _tag: "Absent" } as const;
    const signal: TagSignal = { source: "tag", tag: latest.name, sha: latest.sha };
    return { _tag: "Found", value: signal } as const;
  });

  // A 404 is a source the repository does not have; any other failure is a source that could not
  // be read this time.
  const observe = <A>(
    effect: Effect.Effect<SourceObservation<A>, GitHubLandingsError>,
  ): Effect.Effect<SourceObservation<A>> =>
    effect.pipe(
      Effect.catchTags({
        GitHubApiNotFoundError: () => Effect.succeed<SourceObservation<A>>({ _tag: "Absent" }),
      }),
      Effect.orElseSucceed((): SourceObservation<A> => ({ _tag: "Unavailable" })),
    );

  const readProduction: GitHubLandings["Service"]["readProduction"] = Effect.fn(
    "GitHubLandings.readProduction",
  )(function* ({ repository, previousEnvironment }) {
    const notAsked = { _tag: "NotAsked" } as const;
    const deployment = yield* observe(observeDeployment(repository, previousEnvironment));
    if (deployment._tag === "Found") return { deployment, release: notAsked, tag: notAsked };
    const release = yield* observe(observeRelease(repository));
    if (release._tag === "Found") return { deployment, release, tag: notAsked };
    const tag = yield* observe(observeTag(repository));
    return { deployment, release, tag };
  });

  const mergeBase: GitHubLandings["Service"]["mergeBase"] = Effect.fn("GitHubLandings.mergeBase")(
    function* (input) {
      return yield* compare(input.repository, input.sha, input.headSha).pipe(
        Effect.map((answer) => answer.mergeBase),
        Effect.catchTags({ GitHubApiNotFoundError: () => Effect.succeed(null) }),
      );
    },
  );

  const headContains: GitHubLandings["Service"]["headContains"] = Effect.fn(
    "GitHubLandings.headContains",
  )(function* (input) {
    return yield* compare(input.repository, input.sha, input.headSha).pipe(
      Effect.map((answer) => answer.status === "ahead" || answer.status === "identical"),
      // GitHub no longer knows a commit a force push removed.
      Effect.catchTags({ GitHubApiNotFoundError: () => Effect.succeed(false) }),
    );
  });

  return GitHubLandings.of({
    readHead,
    readHistory,
    readMergedPulls,
    lookupCommitPulls,
    readProduction,
    mergeBase,
    headContains,
  });
});

export const layer = Layer.effect(GitHubLandings, make);
