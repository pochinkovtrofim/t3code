import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { resolveUserDataPath } from "./DesktopUserData.ts";

const FORK_VERSION = "0.1.0-fork.20261020.geffb4337";
const NIGHTLY_VERSION = "0.1.1-nightly.20261019.3348";

const makeLinuxEnvironment = (appVersion: string) =>
  DesktopEnvironment.DesktopEnvironment.pipe(
    Effect.provide(
      DesktopEnvironment.layer({
        dirname: "/opt/app/resources/app.asar/apps/desktop/dist-electron",
        homeDirectory: "/home/alice",
        platform: "linux",
        processArch: "x64",
        appVersion,
        appPath: "/opt/app/resources/app.asar",
        isPackaged: true,
        resourcesPath: "/opt/app/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest({})),
        ),
      ),
    ),
  );

describe("fork desktop identity", () => {
  it.effect("gives a fork build its own window, desktop entry and keyring identity", () =>
    Effect.gen(function* () {
      const fork = yield* makeLinuxEnvironment(FORK_VERSION);
      const nightly = yield* makeLinuxEnvironment(NIGHTLY_VERSION);

      assert.deepStrictEqual(
        [fork.displayName, fork.linuxWmClass, fork.linuxDesktopEntryName],
        ["T3 Code Fork", "t3code-fork", "t3-code-fork.desktop"],
      );
      assert.deepStrictEqual(
        [nightly.displayName, nightly.linuxWmClass, nightly.linuxDesktopEntryName],
        ["T3 Code (Nightly)", "t3code", "com.t3tools.T3Code.desktop"],
      );
      assert.strictEqual(
        DesktopEnvironment.resolveDesktopSafeStorageName(FORK_VERSION),
        "T3 Code Fork",
      );
      assert.strictEqual(
        DesktopEnvironment.resolveDesktopSafeStorageName(NIGHTLY_VERSION),
        "T3 Code (Nightly)",
      );
    }),
  );

  it.effect("keeps the fork's Electron profile, and so its single-instance lock, apart", () =>
    Effect.gen(function* () {
      const input = { appDataDirectory: "/home/alice/.config", isDevelopment: false };
      const fork = yield* resolveUserDataPath({
        ...input,
        platform: "linux",
        appVersion: FORK_VERSION,
      });
      const nightly = yield* resolveUserDataPath({
        ...input,
        platform: "linux",
        appVersion: NIGHTLY_VERSION,
      });

      assert.strictEqual(fork, "/home/alice/.config/t3code-fork");
      assert.strictEqual(nightly, "/home/alice/.config/t3code-v2");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
