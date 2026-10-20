import { DEFAULT_PROJECT_THREAD_INSTRUCTIONS } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { projectThreadEnforcement } from "@t3tools/shared/projectThread";
import { useRef } from "react";

import { Textarea } from "../ui/textarea";
import { providerClients } from "./providerDriverMeta";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

const READ_ONLY_PROVIDER_LABELS = listFormat.format(
  providerClients.definitions
    .filter((definition) => projectThreadEnforcement(definition.driverKind) === "read-only")
    .map((definition) => definition.label),
);

export function ProjectThreadSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope, connectedEnvironments, targets } = useSettingsScope();
  const mixedEnabled = useScopedSettingsMixed(["projectThreadsEnabled"]);
  const mixedInstructions = useScopedSettingsMixed(["projectThreadInstructions"]);
  const instructionsEdited = useRef(false);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const outdatedLabels = connectedEnvironments
    .filter(
      (environment) => environment.serverConfig?.environment.capabilities.projectThreads !== true,
    )
    .map((environment) => environment.label);
  const supported = outdatedLabels.length === 0;
  const instructionsDisabled = !supported || (!mixedEnabled && !settings.projectThreadsEnabled);

  return (
    <SettingsSection title="Project threads">
      <SettingsRow
        serverScoped
        settingKeys={["projectThreadsEnabled"]}
        {...searchableSetting("project-threads")}
        description={
          isProjectScope
            ? "A manager chat for this project that launches and steers its threads. It never edits code itself."
            : "A manager chat per project that launches and steers its threads. It never edits code itself. Projects can override it."
        }
        status={
          supported
            ? undefined
            : `Update T3 Code on ${listFormat.format(outdatedLabels)} to use project threads.`
        }
        resetAction={
          settings.projectThreadsEnabled !== DEFAULT_UNIFIED_SETTINGS.projectThreadsEnabled ? (
            <SettingResetButton
              label="project threads"
              disabled={!supported}
              onClick={() =>
                updateSettings({
                  projectThreadsEnabled: DEFAULT_UNIFIED_SETTINGS.projectThreadsEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["projectThreadsEnabled"]}
            checked={settings.projectThreadsEnabled}
            disabled={!supported}
            onCheckedChange={(checked) => updateSettings({ projectThreadsEnabled: checked })}
            aria-label="Project threads"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["projectThreadInstructions"]}
        {...searchableSetting("project-thread-instructions")}
        description={`What project threads follow on every turn. ${READ_ONLY_PROVIDER_LABELS} also run those turns read-only. Other providers follow these instructions only as guidance.`}
        resetAction={
          mixedInstructions ||
          settings.projectThreadInstructions !== DEFAULT_PROJECT_THREAD_INSTRUCTIONS ? (
            <SettingResetButton
              label="project thread instructions"
              disabled={!supported}
              onClick={() =>
                updateSettings({ projectThreadInstructions: DEFAULT_PROJECT_THREAD_INSTRUCTIONS })
              }
            />
          ) : null
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={`${scopeKey}:${mixedInstructions}:${settings.projectThreadInstructions}`}
            aria-label="Project thread instructions"
            rows={6}
            disabled={instructionsDisabled}
            defaultValue={mixedInstructions ? "" : settings.projectThreadInstructions}
            placeholder={
              mixedInstructions
                ? "Mixed. Enter instructions to apply to all selected targets."
                : undefined
            }
            onChange={() => {
              instructionsEdited.current = true;
            }}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (
                instructionsEdited.current &&
                (mixedInstructions || value !== settings.projectThreadInstructions)
              )
                updateSettings({ projectThreadInstructions: value });
              instructionsEdited.current = false;
            }}
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
