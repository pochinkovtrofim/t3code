/**
 * Identity of a locally built fork of the desktop app. The build version is
 * the switch: a version carrying the fork tag gets this identity, so the fork
 * runs beside an upstream install without sharing its Electron profile,
 * single-instance lock, T3 home, URL handlers, updater, or telemetry. Every
 * other version keeps upstream behavior unchanged.
 */
export const DESKTOP_FORK_IDENTITY = {
  productName: "T3 Code Fork",
  appId: "com.t3tools.t3code.fork",
  linuxExecutableName: "t3-code-fork",
  linuxWmClass: "t3code-fork",
  linuxDesktopEntryName: "t3-code-fork.desktop",
  userDataDirName: "t3code-fork",
  t3HomeDirName: ".t3-fork",
} as const;

export type DesktopForkIdentity = typeof DESKTOP_FORK_IDENTITY;

// The commit gets a "g" prefix (as in `git describe`) because an all-digit
// hash with a leading zero is not a valid semver prerelease identifier.
const FORK_VERSION_PATTERN = /^\d+\.\d+\.\d+-fork\.\d{8}\.g[0-9a-f]{7,40}(?:\.dirty)?$/;

export function resolveDesktopForkIdentity(version: string): DesktopForkIdentity | undefined {
  return FORK_VERSION_PATTERN.test(version) ? DESKTOP_FORK_IDENTITY : undefined;
}

export function formatDesktopForkVersion(input: {
  readonly baseVersion: string;
  readonly commitDate: string;
  readonly commit: string;
  readonly dirty: boolean;
}): string {
  const release = input.baseVersion.split(/[-+]/)[0];
  return `${release}-fork.${input.commitDate}.g${input.commit.toLowerCase()}${input.dirty ? ".dirty" : ""}`;
}

export function resolveDesktopForkT3Home(homeDirectory: string): string {
  return `${homeDirectory}/${DESKTOP_FORK_IDENTITY.t3HomeDirName}`;
}

/**
 * Applied to the desktop process before anything reads its environment. The
 * backend, the `t3` launcher, and terminals inherit it, so they all agree on
 * the fork's home. An inherited T3CODE_HOME is replaced on purpose: pointing
 * the fork at upstream's home would run two servers against one database.
 */
export function resolveDesktopForkEnvironment(homeDirectory: string): Record<string, string> {
  return {
    T3CODE_HOME: resolveDesktopForkT3Home(homeDirectory),
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_DISABLE_AUTO_UPDATE: "1",
  };
}
