// Copyright 2024 the Deno authors. All rights reserved. MIT license.
import { $ } from "@david/dax";
import { Octokit } from "npm:octokit@^3.1";
import { cyan, magenta } from "@std/fmt/colors";
import { ensureFile } from "@std/fs/ensure-file";
import { join } from "@std/path/join";

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
  createIndividualPRs,
  createIndividualTags,
  createPackageReleaseNote,
  createPrBody,
  createReleaseBranchName,
  createReleaseNote,
  createReleaseTitle,
  createSinglePRWithPackageBreakdown,
  defaultParseCommitMessage,
  type Diagnostic,
  getCurrentGitBranch,
  getModule,
  getPackageDir,
  getSmartStartTag,
  getWorkspaceModules,
  getWorkspaceModulesWithOptions,
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
  /** The path to release note markdown file. The default is `Releases.md` for workspace mode, `CHANGELOG.md` for per-package mode */
  releaseNotePath?: string;
  /** Publishing mode: "workspace" (default) creates single release, "per-package" creates individual releases */
  publishMode?: "workspace" | "per-package";
  /** When using per-package mode, whether to create individual PRs for each package */
  individualPRs?: boolean;
  /** When using per-package mode, whether to create individual git tags for each package */
  individualTags?: boolean;
  /** When using per-package mode, whether to create individual release notes for each package */
  individualReleaseNotes?: boolean;
  /** Internal option: suppress additional logging (used for testing) */
  _quiet?: boolean;
  /** Whether to create git tags automatically after the version update commit. Default: true */
  createTags?: boolean;
  /** Tag prefix for single packages. Default: "v" (results in tags like v1.2.3) */
  tagPrefix?: string;
  /** Whether to push tags immediately with the branch. Default: true */
  pushTags?: boolean;
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
    publishMode = "workspace",
    individualPRs = false,
    individualTags = publishMode === "per-package" ? true : false, // Dynamic default
    individualReleaseNotes = publishMode === "per-package" ? true : false, // Dynamic default
    createTags = true,
    tagPrefix = "v",
    pushTags = true,
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

    // Set default release note path based on publish mode
    if (!releaseNotePath) {
      releaseNotePath = publishMode === "per-package"
        ? "CHANGELOG.md"
        : "Releases.md";
    }

    // Use quiet mode for getWorkspaceModules calls to avoid logging interference
    const getModules = _quiet
      ? (root: string) => getWorkspaceModulesWithOptions(root, { quiet: true })
      : getWorkspaceModules;

    // Get current modules first to determine repository type
    const [configPath, modules] = await getModules(root);

    // Determine if this is a single-package repo
    const isSinglePackage = modules.length === 1 &&
      modules[0][pathProp] === configPath;

    if (!start) {
      start = await getSmartStartTag(publishMode, modules, tagPrefix, _quiet);
    }

    // Only log package type info when not in quiet mode
    if (!_quiet) {
      if (isSinglePackage) {
        console.log(`Processing single package: ${cyan(modules[0].name)}`);
        if (publishMode === "per-package") {
          console.log(
            "Note: Per-package mode has limited effect on single-package repos",
          );
        }
      } else {
        console.log(
          `Processing workspace with ${
            cyan(modules.length.toString())
          } packages`,
        );
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
      const [_oldConfigPath, oldModulesResult] = await getModules(root);
      oldModules = oldModulesResult;
      await $`git checkout -`;
    }

    await $`git checkout ${base}`;
    await $`git checkout -`;

    const newBranchName = createReleaseBranchName(now);
    const workspaceReleaseNotePath = join(root, releaseNotePath);

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

    // Choose publishing strategy based on publishMode and repository type
    if (publishMode === "per-package" && !isSinglePackage) {
      await publishPerPackage({
        updates: Object.values(updates),
        modules,
        diagnostics,
        now,
        dryRun,
        releaseNotePath,
        root,
        importMapPath,
        importMapJson,
        gitUserName,
        gitUserEmail,
        githubToken,
        githubRepo,
        base,
        individualPRs,
        individualTags,
        individualReleaseNotes,
        createTags,
        tagPrefix,
        pushTags,
        publishMode,
      });
    } else {
      // Use workspace mode for single-package repos or when explicitly requested
      if (isSinglePackage && publishMode === "per-package" && !_quiet) {
        console.log("Using workspace-style publishing for single package");
      }

      await publishWorkspace({
        updates: Object.values(updates),
        modules,
        diagnostics,
        now,
        dryRun,
        releaseNotePath: workspaceReleaseNotePath,
        importMapPath,
        importMapJson,
        newBranchName,
        gitUserName,
        gitUserEmail,
        githubToken,
        githubRepo,
        base,
        createTags,
        tagPrefix,
        pushTags,
      });
    }

    console.log("Done.");
  }, { quiet: _quiet });
}

async function publishWorkspace({
  updates,
  modules,
  diagnostics,
  now,
  dryRun,
  releaseNotePath,
  importMapPath,
  importMapJson,
  newBranchName,
  gitUserName,
  gitUserEmail,
  githubToken,
  githubRepo,
  base,
  createTags,
  pushTags,
  tagPrefix,
}: {
  updates: VersionUpdateResult[];
  modules: WorkspaceModule[];
  diagnostics: Diagnostic[];
  now: Date;
  dryRun: boolean | "git";
  releaseNotePath: string;
  importMapPath: string;
  importMapJson: string;
  newBranchName: string;
  gitUserName?: string;
  gitUserEmail?: string;
  githubToken?: string;
  githubRepo?: string;
  base: string;
  createTags?: boolean;
  tagPrefix?: string;
  pushTags?: boolean;
}) {
  const releaseNote = createReleaseNote(
    updates,
    modules,
    now,
    githubRepo,
    tagPrefix,
    "workspace",
    false,
  );

  if (dryRun === true) {
    console.log();
    console.log(cyan("The release note:"));
    console.log(releaseNote);

    if (createTags) {
      console.log();
      console.log(cyan("Tags that would be created:"));
      for (const update of updates) {
        const module = getModule(update.summary.module, modules)!;
        const isSinglePackage = modules.length === 1 &&
          modules[0][pathProp].endsWith("deno.json");

        if (isSinglePackage) {
          console.log(`${tagPrefix}${update.to}`);
        } else {
          console.log(`${module.name}@${update.to}`);
        }
      }
    }

    console.log();
    console.log(cyan("Skip making a commit."));
    console.log(cyan("Skip making a pull request."));
  } else {
    // Updates deno.json
    await Deno.writeTextFile(importMapPath, importMapJson);

    // Prepend release notes
    await ensureFile(releaseNotePath);
    await Deno.writeTextFile(
      releaseNotePath,
      releaseNote + "\n" + await Deno.readTextFile(releaseNotePath),
    );

    await $`deno fmt ${releaseNotePath}`;

    if (dryRun === false) {
      gitUserName ??= Deno.env.get("GIT_USER_NAME");
      if (gitUserName === undefined) {
        console.error("GIT_USER_NAME is not set.");
        Deno.exit(1);
      }
      gitUserEmail ??= Deno.env.get("GIT_USER_EMAIL");
      if (gitUserEmail === undefined) {
        console.error("GIT_USER_EMAIL is not set.");
        Deno.exit(1);
      }
      githubToken ??= Deno.env.get("GITHUB_TOKEN");
      if (githubToken === undefined) {
        console.error("GITHUB_TOKEN is not set.");
        Deno.exit(1);
      }
      githubRepo ??= Deno.env.get("GITHUB_REPOSITORY");
      if (githubRepo === undefined) {
        console.error("GITHUB_REPOSITORY is not set.");
        Deno.exit(1);
      }

      // Makes a commit
      console.log(
        `Creating a git commit in the new branch ${magenta(newBranchName)}.`,
      );
      await $`git checkout -b ${newBranchName}`;
      await $`git add .`;
      await $`git -c "user.name=${gitUserName}" -c "user.email=${gitUserEmail}" commit -m "chore: update versions"`;

      if (createTags) {
        console.log("Creating version tags...");
        const isSinglePackage = modules.length === 1 &&
          modules[0][pathProp].endsWith("deno.json");

        for (const update of updates) {
          const module = getModule(update.summary.module, modules)!;
          let tagName: string;

          if (isSinglePackage) {
            // Single package: use v1.2.3 format
            tagName = `${tagPrefix}${update.to}`;
          } else {
            // Workspace: use @scope/package@1.2.3 format
            tagName = `${module.name}@${update.to}`;
          }

          try {
            // Check if tag already exists
            await $`git rev-parse ${tagName}`.quiet();
            console.log(`Tag ${cyan(tagName)} already exists, skipping`);
          } catch {
            // Tag doesn't exist, create it
            await $`git tag ${tagName}`;
            console.log(`Created tag: ${cyan(tagName)}`);
          }
        }
      }

      console.log(`Pushing the new branch ${magenta(newBranchName)}.`);
      if (createTags && pushTags) {
        // Push branch and tags together
        await $`git push origin ${newBranchName} --tags`;
        console.log("Tags pushed along with branch");
      } else {
        // Just push the branch
        await $`git push origin ${newBranchName}`;
        if (createTags) {
          console.log("Tags created locally (use --push-tags to push them)");
        }
      }

      // Makes a PR
      console.log(`Creating a pull request.`);
      const octoKit = new Octokit({ auth: githubToken });
      const [owner, repo] = githubRepo.split("/");
      const openedPr = await octoKit.request(
        "POST /repos/{owner}/{repo}/pulls",
        {
          owner,
          repo,
          base: base,
          head: newBranchName,
          draft: true,
          title: `chore: release ${createReleaseTitle(now)}`,
          body: createPrBody(
            updates,
            diagnostics,
            githubRepo,
            newBranchName,
          ),
        },
      );
      console.log("New pull request:", cyan(openedPr.data.html_url));
    }
  }
}

async function publishPerPackage({
  updates,
  modules,
  diagnostics,
  now,
  dryRun,
  releaseNotePath,
  root,
  importMapPath,
  importMapJson,
  gitUserName,
  gitUserEmail,
  githubToken,
  githubRepo,
  base,
  individualPRs,
  individualTags,
  individualReleaseNotes,
  createTags,
  pushTags,
  tagPrefix,
  publishMode,
}: {
  updates: VersionUpdateResult[];
  modules: WorkspaceModule[];
  diagnostics: Diagnostic[];
  now: Date;
  dryRun: boolean | "git";
  releaseNotePath: string;
  root: string;
  importMapPath: string;
  importMapJson: string;
  gitUserName?: string;
  gitUserEmail?: string;
  githubToken?: string;
  githubRepo?: string;
  base: string;
  individualPRs: boolean;
  individualTags: boolean;
  individualReleaseNotes: boolean;
  createTags?: boolean;
  tagPrefix?: string;
  pushTags?: boolean;
  publishMode: "per-package";
}) {
  console.log(`Publishing per-package mode with ${updates.length} packages`);

  if (dryRun === true) {
    console.log(cyan("Dry run mode - showing what would be done:"));
    for (const update of updates) {
      const module = getModule(update.summary.module, modules)!;
      console.log(`\n${cyan(`Package: ${module.name}`)}`);

      if (individualReleaseNotes || !individualPRs) {
        const packageReleaseNote = createPackageReleaseNote(update, now);
        const packageDir = getPackageDir(module, root);
        const packageReleaseNotePath = join(packageDir, releaseNotePath);
        console.log(`Release note path: ${packageReleaseNotePath}`);
        console.log("Release note:");
        console.log(packageReleaseNote);
      }

      if (individualTags || createTags) {
        const tagName = `${module.name}@${update.to}`;
        console.log(`Would create tag: ${tagName}`);
      }

      if (individualPRs) {
        console.log(`Would create individual PR for ${module.name}`);
      }
    }
    return;
  }

  // Update import map first
  await Deno.writeTextFile(importMapPath, importMapJson);

  const isSinglePackage = modules.length === 1 &&
    modules[0][pathProp].endsWith("deno.json");

  if (individualReleaseNotes) {
    for (const update of updates) {
      const module = getModule(update.summary.module, modules)!;
      const packageDir = getPackageDir(module, root);
      const packageReleaseNotePath = join(packageDir, releaseNotePath);
      const packageReleaseNote = createPackageReleaseNote(
        update,
        now,
        githubRepo,
        tagPrefix,
        publishMode,
        individualTags,
        isSinglePackage,
      );

      await ensureFile(packageReleaseNotePath);
      const existingContent = await Deno.readTextFile(packageReleaseNotePath)
        .catch(() => "");
      await Deno.writeTextFile(
        packageReleaseNotePath,
        packageReleaseNote + "\n" + existingContent,
      );
    }
  }

  if (dryRun !== "git") {
    gitUserName ??= Deno.env.get("GIT_USER_NAME");
    gitUserEmail ??= Deno.env.get("GIT_USER_EMAIL");
    githubToken ??= Deno.env.get("GITHUB_TOKEN");
    githubRepo ??= Deno.env.get("GITHUB_REPOSITORY");

    if (!gitUserName || !gitUserEmail || !githubToken || !githubRepo) {
      console.error(
        "Required environment variables not set for per-package publishing",
      );
      Deno.exit(1);
    }
  }

  if (individualPRs) {
    // Create individual PRs for each package
    await createIndividualPRs({
      updates,
      modules,
      diagnostics,
      now,
      gitUserName: gitUserName!,
      gitUserEmail: gitUserEmail!,
      githubToken: githubToken!,
      githubRepo: githubRepo!,
      base,
      releaseNotePath,
      root,
      dryRun,
      createTags,
      tagPrefix,
      pushTags,
    });
  } else {
    // Create single PR but with per-package organization
    await createSinglePRWithPackageBreakdown({
      updates,
      modules,
      diagnostics,
      now,
      gitUserName: gitUserName!,
      gitUserEmail: gitUserEmail!,
      githubToken: githubToken!,
      githubRepo: githubRepo!,
      base,
      individualReleaseNotes,
      releaseNotePath,
      root,
      dryRun,
      createTags,
      tagPrefix,
      pushTags,
    });
  }

  if (individualTags) {
    // Create individual tags for each package
    await createIndividualTags(
      updates,
      modules,
      gitUserName!,
      gitUserEmail!,
      dryRun,
    );
  }
}
