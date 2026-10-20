import { scopedProjectKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModelSelection,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { waitForThreadShell } from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { useStableCallback } from "./useStableCallback";

const NO_PENDING_PROJECTS: ReadonlySet<string> = new Set();

function fallbackModelSelection(environmentId: EnvironmentId): ModelSelection | null {
  const { stickyActiveProvider, stickyModelSelectionByProvider } = useComposerDraftStore.getState();
  const providers =
    appAtomRegistry.get(environmentPresentations.providersByEnvironmentAtom).get(environmentId) ??
    [];
  return resolveDefaultProviderModelSelection(
    providers,
    stickyActiveProvider === null ? null : stickyModelSelectionByProvider[stickyActiveProvider],
  );
}

function reportOpenFailure(description: string) {
  toastManager.add(
    stackedThreadToast({ type: "error", title: "Could not open the project thread", description }),
  );
}

export function useOpenProjectThread(navigate: (threadRef: ScopedThreadRef) => unknown) {
  const router = useRouter();
  const ensureThread = useAtomCommand(projectEnvironment.ensureThread, { reportFailure: false });
  const inFlightRef = useRef(new Set<string>());
  const [pendingProjectKeys, setPendingProjectKeys] = useState(NO_PENDING_PROJECTS);
  const setPending = (projectKey: string, pending: boolean) => {
    if (pending) inFlightRef.current.add(projectKey);
    else inFlightRef.current.delete(projectKey);
    setPendingProjectKeys(new Set(inFlightRef.current));
  };

  const open = useStableCallback(async (projectRef: ScopedProjectRef) => {
    const projectKey = scopedProjectKey(projectRef);
    if (inFlightRef.current.has(projectKey)) return;
    setPending(projectKey, true);
    const requestedFrom = router.state.location.href;
    const modelSelection = fallbackModelSelection(projectRef.environmentId);
    const result = await ensureThread({
      environmentId: projectRef.environmentId,
      input: {
        projectId: projectRef.projectId,
        ...(modelSelection === null ? {} : { modelSelection }),
      },
    });
    if (result._tag === "Failure") {
      setPending(projectKey, false);
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        reportOpenFailure(error instanceof Error ? error.message : "An error occurred.");
      }
      return;
    }
    const threadRef = scopeThreadRef(projectRef.environmentId, result.value.threadId);
    // A thread route renders an empty view until the client has the thread's shell.
    const arrived = await waitForThreadShell(threadRef);
    setPending(projectKey, false);
    if (!arrived) {
      reportOpenFailure("It has not reached this device yet. Check the connection and try again.");
      return;
    }
    if (router.state.location.href === requestedFrom) navigate(threadRef);
  });

  return { open, pendingProjectKeys };
}
