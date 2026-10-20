import { createProjectChangelogEnvironmentAtoms } from "@t3tools/client-runtime/state/project-changelog";

import { connectionAtomRuntime } from "../connection/runtime";

export const projectChangelogEnvironment =
  createProjectChangelogEnvironmentAtoms(connectionAtomRuntime);
