// Copyright 2024 the Deno authors. All rights reserved. MIT license.

import { assertSnapshot } from "@std/testing/snapshot";
import { assertSpyCallArg, spy, stub } from "@std/testing/mock";
import { copy, exists } from "@std/fs";
import { bumpWorkspaces } from "./mod.ts";
import { join } from "@std/path";
import { tryGetDenoConfig, withGitContextForTesting } from "./util.ts";
import { assert, assertEquals } from "@std/assert";

// Note: The test cases in this file use git information in the branch `origin/base-branch-for-testing`.

Deno.test("bumpWorkspaces()", async (t) => {
  await withGitContextForTesting(async () => {
    const dir = await Deno.makeTempDir();
    await copy("testdata/basic", dir, { overwrite: true });
    await bumpWorkspaces({
      dryRun: "git",
      githubRepo: "denoland/deno_std",
      githubToken: "1234567890",
      base: "origin/base-branch-for-testing",
      start: "start-tag-for-testing",
      root: dir,
    });

    const releaseNote = await Deno.readTextFile(join(dir, "Releases.md"));
    await assertSnapshot(
      t,
      releaseNote.replace(/^### \d+\.\d+\.\d+/, "### YYYY.MM.DD"),
    );

    let _, config;
    [_, config] = await tryGetDenoConfig(dir);
    assertEquals(config, {
      imports: {
        "@scope/foo": "jsr:@scope/foo@^2.0.0",
        "@scope/foo/": "jsr:@scope/foo@^2.0.0/",
        "@scope/bar": "jsr:@scope/bar@^2.3.5",
        "@scope/bar/": "jsr:@scope/bar@^2.3.5/",
        "@scope/baz": "jsr:@scope/baz@^0.2.4",
        "@scope/baz/": "jsr:@scope/baz@^0.2.4/",
        "@scope/qux": "jsr:@scope/qux@^0.3.5",
        "@scope/qux/": "jsr:@scope/qux@^0.3.5/",
        "@scope/quux": "jsr:@scope/quux@^0.1.0",
        "@scope/quux/": "jsr:@scope/quux@^0.1.0/",
      },
      workspace: ["./foo", "./bar", "./baz", "./qux", "./quux"],
    });
    [_, config] = await tryGetDenoConfig(join(dir, "foo"));
    assertEquals(config, {
      name: "@scope/foo",
      version: "2.0.0",
    });
    [_, config] = await tryGetDenoConfig(join(dir, "bar"));
    assertEquals(config, {
      name: "@scope/bar",
      version: "2.3.5",
    });
    [_, config] = await tryGetDenoConfig(join(dir, "baz"));
    assertEquals(config, {
      name: "@scope/baz",
      version: "0.2.4",
    });
    [_, config] = await tryGetDenoConfig(join(dir, "qux"));
    assertEquals(config, {
      name: "@scope/qux",
      version: "0.3.5",
    });
    [_, config] = await tryGetDenoConfig(join(dir, "quux"));
    assertEquals(config, {
      name: "@scope/quux",
      version: "0.1.0",
    });
  });
});

Deno.test(
  "bumpWorkspaces() doesn't write things when dry run specified",
  async () => {
    await withGitContextForTesting(async () => {
      const dir = await Deno.makeTempDir();
      await copy("testdata/basic", dir, { overwrite: true });
      await bumpWorkspaces({
        dryRun: true,
        githubRepo: "denoland/deno_std",
        githubToken: "1234567890",
        base: "origin/base-branch-for-testing",
        start: "start-tag-for-testing",
        root: dir,
      });

      assert(!(await exists(join(dir, "Releases.md"))));

      const [_, config] = await tryGetDenoConfig(dir);
      assertEquals(config, {
        imports: {
          "@scope/foo": "jsr:@scope/foo@^1.2.3",
          "@scope/foo/": "jsr:@scope/foo@^1.2.3/",
          "@scope/bar": "jsr:@scope/bar@^2.3.4",
          "@scope/bar/": "jsr:@scope/bar@^2.3.4/",
          "@scope/baz": "jsr:@scope/baz@^0.2.3",
          "@scope/baz/": "jsr:@scope/baz@^0.2.3/",
          "@scope/qux": "jsr:@scope/qux@^0.3.4",
          "@scope/qux/": "jsr:@scope/qux@^0.3.4/",
          "@scope/quux": "jsr:@scope/quux@^0.0.0",
          "@scope/quux/": "jsr:@scope/quux@^0.0.0/",
        },
        workspace: ["./foo", "./bar", "./baz", "./qux", "./quux"],
      });
    });
  },
);

Deno.test("bumpWorkspaces() handles no version bumps scenario", async () => {
  await withGitContextForTesting(async () => {
    const dir = await Deno.makeTempDir();
    await copy("testdata/basic", dir, { overwrite: true });

    const consoleSpy = spy(console, "log");

    try {
      // Use the same start and base to ensure no commits = no bumps
      await bumpWorkspaces({
        dryRun: true,
        githubRepo: "denoland/deno_std",
        githubToken: "1234567890",
        base: "start-tag-for-testing", // Same as start
        start: "start-tag-for-testing", // Same as base
        root: dir,
        _quiet: false, // Don't suppress the "No version bumps" message
      });

      // Verify the "No version bumps" message was logged
      const logCalls = consoleSpy.calls.map((call) => call.args.join(" "));
      const hasNoVersionBumpsLog = logCalls.some((log) =>
        log.includes("No version bumps")
      );
      assertEquals(
        hasNoVersionBumpsLog,
        true,
        "Should log 'No version bumps' message",
      );
    } finally {
      consoleSpy.restore();
    }
  });
});

Deno.test("bumpWorkspaces() per-package mode with dry run", async (t) => {
  await withGitContextForTesting(async () => {
    const dir = await Deno.makeTempDir();
    await copy("testdata/basic", dir, { overwrite: true });

    const consoleSpy = spy(console, "log");

    try {
      await bumpWorkspaces({
        dryRun: true,
        githubRepo: "denoland/deno_std",
        githubToken: "1234567890",
        base: "origin/base-branch-for-testing",
        start: "start-tag-for-testing",
        root: dir,
        releaseNotePath: "CHANGELOG.md",
        publishMode: "per-package",
        individualPRs: true,
        individualTags: true,
        individualReleaseNotes: true,
        _quiet: true, // suppress extra logging
      });

      // Verify that individual PR creation was logged
      const logs = consoleSpy.calls.map((call) => call.args.join(" "));

      // Check that per-package mode was activated
      const perPackageLog = logs.find((log) =>
        log.includes("Publishing per-package mode")
      );
      assertEquals(
        perPackageLog?.includes("Publishing per-package mode"),
        true,
      );

      // Check that package-specific information is shown
      const packageLogs = logs.filter((log) =>
        log.includes("Package: @scope/")
      );
      assertEquals(packageLogs.length > 0, true);

      // Verify dry run mentions what would be done
      const tagLogs = logs.filter((log) => log.includes("Would create tag:"));
      assertEquals(tagLogs.length > 0, true);

      const prLogs = logs.filter((log) =>
        log.includes("Would create individual PR")
      );
      assertEquals(prLogs.length > 0, true);

      // Normalize paths in logs for snapshot consistency
      const normalizedLogs = logs.map((log) => {
        // Replace the actual temp directory path with a placeholder
        return log.replace(
          new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
          "/tmp/test-dir",
        ).replace(
          /^### (\S+ )?(\d+\.\d+\.\d+ )\(\d+\.\d+\.\d+\)$/gm,
          "### $1$2(YYYY.MM.DD)",
        );
      });
      await assertSnapshot(t, normalizedLogs);
    } finally {
      consoleSpy.restore();
    }
  });
});

Deno.test("bumpWorkspaces() per-package mode with git dry run", async (t) => {
  await withGitContextForTesting(async () => {
    const dir = await Deno.makeTempDir();
    await copy("testdata/basic", dir, { overwrite: true });
    await bumpWorkspaces({
      dryRun: "git",
      githubRepo: "denoland/deno_std",
      githubToken: "1234567890",
      base: "origin/base-branch-for-testing",
      start: "start-tag-for-testing",
      root: dir,
      publishMode: "per-package",
      individualPRs: false, // Single PR mode
      individualTags: false,
      individualReleaseNotes: true,
    });

    // Check that release notes were created in package directories
    const packageDirs = ["foo", "bar", "baz", "qux", "quux"];
    let releaseNoteCount = 0;

    for (const packageDir of packageDirs) {
      const changelogPath = join(dir, packageDir, "CHANGELOG.md");
      try {
        const content = await Deno.readTextFile(changelogPath);
        if (content.length > 0) {
          releaseNoteCount++;
        }
      } catch {
        // File doesn't exist, which is fine if package wasn't updated
      }
    }

    // Also check workspace-level changelog
    const workspaceChangelogPath = join(dir, "CHANGELOG.md");
    const workspaceContent = await Deno.readTextFile(workspaceChangelogPath);

    assertEquals(
      releaseNoteCount > 0,
      true,
      "Should have created package-level changelogs",
    );
    assertEquals(
      workspaceContent.length > 0,
      true,
      "Should have created workspace-level changelog",
    );

    // Verify content of one package changelog if it exists
    for (const packageDir of packageDirs) {
      const changelogPath = join(dir, packageDir, "CHANGELOG.md");
      try {
        const content = await Deno.readTextFile(changelogPath);
        if (content.length > 0) {
          const normalizedContent = content.replace(
            /\d{4}\.\d{2}\.\d{2}/g,
            "YYYY.MM.DD",
          );
          await assertSnapshot(t, { packageDir, content: normalizedContent });
          break; // Only snapshot one for the test
        }
      } catch {
        // Continue to next package
      }
    }
  });
});

Deno.test("bumpWorkspaces() - per-package mode with single PR", async () => {
  await withGitContextForTesting(async () => {
    const dir = await Deno.makeTempDir();
    await copy("testdata/basic", dir, { overwrite: true });

    const consoleSpy = spy(console, "log");

    try {
      await bumpWorkspaces({
        dryRun: "git",
        githubRepo: "denoland/deno_std",
        githubToken: "1234567890",
        base: "origin/base-branch-for-testing",
        start: "start-tag-for-testing",
        root: dir,
        publishMode: "per-package",
        individualPRs: false, // Single PR, not individual
        individualTags: true,
        individualReleaseNotes: true,
        _quiet: false,
      });

      // Verify it used single PR mode, not individual PRs
      const logCalls = consoleSpy.calls.map((call) => call.args.join(" "));
      const hasSinglePRLog = logCalls.some((log) =>
        log.includes("Creating single PR") ||
        log.includes("per-package breakdown") ||
        log.includes("Would create branch:")
      );
      assertEquals(
        hasSinglePRLog,
        true,
        "Should log single PR creation with per-package breakdown",
      );

      // Should NOT have individual PR logs
      const hasIndividualPRLog = logCalls.some((log) =>
        log.includes("Creating individual PR") ||
        log.includes("individual PR creation")
      );
      assertEquals(
        hasIndividualPRLog,
        false,
        "Should not create individual PRs when individualPRs=false",
      );
    } finally {
      consoleSpy.restore();
    }
  });
});

Deno.test("bumpWorkspaces() handles unknown branch error", async () => {
  await withGitContextForTesting(async () => {
    const dir = await Deno.makeTempDir();
    await copy("testdata/basic", dir, { overwrite: true });

    const exitSpy = stub(Deno, "exit", function () {} as typeof Deno.exit);

    // This should trigger the unknown branch error path
    try {
      await bumpWorkspaces({
        dryRun: false, // Not dry run to hit environment variable checks
        base: "unknown", // This should trigger the error
        root: dir,
      });
      assert(false, "Should have thrown an error");
    } catch {
      // Expected - process will exit
      assertSpyCallArg(exitSpy, 0, 0, 1);
    } finally {
      exitSpy.restore();
    }
  });
});

Deno.test("bumpWorkspaces() handles missing environment variables", async () => {
  await withGitContextForTesting(async () => {
    const dir = await Deno.makeTempDir();
    await copy("testdata/basic", dir, { overwrite: true });

    const exitSpy = stub(Deno, "exit", function () {} as typeof Deno.exit);

    // Clear environment variables to trigger the error paths
    const originalEnv = {
      GIT_USER_NAME: Deno.env.get("GIT_USER_NAME"),
      GIT_USER_EMAIL: Deno.env.get("GIT_USER_EMAIL"),
      GITHUB_TOKEN: Deno.env.get("GITHUB_TOKEN"),
      GITHUB_REPOSITORY: Deno.env.get("GITHUB_REPOSITORY"),
    };

    // Clear env vars
    Deno.env.delete("GIT_USER_NAME");
    Deno.env.delete("GIT_USER_EMAIL");
    Deno.env.delete("GITHUB_TOKEN");
    Deno.env.delete("GITHUB_REPOSITORY");

    try {
      await bumpWorkspaces({
        dryRun: false, // Must be false to hit env var checks
        base: "origin/base-branch-for-testing",
        start: "start-tag-for-testing",
        root: dir,
      });
      assert(false, "Should have exited due to missing env vars");
    } catch {
      // Expected - will exit due to missing env vars
      assertSpyCallArg(exitSpy, 0, 0, 1);
    } finally {
      exitSpy.restore();
      // Restore env vars
      if (originalEnv.GIT_USER_NAME) {
        Deno.env.set("GIT_USER_NAME", originalEnv.GIT_USER_NAME);
      }
      if (originalEnv.GIT_USER_EMAIL) {
        Deno.env.set("GIT_USER_EMAIL", originalEnv.GIT_USER_EMAIL);
      }
      if (originalEnv.GITHUB_TOKEN) {
        Deno.env.set("GITHUB_TOKEN", originalEnv.GITHUB_TOKEN);
      }
      if (originalEnv.GITHUB_REPOSITORY) {
        Deno.env.set("GITHUB_REPOSITORY", originalEnv.GITHUB_REPOSITORY);
      }
    }
  });
});

Deno.test("createIndividualPRs() with dry run mode", async () => {
  await withGitContextForTesting(async () => {
    const dir = await Deno.makeTempDir();
    await copy("testdata/basic", dir, { overwrite: true });

    const consoleSpy = spy(console, "log");

    try {
      await bumpWorkspaces({
        dryRun: "git", // This should exercise createIndividualPRs with git dry run
        githubRepo: "denoland/deno_std",
        githubToken: "1234567890",
        base: "origin/base-branch-for-testing",
        start: "start-tag-for-testing",
        root: dir,
        publishMode: "per-package",
        individualPRs: true, // This triggers createIndividualPRs
        _quiet: false, // Don't suppress logging
      });

      // Verify that individual PR creation was logged
      const logCalls = consoleSpy.calls.map((call) => call.args.join(" "));
      const hasIndividualPRLog = logCalls.some((log) =>
        log.includes("Git dry run mode - skipping individual PR creation") ||
        log.includes("Would create branch:") ||
        log.includes("Would create PR:")
      );
      assertEquals(
        hasIndividualPRLog,
        true,
        "Should log individual PR dry run actions",
      );
    } finally {
      consoleSpy.restore();
    }
  });
});

Deno.test("createIndividualTags() functionality", async () => {
  await withGitContextForTesting(async () => {
    const dir = await Deno.makeTempDir();
    await copy("testdata/basic", dir, { overwrite: true });

    const consoleSpy = spy(console, "log");

    try {
      await bumpWorkspaces({
        dryRun: true,
        githubRepo: "denoland/deno_std",
        githubToken: "1234567890",
        base: "origin/base-branch-for-testing",
        start: "start-tag-for-testing",
        root: dir,
        publishMode: "per-package",
        individualTags: true, // This should exercise createIndividualTags
        createTags: true,
        _quiet: false,
      });

      // Verify createIndividualTags behavior through console output
      const logCalls = consoleSpy.calls.map((call) => call.args.join(" "));

      // Should log about creating individual tags
      const hasTagCreationLog = logCalls.some((log) =>
        log.includes("Creating individual tags") ||
        log.includes("Creating tag:") ||
        log.includes("Would create tag:")
      );

      assertEquals(
        hasTagCreationLog,
        true,
        "Should log individual tag creation",
      );
    } finally {
      consoleSpy.restore();
    }
  });
});
