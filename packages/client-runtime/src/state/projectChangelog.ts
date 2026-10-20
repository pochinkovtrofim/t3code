import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Only for environments that advertise the `projectChangelog` capability. */
export function createProjectChangelogEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** The newest entries, pushed again whenever a sync or summary changes them. */
    head: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:project-changelog:head",
      tag: WS_METHODS.projectChangelogWatch,
    }),
    /** Older entries by the cursor of the page before. */
    page: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:project-changelog:page",
      tag: WS_METHODS.projectChangelogRead,
    }),
  };
}
