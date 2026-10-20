import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import type {
  ProjectChangelogEntry,
  ProjectChangelogPage,
  ProjectChangelogSyncProblem,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { formatRelativeTimeLabel, formatUpcomingTimestamp } from "../../timestampFormat";
import { isActiveProjectThread } from "../sidebar/projectGroups.logic";

export function canShowProjectChangelog(
  config: EnvironmentServerConfig | undefined,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
): boolean {
  return (
    config?.environment.capabilities.projectChangelog === true &&
    isActiveProjectThread(config, thread)
  );
}

export interface ChangelogNotice {
  readonly title: string;
  readonly description: string;
}

export interface ChangelogStatusLine {
  readonly tone: "muted" | "warning";
  readonly text: string;
}

interface ChangelogProductionLine extends ChangelogStatusLine {
  readonly url: string | null;
}

interface ChangelogPageView {
  readonly empty: ChangelogNotice | null;
  readonly sync: ChangelogStatusLine | null;
  readonly production: ChangelogProductionLine | null;
}

export interface ChangelogClock {
  readonly nowMs: number;
  readonly timestampFormat: TimestampFormat;
}

const UNAVAILABLE_NOTICES: Record<
  Exclude<ProjectChangelogPage["availability"], "ready">,
  ChangelogNotice
> = {
  disabled: {
    title: "Changelog is off",
    description:
      "Project threads are off for this project, and T3 Code keeps a changelog only for projects that use them.",
  },
  "no-repository": {
    title: "No repository to read",
    description:
      "This project has no Git remote, so there is no history to build a changelog from.",
  },
  "not-github": {
    title: "Not a GitHub repository",
    description:
      "The changelog reads pull requests, releases and deployments from GitHub, and this project's remote is not on GitHub.",
  },
};

const shortSha = (sha: string) => sha.slice(0, 7);

function retrySentence(retryAt: string | null, clock: ChangelogClock): string {
  if (retryAt === null) return "T3 Code tries again automatically.";
  const retryMs = Date.parse(retryAt);
  if (!(retryMs > clock.nowMs)) return "T3 Code is trying again now.";
  const label = formatUpcomingTimestamp(retryAt, clock.timestampFormat, clock.nowMs);
  const sameDay = new Date(retryMs).toDateString() === new Date(clock.nowMs).toDateString();
  return `T3 Code tries again ${sameDay ? `at ${label}` : label}.`;
}

function problemText(
  problem: ProjectChangelogSyncProblem,
  repository: string,
  clock: ChangelogClock,
): string {
  switch (problem.reason) {
    case "credentials":
      return "GitHub sign-in is missing or no longer works on this environment. Connect GitHub in Settings → Source Control.";
    case "not-found":
      return `GitHub cannot find ${repository} with this environment's GitHub sign-in.`;
    case "rate-limited":
      return `GitHub's rate limit was reached. ${retrySentence(problem.retryAt, clock)}`;
    case "unreachable":
      return `Could not reach GitHub. ${retrySentence(problem.retryAt, clock)}`;
  }
}

function syncLine(page: ProjectChangelogPage, clock: ChangelogClock): ChangelogStatusLine {
  const { lastSyncedAt, problem, syncing } = page.sync;
  const updated = lastSyncedAt === null ? null : formatRelativeTimeLabel(lastSyncedAt, clock.nowMs);
  if (problem !== null) {
    const text = problemText(problem, page.repository?.displayName ?? "this repository", clock);
    return {
      tone: "warning",
      text: updated === null ? text : `${text} Showing what was read ${updated}.`,
    };
  }
  if (updated === null) {
    return {
      tone: "muted",
      text: syncing
        ? "Reading the repository on GitHub for the first time."
        : "Waiting for the first read of GitHub.",
    };
  }
  return { tone: "muted", text: `Updated ${updated}${syncing ? ", checking GitHub now" : ""}.` };
}

function productionLine(
  page: ProjectChangelogPage,
  clock: ChangelogClock,
): ChangelogProductionLine | null {
  const production = page.production;
  if (production === null) {
    return page.sync.lastSyncedAt === null
      ? null
      : { tone: "muted", text: "Production not detected yet.", url: null };
  }
  let text: string;
  if (production.source === "default-branch") {
    const branch = page.repository?.defaultBranch ?? "the default branch";
    text = `No deployments, releases or tags found, so everything merged to ${branch} counts as in production.`;
  } else {
    const at = production.sha === null ? "" : ` at ${shortSha(production.sha)}`;
    const when =
      production.at === null ? "" : `, ${formatRelativeTimeLabel(production.at, clock.nowMs)}`;
    const label = production.label === null ? "" : ` ${production.label}`;
    text = `Production = ${production.source}${label}${at}${when}. Detected automatically.`;
  }
  return production.stale
    ? {
        tone: "warning",
        text: `${text} Production could not be checked on the last read, so this may be out of date.`,
        url: production.url,
      }
    : { tone: "muted", text, url: production.url };
}

export function describeChangelogPage(
  page: ProjectChangelogPage,
  clock: ChangelogClock,
): ChangelogPageView {
  if (page.availability !== "ready") {
    return { empty: UNAVAILABLE_NOTICES[page.availability], sync: null, production: null };
  }
  const nothingLanded = page.entries.length === 0 && page.sync.lastSyncedAt !== null;
  return {
    empty: nothingLanded
      ? {
          title: "Nothing has landed yet",
          description: `No pull requests or pushes on ${page.repository?.defaultBranch ?? "the default branch"} yet.`,
        }
      : null,
    sync: syncLine(page, clock),
    production: productionLine(page, clock),
  };
}

interface ChangelogEntryView {
  readonly title: string;
  readonly summary: string | null;
  readonly hint: string | null;
  readonly badge: { readonly label: string; readonly variant: "success" | "warning" | "outline" };
  readonly source: { readonly label: string; readonly url: string };
  readonly threads: ReadonlyArray<{ readonly threadId: ThreadId; readonly title: string }>;
}

const SUMMARY_HINTS: Record<ProjectChangelogEntry["summaryState"], string | null> = {
  ready: null,
  pending: "Summarizing",
  unavailable: "Summary unavailable",
};

export function describeChangelogEntry(
  entry: ProjectChangelogEntry,
  page: Pick<ProjectChangelogPage, "production" | "repository">,
): ChangelogEntryView {
  const pullRequest = entry.pullRequest;
  return {
    title: entry.title,
    summary: entry.summaryState === "ready" ? entry.summary : null,
    hint: SUMMARY_HINTS[entry.summaryState],
    badge:
      page.production === null
        ? { label: "Merged", variant: "outline" }
        : entry.inProduction
          ? { label: "In production", variant: "success" }
          : { label: "Merged, not in prod", variant: "warning" },
    source:
      pullRequest !== null
        ? {
            label:
              pullRequest.repository === page.repository?.displayName
                ? `PR #${pullRequest.number}`
                : `${pullRequest.repository}#${pullRequest.number}`,
            url: pullRequest.url,
          }
        : {
            label:
              entry.commits.count === 1
                ? `commit ${shortSha(entry.commits.headSha)}`
                : `${entry.commits.count} commits, last ${shortSha(entry.commits.headSha)}`,
            url: entry.commits.url,
          },
    threads: entry.threads.map((thread) => ({
      threadId: thread.threadId,
      title: thread.title.trim() || "Untitled thread",
    })),
  };
}
