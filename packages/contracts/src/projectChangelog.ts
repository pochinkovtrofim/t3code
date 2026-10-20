import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * A per-project changelog of what landed on the project's GitHub default branch, in plain
 * English, with what is in production. Nothing here names ordinals, ETags or tables: those stay
 * behind the server's ProjectChangelog service. The RPCs, the MCP tool and the client share the
 * page shape.
 */

/** Opaque keyset cursor; clients pass it back and never parse it. */
export const ProjectChangelogCursor = TrimmedNonEmptyString.pipe(
  Schema.brand("ProjectChangelogCursor"),
);
export type ProjectChangelogCursor = typeof ProjectChangelogCursor.Type;

/** Stable across syncs: `pr:<number>`, `pr:<owner/name>#<number>` or `push:<first sha>`. */
export const ProjectChangelogEntryId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProjectChangelogEntryId"),
);
export type ProjectChangelogEntryId = typeof ProjectChangelogEntryId.Type;

export const ProjectChangelogCategory = Schema.Literals([
  "feature",
  "fix",
  "improvement",
  "maintenance",
]);
export type ProjectChangelogCategory = typeof ProjectChangelogCategory.Type;

export const ProjectChangelogEntry = Schema.Struct({
  id: ProjectChangelogEntryId,
  kind: Schema.Literals(["pull-request", "direct-push"]),
  /** The model's title once summarized; the PR title or first commit subject before. */
  title: TrimmedNonEmptyString,
  /** One to three plain-English sentences; null until summarized. */
  summary: Schema.NullOr(Schema.String),
  category: Schema.NullOr(ProjectChangelogCategory),
  /** `unavailable`: the model failed three times, so the title is the fallback for good. */
  summaryState: Schema.Literals(["pending", "ready", "unavailable"]),
  landedAt: IsoDateTime,
  inProduction: Schema.Boolean,
  pullRequest: Schema.NullOr(
    Schema.Struct({
      /** `owner/name`; a fork's entry can name its parent's pull request. */
      repository: TrimmedNonEmptyString,
      number: PositiveInt,
      url: TrimmedNonEmptyString,
      title: TrimmedNonEmptyString,
      author: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
  commits: Schema.Struct({
    count: PositiveInt,
    /** The newest commit of the entry on the default branch. */
    headSha: TrimmedNonEmptyString,
    url: TrimmedNonEmptyString,
  }),
  authors: Schema.Array(TrimmedNonEmptyString),
  /** T3 threads that did the work, matched by linked pull request or branch. */
  threads: Schema.Array(
    Schema.Struct({ threadId: ThreadId, projectId: ProjectId, title: Schema.String }),
  ),
});
export type ProjectChangelogEntry = typeof ProjectChangelogEntry.Type;

export const ProjectChangelogProduction = Schema.Struct({
  /** `default-branch`: the repository has no deployments, releases or tags. */
  source: Schema.Literals(["deployment", "release", "tag", "default-branch"]),
  /** The environment for a deployment, the tag for a release or tag. */
  label: Schema.NullOr(TrimmedNonEmptyString),
  sha: Schema.NullOr(TrimmedNonEmptyString),
  at: Schema.NullOr(IsoDateTime),
  url: Schema.NullOr(TrimmedNonEmptyString),
  /** The source could not be read on the last sync, so this is the previous answer. */
  stale: Schema.Boolean,
});
export type ProjectChangelogProduction = typeof ProjectChangelogProduction.Type;

export const ProjectChangelogSyncProblem = Schema.Struct({
  /** `internal`: the sync failed on a bug in this server, not on GitHub. */
  reason: Schema.Literals(["credentials", "not-found", "rate-limited", "unreachable", "internal"]),
  retryAt: Schema.NullOr(IsoDateTime),
});
export type ProjectChangelogSyncProblem = typeof ProjectChangelogSyncProblem.Type;

export const ProjectChangelogPage = Schema.Struct({
  projectId: ProjectId,
  /**
   * `disabled`: project threads are off for the project. `no-repository` / `not-github`:
   * nothing to read. Only `ready` has entries.
   */
  availability: Schema.Literals(["ready", "disabled", "no-repository", "not-github"]),
  repository: Schema.NullOr(
    Schema.Struct({
      displayName: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
      defaultBranch: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
  sync: Schema.Struct({
    /** Null until the first successful read of GitHub. */
    lastSyncedAt: Schema.NullOr(IsoDateTime),
    problem: Schema.NullOr(ProjectChangelogSyncProblem),
    /** A read of GitHub is running, so fresher entries may follow. */
    syncing: Schema.Boolean,
  }),
  production: Schema.NullOr(ProjectChangelogProduction),
  /** Newest landing first. */
  entries: Schema.Array(ProjectChangelogEntry),
  nextCursor: Schema.NullOr(ProjectChangelogCursor),
});
export type ProjectChangelogPage = typeof ProjectChangelogPage.Type;

export const PROJECT_CHANGELOG_MAX_PAGE = 50;
export const PROJECT_CHANGELOG_HEAD_PAGE = 30;

export const ProjectChangelogReadInput = Schema.Struct({
  projectId: ProjectId,
  cursor: Schema.optionalKey(ProjectChangelogCursor),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PROJECT_CHANGELOG_MAX_PAGE })),
  ),
});
export type ProjectChangelogReadInput = typeof ProjectChangelogReadInput.Type;

export const ProjectChangelogWatchInput = Schema.Struct({ projectId: ProjectId });
export type ProjectChangelogWatchInput = typeof ProjectChangelogWatchInput.Type;

export class ProjectChangelogError extends Schema.TaggedError<ProjectChangelogError>()(
  "ProjectChangelogError",
  {
    projectId: ProjectId,
    reason: Schema.Literals(["project-not-found", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "project-not-found"
      ? "The project was not found."
      : "The project changelog could not be read.";
  }
}
