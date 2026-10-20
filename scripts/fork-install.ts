#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  DESKTOP_FORK_IDENTITY,
  formatDesktopForkVersion,
  resolveDesktopForkT3Home,
} from "@t3tools/shared/desktopFork";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };

const KEEP_VERSIONS = 2;
const SEEDED_USERDATA_FILES = ["settings.json", "keybindings.json"] as const;

export class ForkInstallError extends Schema.TaggedError<ForkInstallError>()("ForkInstallError", {
  step: Schema.Literals(["preflight", "version", "build", "extract", "install", "seed"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return `fork:install failed during ${this.step}: ${this.detail}`;
  }
}

export interface ForkInstallPaths {
  readonly optDir: string;
  readonly launcherPath: string;
  readonly applicationsDir: string;
  readonly desktopEntryPath: string;
  readonly workDir: string;
  readonly forkHome: string;
  readonly upstreamUserData: string;
}

export function resolveForkInstallPaths(input: {
  readonly homeDirectory: string;
  readonly xdgDataHome: Option.Option<string>;
  readonly xdgCacheHome: Option.Option<string>;
  readonly join: (...segments: ReadonlyArray<string>) => string;
}): ForkInstallPaths {
  const { join } = input;
  const name = DESKTOP_FORK_IDENTITY.linuxExecutableName;
  const dataHome = Option.getOrElse(input.xdgDataHome, () =>
    join(input.homeDirectory, ".local", "share"),
  );
  const cacheHome = Option.getOrElse(input.xdgCacheHome, () => join(input.homeDirectory, ".cache"));
  const applicationsDir = join(dataHome, "applications");
  return {
    optDir: join(input.homeDirectory, ".local", "opt", name),
    launcherPath: join(input.homeDirectory, ".local", "bin", name),
    applicationsDir,
    desktopEntryPath: join(applicationsDir, DESKTOP_FORK_IDENTITY.linuxDesktopEntryName),
    workDir: join(cacheHome, name),
    forkHome: resolveDesktopForkT3Home(input.homeDirectory),
    upstreamUserData: join(input.homeDirectory, ".t3", "userdata"),
  };
}

// No MimeType line: t3code:// links stay with the upstream install.
export function renderForkDesktopEntry(input: {
  readonly launcherPath: string;
  readonly iconPath: string;
  readonly version: string;
}): string {
  return [
    "[Desktop Entry]",
    `Name=${DESKTOP_FORK_IDENTITY.productName}`,
    "Comment=T3 Code desktop, local fork build",
    `Exec=${input.launcherPath} --no-sandbox %U`,
    "Terminal=false",
    "Type=Application",
    `Icon=${input.iconPath}`,
    `StartupWMClass=${DESKTOP_FORK_IDENTITY.linuxWmClass}`,
    "Categories=Development;",
    `X-AppImage-Version=${input.version}`,
    "",
  ].join("\n");
}

export function selectForkVersionsToPrune(
  installs: ReadonlyArray<{ readonly version: string; readonly installedAtMs: number }>,
  currentVersion: string,
  keep: number,
): ReadonlyArray<string> {
  const others = installs
    .filter((install) => install.version !== currentVersion)
    .toSorted((left, right) => right.installedAtMs - left.installedAtMs);
  return others.slice(Math.max(keep - 1, 0)).map((install) => install.version);
}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

const fail = (step: ForkInstallError["step"], detail: string) =>
  Effect.fail(new ForkInstallError({ step, detail }));

const run = Effect.fn("forkInstall.run")(function* (
  step: ForkInstallError["step"],
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env?: Record<string, string>;
    readonly stdout?: "inherit" | "ignore";
  },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make(command, [...args], {
        cwd: options.cwd,
        ...(options.env ? { env: options.env, extendEnv: true } : {}),
        stdin: "ignore",
        stdout: options.stdout ?? "inherit",
        stderr: "inherit",
      }),
    )
    .pipe(Effect.mapError((cause) => new ForkInstallError({ step, detail: cause.message })));
  if (exitCode !== 0) {
    return yield* fail(step, `${command} ${args.join(" ")} exited with ${exitCode}`);
  }
});

const git = Effect.fn("forkInstall.git")(function* (repoRoot: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .string(
      ChildProcess.make("git", ["-C", repoRoot, ...args], {
        env: { TZ: "UTC" },
        extendEnv: true,
      }),
    )
    .pipe(
      Effect.map((output) => output.trim()),
      Effect.mapError((cause) => new ForkInstallError({ step: "version", detail: cause.message })),
    );
});

const resolveForkVersion = Effect.fn("forkInstall.resolveVersion")(function* (repoRoot: string) {
  const commit = yield* git(repoRoot, ["rev-parse", "--short=8", "HEAD"]);
  const commitDate = yield* git(repoRoot, [
    "show",
    "-s",
    "--format=%cd",
    "--date=format-local:%Y%m%d",
    "HEAD",
  ]);
  const status = yield* git(repoRoot, ["status", "--porcelain"]);
  const dirty = status.length > 0;
  return {
    version: formatDesktopForkVersion({
      baseVersion: desktopPackageJson.version,
      commitDate,
      commit,
      dirty,
    }),
    dirty,
  };
});

// Linux /proc lookup: an install directory some running process executes
// from must not be replaced or pruned underneath it.
const processesRunningFrom = Effect.fn("forkInstall.processesRunningFrom")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory("/proc").pipe(Effect.orElseSucceed(() => []));
  const pids: Array<string> = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const executable = yield* fs.readLink(`/proc/${entry}/exe`).pipe(Effect.option);
    if (Option.isSome(executable) && executable.value.startsWith(`${directory}/`)) {
      pids.push(entry);
    }
  }
  return pids;
});

const buildAppImage = Effect.fn("forkInstall.buildAppImage")(function* (input: {
  readonly repoRoot: string;
  readonly version: string;
  readonly workDir: string;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const artifactsDir = path.join(input.workDir, "artifacts");
  const tmpDir = path.join(input.workDir, "tmp");
  yield* fs.remove(artifactsDir, { recursive: true, force: true });
  yield* fs.makeDirectory(tmpDir, { recursive: true });
  // The build stages a full app tree in TMPDIR, too large for a RAM-backed /tmp.
  yield* run(
    "build",
    process.execPath,
    [
      "scripts/build-desktop-artifact.ts",
      "--platform",
      "linux",
      "--target",
      "AppImage",
      "--arch",
      "x64",
      "--build-version",
      input.version,
      "--output-dir",
      artifactsDir,
      ...(input.verbose ? ["--verbose"] : []),
    ],
    { cwd: input.repoRoot, env: { TMPDIR: tmpDir } },
  );
  const appImages = (yield* fs.readDirectory(artifactsDir)).filter((entry) =>
    entry.endsWith(".AppImage"),
  );
  if (appImages.length !== 1) {
    return yield* fail(
      "build",
      `expected one AppImage in ${artifactsDir}, found ${appImages.length}`,
    );
  }
  return path.join(artifactsDir, appImages[0]!);
});

const installAppImage = Effect.fn("forkInstall.installAppImage")(function* (input: {
  readonly appImage: string;
  readonly installDir: string;
  readonly optDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Extract next to the install dir so the final rename never crosses filesystems.
  const stagingDir = path.join(input.optDir, ".staging");
  yield* fs.remove(stagingDir, { recursive: true, force: true });
  yield* fs.makeDirectory(stagingDir, { recursive: true });
  yield* run("extract", input.appImage, ["--appimage-extract"], {
    cwd: stagingDir,
    stdout: "ignore",
  });
  const extracted = path.join(stagingDir, "squashfs-root");
  const executable = path.join(extracted, DESKTOP_FORK_IDENTITY.linuxExecutableName);
  if (!(yield* fs.exists(executable))) {
    return yield* fail(
      "extract",
      `the AppImage has no ${DESKTOP_FORK_IDENTITY.linuxExecutableName} executable`,
    );
  }
  if (yield* fs.exists(path.join(extracted, "resources", "app-update.yml"))) {
    return yield* fail("extract", "the AppImage carries an update feed; a fork build must not");
  }
  if (yield* fs.exists(input.installDir)) {
    const running = yield* processesRunningFrom(input.installDir);
    if (running.length > 0) {
      return yield* fail(
        "install",
        `${input.installDir} is in use by pid ${running.join(", ")}. Quit ${DESKTOP_FORK_IDENTITY.productName} and rerun.`,
      );
    }
    yield* fs.remove(input.installDir, { recursive: true });
  }
  yield* fs.rename(extracted, input.installDir);
  yield* fs.remove(stagingDir, { recursive: true, force: true });
});

const writeAtomically = Effect.fn("forkInstall.writeAtomically")(function* (
  filePath: string,
  content: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  const staging = `${filePath}.${process.pid}.tmp`;
  yield* fs.writeFileString(staging, content);
  yield* fs.rename(staging, filePath);
});

const linkLauncherAndDesktopEntry = Effect.fn("forkInstall.linkLauncherAndDesktopEntry")(
  function* (input: {
    readonly paths: ForkInstallPaths;
    readonly installDir: string;
    readonly version: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconPath = path.join(
      input.installDir,
      "usr/share/icons/hicolor/512x512/apps",
      `${DESKTOP_FORK_IDENTITY.linuxExecutableName}.png`,
    );
    if (!(yield* fs.exists(iconPath))) {
      return yield* fail("install", `missing icon at ${iconPath}`);
    }
    yield* fs.makeDirectory(path.dirname(input.paths.launcherPath), { recursive: true });
    const stagingLink = `${input.paths.launcherPath}.${process.pid}.tmp`;
    yield* fs.remove(stagingLink, { force: true });
    yield* fs.symlink(path.join(input.installDir, "AppRun"), stagingLink);
    yield* fs.rename(stagingLink, input.paths.launcherPath);
    yield* writeAtomically(
      input.paths.desktopEntryPath,
      renderForkDesktopEntry({
        launcherPath: input.paths.launcherPath,
        iconPath,
        version: input.version,
      }),
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // Only refreshes the launcher cache; the entry works without it.
    yield* spawner
      .exitCode(
        ChildProcess.make("update-desktop-database", [input.paths.applicationsDir], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.ignore);
  },
);

const pruneOldVersions = Effect.fn("forkInstall.pruneOldVersions")(function* (
  optDir: string,
  currentVersion: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const installs: Array<{ version: string; installedAtMs: number }> = [];
  for (const entry of yield* fs.readDirectory(optDir)) {
    if (entry.startsWith(".")) continue;
    const info = yield* fs.stat(path.join(optDir, entry));
    if (info.type !== "Directory") continue;
    installs.push({
      version: entry,
      installedAtMs: Option.match(info.mtime, {
        onNone: () => 0,
        onSome: (date) => date.getTime(),
      }),
    });
  }
  for (const version of selectForkVersionsToPrune(installs, currentVersion, KEEP_VERSIONS)) {
    const directory = path.join(optDir, version);
    const running = yield* processesRunningFrom(directory);
    if (running.length > 0) {
      yield* Console.log(`Keeping ${version}: in use by pid ${running.join(", ")}.`);
      continue;
    }
    yield* fs.remove(directory, { recursive: true });
    yield* Console.log(`Pruned ${version}.`);
  }
});

const seedForkHome = Effect.fn("forkInstall.seedForkHome")(function* (input: {
  readonly repoRoot: string;
  readonly paths: ForkInstallPaths;
  readonly projects: number;
  readonly threadsPerProject: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const forkUserData = path.join(input.paths.forkHome, "userdata");
  if (yield* fs.exists(forkUserData)) {
    yield* Console.log(`Leaving existing ${input.paths.forkHome} untouched.`);
    return;
  }
  const sourceDatabase = path.join(input.paths.upstreamUserData, "statev2.sqlite");
  if (!(yield* fs.exists(sourceDatabase))) {
    yield* Console.log(`No ${sourceDatabase} to seed from; the fork starts empty.`);
    return;
  }
  // Seed beside the fork home and move userdata in last, so an interrupted
  // seed never leaves a half-built userdata that later runs would keep.
  const stagingHome = `${input.paths.forkHome}.seeding`;
  yield* fs.remove(stagingHome, { recursive: true, force: true });
  yield* run(
    "seed",
    process.execPath,
    [
      "apps/server/scripts/migrate-dev-db.ts",
      "--base-dir",
      stagingHome,
      "--source",
      sourceDatabase,
      "--projects",
      String(input.projects),
      "--threads-per-project",
      String(input.threadsPerProject),
    ],
    { cwd: input.repoRoot },
  );
  const stagingUserData = path.join(stagingHome, "userdata");
  for (const file of SEEDED_USERDATA_FILES) {
    const source = path.join(input.paths.upstreamUserData, file);
    if (yield* fs.exists(source)) {
      yield* fs.copyFile(source, path.join(stagingUserData, file));
      yield* Console.log(`Copied ${file}.`);
    }
  }
  yield* fs.makeDirectory(input.paths.forkHome, { recursive: true });
  yield* fs.rename(stagingUserData, forkUserData);
  yield* fs.remove(stagingHome, { recursive: true, force: true });
  yield* Console.log(`Seeded ${forkUserData} from a read-only snapshot of ${sourceDatabase}.`);
});

export const forkInstall = Effect.fn("forkInstall")(function* (options: {
  readonly rebuild: boolean;
  readonly verbose: boolean;
  readonly seedProjects: number;
  readonly seedThreadsPerProject: number;
}) {
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  if (platform !== "linux" || arch !== "x64") {
    return yield* fail("preflight", `only linux x64 is supported, not ${platform} ${arch}`);
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const paths = resolveForkInstallPaths({
    homeDirectory: yield* HostProcess.HomeDirectory,
    xdgDataHome: yield* Config.String("XDG_DATA_HOME").pipe(Config.option),
    xdgCacheHome: yield* Config.String("XDG_CACHE_HOME").pipe(Config.option),
    join: (...segments) => path.join(...segments),
  });
  const { version, dirty } = yield* resolveForkVersion(repoRoot);
  const installDir = path.join(paths.optDir, version);
  yield* Console.log(`${DESKTOP_FORK_IDENTITY.productName} ${version}`);

  const installed = yield* fs.exists(
    path.join(installDir, DESKTOP_FORK_IDENTITY.linuxExecutableName),
  );
  if (installed && !dirty && !options.rebuild) {
    yield* Console.log(`Already installed at ${installDir}; pass --rebuild to build it again.`);
  } else {
    yield* Effect.gen(function* () {
      const appImage = yield* buildAppImage({
        repoRoot,
        version,
        workDir: paths.workDir,
        verbose: options.verbose,
      });
      yield* installAppImage({ appImage, installDir, optDir: paths.optDir });
    }).pipe(
      Effect.ensuring(
        fs.remove(paths.workDir, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    yield* Console.log(`Installed ${installDir}.`);
  }

  yield* linkLauncherAndDesktopEntry({ paths, installDir, version });
  yield* Console.log(`Launcher ${paths.launcherPath}, desktop entry ${paths.desktopEntryPath}.`);
  yield* pruneOldVersions(paths.optDir, version);
  yield* seedForkHome({
    repoRoot,
    paths,
    projects: options.seedProjects,
    threadsPerProject: options.seedThreadsPerProject,
  });
});

const command = Command.make(
  "fork-install",
  {
    rebuild: Flag.Boolean("rebuild").pipe(
      Flag.withDescription("Build again even when this commit is already installed."),
      Flag.withDefault(false),
    ),
    verbose: Flag.Boolean("verbose").pipe(
      Flag.withDescription("Stream the desktop build's subprocess output."),
      Flag.withDefault(false),
    ),
    seedProjects: Flag.Int("seed-projects").pipe(
      Flag.withDescription("Recent projects to copy into a new fork home."),
      Flag.withDefault(5),
    ),
    seedThreadsPerProject: Flag.Int("seed-threads-per-project").pipe(
      Flag.withDescription("Recent stopped threads per project to copy into a new fork home."),
      Flag.withDefault(10),
    ),
  },
  forkInstall,
).pipe(
  Command.withDescription(
    "Build the fork's Linux AppImage and install it beside the upstream app, with its own launcher, desktop entry and T3 home.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
