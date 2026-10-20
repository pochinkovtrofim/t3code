import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectChangelogEntryId,
  ProjectId,
  ThreadId,
  type ProjectChangelogEntry,
  type ProjectChangelogPage,
  type ProjectChangelogProduction,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canShowProjectChangelog,
  describeChangelogEntry,
  describeChangelogPage,
  type ChangelogClock,
} from "./projectChangelogPanel.logic";

const NOW = "2026-10-20T12:00:00.000Z";
const clock: ChangelogClock = { nowMs: Date.parse(NOW), timestampFormat: "locale" };
const projectId = ProjectId.make("acme");
const hoursAgo = (hours: number) => new Date(clock.nowMs - hours * 3_600_000).toISOString();

function page(overrides: Partial<ProjectChangelogPage> = {}): ProjectChangelogPage {
  return {
    projectId,
    availability: "ready",
    repository: {
      displayName: "example/acme",
      url: "https://github.com/example/acme",
      defaultBranch: "main",
    },
    sync: { lastSyncedAt: hoursAgo(0.1), problem: null, syncing: false },
    production: production(),
    entries: [entry()],
    nextCursor: null,
    ...overrides,
  };
}

function production(
  overrides: Partial<ProjectChangelogProduction> = {},
): ProjectChangelogProduction {
  return {
    source: "deployment",
    label: "production",
    sha: "3f2a1c9d0e8b7a6f",
    at: hoursAgo(2),
    url: "https://github.com/example/acme/deployments/production",
    stale: false,
    ...overrides,
  };
}

function entry(overrides: Partial<ProjectChangelogEntry> = {}): ProjectChangelogEntry {
  return {
    id: ProjectChangelogEntryId.make("pr:142"),
    kind: "pull-request",
    title: "Export reports as CSV",
    summary: "Reports can be exported as CSV from the reports page.",
    category: "feature",
    summaryState: "ready",
    landedAt: hoursAgo(1),
    inProduction: false,
    pullRequest: {
      repository: "example/acme",
      number: 142,
      url: "https://github.com/example/acme/pull/142",
      title: "feat: csv export",
      author: "octocat",
    },
    commits: {
      count: 3,
      headSha: "9b1e07a5c4d3",
      url: "https://github.com/example/acme/commit/9b1e07a5c4d3",
    },
    authors: ["octocat"],
    threads: [],
    ...overrides,
  };
}

describe("describeChangelogPage", () => {
  it("explains each availability that keeps no changelog, with no sync or production line", () => {
    for (const availability of ["disabled", "no-repository", "not-github"] as const) {
      const view = describeChangelogPage(
        page({ availability, repository: null, production: null, entries: [] }),
        clock,
      );
      expect(view.sync).toBeNull();
      expect(view.production).toBeNull();
      expect(view.empty?.title).toBeTruthy();
    }
    expect(
      describeChangelogPage(page({ availability: "disabled" }), clock).empty?.description,
    ).toContain("Project threads are off");
    expect(
      describeChangelogPage(page({ availability: "not-github" }), clock).empty?.description,
    ).toContain("not on GitHub");
  });

  it("shows when a ready changelog was last read and lists its entries", () => {
    const view = describeChangelogPage(page(), clock);
    expect(view.empty).toBeNull();
    expect(view.sync).toEqual({ tone: "muted", text: "Updated 6m ago." });
  });

  it("says a later read is running without hiding when the last one finished", () => {
    const view = describeChangelogPage(
      page({ sync: { lastSyncedAt: hoursAgo(0.1), problem: null, syncing: true } }),
      clock,
    );
    expect(view.sync?.text).toBe("Updated 6m ago, checking GitHub now.");
  });

  it("tells a first read in progress from one that has not started, with no empty notice yet", () => {
    const firstRead = (syncing: boolean) =>
      describeChangelogPage(
        page({
          sync: { lastSyncedAt: null, problem: null, syncing },
          production: null,
          entries: [],
        }),
        clock,
      );
    expect(firstRead(true).sync?.text).toBe("Reading the repository on GitHub for the first time.");
    expect(firstRead(false).sync?.text).toBe("Waiting for the first read of GitHub.");
    expect(firstRead(true).empty).toBeNull();
    expect(firstRead(true).production).toBeNull();
  });

  it("says nothing has landed once a read finished with no entries", () => {
    const view = describeChangelogPage(page({ entries: [] }), clock);
    expect(view.empty).toEqual({
      title: "Nothing has landed yet",
      description: "No pull requests or pushes on main yet.",
    });
  });

  it("names the fix for sign-in and missing repository problems", () => {
    const problem = (reason: "credentials" | "not-found") =>
      describeChangelogPage(
        page({ sync: { lastSyncedAt: null, problem: { reason, retryAt: null }, syncing: false } }),
        clock,
      ).sync;
    expect(problem("credentials")).toEqual({
      tone: "warning",
      text: "GitHub sign-in is missing or no longer works on this environment. Connect GitHub in Settings → Source Control.",
    });
    expect(problem("not-found")?.text).toBe(
      "GitHub cannot find example/acme with this environment's GitHub sign-in.",
    );
  });

  it("says when a rate-limited or unreachable read tries again", () => {
    const problem = (
      reason: "rate-limited" | "unreachable",
      retryAt: string | null,
      lastSyncedAt: string | null = null,
    ) =>
      describeChangelogPage(
        page({ sync: { lastSyncedAt, problem: { reason, retryAt }, syncing: false } }),
        clock,
      ).sync?.text;

    expect(problem("rate-limited", hoursAgo(-0.5))).toMatch(
      /^GitHub's rate limit was reached\. T3 Code tries again at \S.*\.$/,
    );
    expect(problem("rate-limited", hoursAgo(-30))).toMatch(/T3 Code tries again tomorrow at \S/);
    expect(problem("rate-limited", hoursAgo(1))).toBe(
      "GitHub's rate limit was reached. T3 Code is trying again now.",
    );
    expect(problem("unreachable", null)).toBe(
      "Could not reach GitHub. T3 Code tries again automatically.",
    );
    expect(problem("unreachable", null, hoursAgo(3))).toBe(
      "Could not reach GitHub. T3 Code tries again automatically. Showing what was read 3h ago.",
    );
  });

  it("describes production from a deployment, a release or a tag", () => {
    expect(describeChangelogPage(page(), clock).production).toEqual({
      tone: "muted",
      text: "Production = deployment production at 3f2a1c9, 2h ago. Detected automatically.",
      url: "https://github.com/example/acme/deployments/production",
    });
    expect(
      describeChangelogPage(
        page({ production: production({ source: "release", label: "v1.4.0", at: hoursAgo(26) }) }),
        clock,
      ).production?.text,
    ).toBe("Production = release v1.4.0 at 3f2a1c9, 1d ago. Detected automatically.");
    expect(
      describeChangelogPage(
        page({ production: production({ source: "tag", label: "v1.3.9", at: null, url: null }) }),
        clock,
      ).production,
    ).toEqual({
      tone: "muted",
      text: "Production = tag v1.3.9 at 3f2a1c9. Detected automatically.",
      url: null,
    });
  });

  it("explains the default-branch fallback", () => {
    expect(
      describeChangelogPage(
        page({
          production: production({
            source: "default-branch",
            label: null,
            sha: null,
            at: null,
            url: null,
          }),
        }),
        clock,
      ).production?.text,
    ).toBe(
      "No deployments, releases or tags found, so everything merged to main counts as in production.",
    );
  });

  it("warns that a stale production answer may be out of date", () => {
    const line = describeChangelogPage(
      page({ production: production({ stale: true }) }),
      clock,
    ).production;
    expect(line?.tone).toBe("warning");
    expect(line?.text).toBe(
      "Production = deployment production at 3f2a1c9, 2h ago. Detected automatically. Production could not be checked on the last read, so this may be out of date.",
    );
  });

  it("says production is unknown after a read that found none", () => {
    expect(describeChangelogPage(page({ production: null }), clock).production).toEqual({
      tone: "muted",
      text: "Production not detected yet.",
      url: null,
    });
  });
});

describe("describeChangelogEntry", () => {
  it("shows a summarized pull request that is merged but not in production", () => {
    expect(describeChangelogEntry(entry(), page())).toEqual({
      title: "Export reports as CSV",
      summary: "Reports can be exported as CSV from the reports page.",
      hint: null,
      badge: { label: "Merged, not in prod", variant: "warning" },
      source: { label: "PR #142", url: "https://github.com/example/acme/pull/142" },
      threads: [],
    });
  });

  it("marks entries in production", () => {
    expect(describeChangelogEntry(entry({ inProduction: true }), page()).badge).toEqual({
      label: "In production",
      variant: "success",
    });
  });

  it("claims nothing about production when production is unknown", () => {
    expect(
      describeChangelogEntry(entry({ inProduction: false }), page({ production: null })).badge,
    ).toEqual({ label: "Merged", variant: "outline" });
  });

  it("shows the fallback title with a summarizing hint while the summary is pending", () => {
    const view = describeChangelogEntry(
      entry({ title: "feat: csv export", summary: null, summaryState: "pending" }),
      page(),
    );
    expect(view).toMatchObject({ title: "feat: csv export", summary: null, hint: "Summarizing" });
  });

  it("keeps the fallback title for good when the summary is unavailable", () => {
    const view = describeChangelogEntry(
      entry({ title: "feat: csv export", summary: "stale", summaryState: "unavailable" }),
      page(),
    );
    expect(view).toMatchObject({
      title: "feat: csv export",
      summary: null,
      hint: "Summary unavailable",
    });
  });

  it("names a parent repository's pull request in full", () => {
    const pullRequest = entry().pullRequest!;
    expect(
      describeChangelogEntry(
        entry({ pullRequest: { ...pullRequest, repository: "upstream/acme", number: 77 } }),
        page(),
      ).source.label,
    ).toBe("upstream/acme#77");
  });

  it("links a direct push by its short commit sha", () => {
    const push = (count: number) =>
      describeChangelogEntry(
        entry({
          kind: "direct-push",
          pullRequest: null,
          commits: { ...entry().commits, count },
        }),
        page(),
      ).source;
    expect(push(1)).toEqual({
      label: "commit 9b1e07a",
      url: "https://github.com/example/acme/commit/9b1e07a5c4d3",
    });
    expect(push(3).label).toBe("3 commits, last 9b1e07a");
  });

  it("links the T3 threads that did the work", () => {
    const threads = describeChangelogEntry(
      entry({
        threads: [
          { threadId: ThreadId.make("thread-1"), projectId, title: "CSV export" },
          { threadId: ThreadId.make("thread-2"), projectId, title: "  " },
        ],
      }),
      page(),
    ).threads;
    expect(threads).toEqual([
      { threadId: "thread-1", title: "CSV export" },
      { threadId: "thread-2", title: "Untitled thread" },
    ]);
  });
});

describe("canShowProjectChangelog", () => {
  const config = (capabilities: { projectThreads?: boolean; projectChangelog?: boolean }) =>
    ({
      environment: { capabilities },
      settings: DEFAULT_SERVER_SETTINGS,
    }) as unknown as EnvironmentServerConfig;
  const projectThread = { id: ThreadId.make("project-thread:abc"), projectId };

  it("needs a live project thread on an environment that serves the changelog", () => {
    expect(
      canShowProjectChangelog(
        config({ projectThreads: true, projectChangelog: true }),
        projectThread,
      ),
    ).toBe(true);
    expect(canShowProjectChangelog(config({ projectThreads: true }), projectThread)).toBe(false);
    expect(
      canShowProjectChangelog(config({ projectThreads: true, projectChangelog: true }), {
        id: ThreadId.make("ordinary"),
        projectId,
      }),
    ).toBe(false);
  });
});
