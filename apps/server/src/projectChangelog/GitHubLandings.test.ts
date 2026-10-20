import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import { type GitHubRepository, repositoryKeyOf } from "./changelogModel.ts";
import * as GitHubLandings from "./GitHubLandings.ts";
// Trimmed answers recorded from api.github.com for pochinkovtrofim/t3code and its parent
// pingdotgg/t3code on 2026-10-20.
import shapes from "./testFixtures/gitHubShapes.json" with { type: "json" };

const NOW = Date.parse("2026-10-20T10:00:00Z");

const fork: GitHubRepository = {
  key: repositoryKeyOf("github.com", "pochinkovtrofim/t3code"),
  host: "github.com",
  owner: "pochinkovtrofim",
  name: "t3code",
  webUrl: "https://github.com/pochinkovtrofim/t3code",
};
const upstream: GitHubRepository = {
  key: repositoryKeyOf("github.com", "pingdotgg/t3code"),
  host: "github.com",
  owner: "pingdotgg",
  name: "t3code",
  webUrl: "https://github.com/pingdotgg/t3code",
};

type Reply = { readonly status?: number; readonly body?: unknown; readonly headers?: object };

/**
 * A fake api.github.com keyed by path and query. Every 200 carries an ETag derived from the
 * path, and a request revalidating that ETag gets a bodiless 304, as GitHub answers.
 */
function harness(routes: Record<string, Reply | (() => Reply)>) {
  const requests: Array<{ readonly url: string; readonly headers: Record<string, string> }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      const url = new URL(request.url);
      const route = `${url.pathname.replace(/^\//, "")}${url.search}`;
      requests.push({ url: route, headers: request.headers });
      const found = routes[route];
      const reply = typeof found === "function" ? found() : found;
      const etag = `"${route}"`;
      const response =
        reply === undefined
          ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
          : (reply.status ?? 200) === 200 && request.headers["if-none-match"] === etag
            ? new Response(null, { status: 304, headers: { etag } })
            : new Response(
                typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? null),
                { status: reply.status ?? 200, headers: { etag, ...reply.headers } },
              );
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    }),
  );
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.succeed({
          host,
          token: Redacted.make("test-token"),
          source: "gh" as const,
          fingerprint: `${host}:test`,
        }),
      invalidate: () => Effect.void,
    }),
  );
  const layer = GitHubLandings.layer.pipe(
    Layer.provide(GitHubRest.layer),
    Layer.provide(Layer.mergeAll(credentials, http)),
    Layer.provide(GitHubQuota.layer),
    Layer.provide(SourceControlRateLimit.layer),
  );
  return { layer, requests };
}

const forkPath = (rest: string) => `repos/pochinkovtrofim/t3code${rest}`;
const upstreamPath = (rest: string) => `repos/pingdotgg/t3code${rest}`;
const [headSha, middleSha, oldestSha] = shapes.commits.map((commit) => commit.sha) as [
  string,
  string,
  string,
];

const previewDeployments = Array.from({ length: 30 }, (_, index) => ({
  ...shapes.deployments[0]!,
  id: index + 1,
  environment: `pr-${index + 1}`,
  transient_environment: true,
}));

const environmentList = (names: ReadonlyArray<string>) => ({
  total_count: names.length,
  environments: names.map((name, index) => ({ id: index + 1, name })),
});

const forkRoutes = {
  [forkPath("")]: { body: shapes.repository },
  [forkPath("/commits/main")]: { body: shapes.headSha },
  [forkPath(`/commits?sha=${headSha}&per_page=100&page=1&since=2026-09-20T10:00:00.000Z`)]: {
    body: shapes.commits,
  },
  [forkPath(`/commits?sha=${headSha}&per_page=100&page=1`)]: { body: shapes.commits },
  [forkPath(`/commits/${headSha}/pulls`)]: { body: shapes.commitPulls },
  [forkPath(`/commits/${middleSha}/pulls`)]: { status: 422, body: { message: "No commit found" } },
};

describe("GitHubLandings", () => {
  it.effect("reads a fork's head, then revalidates it for two 304s", () => {
    const { layer, requests } = harness(forkRoutes);
    return Effect.gen(function* () {
      const landings = yield* GitHubLandings.GitHubLandings;
      const first = yield* landings.readHead(fork);
      assert.deepStrictEqual(first, { defaultBranch: "main", headSha });
      const second = yield* landings.readHead(fork);
      assert.deepStrictEqual(second, first);
      assert.deepStrictEqual(
        requests.map((request) => request.headers["if-none-match"] ?? null),
        [null, null, `"${forkPath("")}"`, `"${forkPath("/commits/main")}"`],
      );
      assert.strictEqual(requests[1]!.headers["accept"], "application/vnd.github.sha");
    }).pipe(Effect.provide(layer));
  });

  it.effect("walks the first-parent chain oldest first, back to the window or the cursor", () => {
    const { layer } = harness(forkRoutes);
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const landings = yield* GitHubLandings.GitHubLandings;
      const cold = yield* landings.readHistory({
        repository: fork,
        headSha,
        stopAtSha: null,
        since: NOW - 30 * 24 * 60 * 60_000,
        maxCommits: 500,
      });
      assert.deepStrictEqual(
        cold.chain.map((commit) => commit.sha),
        [oldestSha, middleSha, headSha],
      );
      assert.isFalse(cold.reachedCursor);
      assert.deepStrictEqual(cold.chain[2], {
        sha: headSha,
        parentShas: [middleSha],
        subject:
          "feat(web,server): add a project to another machine from Run on, .env files included (#22180)",
        authorKey: "t3dotgg",
        authorDisplay: "t3dotgg",
        committedAt: Date.parse("2026-10-20T07:33:13Z"),
      });

      const warm = yield* landings.readHistory({
        repository: fork,
        headSha,
        stopAtSha: oldestSha,
        since: null,
        maxCommits: 500,
      });
      assert.deepStrictEqual(
        warm.chain.map((commit) => commit.sha),
        [middleSha, headSha],
      );
      assert.isTrue(warm.reachedCursor);
    }).pipe(Effect.provide(layer));
  });

  it.effect("cuts unbounded repository text and skips a blank author name", () => {
    const head = shapes.commits[0]!;
    const { layer } = harness({
      [forkPath(`/commits?sha=${headSha}&per_page=100&page=1`)]: {
        body: [
          {
            ...head,
            author: null,
            commit: {
              ...head.commit,
              message: `${"x".repeat(1_000_000)}\n\nBody`,
              author: { name: " ", email: "dev@example.com", date: head.commit.author.date },
            },
          },
        ],
      },
      [upstreamPath(
        "/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=1",
      )]: { body: [{ ...shapes.closedPulls[0]!, title: "t".repeat(100_000) }] },
    });
    return Effect.gen(function* () {
      const landings = yield* GitHubLandings.GitHubLandings;
      const { chain } = yield* landings.readHistory({
        repository: fork,
        headSha,
        stopAtSha: null,
        since: null,
        maxCommits: 10,
      });
      const [commit] = chain;
      assert.strictEqual(commit?.subject.length, 200);
      assert.strictEqual(commit?.authorDisplay, "dev@example.com");
      assert.strictEqual(commit?.authorKey, "dev@example.com");
      const {
        pullRequests: [pull],
      } = yield* landings.readMergedPulls({
        repository: upstream,
        defaultBranch: "main",
        since: NOW,
      });
      assert.strictEqual(pull?.title.length, 256);
    }).pipe(Effect.provide(layer));
  });

  it.effect("finds the parent's pull request for a fork's commit", () => {
    const { layer } = harness(forkRoutes);
    return Effect.gen(function* () {
      const landings = yield* GitHubLandings.GitHubLandings;
      const lookups = yield* landings.lookupCommitPulls({
        repository: fork,
        shas: [headSha, middleSha],
      });
      const answered = lookups.get(headSha);
      assert(answered?._tag === "Answered");
      const [pull] = answered.pullRequests;
      assert.strictEqual(pull?.number, 22180);
      assert.strictEqual(pull?.repository, "pingdotgg/t3code");
      assert.strictEqual(pull?.baseRef, "main");
      assert.strictEqual(pull?.headRef, "t3/clone-repo-to-other-machine");
      assert.strictEqual(pull?.mergeCommitSha, headSha);
      assert.isAtMost(pull?.bodyExcerpt.length ?? 0, 1_500);
      // GitHub refused the question about this commit: one spent attempt, not a failed sync.
      assert.deepStrictEqual(lookups.get(middleSha), { _tag: "Failed" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves a commit unasked when the lookup hit the rate limit", () => {
    const { layer } = harness({
      [forkPath(`/commits/${headSha}/pulls`)]: {
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 600) },
      },
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const landings = yield* GitHubLandings.GitHubLandings;
      const lookups = yield* landings.lookupCommitPulls({ repository: fork, shas: [headSha] });
      assert.strictEqual(lookups.size, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps only merged pull requests and maps them to the base repository", () => {
    const closed = [
      ...shapes.closedPulls,
      { ...shapes.closedPulls[0]!, number: 1, merged_at: null, merge_commit_sha: null },
    ];
    const { layer } = harness({
      [upstreamPath(
        "/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=1",
      )]: { body: closed },
    });
    return Effect.gen(function* () {
      const landings = yield* GitHubLandings.GitHubLandings;
      const merged = yield* landings.readMergedPulls({
        repository: upstream,
        defaultBranch: "main",
        since: NOW,
      });
      assert.isNull(merged.incompleteBefore);
      assert.deepStrictEqual(
        merged.pullRequests.map((pull) => [pull.number, pull.repository, pull.mergeCommitSha]),
        shapes.closedPulls.map((pull) => [pull.number, "pingdotgg/t3code", pull.merge_commit_sha]),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("says how far back the merged list reaches when its page budget runs out", () => {
    const [template] = shapes.closedPulls;
    const pageOf = (page: number) =>
      Array.from({ length: 100 }, (_, index) => {
        const age = (page - 1) * 100 + index;
        return {
          ...template!,
          number: 1_000 + age,
          updated_at: DateTime.formatIso(DateTime.makeUnsafe(NOW - age * 60_000)),
        };
      });
    const pulls = (page: number) =>
      upstreamPath(
        `/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}`,
      );
    const { layer } = harness({
      [pulls(1)]: { body: pageOf(1) },
      [pulls(2)]: { body: pageOf(2) },
      [pulls(3)]: { body: pageOf(3) },
    });
    return Effect.gen(function* () {
      const landings = yield* GitHubLandings.GitHubLandings;
      const merged = yield* landings.readMergedPulls({
        repository: upstream,
        defaultBranch: "main",
        since: NOW - 30 * 24 * 60 * 60_000,
      });
      assert.strictEqual(merged.pullRequests.length, 300);
      assert.strictEqual(merged.incompleteBefore, NOW - 299 * 60_000);
    }).pipe(Effect.provide(layer));
  });

  it.effect("takes production from a successful deployment named production", () => {
    const { layer, requests } = harness({
      [upstreamPath("/deployments?per_page=30")]: { body: shapes.deployments },
      [upstreamPath("/deployments?environment=production&per_page=5")]: {
        body: shapes.deployments,
      },
      [upstreamPath("/deployments?environment=Production&per_page=5")]: { body: [] },
      [upstreamPath(`/deployments/${shapes.deployments[0]!.id}/statuses?per_page=1`)]: {
        body: shapes.deploymentStatuses,
      },
    });
    return Effect.gen(function* () {
      const landings = yield* GitHubLandings.GitHubLandings;
      const production = yield* landings.readProduction({
        repository: upstream,
        previousEnvironment: null,
      });
      // GitHub reports production_environment false for this repository; the name decides.
      assert.deepStrictEqual(production, {
        deployment: {
          _tag: "Found",
          value: {
            source: "deployment",
            environment: "production",
            deploymentId: shapes.deployments[0]!.id,
            sha: shapes.deployments[0]!.sha,
            at: Date.parse(shapes.deploymentStatuses[0]!.created_at),
            url: null,
          },
        },
        release: { _tag: "NotAsked" },
        tag: { _tag: "NotAsked" },
      });
      assert.isFalse(requests.some((request) => request.url.includes("releases")));
    }).pipe(Effect.provide(layer));
  });

  it.effect("finds production behind a page of preview deployments", () => {
    const [deployed] = shapes.deployments;
    const { layer } = harness({
      [upstreamPath("/deployments?per_page=30")]: { body: previewDeployments },
      [upstreamPath("/deployments?environment=production&per_page=5")]: { body: [deployed] },
      [upstreamPath("/deployments?environment=Production&per_page=5")]: { body: [] },
      [upstreamPath(`/deployments/${deployed!.id}/statuses?per_page=1`)]: {
        body: shapes.deploymentStatuses,
      },
    });
    return Effect.gen(function* () {
      const landings = yield* GitHubLandings.GitHubLandings;
      const { deployment } = yield* landings.readProduction({
        repository: upstream,
        previousEnvironment: null,
      });
      assert(deployment._tag === "Found");
      assert.strictEqual(deployment.value.deploymentId, deployed!.id);
    }).pipe(Effect.provide(layer));
  });

  it.effect("finds a production environment the first time, behind a page of previews", () => {
    const [deployed] = shapes.deployments;
    const { layer } = harness({
      [upstreamPath("/environments?per_page=100")]: {
        body: environmentList(["prod-eu", ...previewDeployments.map((p) => p.environment)]),
      },
      [upstreamPath("/deployments?per_page=30")]: { body: previewDeployments },
      [upstreamPath("/deployments?environment=prod-eu&per_page=5")]: {
        body: [{ ...deployed!, environment: "prod-eu" }],
      },
      [upstreamPath(`/deployments/${deployed!.id}/statuses?per_page=1`)]: {
        body: shapes.deploymentStatuses,
      },
    });
    return Effect.gen(function* () {
      const landings = yield* GitHubLandings.GitHubLandings;
      const { deployment } = yield* landings.readProduction({
        repository: upstream,
        previousEnvironment: null,
      });
      assert(deployment._tag === "Found");
      assert.strictEqual(deployment.value.environment, "prod-eu");
    }).pipe(Effect.provide(layer));
  });

  it.effect("takes a newer production deployment over last sync's environment", () => {
    const [deployed] = shapes.deployments;
    const [status] = shapes.deploymentStatuses;
    const { layer } = harness({
      [upstreamPath("/environments?per_page=100")]: {
        body: environmentList(["prod-eu", "prod-us"]),
      },
      [upstreamPath("/deployments?per_page=30")]: { body: [] },
      [upstreamPath("/deployments?environment=prod-eu&per_page=5")]: {
        body: [{ ...deployed!, id: 1, sha: "a".repeat(40), environment: "prod-eu" }],
      },
      [upstreamPath("/deployments?environment=prod-us&per_page=5")]: {
        body: [{ ...deployed!, id: 2, sha: "b".repeat(40), environment: "prod-us" }],
      },
      [upstreamPath("/deployments/1/statuses?per_page=1")]: {
        body: [{ ...status!, created_at: "2026-10-20T08:00:00Z" }],
      },
      [upstreamPath("/deployments/2/statuses?per_page=1")]: {
        body: [{ ...status!, created_at: "2026-10-20T09:00:00Z" }],
      },
    });
    return Effect.gen(function* () {
      const landings = yield* GitHubLandings.GitHubLandings;
      const { deployment } = yield* landings.readProduction({
        repository: upstream,
        previousEnvironment: "prod-eu",
      });
      assert(deployment._tag === "Found");
      assert.deepStrictEqual(
        [deployment.value.environment, deployment.value.sha],
        ["prod-us", "b".repeat(40)],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([403, 500])(
    "never calls production absent when the environment list answers %s",
    (status) => {
      const { layer } = harness({
        [upstreamPath("/environments?per_page=100")]: {
          status,
          body: { message: "Resource not accessible by integration" },
        },
        [upstreamPath("/deployments?per_page=30")]: { body: previewDeployments },
        [upstreamPath("/deployments?environment=production&per_page=5")]: { body: [] },
        [upstreamPath("/deployments?environment=Production&per_page=5")]: { body: [] },
        [upstreamPath("/releases?per_page=1")]: { body: [] },
        [upstreamPath("/tags?per_page=100")]: { body: [] },
      });
      return Effect.gen(function* () {
        const landings = yield* GitHubLandings.GitHubLandings;
        const { deployment } = yield* landings.readProduction({
          repository: upstream,
          previousEnvironment: null,
        });
        assert.deepStrictEqual(deployment, { _tag: "Unavailable" });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("asks last sync's environment first, and never calls it absent unproven", () => {
    const [deployed] = shapes.deployments;
    const { layer, requests } = harness({
      [upstreamPath("/deployments?environment=prod-eu&per_page=5")]: {
        body: [{ ...deployed!, environment: "prod-eu" }],
      },
      [upstreamPath(`/deployments/${deployed!.id}/statuses?per_page=1`)]: {
        body: [{ ...shapes.deploymentStatuses[0]!, state: "in_progress" }],
      },
      [upstreamPath("/deployments?per_page=30")]: { body: previewDeployments },
      [upstreamPath("/deployments?environment=production&per_page=5")]: { body: [] },
      [upstreamPath("/deployments?environment=Production&per_page=5")]: { body: [] },
      [upstreamPath("/releases?per_page=1")]: { body: [] },
      [upstreamPath("/tags?per_page=100")]: { body: [] },
    });
    return Effect.gen(function* () {
      const landings = yield* GitHubLandings.GitHubLandings;
      const production = yield* landings.readProduction({
        repository: upstream,
        previousEnvironment: "prod-eu",
      });
      assert.deepStrictEqual(production.deployment, { _tag: "Unavailable" });
      assert.strictEqual(
        requests.find((request) => request.url.includes("environment="))?.url,
        upstreamPath("/deployments?environment=prod-eu&per_page=5"),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls to the latest release when every deployment is transient", () => {
    const releaseSha = "81493efb71e8e8244f95d3e9f71d8369654ab151";
    const { layer } = harness({
      [upstreamPath("/deployments?per_page=30")]: {
        body: shapes.deployments.map((deployment) => ({
          ...deployment,
          transient_environment: true,
        })),
      },
      [upstreamPath("/deployments?environment=production&per_page=5")]: { body: [] },
      [upstreamPath("/deployments?environment=Production&per_page=5")]: { body: [] },
      [upstreamPath("/releases?per_page=1")]: { body: [shapes.releaseLatest] },
      [upstreamPath("/releases/latest")]: { body: shapes.releaseLatest },
      [upstreamPath("/commits/v0.1.0")]: { body: releaseSha },
    });
    return Effect.gen(function* () {
      const landings = yield* GitHubLandings.GitHubLandings;
      const production = yield* landings.readProduction({
        repository: upstream,
        previousEnvironment: null,
      });
      assert.deepStrictEqual(production, {
        deployment: { _tag: "Absent" },
        release: {
          _tag: "Found",
          value: {
            source: "release",
            tag: "v0.1.0",
            sha: releaseSha,
            at: Date.parse(shapes.releaseLatest.published_at),
            url: shapes.releaseLatest.html_url,
          },
        },
        tag: { _tag: "NotAsked" },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports an unreadable source as unavailable and a missing release as absent", () => {
    const { layer } = harness({
      [upstreamPath("/deployments?per_page=30")]: {
        status: 403,
        body: { message: "Resource not accessible by integration" },
      },
      [upstreamPath("/tags?per_page=100")]: { body: shapes.tags },
    });
    return Effect.gen(function* () {
      const landings = yield* GitHubLandings.GitHubLandings;
      const production = yield* landings.readProduction({
        repository: upstream,
        previousEnvironment: null,
      });
      assert.deepStrictEqual(production, {
        deployment: { _tag: "Unavailable" },
        release: { _tag: "Absent" },
        tag: {
          _tag: "Found",
          value: {
            source: "tag",
            tag: "v0.1.1-preview.20261019.3339",
            sha: shapes.tags[0]!.commit.sha,
          },
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "revalidates a repository's lack of releases instead of reading a 404 each sync",
    () => {
      const { layer, requests } = harness({
        [upstreamPath("/environments?per_page=100")]: { body: environmentList([]) },
        [upstreamPath("/deployments?per_page=30")]: { body: [] },
        [upstreamPath("/releases?per_page=1")]: { body: [] },
        [upstreamPath("/tags?per_page=100")]: { body: shapes.tags },
      });
      return Effect.gen(function* () {
        const landings = yield* GitHubLandings.GitHubLandings;
        const first = yield* landings.readProduction({
          repository: upstream,
          previousEnvironment: null,
        });
        const second = yield* landings.readProduction({
          repository: upstream,
          previousEnvironment: null,
        });
        assert.deepStrictEqual(first.release, { _tag: "Absent" });
        assert.deepStrictEqual(second, first);
        const releaseReads = requests.filter((request) => request.url.includes("releases"));
        assert.deepStrictEqual(
          releaseReads.map((request) => [request.url, request.headers["if-none-match"] ?? null]),
          [
            [upstreamPath("/releases?per_page=1"), null],
            [upstreamPath("/releases?per_page=1"), `"${upstreamPath("/releases?per_page=1")}"`],
          ],
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("asks for the latest release of a prerelease-only repository once an hour", () => {
    const { layer, requests } = harness({
      [upstreamPath("/environments?per_page=100")]: { body: environmentList([]) },
      [upstreamPath("/deployments?per_page=30")]: { body: [] },
      [upstreamPath("/releases?per_page=1")]: {
        body: [{ ...shapes.releaseLatest, prerelease: true }],
      },
      [upstreamPath("/tags?per_page=100")]: { body: shapes.tags },
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const landings = yield* GitHubLandings.GitHubLandings;
      const sync = landings.readProduction({ repository: upstream, previousEnvironment: null });
      const latestReads = () =>
        requests.filter((request) => request.url === upstreamPath("/releases/latest")).length;

      assert.deepStrictEqual((yield* sync).release, { _tag: "Absent" });
      yield* TestClock.adjust(59 * 60_000);
      assert.deepStrictEqual((yield* sync).release, { _tag: "Absent" });
      assert.strictEqual(latestReads(), 1);

      yield* TestClock.adjust(60_000);
      assert.deepStrictEqual((yield* sync).release, { _tag: "Absent" });
      assert.strictEqual(latestReads(), 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("says whether the head still contains the cursor", () => {
    const compareAt = (base: string, head: string) =>
      forkPath(`/compare/${base}...${head}?per_page=1&page=2`);
    const { layer } = harness({
      [compareAt(oldestSha, headSha)]: { body: { ...shapes.compare, status: "ahead" } },
      [compareAt(middleSha, headSha)]: { body: shapes.compare },
    });
    return Effect.gen(function* () {
      const landings = yield* GitHubLandings.GitHubLandings;
      const contains = (sha: string) => landings.headContains({ repository: fork, sha, headSha });
      assert.isTrue(yield* contains(oldestSha));
      assert.isFalse(yield* contains(middleSha));
      assert.isFalse(yield* contains("0".repeat(40)));
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads the merge base from a comparison", () => {
    const { layer } = harness({
      [forkPath(`/compare/${oldestSha}...${headSha}?per_page=1&page=2`)]: { body: shapes.compare },
    });
    return Effect.gen(function* () {
      const landings = yield* GitHubLandings.GitHubLandings;
      const base = yield* landings.mergeBase({ repository: fork, sha: oldestSha, headSha });
      assert.strictEqual(base, shapes.compare.merge_base_commit.sha);
      const unrelated = yield* landings.mergeBase({
        repository: fork,
        sha: headSha,
        headSha: oldestSha,
      });
      assert.isNull(unrelated);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never spends the reserve, even for a caller marked interactive", () => {
    const reset = String(Math.floor(NOW / 1000) + 600);
    const { layer, requests } = harness({
      [forkPath("")]: {
        body: shapes.repository,
        headers: {
          "x-ratelimit-resource": "core",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "499",
          "x-ratelimit-reset": reset,
        },
      },
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const landings = yield* GitHubLandings.GitHubLandings;
      // The repository read reports the quota down in the reserve, so the head read is refused.
      const background = yield* Effect.flip(landings.readHead(fork));
      assert.strictEqual(background._tag, "SourceControlRateLimitPausedError");
      const interactive = yield* Effect.flip(
        landings
          .readHead(fork)
          .pipe(Effect.provideService(SourceControlRateLimit.Interactive, true)),
      );
      assert.strictEqual(interactive._tag, "SourceControlRateLimitPausedError");
      assert.strictEqual(requests.length, 1);
    }).pipe(Effect.provide(layer));
  });
});
