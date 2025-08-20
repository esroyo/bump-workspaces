// Copyright 2024 the Deno authors. All rights reserved. MIT license.
import { assertSnapshot } from "@std/testing/snapshot";
import { assertSpyCallArg, spy, stub } from "@std/testing/mock";
import { copy, exists } from "@std/fs";
import { bumpWorkspaces } from "./mod.ts";
import { join } from "@std/path";
import { tryGetDenoConfig, withGitContext } from "./util.ts";
import { assert, assertEquals } from "@std/assert";

// Note: The test cases in this file use git information in the branch `origin/base-branch-for-testing`.

Deno.test("bumpWorkspaces()", async (t) => {
  await withGitContext(async () => {
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
  }, { quiet: true });
});

Deno.test(
  "bumpWorkspaces() doesn't write things when dry run specified",
  async () => {
    await withGitContext(async () => {
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
    }, { quiet: true });
  },
);

Deno.test("bumpWorkspaces() handles no version bumps scenario", async () => {
  await withGitContext(async () => {
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
  }, { quiet: true });
});

Deno.test("bumpWorkspaces() individual tags and release notes mode with dry run", async (t) => {
  await withGitContext(async () => {
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
        releaseNotePath: "CHANGELOG.md", // Explicit override from default
        individualTags: true,
        individualReleaseNotes: true,
        _quiet: false,
      });

      // Verify that per-package mode was activated
      const logs = consoleSpy.calls.map((call) => call.args.join(" "));

      // Check that per-package mode was activated
      const perPackageLog = logs.find((log) =>
        log.includes("Using per-package strategy")
      );
      assertEquals(
        perPackageLog?.includes("Using per-package strategy"),
        true,
      );

      // Normalize paths in logs for snapshot consistency
      const normalizedLogs = logs.map((log) => {
        // Replace the actual temp directory path with a placeholder
        return log.replace(
          new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
          "/tmp/test-dir",
        ).replace(/\d{4}\.\d{2}\.\d{2}/g, "YYYY.MM.DD");
      });
      await assertSnapshot(t, normalizedLogs);
    } finally {
      consoleSpy.restore();
    }
  }, { quiet: true });
});

Deno.test("bumpWorkspaces() individual release notes with git dry run", async (t) => {
  await withGitContext(async () => {
    const dir = await Deno.makeTempDir();
    await copy("testdata/basic", dir, { overwrite: true });
    await bumpWorkspaces({
      dryRun: "git",
      githubRepo: "denoland/deno_std",
      githubToken: "1234567890",
      base: "origin/base-branch-for-testing",
      start: "start-tag-for-testing",
      root: dir,
      individualTags: false,
      individualReleaseNotes: true,
    });

    // Check that release notes were created in package directories
    const packageDirs = ["foo", "bar", "baz", "qux", "quux"];
    let releaseNoteCount = 0;

    for (const packageDir of packageDirs) {
      const changelogPath = join(dir, packageDir, "Releases.md");
      try {
        const content = await Deno.readTextFile(changelogPath);
        if (content.length > 0) {
          releaseNoteCount++;
        }

        // Verify individual notes have proper format with full module names
        assertEquals(
          content.includes(`### @scope/${packageDir}`),
          true,
          `Individual note should include full module name for ${packageDir}`,
        );
      } catch {
        // File doesn't exist, which is fine if package wasn't updated
      }
    }

    assertEquals(
      releaseNoteCount > 0,
      true,
      "Should have created package-level changelogs",
    );

    // Verify content of one package changelog if it exists
    for (const packageDir of packageDirs) {
      const changelogPath = join(dir, packageDir, "Releases.md");
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
  }, { quiet: true });
});

Deno.test("bumpWorkspaces() single-package release note format", async (t) => {
  await withGitContext(async () => {
    // Create a temporary single-package repo
    const dir = await Deno.makeTempDir();
    const singlePackageConfig = {
      name: "@test/single-package",
      version: "1.0.0",
      exports: "./mod.ts",
    };

    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify(singlePackageConfig, null, 2),
    );

    await bumpWorkspaces({
      dryRun: "git",
      githubRepo: "owner/repo",
      githubToken: "1234567890",
      base: "origin/base-branch-for-testing",
      start: "start-tag-for-testing",
      root: dir,
    });

    // Check that release note was created at root
    const releaseNotePath = join(dir, "Releases.md");
    const releaseNoteExists = await exists(releaseNotePath);
    assertEquals(releaseNoteExists, true, "Should create release note at root");

    if (releaseNoteExists) {
      const content = await Deno.readTextFile(releaseNotePath);

      // Should use simple format without module name redundancy
      assertEquals(
        content.includes("### 1.0.1") || content.includes("### [1.0.1]"), // Simple version heading
        true,
        "Should use simple version format for single package",
      );

      // Should NOT include module name in heading
      assertEquals(
        content.includes("#### @test/single-package"),
        false,
        "Should not include redundant module name in single-package format",
      );

      // Normalize for snapshot
      const normalizedContent = content.replace(
        /\d{4}\.\d{2}\.\d{2}/g,
        "YYYY.MM.DD",
      );
      await assertSnapshot(t, {
        type: "single-package",
        content: normalizedContent,
      });
    }
  }, { quiet: true });
});

Deno.test("bumpWorkspaces() individual release notes strategy (no workspace note)", async () => {
  await withGitContext(async () => {
    const dir = await Deno.makeTempDir();
    await copy("testdata/basic", dir, { overwrite: true });

    await bumpWorkspaces({
      dryRun: "git",
      githubRepo: "denoland/deno_std",
      githubToken: "1234567890",
      base: "origin/base-branch-for-testing",
      start: "start-tag-for-testing",
      root: dir,
      individualReleaseNotes: true,
    });

    // Check that NO workspace-level release note was created
    const workspaceReleaseNotePath = join(dir, "Releases.md");
    const workspaceNoteExists = await exists(workspaceReleaseNotePath);
    assertEquals(
      workspaceNoteExists,
      false,
      "Should NOT create workspace release note when using individual strategy",
    );

    // Check that individual release notes were created
    const packageDirs = ["foo", "bar", "baz", "qux", "quux"];
    let individualNotesCount = 0;

    for (const packageDir of packageDirs) {
      const packageReleaseNotePath = join(dir, packageDir, "Releases.md");
      try {
        const content = await Deno.readTextFile(packageReleaseNotePath);
        if (content.length > 0) {
          individualNotesCount++;

          // Verify individual note format includes module name
          assertEquals(
            content.includes(`### @scope/${packageDir}`),
            true,
            `Individual note should include module name for ${packageDir}`,
          );
        }
      } catch {
        // File doesn't exist, which is fine if package wasn't updated
      }
    }

    assertEquals(
      individualNotesCount > 0,
      true,
      "Should have created individual release notes",
    );
  }, { quiet: true });
});

Deno.test("bumpWorkspaces() workspace strategy (consolidated note only)", async () => {
  await withGitContext(async () => {
    const dir = await Deno.makeTempDir();
    await copy("testdata/basic", dir, { overwrite: true });

    await bumpWorkspaces({
      dryRun: "git",
      githubRepo: "denoland/deno_std",
      githubToken: "1234567890",
      base: "origin/base-branch-for-testing",
      start: "start-tag-for-testing",
      root: dir,
      individualReleaseNotes: false, // Explicit default
    });

    // Check that workspace-level release note was created
    const workspaceReleaseNotePath = join(dir, "Releases.md");
    const workspaceNoteExists = await exists(workspaceReleaseNotePath);
    assertEquals(
      workspaceNoteExists,
      true,
      "Should create workspace release note for default strategy",
    );

    // Check that NO individual release notes were created
    const packageDirs = ["foo", "bar", "baz", "qux", "quux"];

    for (const packageDir of packageDirs) {
      const packageReleaseNotePath = join(dir, packageDir, "Releases.md");
      const individualNoteExists = await exists(packageReleaseNotePath);
      assertEquals(
        individualNoteExists,
        false,
        `Should NOT create individual release note for ${packageDir} in workspace strategy`,
      );
    }

    // Verify workspace note format includes module names in headers
    const content = await Deno.readTextFile(workspaceReleaseNotePath);
    assertEquals(
      content.includes("#### @scope/"),
      true,
      "Workspace note should include module names in headers",
    );
  }, { quiet: true });
});

Deno.test(
  "bumpWorkspaces() dry-run shows individual release notes preview",
  async (t) => {
    await withGitContext(async () => {
      const dir = await Deno.makeTempDir();
      await copy("testdata/basic", dir, { overwrite: true });

      const consoleSpy = spy(console, "log");

      try {
        await bumpWorkspaces({
          dryRun: true, // Key: this is dry-run
          githubRepo: "denoland/deno_std",
          githubToken: "1234567890",
          base: "origin/base-branch-for-testing",
          start: "start-tag-for-testing",
          root: dir,
          individualReleaseNotes: true, // Key: individual notes requested
          _quiet: false, // Don't suppress console output
        });

        const logs = consoleSpy.calls.map((call) => call.args.join(" "));

        // Should show individual release notes preview
        const hasIndividualNotesHeader = logs.some((log) =>
          log.includes("Individual release notes that would be created")
        );
        assertEquals(
          hasIndividualNotesHeader,
          true,
          "Should show header for individual release notes preview",
        );

        // Should show file paths for each package
        const hasPackageFilePaths = logs.some((log) =>
          log.includes("📄") && log.includes("Releases.md")
        );
        assertEquals(
          hasPackageFilePaths,
          true,
          "Should show file paths for individual release notes",
        );

        // Should show release note content (with package names)
        const hasPackageContent = logs.some((log) => log.includes("### @scope/") // Package release notes have module names
        );
        assertEquals(
          hasPackageContent,
          true,
          "Should show individual release note content",
        );

        // Should explicitly state no workspace note
        const hasNoWorkspaceNote = logs.some((log) =>
          log.includes("No workspace-level release note would be created")
        );
        assertEquals(
          hasNoWorkspaceNote,
          true,
          "Should state that no workspace note will be created",
        );

        // Should NOT show workspace release note content
        const hasWorkspaceReleaseNote = logs.some((log) =>
          log.includes("The release note:") // This is the workspace note header
        );
        assertEquals(
          hasWorkspaceReleaseNote,
          false,
          "Should NOT show workspace release note when using individual strategy",
        );

        // Normalize paths and snapshot the preview output
        const normalizedLogs = logs.map((log) => {
          return log.replace(
            new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
            "/tmp/test-dir",
          ).replace(
            /\d{4}\.\d{2}\.\d{2}/g,
            "YYYY.MM.DD",
          );
        });

        await assertSnapshot(t, {
          type: "dry-run-individual-notes-preview",
          logs: normalizedLogs,
        });
      } finally {
        consoleSpy.restore();
      }
    }, { quiet: true });
  },
);

Deno.test(
  "bumpWorkspaces() dry-run shows single-package release note preview",
  async (_t) => {
    await withGitContext(async () => {
      // Create a temporary single-package repo
      const dir = await Deno.makeTempDir();
      const singlePackageConfig = {
        name: "@test/single-package",
        version: "1.0.0",
        exports: "./mod.ts",
      };

      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify(singlePackageConfig, null, 2),
      );

      const consoleSpy = spy(console, "log");

      try {
        await bumpWorkspaces({
          dryRun: true,
          githubRepo: "owner/repo",
          githubToken: "1234567890",
          base: "origin/base-branch-for-testing",
          start: "start-tag-for-testing",
          root: dir,
          individualReleaseNotes: true, // This should be ignored for single-package
          _quiet: false,
        });

        const logs = consoleSpy.calls.map((call) => call.args.join(" "));

        // Should show "The release note:" header (single note)
        const hasReleaseNoteHeader = logs.some((log) =>
          log.includes("The release note:")
        );
        assertEquals(
          hasReleaseNoteHeader,
          true,
          "Should show single release note header for single-package repo",
        );

        // Should show simple format (version without module name)
        const hasSimpleFormat = logs.some((log) =>
          (log.includes("### 1.0.1") || log.includes("### [1.0.1]")) &&
          !log.includes("#### @test/single-package")
        );
        assertEquals(
          hasSimpleFormat,
          true,
          "Should show simple format without redundant module name",
        );

        // Should NOT show individual notes messaging
        const hasIndividualNotesHeader = logs.some((log) =>
          log.includes("Individual release notes that would be created")
        );
        assertEquals(
          hasIndividualNotesHeader,
          false,
          "Should NOT show individual notes messaging for single-package repo",
        );
      } finally {
        consoleSpy.restore();
      }
    }, { quiet: true });
  },
);

Deno.test("bumpWorkspaces() dry-run shows workspace release note preview", async (_t) => {
  await withGitContext(async () => {
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
        individualReleaseNotes: false, // Workspace strategy
        _quiet: false,
      });

      const logs = consoleSpy.calls.map((call) => call.args.join(" "));

      // Should show "The release note:" header
      const hasReleaseNoteHeader = logs.some((log) =>
        log.includes("The release note:")
      );
      assertEquals(
        hasReleaseNoteHeader,
        true,
        "Should show workspace release note header",
      );

      // Should show workspace format (with module names in headers)
      const hasWorkspaceFormat = logs.some((log) => log.includes("#### @scope/") // Workspace notes have module names in headers
      );
      assertEquals(
        hasWorkspaceFormat,
        true,
        "Should show workspace format with module names in headers",
      );

      // Should NOT show individual notes messaging
      const hasIndividualNotesHeader = logs.some((log) =>
        log.includes("Individual release notes that would be created")
      );
      assertEquals(
        hasIndividualNotesHeader,
        false,
        "Should NOT show individual notes messaging for workspace strategy",
      );
    } finally {
      consoleSpy.restore();
    }
  }, { quiet: true });
});

Deno.test("bumpWorkspaces() handles unknown branch error", async () => {
  await withGitContext(async () => {
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
  }, { quiet: true });
});

Deno.test("bumpWorkspaces() handles missing environment variables", async () => {
  await withGitContext(async () => {
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
  }, { quiet: true });
});

Deno.test("bumpWorkspaces() with consolidated tags (individualTags=false)", async () => {
  await withGitContext(async () => {
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
        individualTags: false, // This should create consolidated tags
        gitTag: true,
        _quiet: false,
      });

      // Verify consolidated tag creation behavior through console output
      const logCalls = consoleSpy.calls.map((call) => call.args.join(" "));

      // Should log about creating consolidated tags (not individual package tags)
      const hasConsolidatedTagLog = logCalls.some((log) =>
        log.match(/^release-\d+\.\d+\.\d+$/)
      );

      assertEquals(
        hasConsolidatedTagLog,
        true,
        "Should log consolidated tag creation (release-YYYY.MM.DD format)",
      );

      // Should NOT have individual package tag logs
      const hasIndividualTagLog = logCalls.some((log) =>
        log.match(/^@scope\/[^@ ]+@\d+\.\d+\.\d+$/)
      );

      assertEquals(
        hasIndividualTagLog,
        false,
        "Should not create individual package tags when individualTags=false",
      );
    } finally {
      consoleSpy.restore();
    }
  }, { quiet: true });
});

Deno.test("bumpWorkspaces() with individual tags (individualTags=true)", async () => {
  await withGitContext(async () => {
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
        individualTags: true, // This should create individual package tags
        gitTag: true,
        _quiet: false,
      });

      // Verify individual tag creation behavior through console output
      const logCalls = consoleSpy.calls.map((call) => call.args.join(" "));

      // Should log about creating individual package tags
      const hasIndividualTagLog = logCalls.some((log) =>
        log.includes("@scope/") && log.includes("@")
      );

      assertEquals(
        hasIndividualTagLog,
        true,
        "Should log individual package tag creation (@scope/package@version format)",
      );

      // Should NOT have consolidated tag logs
      const hasConsolidatedTagLog = logCalls.some((log) =>
        log.includes("release-") && !log.includes("@scope/")
      );

      assertEquals(
        hasConsolidatedTagLog,
        false,
        "Should not create consolidated tags when individualTags=true",
      );
    } finally {
      consoleSpy.restore();
    }
  }, { quiet: true });
});

Deno.test("bumpWorkspaces() with gitTag=false (default)", async () => {
  await withGitContext(async () => {
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
        gitTag: false, // Explicitly disable tag creation
        _quiet: false,
      });

      // Verify no tag creation logs
      const logCalls = consoleSpy.calls.map((call) => call.args.join(" "));

      // Should NOT have any tag-related logs
      const hasTagLog = logCalls.some((log) =>
        log.includes("Tags that would be created") ||
        log.includes("Created tag") ||
        log.includes("Tag")
      );

      assertEquals(
        hasTagLog,
        false,
        "Should not log any tag creation when gitTag=false",
      );
    } finally {
      consoleSpy.restore();
    }
  }, { quiet: true });
});

Deno.test("bumpWorkspaces() single package repo handling", async () => {
  await withGitContext(async () => {
    // Create a temporary single-package repo
    const dir = await Deno.makeTempDir();
    const singlePackageConfig = {
      name: "@test/single-package",
      version: "1.0.0",
      exports: "./mod.ts",
    };

    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify(singlePackageConfig, null, 2),
    );

    const consoleSpy = spy(console, "log");

    try {
      await bumpWorkspaces({
        dryRun: true,
        base: "origin/base-branch-for-testing",
        start: "start-tag-for-testing",
        root: dir,
        _quiet: false,
      });

      // Verify single package detection
      const logCalls = consoleSpy.calls.map((call) => call.args.join(" "));
      const hasSinglePackageLog = logCalls.some((log) =>
        log.includes("Processing single package")
      );

      assertEquals(
        hasSinglePackageLog,
        true,
        "Should detect and log single package mode",
      );
    } finally {
      consoleSpy.restore();
      await Deno.remove(dir, { recursive: true });
    }
  }, { quiet: true });
});

Deno.test("bumpWorkspaces() workspace repo handling", async () => {
  await withGitContext(async () => {
    const dir = await Deno.makeTempDir();
    await copy("testdata/basic", dir, { overwrite: true });

    const consoleSpy = spy(console, "log");

    try {
      await bumpWorkspaces({
        dryRun: true,
        base: "origin/base-branch-for-testing",
        start: "start-tag-for-testing",
        root: dir,
        _quiet: false,
      });

      // Verify workspace detection
      const logCalls = consoleSpy.calls.map((call) => call.args.join(" "));
      const hasWorkspaceLog = logCalls.some((log) =>
        log.includes("Processing workspace with") && log.includes("packages")
      );

      assertEquals(
        hasWorkspaceLog,
        true,
        "Should detect and log workspace mode",
      );
    } finally {
      consoleSpy.restore();
    }
  }, { quiet: true });
});
