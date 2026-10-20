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

/**
 * The T3 MCP tools a read-only project-thread turn may call on top of T3's
 * read-only tools: the ones that start, steer and stop other threads.
 */
export const PROJECT_THREAD_ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set([
  "t3_thread_launch",
  "t3_thread_send",
  "t3_thread_read",
  "t3_thread_interrupt",
  "t3_thread_configure",
]);

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

/**
 * The text a provider receives for one project-thread turn: the project's
 * instructions, then the user's request. A native slash command passes through
 * untouched because it only works at the start of the prompt.
 */
export function projectThreadTurnText(input: {
  readonly text: string;
  readonly instructions: string;
  readonly project: { readonly title: string; readonly workspaceRoot: string };
}): string {
  if (input.text.trimStart().startsWith("/")) return input.text;
  const preamble = `This is the project thread for the project "${input.project.title}" at ${input.project.workspaceRoot}. Follow these instructions on every turn. They take precedence over T3 Code's general orchestration guidance, including its rule to use t3_thread_launch only when the user explicitly asks for new threads.`;
  const instructions = [preamble, input.instructions.trim()]
    .filter((part) => part !== "")
    .join("\n\n");
  return `<t3_project_thread_instructions>\n${instructions}\n</t3_project_thread_instructions>\n\n<user_request>\n${input.text}\n</user_request>`;
}
