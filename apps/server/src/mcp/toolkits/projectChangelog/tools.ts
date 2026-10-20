import {
  OrchestratorMcpFailure,
  ProjectChangelogPage,
  ProjectChangelogReadInput,
  ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectChangelog from "../../../projectChangelog/ProjectChangelog.ts";

const ProjectChangelogReadTool = Tool.make("t3_project_changelog_read", {
  description:
    "Read what landed on a project's GitHub default branch, newest first: one entry per merged pull request or direct push, in plain English, with whether it is in production (deployment, release or tag) and the T3 threads that did the work. Pass nextCursor back as cursor for older entries. Entries whose summaryState is pending show the pull request title until the summary is written.",
  parameters: Schema.Struct({
    projectId: Schema.optional(
      ProjectId.annotate({ description: "Project to read. Omit for this thread's project." }),
    ),
    cursor: ProjectChangelogReadInput.fields.cursor,
    limit: ProjectChangelogReadInput.fields.limit,
  }),
  success: ProjectChangelogPage,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectChangelog.ProjectChangelog,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const ProjectChangelogToolkit = Toolkit.make(ProjectChangelogReadTool);
