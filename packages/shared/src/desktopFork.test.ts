import { assert, describe, it } from "@effect/vitest";

import {
  DESKTOP_FORK_IDENTITY,
  formatDesktopForkVersion,
  resolveDesktopForkEnvironment,
  resolveDesktopForkIdentity,
} from "./desktopFork.ts";

describe("formatDesktopForkVersion", () => {
  it("stamps the release with the commit date and hash", () => {
    assert.strictEqual(
      formatDesktopForkVersion({
        baseVersion: "0.1.0",
        commitDate: "20261020",
        commit: "EFFB4337",
        dirty: false,
      }),
      "0.1.0-fork.20261020.geffb4337",
    );
  });

  it("marks an uncommitted tree and drops an upstream prerelease tag", () => {
    assert.strictEqual(
      formatDesktopForkVersion({
        baseVersion: "0.1.1-nightly.20261019.3348",
        commitDate: "20261020",
        commit: "0123456",
        dirty: true,
      }),
      "0.1.1-fork.20261020.g0123456.dirty",
    );
  });
});

describe("resolveDesktopForkIdentity", () => {
  it("gives stamped fork versions the fork identity", () => {
    for (const version of [
      formatDesktopForkVersion({
        baseVersion: "0.1.0",
        commitDate: "20261020",
        commit: "0123456",
        dirty: false,
      }),
      "0.1.0-fork.20261020.geffb4337.dirty",
    ]) {
      assert.strictEqual(resolveDesktopForkIdentity(version), DESKTOP_FORK_IDENTITY, version);
    }
  });

  it("leaves upstream versions on upstream behavior", () => {
    for (const version of [
      "0.1.0",
      "0.1.1-nightly.20261019.3348",
      "0.1.1-preview.20261019.12",
      "0.1.1-pr.123",
      "0.1.0-fork",
      "0.1.0-fork.20261020.effb4337",
    ]) {
      assert.strictEqual(resolveDesktopForkIdentity(version), undefined, version);
    }
  });
});

describe("resolveDesktopForkEnvironment", () => {
  it("moves the T3 home and turns off telemetry and updates", () => {
    assert.deepStrictEqual(resolveDesktopForkEnvironment("/home/user"), {
      T3CODE_HOME: "/home/user/.t3-fork",
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_DISABLE_AUTO_UPDATE: "1",
    });
  });
});
