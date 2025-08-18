// Copyright 2024 the Deno authors. All rights reserved. MIT license.
import { $ } from "@david/dax";
import { cyan, magenta } from "@std/fmt/colors";

/**
 * Upgrade the versions of the packages in the workspace using Conventional Commits rules.
 *
 * The workflow of this function is:
 * - Read workspace info from the deno.json in the given `root`.
 * - Read commit messages between the given `start` and `base`.
 *   - `start` defaults to the latest tag in the current branch (=`git describe --tags --abbrev=0`)
 *   - `base` defaults to the current branch (=`git branch --show-current`)
 * - Detect necessary version updates from the commit messages.
 * - Update the versions in the deno.json files.
 * - Create a release note.
 * - Create a git commit with given `gitUserName` and `gitUserEmail`.
 * - Create a pull request, targeting the given `base` branch.
 *
 * @module
 */

import {
  applyVersionBump,
  checkModuleName,
  type Commit,
  createPullRequest,
  createReleaseBranchName,
  defaultParseCommitMessage,
  type Diagnostic,
  getCurrentGitBranch,
  getModule,
  getSmartStartTag,
  getWorkspaceModules,
  pathProp,
  summarizeVersionBumpsByModule,
  tryGetDenoConfig,
  type VersionBump,
  type VersionUpdateResult,
  withGitContext,
  type WorkspaceModule,
} from "./util.ts";

// A random separator that is unlikely to be in a commit message.
const separator = "#%$".repeat(35);

/** The option for {@linkcode bumpWorkspaces} */
export type BumpWorkspaceOptions = {
  /** The git tag or commit hash to start from. The default is the latest tag. */
  start?: string;
  /** The base branch name to compare commits. The default is the current branch. */
  base?: string;
  parseCommitMessage?: (
    commit: Commit,
    workspaceModules: WorkspaceModule[],
  ) => VersionBump[] | Diagnostic;
  /** The root directory of the workspace. */
  root?: string;
  /** The git user name which is used for making a commit */
  gitUserName?: string;
  /** The git user email which is used for making a commit */
  gitUserEmail?: string;
  /** The github token e.g. */
  githubToken?: string;
  /** The github repository e.g. denoland/deno_std */
  githubRepo?: string;
  /** Perform all operations if false.
   * Doesn't perform file edits and network operations when true.
   * Perform fs ops, but doesn't perform git operations when "network" */
  dryRun?: boolean | "git";
  /** The import map path. Default is deno.json(c) at the root. */
  importMap?: string;
  /** The path to release note markdown file. Default: "Releases.md" */
  releaseNotePath?: string;
  /** Whether to create individual git tags for each package. Default: false */
  individualTags?: boolean;
  /** Whether to create individual release notes for each package. Default: false */
  individualReleaseNotes?: boolean;
  /** Internal option: suppress additional logging (used for testing) */
  _quiet?: boolean;
  /** Whether to create and push git tags automatically. Default: false (for compatibility) */
  gitTag?: boolean;
};

/**
 * Upgrade the versions of the packages in the workspace using Conventional Commits rules.
 */
export async function bumpWorkspaces(
  {
    parseCommitMessage = defaultParseCommitMessage,
    start,
    base,
    gitUserName,
    gitUserEmail,
    githubToken,
    githubRepo,
    dryRun = false,
    importMap,
    releaseNotePath,
    root = ".",
    individualTags = false,
    individualReleaseNotes = false,
    gitTag = false,
    _quiet = false,
  }: BumpWorkspaceOptions = {},
): Promise<void> {
  return withGitContext(async () => {
    const now = new Date();

    base ??= await getCurrentGitBranch();
    if (!base || base === "unknown") {
      console.error("The current branch is not found.");
      Deno.exit(1);
    }

    // Set default release note path - always Releases.md for predictability
    if (!releaseNotePath) {
      releaseNotePath = "Releases.md";
    }

    // Get current modules first to determine repository type
    const [configPath, modules] = await getWorkspaceModules(root, {
      quiet: _quiet,
    });

    // Determine if this is a single-package repo
    const isSinglePackage = modules.length === 1 &&
      modules[0][pathProp] === configPath;

    if (!start) {
      start = await getSmartStartTag(
        individualTags,
        modules,
        isSinglePackage,
        _quiet,
      );
    }

    // Only log package type info when not in quiet mode
    if (!_quiet) {
      if (isSinglePackage) {
        console.log(`Processing single package: ${cyan(modules[0].name)}`);
      } else {
        console.log(
          `Processing workspace with ${
            cyan(modules.length.toString())
          } packages`,
        );

        // Log the strategy being used
        if (individualTags && individualReleaseNotes) {
          console.log(
            "Using per-package strategy (individual tags + individual release notes)",
          );
        } else if (individualTags) {
          console.log("Using individual tags with consolidated release notes");
        } else if (individualReleaseNotes) {
          console.log("Using individual release notes with consolidated tag");
        } else {
          console.log(
            "Using workspace strategy (consolidated tag + consolidated release notes)",
          );
        }
      }
    }

    // For historical comparison, use a safe approach
    let oldModules: WorkspaceModule[];

    if (isSinglePackage) {
      // For single-package repos, try to get historical version safely
      try {
        await $`git checkout ${start}`;

        // Try to read the historical deno.json
        const [historicalConfigPath, historicalConfig] = await tryGetDenoConfig(
          root,
        );

        if (historicalConfig.name && historicalConfig.version) {
          // Historical config is valid single-package
          oldModules = [{
            ...historicalConfig,
            [pathProp]: historicalConfigPath,
          }];
        } else {
          // Historical config is incomplete - use current structure with historical version
          // Try to extract version from git tags or use 0.0.0
          let historicalVersion = "0.0.0";
          try {
            const tagOutput = await $`git describe --tags --abbrev=0`.text()
              .catch(() => "");
            if (tagOutput.trim()) {
              const versionMatch = tagOutput.match(/v?(\d+\.\d+\.\d+)/);
              if (versionMatch) {
                historicalVersion = versionMatch[1];
              }
            }
          } catch {
            // Use default 0.0.0
          }

          oldModules = [{
            name: modules[0].name, // Use current name
            version: historicalVersion,
            [pathProp]: configPath,
          }];
        }

        await $`git checkout -`;
      } catch {
        if (!_quiet) {
          console.warn(
            `Could not read historical config at ${start}, using fallback`,
          );
        }
        // Fallback: create old module with 0.0.0 version
        oldModules = [{
          name: modules[0].name,
          version: "0.0.0",
          [pathProp]: configPath,
        }];
        await $`git checkout -`;
      }
    } else {
      // For workspace repos, use the original logic
      await $`git checkout ${start}`;
      const [_oldConfigPath, oldModulesResult] = await getWorkspaceModules(
        root,
        { quiet: _quiet },
      );
      oldModules = oldModulesResult;
      await $`git checkout -`;
    }

    await $`git checkout ${base}`;
    await $`git checkout -`;

    const newBranchName = createReleaseBranchName(now);

    const text =
      await $`git --no-pager log --pretty=format:${separator}%H%B ${start}..${base}`
        .text();

    const commits = text.split(separator).map((commit) => {
      const hash = commit.slice(0, 40);
      commit = commit.slice(40);
      const i = commit.indexOf("\n");
      if (i < 0) {
        return { hash, subject: commit.trim(), body: "" };
      }
      const subject = commit.slice(0, i).trim();
      const body = commit.slice(i + 1).trim();
      return { hash, subject, body };
    });
    commits.shift(); // drop the first empty item

    console.log(
      `Found ${cyan(commits.length.toString())} commits between ${
        magenta(start)
      } and ${magenta(base)}.`,
    );
    const versionBumps: VersionBump[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const commit of commits) {
      if (/^v?\d+\.\d+\.\d+/.test(commit.subject)) {
        // Skip if the commit subject is version bump
        continue;
      }
      if (/^Release \d+\.\d+\.\d+/.test(commit.subject)) {
        // Skip if the commit subject is release
        continue;
      }
      const parsed = parseCommitMessage(commit, modules);
      if (Array.isArray(parsed)) {
        for (const versionBump of parsed) {
          const diagnostic = checkModuleName(versionBump, modules);
          if (diagnostic) {
            diagnostics.push(diagnostic);
          } else {
            versionBumps.push(versionBump);
          }
        }
      } else {
        // The commit message is completely unknown
        diagnostics.push(parsed);
      }
    }
    const summaries = summarizeVersionBumpsByModule(versionBumps);

    if (summaries.length === 0) {
      console.log("No version bumps.");
      return;
    }

    console.log(`Updating the versions:`);
    let importMapPath: string;
    if (importMap) {
      console.log(`Using the import map: ${cyan(importMap)}`);
      importMapPath = importMap;
    } else {
      importMapPath = configPath;
    }
    const updates: Record<string, VersionUpdateResult> = {};
    let importMapJson = await Deno.readTextFile(importMapPath);
    for (const summary of summaries) {
      const module = getModule(summary.module, modules)!;
      const oldModule = getModule(summary.module, oldModules);
      const [importMapJson_, versionUpdate] = await applyVersionBump(
        summary,
        module,
        oldModule,
        importMapJson,
        dryRun === true,
      );
      importMapJson = importMapJson_;
      updates[module.name] = versionUpdate;
    }
    console.table(updates, ["diff", "from", "to", "path"]);

    console.log(
      `Found ${cyan(diagnostics.length.toString())} diagnostics:`,
    );
    for (const unknownCommit of diagnostics) {
      console.log(`  ${unknownCommit.type} ${unknownCommit.commit.subject}`);
    }

    // Create the pull request
    await createPullRequest({
      updates: Object.values(updates),
      modules,
      diagnostics,
      now,
      dryRun,
      releaseNotePath,
      root,
      importMapPath,
      importMapJson,
      newBranchName,
      gitUserName,
      gitUserEmail,
      githubToken,
      githubRepo,
      base,
      gitTag,
      individualTags,
      individualReleaseNotes,
      isSinglePackage,
    });

    console.log("Done.");
  }, { quiet: _quiet });
}
