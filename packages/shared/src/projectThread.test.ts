import {
  DEFAULT_PROJECT_THREAD_INSTRUCTIONS,
  ProjectId,
  ProviderDriverKind,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  isProjectThreadId,
  makeProjectThreadId,
  projectThreadEnforcement,
  resolveProjectThread,
} from "./projectThread.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const projectId = ProjectId.make("project:alpha");
const otherProjectId = ProjectId.make("project:beta");

describe("project thread ids", () => {
  it("recognizes the ids it makes and nothing else", () => {
    const id = makeProjectThreadId("0b7c7f8e-4a7e-4d43-9b1f-6a1f1c2f3e4d");
    expect(id).toBe("project-thread:0b7c7f8e-4a7e-4d43-9b1f-6a1f1c2f3e4d");
    expect(isProjectThreadId(id)).toBe(true);
    expect(isProjectThreadId(ThreadId.make("thread:project:alpha:1234"))).toBe(false);
    expect(isProjectThreadId(ThreadId.make("project-thread:"))).toBe(false);
    expect(isProjectThreadId(ThreadId.make("thread:project-thread:1234"))).toBe(false);
  });

  it("gives every call its own id", () => {
    expect(makeProjectThreadId("a")).not.toBe(makeProjectThreadId("b"));
  });
});

describe("project thread enforcement", () => {
  it("enforces read-only turns only where the provider honours the sandbox and T3 tools", () => {
    expect(projectThreadEnforcement(ProviderDriverKind.make("codex"))).toBe("read-only");
    expect(projectThreadEnforcement(ProviderDriverKind.make("claudeAgent"))).toBe("read-only");
    for (const driver of [
      "cursor",
      "pi",
      "muse",
      "grok",
      "opencode",
      "acpRegistry",
      "antigravity",
      "forkOnlyDriver",
    ]) {
      expect(projectThreadEnforcement(ProviderDriverKind.make(driver))).toBe("prompt-only");
    }
  });
});

describe("resolveProjectThread", () => {
  const projectThread = { id: makeProjectThreadId("1"), projectId };

  it("is on with the default instructions for a fresh environment", () => {
    expect(resolveProjectThread(decodeSettings({}), projectThread)).toEqual({
      instructions: DEFAULT_PROJECT_THREAD_INSTRUCTIONS,
    });
  });

  it("treats an ordinary thread as no project thread", () => {
    expect(
      resolveProjectThread(decodeSettings({}), {
        id: ThreadId.make("thread:project:alpha:1"),
        projectId,
      }),
    ).toBeNull();
  });

  it("follows the environment switch unless the project overrides it", () => {
    const settings = decodeSettings({
      projectThreadsEnabled: false,
      projectThreadInstructions: "Environment text.",
      projectSettingsOverrides: {
        [projectId]: { projectThreadsEnabled: true, projectThreadInstructions: "Project text." },
      },
    });
    expect(resolveProjectThread(settings, projectThread)).toEqual({
      instructions: "Project text.",
    });
    expect(
      resolveProjectThread(settings, { id: makeProjectThreadId("2"), projectId: otherProjectId }),
    ).toBeNull();
  });

  it("lets one project turn the feature off while the environment keeps it on", () => {
    const settings = decodeSettings({
      projectSettingsOverrides: { [projectId]: { projectThreadsEnabled: false } },
    });
    expect(resolveProjectThread(settings, projectThread)).toBeNull();
    expect(
      resolveProjectThread(settings, { id: makeProjectThreadId("2"), projectId: otherProjectId }),
    ).toEqual({ instructions: DEFAULT_PROJECT_THREAD_INSTRUCTIONS });
  });
});
