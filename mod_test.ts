// Copyright 2024 the Deno authors. All rights reserved. MIT license.

import { assertSnapshot } from "@std/testing/snapshot";
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

Deno.test("bumpWorkspaces() per-package mode with dry run", async (t) => {
  await withGitContextForTesting(async () => {
    const dir = await Deno.makeTempDir();
    await copy("testdata/basic", dir, { overwrite: true });
    // Capture console output
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args) => {
      logs.push(args.join(" "));
      originalLog(...args);
    };

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
      });

      // Check that per-package mode was activated
      const perPackageLog = logs.find(log => log.includes("Publishing per-package mode"));
      assertEquals(perPackageLog?.includes("Publishing per-package mode"), true);

      // Check that package-specific information is shown
      const packageLogs = logs.filter(log => log.includes("Package: @scope/"));
      assertEquals(packageLogs.length > 0, true);

      // Verify dry run mentions what would be done
      const tagLogs = logs.filter(log => log.includes("Would create tag:"));
      assertEquals(tagLogs.length > 0, true);

      const prLogs = logs.filter(log => log.includes("Would create individual PR"));
      assertEquals(prLogs.length > 0, true);

      // Normalize paths in logs for snapshot consistency
      const normalizedLogs = logs.map(log => {
        // Replace the actual temp directory path with a placeholder
        return log.replace(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '/tmp/test-dir');
      });
      await assertSnapshot(t, normalizedLogs);
    } finally {
      console.log = originalLog;
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

    assertEquals(releaseNoteCount > 0, true, "Should have created package-level changelogs");
    assertEquals(workspaceContent.length > 0, true, "Should have created workspace-level changelog");

    // Verify content of one package changelog if it exists
    for (const packageDir of packageDirs) {
      const changelogPath = join(dir, packageDir, "CHANGELOG.md");
      try {
        const content = await Deno.readTextFile(changelogPath);
        if (content.length > 0) {
          const normalizedContent = content.replace(/\d{4}\.\d{2}\.\d{2}/g, "YYYY.MM.DD");
          await assertSnapshot(t, { packageDir, content: normalizedContent });
          break; // Only snapshot one for the test
        }
      } catch {
        // Continue to next package
      }
    }
  });
});
