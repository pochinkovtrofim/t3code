import { DEFAULT_PROJECT_THREAD_INSTRUCTIONS } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import type { ScopedSettingsPatch } from "./scopedSettings";

interface Target {
  label: string;
  projectThreads: boolean;
  projectThreadsEnabled: boolean;
  projectThreadInstructions: string;
}

const state = vi.hoisted(() => ({
  targets: [] as Target[],
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

const differs = (key: "projectThreadsEnabled" | "projectThreadInstructions") =>
  state.targets.some((target) => target[key] !== state.targets[0]?.[key]);

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    projectThreadsEnabled: state.targets[0]!.projectThreadsEnabled,
    projectThreadInstructions: state.targets[0]!.projectThreadInstructions,
  })) as never,
  useScopedSettingsMixed: (keys) =>
    keys.some((key) =>
      key === "projectThreadsEnabled" || key === "projectThreadInstructions" ? differs(key) : false,
    ),
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [] },
    connectedEnvironments: state.targets.map((target) => ({
      label: target.label,
      serverConfig: {
        environment: { capabilities: { projectThreads: target.projectThreads } },
      },
    })),
    targets: state.targets.map((target) => ({ environmentId: target.label, projectId: null })),
  })) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ title, description, status, control, resetAction, children }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      <p>{status}</p>
      {control}
      {resetAction}
      {children}
    </div>
  ),
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
}));

import { ProjectThreadSettings } from "./ProjectThreadSettings";

let root: Root;
let container: HTMLDivElement;

const toggle = () => page.getByRole("switch", { name: "Project threads" });
const instructions = () => page.getByRole("textbox", { name: "Project thread instructions" });
const resetInstructions = () =>
  page.getByRole("button", { name: "Reset project thread instructions to default" });

async function render() {
  await act(async () => root.render(<ProjectThreadSettings />));
}

async function remountWith(targets: Target[]) {
  state.targets = targets;
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
}

function target(overrides: Partial<Target> = {}): Target {
  return {
    label: "Laptop",
    projectThreads: true,
    projectThreadsEnabled: true,
    projectThreadInstructions: DEFAULT_PROJECT_THREAD_INSTRUCTIONS,
    ...overrides,
  };
}

beforeEach(async () => {
  state.targets = [target()];
  state.updateSettings.mockReset().mockImplementation((patch) => {
    state.targets = state.targets.map((current) => ({
      ...current,
      ...(patch.projectThreadsEnabled !== undefined
        ? { projectThreadsEnabled: patch.projectThreadsEnabled }
        : {}),
      ...(patch.projectThreadInstructions !== undefined
        ? { projectThreadInstructions: patch.projectThreadInstructions }
        : {}),
    }));
    void render();
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("project thread settings", () => {
  it("turns project threads off and locks the instructions until they are back on", async () => {
    await expect.element(instructions()).toBeEnabled();

    await userEvent.click(toggle());

    expect(state.updateSettings).toHaveBeenCalledWith({ projectThreadsEnabled: false });
    await expect.element(toggle()).not.toBeChecked();
    await expect.element(instructions()).toBeDisabled();

    await userEvent.click(toggle());

    expect(state.updateSettings).toHaveBeenLastCalledWith({ projectThreadsEnabled: true });
    await expect.element(instructions()).toBeEnabled();
  });

  it("saves edited instructions on blur and resets them to the default", async () => {
    await expect.element(instructions()).toHaveValue(DEFAULT_PROJECT_THREAD_INSTRUCTIONS);
    await expect.element(resetInstructions()).not.toBeInTheDocument();

    await userEvent.fill(instructions(), "  Launch one thread per task.  ");
    await act(async () => (instructions().element() as HTMLTextAreaElement).blur());

    expect(state.updateSettings).toHaveBeenCalledWith({
      projectThreadInstructions: "Launch one thread per task.",
    });
    await expect.element(instructions()).toHaveValue("Launch one thread per task.");

    await userEvent.click(resetInstructions());

    expect(state.updateSettings).toHaveBeenLastCalledWith({
      projectThreadInstructions: DEFAULT_PROJECT_THREAD_INSTRUCTIONS,
    });
    await expect.element(instructions()).toHaveValue(DEFAULT_PROJECT_THREAD_INSTRUCTIONS);
  });

  it("names Codex and Claude as the read-only providers", async () => {
    await expect
      .element(page.getByText(/Codex and Claude also run those turns read-only/))
      .toBeInTheDocument();
  });

  it("applies one value to every environment when they disagree", async () => {
    await remountWith([
      target({ label: "Laptop", projectThreadsEnabled: true }),
      target({ label: "Server", projectThreadsEnabled: false, projectThreadInstructions: "" }),
    ]);

    await expect.element(instructions()).toHaveValue("");
    await expect.element(instructions()).toBeEnabled();
    await expect.element(resetInstructions()).toBeInTheDocument();
    await expect.element(toggle()).toHaveAttribute("aria-checked", "mixed");

    await userEvent.click(toggle());

    expect(state.updateSettings).toHaveBeenCalledWith({ projectThreadsEnabled: true });
    expect(state.targets.map((current) => current.projectThreadsEnabled)).toEqual([true, true]);
  });

  it("locks both controls and names the environments that lack project threads", async () => {
    await remountWith([
      target({ label: "Laptop" }),
      target({ label: "Old server", projectThreads: false }),
    ]);

    await expect
      .element(page.getByText("Update T3 Code on Old server to use project threads."))
      .toBeInTheDocument();
    await expect.element(toggle()).toBeDisabled();
    await expect.element(instructions()).toBeDisabled();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });
});
