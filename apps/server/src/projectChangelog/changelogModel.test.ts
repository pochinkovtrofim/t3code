import { describe, expect, it } from "vite-plus/test";
import { ProjectId, type RepositoryIdentity } from "@t3tools/contracts";

import {
  ACTIVE_SYNC_INTERVAL_MS,
  assignOrdinals,
  associateLandings,
  type ChangeUnit,
  chooseProductionSource,
  commitsNeedingLookup,
  type CommitPullsLookup,
  firstParentChain,
  type GitHubRepository,
  groupChangeUnits,
  IDLE_SYNC_INTERVAL_MS,
  isInProduction,
  isProductionEnvironment,
  type LandedCommit,
  type Landing,
  type MergedPullRequest,
  nextSyncAt,
  ownerProject,
  pickLatestTag,
  PUSH_GROUP_GAP_MS,
  resolveGitHubRepository,
  selectSummaryBatch,
  summaryAfterFailure,
} from "./changelogModel.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-01T12:00:00Z");

const repository: GitHubRepository = {
  key: "github.com/acme/web" as GitHubRepository["key"],
  host: "github.com",
  owner: "acme",
  name: "web",
  webUrl: "https://github.com/acme/web",
};

const commit = (
  sha: string,
  parents: ReadonlyArray<string>,
  options: { readonly author?: string; readonly at?: number; readonly subject?: string } = {},
): LandedCommit => ({
  sha,
  parentShas: parents,
  subject: options.subject ?? `subject ${sha}`,
  authorKey: options.author ?? "alice",
  authorDisplay: options.author ?? "alice",
  committedAt: options.at ?? T0,
});

const pull = (number: number, overrides: Partial<MergedPullRequest> = {}): MergedPullRequest => ({
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
  ...overrides,
});

const viaPull = (sha: string, pullRequest: MergedPullRequest, at = T0): Landing => ({
  ...commit(sha, [], { at }),
  association: { _tag: "PullRequest", pullRequest },
  ordinal: 0,
});

const direct = (sha: string, author: string, at: number): Landing => ({
  ...commit(sha, [], { author, at }),
  association: { _tag: "Direct" },
  ordinal: 0,
});

const unresolved = (sha: string): Landing => ({
  ...commit(sha, []),
  association: { _tag: "Unresolved", attempts: 0 },
  ordinal: 0,
});

const positioned = (landings: ReadonlyArray<Landing>, base = 0): ReadonlyArray<Landing> =>
  assignOrdinals(base, landings);

describe("resolveGitHubRepository", () => {
  const identity = (overrides: Partial<RepositoryIdentity>): RepositoryIdentity => ({
    canonicalKey: "github.com/acme/web",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/Acme/Web.git",
    },
    provider: "github",
    owner: "Acme",
    name: "Web",
    ...overrides,
  });

  it("keys a GitHub repository by its lower-cased host and path, keeping display casing", () => {
    expect(resolveGitHubRepository(identity({}))).toEqual({
      _tag: "GitHub",
      repository: {
        key: "github.com/acme/web",
        host: "github.com",
        owner: "Acme",
        name: "Web",
        webUrl: "https://github.com/Acme/Web",
      },
    });
  });

  it("tells a missing remote apart from a host the changelog cannot read", () => {
    expect(resolveGitHubRepository(null)._tag).toBe("NoRepository");
    expect(
      resolveGitHubRepository(identity({ provider: "gitlab", canonicalKey: "gitlab.com/a/b" }))
        ._tag,
    ).toBe("NotGitHub");
  });
});

describe("firstParentChain", () => {
  // root <- a <- merge(a, side2) <- b ; side1 <- side2 is the merged branch
  const commits = new Map(
    [
      commit("root", []),
      commit("a", ["root"]),
      commit("side1", ["a"]),
      commit("side2", ["side1"]),
      commit("merge", ["a", "side2"]),
      commit("b", ["merge"]),
    ].map((value) => [value.sha, value]),
  );

  it("walks first parents only, so a merged branch's commits are not landings", () => {
    const { chain, end } = firstParentChain({
      headSha: "b",
      stopAtSha: null,
      commits,
      maxLength: 100,
    });
    expect(chain.map((value) => value.sha)).toEqual(["root", "a", "merge", "b"]);
    expect(end).toEqual({ _tag: "Root" });
  });

  it("stops at the cursor, at the length limit, and at a commit it does not have", () => {
    expect(
      firstParentChain({ headSha: "b", stopAtSha: "a", commits, maxLength: 100 }),
    ).toMatchObject({ chain: [{ sha: "merge" }, { sha: "b" }], end: { _tag: "Cursor" } });
    expect(
      firstParentChain({ headSha: "b", stopAtSha: null, commits, maxLength: 2 }),
    ).toMatchObject({ chain: [{ sha: "merge" }, { sha: "b" }], end: { _tag: "Limit" } });
    const partial = new Map([...commits].filter(([sha]) => sha !== "a"));
    expect(
      firstParentChain({ headSha: "b", stopAtSha: null, commits: partial, maxLength: 100 }),
    ).toMatchObject({
      chain: [{ sha: "merge" }, { sha: "b" }],
      end: { _tag: "Missing", sha: "a" },
    });
  });
});

describe("associateLandings", () => {
  const squash = pull(10, { mergeCommitSha: "s1" });
  const chain = [commit("s1", []), commit("r1", []), commit("r2", []), commit("d1", [])];

  it("matches squash merges from the list and looks up only the rest, oldest first", () => {
    expect(commitsNeedingLookup({ commits: chain, mergedPulls: [squash], budget: 2 })).toEqual([
      "r1",
      "r2",
    ]);
  });

  it("uses lookups for rebase merges and direct pushes and leaves out-of-budget commits unresolved", () => {
    const rebased = pull(11);
    const lookups = new Map<string, CommitPullsLookup>([
      ["r1", { _tag: "Answered", pullRequests: [rebased] }],
      ["r2", { _tag: "Answered", pullRequests: [pull(12, { baseRef: "release" }), rebased] }],
    ]);
    const associated = associateLandings({
      commits: [...chain, commit("later", [])],
      defaultBranch: "main",
      mergedPulls: [squash],
      lookups: new Map([...lookups, ["d1", { _tag: "Answered", pullRequests: [] }]]),
    });
    expect(associated.map((value) => value.association)).toEqual([
      { _tag: "PullRequest", pullRequest: squash },
      { _tag: "PullRequest", pullRequest: rebased },
      { _tag: "PullRequest", pullRequest: rebased },
      { _tag: "Direct" },
      { _tag: "Unresolved", attempts: 0 },
    ]);
  });

  it("gives up on a commit whose lookup keeps failing after three attempts", () => {
    const attemptsAfter = (previous: number) =>
      associateLandings({
        commits: [commit("x", [])],
        defaultBranch: "main",
        mergedPulls: [],
        lookups: new Map([["x", { _tag: "Failed" }]]),
        previousAttempts: new Map([["x", previous]]),
      })[0]!.association;
    expect(attemptsAfter(0)).toEqual({ _tag: "Unresolved", attempts: 1 });
    expect(attemptsAfter(1)).toEqual({ _tag: "Unresolved", attempts: 2 });
    expect(attemptsAfter(2)).toEqual({ _tag: "Direct" });
  });
});

describe("groupChangeUnits", () => {
  const keysOf = (units: ReadonlyArray<ChangeUnit>) =>
    units.map((unit) => [unit.key, unit.firstOrdinal, unit.lastOrdinal, unit.commitCount]);

  it("makes one entry per squash or merge-commit PR and one for a rebase merge's commits", () => {
    const rebased = pull(7);
    const { units, deferred } = groupChangeUnits({
      repository,
      tail: null,
      landings: positioned([
        viaPull("squash", pull(5)),
        viaPull("merge", pull(6)),
        viaPull("r1", rebased),
        viaPull("r2", rebased),
        viaPull("r3", rebased),
      ]),
    });
    expect(keysOf(units)).toEqual([
      ["pr:5", 1, 1, 1],
      ["pr:6", 2, 2, 1],
      ["pr:7", 3, 5, 3],
    ]);
    expect(units[2]!.headSha).toBe("r3");
    expect(units[2]!.source.commitSubjects).toEqual(["subject r1", "subject r2", "subject r3"]);
    expect(deferred).toEqual([]);
  });

  it("groups direct pushes by author while commits stay under the gap apart", () => {
    const { units } = groupChangeUnits({
      repository,
      tail: null,
      landings: positioned([
        direct("p1", "alice", T0),
        direct("p2", "alice", T0 + 5 * MINUTE),
        direct("p3", "alice", T0 + 5 * MINUTE + PUSH_GROUP_GAP_MS),
        direct("p4", "carol", T0 + 5 * MINUTE + PUSH_GROUP_GAP_MS + MINUTE),
        viaPull("pr", pull(9)),
        direct("p5", "carol", T0 + 5 * MINUTE + PUSH_GROUP_GAP_MS + 2 * MINUTE),
      ]),
    });
    expect(keysOf(units)).toEqual([
      ["push:p1", 1, 2, 2],
      ["push:p3", 3, 3, 1],
      ["push:p4", 4, 4, 1],
      ["pr:9", 5, 5, 1],
      ["push:p5", 6, 6, 1],
    ]);
  });

  it("keeps the last push group open until the gap passes, and settles a closed one at once", () => {
    const { units } = groupChangeUnits({
      repository,
      tail: null,
      landings: positioned([
        direct("p1", "alice", T0),
        viaPull("pr", pull(3)),
        direct("p2", "alice", T0 + MINUTE),
      ]),
    });
    expect(units.map((unit) => unit.settlesAt)).toEqual([T0, T0, T0 + MINUTE + PUSH_GROUP_GAP_MS]);
  });

  it("never forms a unit across an unresolved commit", () => {
    const landings = positioned([
      direct("p1", "alice", T0),
      unresolved("u"),
      direct("p2", "alice", T0 + MINUTE),
    ]);
    const { units, deferred } = groupChangeUnits({ repository, tail: null, landings });
    expect(keysOf(units)).toEqual([["push:p1", 1, 1, 1]]);
    expect(deferred.map((landing) => landing.sha)).toEqual(["u", "p2"]);
  });

  it("keys another repository's pull request apart from this repository's", () => {
    const { units } = groupChangeUnits({
      repository,
      tail: null,
      landings: positioned([viaPull("x", pull(5, { repository: "upstream/web" }))]),
    });
    expect(units[0]!.key).toBe("pr:upstream/web#5");
  });

  it("yields the same units whether history arrives in one sync or split across two", () => {
    const rebased = pull(21);
    const history = positioned([
      direct("a1", "alice", T0),
      direct("a2", "alice", T0 + MINUTE),
      viaPull("r1", rebased),
      viaPull("r2", rebased),
      direct("a3", "alice", T0 + 2 * MINUTE),
      direct("a4", "alice", T0 + 3 * MINUTE),
      viaPull("s", pull(22)),
      direct("b1", "bob", T0 + 4 * MINUTE),
      direct("b2", "bob", T0 + 5 * MINUTE),
    ]);
    const whole = groupChangeUnits({ repository, tail: null, landings: history }).units;
    for (let split = 1; split < history.length; split++) {
      const first = groupChangeUnits({ repository, tail: null, landings: history.slice(0, split) });
      const stored = new Map(first.units.map((unit) => [unit.key, unit]));
      const tail = first.units.at(-1) ?? null;
      const second = groupChangeUnits({ repository, tail, landings: history.slice(split) });
      for (const unit of second.units) stored.set(unit.key, unit);
      expect(
        [...stored.values()].toSorted((a, b) => a.firstOrdinal - b.firstOrdinal),
        `split at ${split}`,
      ).toEqual(whole);
    }
  });

  it("changes the content hash when a unit grows, so its summary is written again", () => {
    const one = groupChangeUnits({
      repository,
      tail: null,
      landings: positioned([direct("p1", "alice", T0)]),
    }).units[0]!;
    const grown = groupChangeUnits({
      repository,
      tail: one,
      landings: positioned([direct("p2", "alice", T0 + MINUTE)], 1),
    }).units[0]!;
    expect(grown.key).toBe(one.key);
    expect(grown.contentHash).not.toBe(one.contentHash);
  });
});

describe("production", () => {
  const deployment = {
    source: "deployment" as const,
    environment: "production",
    deploymentId: 1,
    sha: "d",
    at: T0,
    url: null,
  };
  const release = {
    source: "release" as const,
    tag: "v1.0.0",
    sha: "r",
    at: T0,
    url: "https://github.com/acme/web/releases/tag/v1.0.0",
  };
  const tag = { source: "tag" as const, tag: "v0.9.0", sha: "t" };

  it("prefers a deployment, then a release, then a tag, then the default branch", () => {
    expect(
      chooseProductionSource({
        deployment: { _tag: "Found", value: deployment },
        release: { _tag: "NotAsked" },
        tag: { _tag: "NotAsked" },
        previous: null,
      }),
    ).toEqual(deployment);
    expect(
      chooseProductionSource({
        deployment: { _tag: "Absent" },
        release: { _tag: "Found", value: release },
        tag: { _tag: "NotAsked" },
        previous: null,
      }),
    ).toEqual(release);
    expect(
      chooseProductionSource({
        deployment: { _tag: "Absent" },
        release: { _tag: "Absent" },
        tag: { _tag: "Found", value: tag },
        previous: null,
      }),
    ).toEqual(tag);
    expect(
      chooseProductionSource({
        deployment: { _tag: "Absent" },
        release: { _tag: "Absent" },
        tag: { _tag: "Absent" },
        previous: deployment,
      }),
    ).toEqual({ source: "default-branch" });
  });

  it("keeps the previous answer when its source is briefly unreachable instead of falling back", () => {
    expect(
      chooseProductionSource({
        deployment: { _tag: "Unavailable" },
        release: { _tag: "Found", value: release },
        tag: { _tag: "NotAsked" },
        previous: deployment,
      }),
    ).toBe("keep-previous");
    expect(
      chooseProductionSource({
        deployment: { _tag: "Absent" },
        release: { _tag: "Unavailable" },
        tag: { _tag: "Found", value: tag },
        previous: release,
      }),
    ).toBe("keep-previous");
  });

  it("uses a weaker source when the stronger one is unreachable and never answered before", () => {
    expect(
      chooseProductionSource({
        deployment: { _tag: "Unavailable" },
        release: { _tag: "Found", value: release },
        tag: { _tag: "NotAsked" },
        previous: tag,
      }),
    ).toEqual(release);
    expect(
      chooseProductionSource({
        deployment: { _tag: "Unavailable" },
        release: { _tag: "Absent" },
        tag: { _tag: "Absent" },
        previous: null,
      }),
    ).toEqual({ source: "default-branch" });
  });

  it("recognizes production environments and ignores transient and preview ones", () => {
    const cases: ReadonlyArray<[string, boolean | null, boolean | null, boolean]> = [
      ["production", false, false, true],
      ["Production – t3code-app", null, null, true],
      ["prod-eu", null, null, true],
      ["live", null, null, true],
      ["Preview – t3code-app", null, null, false],
      ["staging", null, null, false],
      ["production-preview", null, null, false],
      ["productionish", null, null, false],
      ["github-pages", null, null, false],
      ["copilot", null, null, false],
      ["pr-42", true, true, false],
      ["web", true, false, true],
    ];
    for (const [name, productionFlag, transient, expected] of cases) {
      expect(isProductionEnvironment({ name, productionFlag, transient }), name).toBe(expected);
    }
  });

  it("picks the highest version tag, preferring a stable release over its prereleases", () => {
    expect(
      pickLatestTag([
        { name: "v0.9.0", sha: "a" },
        { name: "v0.10.0-nightly.20261020.2", sha: "b" },
        { name: "v0.10.0-nightly.20261020.10", sha: "c" },
        { name: "v0.10.0", sha: "d" },
      ]),
    ).toEqual({ name: "v0.10.0", sha: "d" });
    expect(
      pickLatestTag([
        { name: "v0.1.1-nightly.20261019.3373", sha: "a" },
        { name: "v0.1.1-nightly.20261020.3401", sha: "b" },
      ]),
    ).toEqual({ name: "v0.1.1-nightly.20261020.3401", sha: "b" });
    expect(
      pickLatestTag([
        { name: "release-b", sha: "b" },
        { name: "release-a", sha: "a" },
      ]),
    ).toEqual({ name: "release-b", sha: "b" });
    expect(pickLatestTag([])).toBeNull();
  });

  it("marks entries at or below the watermark as in production", () => {
    const state = (watermark: number | "head" | null) => ({
      signal: tag,
      watermark,
      stale: false,
      resolvedAt: T0,
    });
    expect(isInProduction({ lastOrdinal: 4 }, state(4))).toBe(true);
    expect(isInProduction({ lastOrdinal: 5 }, state(4))).toBe(false);
    expect(isInProduction({ lastOrdinal: 500 }, state("head"))).toBe(true);
    expect(isInProduction({ lastOrdinal: 1 }, state(null))).toBe(false);
    expect(isInProduction({ lastOrdinal: 1 }, null)).toBe(false);
  });
});

describe("cadence and summaries", () => {
  it("syncs every minute while watched or catching up, every fifteen otherwise", () => {
    expect(nextSyncAt({ now: T0, watched: false, backlog: false })).toBe(
      T0 + IDLE_SYNC_INTERVAL_MS,
    );
    expect(nextSyncAt({ now: T0, watched: true, backlog: false })).toBe(
      T0 + ACTIVE_SYNC_INTERVAL_MS,
    );
    expect(nextSyncAt({ now: T0, watched: false, backlog: true })).toBe(
      T0 + ACTIVE_SYNC_INTERVAL_MS,
    );
    expect(nextSyncAt({ now: T0, watched: true, backlog: false, retryAt: T0 + 10 * MINUTE })).toBe(
      T0 + 10 * MINUTE,
    );
  });

  it("retries a failed summary with backoff and gives up at the third failure", () => {
    expect(summaryAfterFailure({ attempts: 0, now: T0 })).toEqual({
      _tag: "Retry",
      attempts: 1,
      nextAttemptAt: T0 + 5 * MINUTE,
    });
    expect(summaryAfterFailure({ attempts: 1, now: T0 })).toEqual({
      _tag: "Retry",
      attempts: 2,
      nextAttemptAt: T0 + 30 * MINUTE,
    });
    expect(summaryAfterFailure({ attempts: 2, now: T0 })).toEqual({
      _tag: "Unavailable",
      attempts: 3,
    });
  });

  it("cuts a summary batch at twelve units or the prompt budget, always taking one", () => {
    const units = (count: number, promptBytes: number) =>
      Array.from({ length: count }, (_, index) => ({ index, promptBytes }));
    expect(selectSummaryBatch(units(20, 100))).toHaveLength(12);
    expect(selectSummaryBatch(units(5, 10_000))).toHaveLength(3);
    expect(selectSummaryBatch(units(2, 50_000))).toHaveLength(1);
  });

  it("picks the same owner project for a repository on every run", () => {
    const projects = [ProjectId.make("p-b"), ProjectId.make("p-a"), ProjectId.make("p-c")].map(
      (id) => ({ id }),
    );
    expect(ownerProject(projects)?.id).toBe("p-a");
    expect(ownerProject([])).toBeNull();
  });
});
