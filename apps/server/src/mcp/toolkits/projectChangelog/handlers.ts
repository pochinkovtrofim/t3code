import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectChangelog from "../../../projectChangelog/ProjectChangelog.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { ProjectChangelogToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ProjectChangelogToolkit, {
  t3_project_changelog_read: McpToolAccess.reads(({ projectId: requested, ...page }) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const projectId = requested ?? caller?.projectId;
      if (projectId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Pass projectId; this caller has no project.",
        });
      const changelog = yield* ProjectChangelog.ProjectChangelog;
      return yield* changelog
        .read({ projectId, ...page })
        .pipe(
          Effect.mapError((error) =>
            error.reason === "project-not-found"
              ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
              : unavailable(),
          ),
        );
    }),
  ),
});
