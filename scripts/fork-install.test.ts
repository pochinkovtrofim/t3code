import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  renderForkDesktopEntry,
  resolveForkInstallPaths,
  selectForkVersionsToPrune,
} from "./fork-install.ts";

describe("resolveForkInstallPaths", () => {
  it("installs beside, never over, the upstream app and its home", () => {
    const paths = resolveForkInstallPaths({
      homeDirectory: "/home/alice",
      xdgDataHome: Option.none(),
      xdgCacheHome: Option.some("/var/cache/alice"),
      join: (...segments) => segments.join("/"),
    });

    assert.deepStrictEqual(paths, {
      optDir: "/home/alice/.local/opt/t3-code-fork",
      launcherPath: "/home/alice/.local/bin/t3-code-fork",
      applicationsDir: "/home/alice/.local/share/applications",
      desktopEntryPath: "/home/alice/.local/share/applications/t3-code-fork.desktop",
      workDir: "/var/cache/alice/t3-code-fork",
      forkHome: "/home/alice/.t3-fork",
      upstreamUserData: "/home/alice/.t3/userdata",
    });
  });
});

describe("renderForkDesktopEntry", () => {
  it("launches the fork under its own window class and claims no URL scheme", () => {
    const entry = renderForkDesktopEntry({
      launcherPath: "/home/alice/.local/bin/t3-code-fork",
      iconPath: "/opt/fork/icon.png",
      version: "0.1.0-fork.20261020.geffb4337",
    });

    assert.include(entry, "Name=T3 Code Fork\n");
    assert.include(entry, "Exec=/home/alice/.local/bin/t3-code-fork --no-sandbox %U\n");
    assert.include(entry, "StartupWMClass=t3code-fork\n");
    assert.include(entry, "Icon=/opt/fork/icon.png\n");
    assert.notInclude(entry, "MimeType");
  });
});

describe("selectForkVersionsToPrune", () => {
  const installs = [
    { version: "a", installedAtMs: 1 },
    { version: "b", installedAtMs: 3 },
    { version: "c", installedAtMs: 2 },
    { version: "d", installedAtMs: 4 },
  ];

  it("keeps the current version and the most recently installed other", () => {
    assert.deepStrictEqual(selectForkVersionsToPrune(installs, "a", 2), ["b", "c"]);
  });

  it("prunes nothing when no more than the kept versions exist", () => {
    assert.deepStrictEqual(selectForkVersionsToPrune(installs.slice(0, 2), "a", 2), []);
    assert.deepStrictEqual(selectForkVersionsToPrune([], "a", 2), []);
  });
});
