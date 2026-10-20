import type { ProjectId, ProviderDriverKind, ServerSettings, ThreadId } from "@t3tools/contracts";
import type * as Brand from "effect/Brand";

import { resolveProjectSettings } from "./projectSettings.ts";

/**
 * A project thread is an ordinary thread marked only by this id prefix. The
 * mark survives servers that re-emit threads without unknown fields, and the
 * random suffix keeps a deleted project thread's tombstone from blocking the
 * next one.
 */
export const PROJECT_THREAD_ID_PREFIX = "project-thread:";

export type ProjectThreadId = ThreadId & Brand.Brand<"ProjectThreadId">;

export function makeProjectThreadId(randomId: string): ProjectThreadId {
  return `${PROJECT_THREAD_ID_PREFIX}${randomId}` as ProjectThreadId;
}

export function isProjectThreadId(threadId: ThreadId): threadId is ProjectThreadId {
  return (
    threadId.startsWith(PROJECT_THREAD_ID_PREFIX) &&
    threadId.length > PROJECT_THREAD_ID_PREFIX.length
  );
}

/**
 * How a provider keeps a project thread's own turns from changing anything:
 * `read-only` runs them in a read-only sandbox that still allows T3's thread
 * tools, `prompt-only` relies on the instructions alone.
 */
export type ProjectThreadEnforcement = "read-only" | "prompt-only";

// Every other driver is prompt-only: Cursor, Pi and Muse ignore the sandbox
// policy, and Grok, OpenCode and ACP agents would deny T3's own tools under it,
// leaving the project thread unable to launch anything.
const PROJECT_THREAD_ENFORCEMENT: Readonly<Record<string, ProjectThreadEnforcement>> = {
  codex: "read-only",
  claudeAgent: "read-only",
};

export function projectThreadEnforcement(driver: ProviderDriverKind): ProjectThreadEnforcement {
  return PROJECT_THREAD_ENFORCEMENT[driver] ?? "prompt-only";
}

/**
 * The project-thread behaviour a thread gets, or null when it is not a project
 * thread or its project has the feature turned off and it behaves like any
 * other thread.
 */
export function resolveProjectThread(
  settings: ServerSettings,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
): { readonly instructions: string } | null {
  if (!isProjectThreadId(thread.id)) return null;
  const resolved = resolveProjectSettings(settings, thread.projectId).settings;
  return resolved.projectThreadsEnabled
    ? { instructions: resolved.projectThreadInstructions }
    : null;
}
