import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { formatDesktopForkVersion } from "@t3tools/shared/desktopFork";

import { createBuildConfig, resolveDesktopUpdateChannel } from "./build-desktop-artifact.ts";

const forkVersion = formatDesktopForkVersion({
  baseVersion: "0.1.0",
  commitDate: "20261020",
  commit: "effb4337",
  dirty: false,
});

const releaseRepositoryEnv = Layer.mergeAll(
  NodeServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "pingdotgg/t3code" } })),
);

it.effect("packages a fork build under its own identity without an update feed", () =>
  Effect.gen(function* () {
    const config = yield* createBuildConfig(
      "linux",
      "AppImage",
      forkVersion,
      false,
      false,
      undefined,
      undefined,
    );
    const linux = config.linux as Record<string, unknown>;

    assert.strictEqual(resolveDesktopUpdateChannel(forkVersion), "latest");
    assert.strictEqual(config.productName, "T3 Code Fork");
    assert.strictEqual(config.appId, "com.t3tools.t3code.fork");
    assert.isNull(config.publish);
    assert.deepStrictEqual(linux.target, ["AppImage"]);
    assert.strictEqual(linux.executableName, "t3-code-fork");
    assert.notProperty(linux, "protocols");
    assert.deepStrictEqual(linux.desktop, { entry: { StartupWMClass: "t3code-fork" } });
  }).pipe(Effect.provide(releaseRepositoryEnv)),
);

it.effect("keeps the upstream identity and feed for upstream versions", () =>
  Effect.gen(function* () {
    const config = yield* createBuildConfig(
      "linux",
      "AppImage",
      "0.1.1-nightly.20261019.3348",
      false,
      false,
      undefined,
      undefined,
    );
    const linux = config.linux as Record<string, unknown>;

    assert.strictEqual(config.productName, "T3 Code (Nightly)");
    assert.strictEqual(config.appId, "com.t3tools.t3code");
    assert.deepStrictEqual(config.publish, [
      {
        provider: "github",
        owner: "pingdotgg",
        repo: "t3code",
        releaseType: "prerelease",
        channel: "nightly",
      },
    ]);
    assert.strictEqual(linux.executableName, "t3code");
    assert.deepStrictEqual(linux.protocols, [
      { name: "T3 Code", schemes: ["t3code", "t3code-dev"] },
    ]);
  }).pipe(Effect.provide(releaseRepositoryEnv)),
);
