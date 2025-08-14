// Copyright 2024 the Deno authors. All rights reserved. MIT license.
import { $ } from "@david/dax";
import { Octokit } from "npm:octokit@^3.1";
import { cyan } from "@std/fmt/colors";
import { ensureFile } from "@std/fs/ensure-file";
import { parse as parseJsonc } from "@std/jsonc/parse";
import { join } from "@std/path/join";
import { resolve } from "@std/path/resolve";
import { isAbsolute } from "@std/path/is-absolute";
import {
  format as formatSemver,
  increment,
  parse as parseSemVer,
  type SemVer,
} from "@std/semver";
import { red } from "@std/fmt/colors";

export type VersionUpdate = "major" | "minor" | "patch" | "prerelease";

export type Commit = {
  subject: string;
  body: string;
  hash: string;
};

export type CommitWithTag = Commit & { tag: string };

export const pathProp = Symbol.for("path");

export type WorkspaceModule = {
  name: string;
  version: string;
  [pathProp]: string;
};

export type VersionBump = {
  module: string;
  tag: string;
  commit: Commit;
  version: VersionUpdate;
};

export type VersionBumpSummary = {
  module: string;
  version: VersionUpdate;
  commits: CommitWithTag[];
};

export type Diagnostic =
  | UnknownCommit
  | UnknownRangeCommit
  | SkippedCommit
  | MissingRange;

export type UnknownCommit = {
  type: "unknown_commit";
  commit: Commit;
  reason: string;
};

export type MissingRange = {
  type: "missing_range";
  commit: Commit;
  reason: string;
};

export type UnknownRangeCommit = {
  type: "unknown_range_commit";
  commit: Commit;
  reason: string;
};

export type SkippedCommit = {
  type: "skipped_commit";
  commit: Commit;
  reason: string;
};

export type AppliedVersionBump = {
  oldVersion: string;
  newVersion: string;
  diff: VersionUpdate;
  denoJson: string;
};

export type VersionUpdateResult = {
  from: string;
  to: string;
  diff: VersionUpdate;
  path: string;
  summary: VersionBumpSummary;
};

/**
 * Git context state that can be captured and restored
 */
export interface GitState {
  branch: string;
  workingDirectory: string;
  hasUncommittedChanges: boolean;
}

/**
 * Options for git context management
 */
export interface GitContextOptions {
  /** Whether to stash uncommitted changes before starting (default: false) */
  stashChanges?: boolean;
  /** Whether to suppress restoration logging (default: false) */
  quiet?: boolean;
  /** Custom working directory (default: current directory) */
  workingDirectory?: string;
}

// Options interface for controlling behavior
interface GetWorkspaceModulesOptions {
  throwOnError?: boolean;
  quiet?: boolean;
}

const RE_DEFAULT_PATTERN = /^([^:()!]+)(?:\((.+)\))?(\!)?: (.*)$/;
const REGEXP_UNSTABLE_SCOPE = /^(unstable\/(.+)|(.+)\/unstable)$/;

type VersionBumpKind = "major" | "minor" | "patch";
// Defines the version bump for each tag.
const TAG_TO_VERSION: Record<string, VersionBumpKind> = {
  BREAKING: "major",
  feat: "minor",
  deprecation: "patch",
  fix: "patch",
  perf: "patch",
  docs: "patch",
  style: "patch",
  refactor: "patch",
  test: "patch",
  chore: "patch",
};
const POST_MODULE_TO_VERSION: Record<string, VersionBumpKind> = {
  "!": "major",
};
const TAG_PRIORITY = Object.keys(TAG_TO_VERSION);

export const DEFAULT_RANGE_REQUIRED = [
  "BREAKING",
  "feat",
  "fix",
  "perf",
  "deprecation",
];

// Custom error class for configuration issues
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function defaultParseCommitMessage(
  commit: Commit,
  workspaceModules: WorkspaceModule[],
): VersionBump[] | Diagnostic {
  const match = RE_DEFAULT_PATTERN.exec(commit.subject);
  if (match === null) {
    return {
      type: "unknown_commit",
      commit,
      reason: "The commit message does not match the default pattern.",
    };
  }
  const [, tag, module, optionalPostModule, _message] = match;

  // Determine which modules this commit applies to
  let modules: string[];
  if (module === "*") {
    // Wildcard scope - applies to all modules
    modules = workspaceModules.map((x) => x.name);
  } else if (module) {
    // Explicit scope(s) provided
    modules = module.split(/\s*,\s*/);
  } else {
    // No scope provided
    modules = [];
  }

  // Handle the case where no modules are specified
  if (modules.length === 0) {
    // For single-package repos, apply scopeless commits to the single package
    if (workspaceModules.length === 1) {
      modules = [workspaceModules[0].name];
    } else {
      // Multi-package repo with no scope
      if (DEFAULT_RANGE_REQUIRED.includes(tag)) {
        return {
          type: "missing_range",
          commit,
          reason: "The commit message does not specify a module.",
        };
      }
      return {
        type: "skipped_commit",
        commit,
        reason: "The commit message does not specify a module.",
      };
    }
  }

  const version = optionalPostModule in POST_MODULE_TO_VERSION
    ? POST_MODULE_TO_VERSION[optionalPostModule]
    : TAG_TO_VERSION[tag];
  if (version === undefined) {
    return {
      type: "unknown_commit",
      commit,
      reason: `Unknown commit tag: ${tag}.`,
    };
  }

  return modules.map((module) => {
    const matchUnstable = REGEXP_UNSTABLE_SCOPE.exec(module);
    if (matchUnstable) {
      // 'scope' is in the form of unstable/foo or foo/unstable
      // In this case all changes are considered as patch
      return {
        module: matchUnstable[2] || matchUnstable[3],
        tag,
        commit,
        version: "patch",
      };
    }
    return ({ module, tag, version, commit });
  });
}

export function summarizeVersionBumpsByModule(
  versionBumps: VersionBump[],
): VersionBumpSummary[] {
  const result = {} as Record<string, VersionBumpSummary>;
  for (const versionBump of versionBumps) {
    const { module, version } = versionBump;
    const summary = result[module] = result[module] ?? {
      module,
      version,
      commits: [],
    };
    summary.version = maxVersion(summary.version, version);
    summary.commits.push({ ...versionBump.commit, tag: versionBump.tag });
  }
  for (const summary of Object.values(result)) {
    summary.commits.sort((a, b) => {
      const priorityA = TAG_PRIORITY.indexOf(a.tag);
      const priorityB = TAG_PRIORITY.indexOf(b.tag);
      if (priorityA === priorityB) {
        return 0;
      }
      return priorityA < priorityB ? -1 : 1;
    });
  }

  return Object.values(result).sort((a, b) => a.module < b.module ? -1 : 1);
}

export function maxVersion(
  v0: VersionUpdate,
  v1: VersionUpdate,
): VersionUpdate {
  if (v0 === "major" || v1 === "major") {
    return "major";
  }
  if (v0 === "minor" || v1 === "minor") {
    return "minor";
  }
  return "patch";
}

export async function tryGetDenoConfig(
  path: string,
  // deno-lint-ignore no-explicit-any
): Promise<[path: string, config: any]> {
  let denoJson: string | undefined;
  let denoJsonPath: string | undefined;
  try {
    denoJsonPath = join(path, "deno.json");
    denoJson = await Deno.readTextFile(denoJsonPath);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw e;
    }
  }

  if (!denoJson) {
    try {
      denoJsonPath = join(path, "deno.jsonc");
      denoJson = await Deno.readTextFile(denoJsonPath);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        console.log(`No deno.json or deno.jsonc found in ${resolve(path)}`);
        Deno.exit(1);
      }
      throw e;
    }
  }

  try {
    return [denoJsonPath!, parseJsonc(denoJson)];
  } catch (e) {
    console.log("Invalid deno.json or deno.jsonc file.");
    console.log(e);
    Deno.exit(1);
  }
}

export async function getWorkspaceModulesWithOptions(
  root: string,
  options: GetWorkspaceModulesOptions = {},
): Promise<[string, WorkspaceModule[]]> {
  const { throwOnError = false, quiet = false } = options;

  const [path, denoConfig] = await tryGetDenoConfig(root);
  const workspaces = denoConfig.workspaces || denoConfig.workspace;

  // Handle single-package repos (non-workspace)
  if (!workspaces) {
    if (denoConfig.name && denoConfig.version) {
      // Treat root as a single package
      return [path, [{ ...denoConfig, [pathProp]: path }]];
    } else {
      const errorMessage = red("Error") +
        " deno.json must have either:\n" +
        "  - 'workspace' field for multi-package repos, or\n" +
        "  - 'name' and 'version' fields for single-package repos";

      if (throwOnError) {
        throw new ConfigurationError(errorMessage);
      }

      if (!quiet) {
        console.log(errorMessage);
      }
      Deno.exit(1);
    }
  }

  // Existing workspace logic
  if (!Array.isArray(workspaces)) {
    const errorMessage = red("Error") +
      " deno.json workspace field should be an array of strings.";

    if (throwOnError) {
      throw new ConfigurationError(errorMessage);
    }

    console.log(errorMessage);
    Deno.exit(1);
  }

  const result = [];
  for (const workspace of workspaces) {
    if (typeof workspace !== "string") {
      const errorMessage =
        "deno.json workspace field should be an array of strings.";

      if (throwOnError) {
        throw new ConfigurationError(errorMessage);
      }

      console.log(errorMessage);
      Deno.exit(1);
    }
    const [path, workspaceConfig] = await tryGetDenoConfig(
      join(root, workspace),
    );
    if (!workspaceConfig.name) {
      continue;
    }
    result.push({ ...workspaceConfig, [pathProp]: path });
  }
  return [path, result];
}

// Public function - maintains original behavior for CLI usage
export async function getWorkspaceModules(
  root: string,
): Promise<[string, WorkspaceModule[]]> {
  return getWorkspaceModulesWithOptions(root, {
    throwOnError: false,
    quiet: false,
  });
}

// Test-friendly function - throws errors instead of exiting
export async function getWorkspaceModulesForTesting(
  root: string,
): Promise<[string, WorkspaceModule[]]> {
  return getWorkspaceModulesWithOptions(root, {
    throwOnError: true,
    quiet: true,
  });
}

export function getModule(module: string, modules: WorkspaceModule[]) {
  return modules.find((m) =>
    m.name === module || m.name.endsWith(`/${module}`)
  );
}

export function checkModuleName(
  versionBump: Pick<VersionBump, "module" | "commit" | "tag">,
  modules: WorkspaceModule[],
): Diagnostic | undefined {
  if (getModule(versionBump.module, modules)) {
    return undefined;
  }
  // The commit include unknown module name
  return {
    type: "unknown_range_commit",
    commit: versionBump.commit,
    reason: `Unknown module: ${versionBump.module}.`,
  };
}

function hasPrerelease(version: SemVer) {
  return version.prerelease !== undefined && version.prerelease.length > 0;
}

export function calcVersionDiff(
  newVersionStr: string,
  oldVersionStr: string,
): VersionUpdate {
  const newVersion = parseSemVer(newVersionStr);
  const oldVersion = parseSemVer(oldVersionStr);
  if (hasPrerelease(newVersion)) {
    return "prerelease";
  } else if (newVersion.major !== oldVersion.major) {
    return "major";
  } else if (newVersion.minor !== oldVersion.minor) {
    return "minor";
  } else if (newVersion.patch !== oldVersion.patch) {
    return "patch";
  } else if (
    hasPrerelease(oldVersion) && !hasPrerelease(newVersion) &&
    newVersion.major === oldVersion.major &&
    newVersion.minor === oldVersion.minor &&
    newVersion.patch === oldVersion.patch
  ) {
    // The prerelease version is removed like
    // 1.0.0-rc.1 -> 1.0.0
    if (newVersion.patch !== 0) {
      return "patch";
    } else if (newVersion.minor !== 0) {
      return "minor";
    } else if (newVersion.major !== 0) {
      return "major";
    }
  }
  throw new Error(
    `Unexpected manual version update: ${oldVersion} -> ${newVersion}`,
  );
}

/** Apply the version bump to the file system. */
export async function applyVersionBump(
  summary: VersionBumpSummary,
  module: WorkspaceModule,
  oldModule: WorkspaceModule | undefined,
  denoJson: string,
  dryRun = false,
): Promise<[denoJson: string, VersionUpdateResult]> {
  if (!oldModule) {
    // The module is newly added
    console.info(`New module ${module.name} detected.`);
    const diff = calcVersionDiff(module.version, "0.0.0");
    summary.version = diff;
    return [denoJson, {
      from: "0.0.0",
      to: module.version,
      diff,
      summary,
      path: module[pathProp],
    }];
  }
  if (oldModule.version !== module.version) {
    // The version is manually updated
    console.info(
      `Manual version update detected for ${module.name}: ${oldModule.version} -> ${module.version}`,
    );

    const diff = calcVersionDiff(module.version, oldModule.version);
    summary.version = diff;
    return [denoJson, {
      from: oldModule.version,
      to: module.version,
      diff,
      summary,
      path: module[pathProp],
    }];
  }
  const currentVersionStr = module.version;
  const currentVersion = parseSemVer(currentVersionStr);
  let diff = summary.version;
  if (currentVersion.prerelease && currentVersion.prerelease.length > 0) {
    // If the current version is a prerelease version, the version bump type is always prerelease
    diff = "prerelease";
  } else if (currentVersion.major === 0) {
    // Change the version bump type for 0.x.y
    // This is aligned with the spec proposal discussed in https://github.com/semver/semver/pull/923
    if (diff === "major") {
      // breaking change is considered as minor in 0.x.y
      diff = "minor";
    } else if (diff === "minor") {
      // new feature is considered as patch in 0.x.y
      diff = "patch";
    }
  }
  summary.version = diff;
  const newVersion = increment(currentVersion, diff);
  const newVersionStr = formatSemver(newVersion);
  module.version = newVersionStr;
  const path = module[pathProp];
  if (!dryRun) {
    await Deno.writeTextFile(path, JSON.stringify(module, null, 2) + "\n");
  }
  denoJson = denoJson.replace(
    new RegExp(`${module.name}@([^~]?)${currentVersionStr}`, "g"),
    `${module.name}@$1${newVersionStr}`,
  );
  if (path.endsWith("deno.jsonc")) {
    console.warn(
      `Currently this tool doesn't keep the comments in deno.jsonc files. Comments in the path "${path}" might be removed by this update.`,
    );
  }
  return [denoJson, {
    from: currentVersionStr,
    to: newVersionStr,
    diff,
    summary,
    path,
  }];
}

export function createReleaseNote(
  updates: VersionUpdateResult[],
  modules: WorkspaceModule[],
  date: Date,
) {
  const heading = `### ${createReleaseTitle(date)}\n\n`;
  return heading + updates.map((u) => {
    const module = getModule(u.summary.module, modules)!;
    return `#### ${module.name} ${u.to} (${u.diff}) \n` +
      u.summary.commits.map((c) => `- ${c.subject}\n`).join("");
  }).join("\n");
}

export function createPrBody(
  updates: VersionUpdateResult[],
  diagnostics: Diagnostic[],
  githubRepo: string,
  releaseBranch: string,
) {
  const table = updates.map((u) =>
    "|" + [u.summary.module, u.from, u.to, u.diff].join("|") + "|"
  ).join("\n");

  const unknownCommitsNotes = createDiagnosticsNotes(
    "The following commits are not recognized. Please handle them manually if necessary:",
    "unknown_commit",
  );
  const unknownRangesNotes = createDiagnosticsNotes(
    "The following commits have unknown scopes. Please handle them manually if necessary:",
    "unknown_range_commit",
  );
  const missingRangesNotes = createDiagnosticsNotes(
    "Required scopes are missing in the following commits. Please handle them manually if necessary:",
    "missing_range",
  );
  const ignoredCommitsNotes = createDiagnosticsNotes(
    "The following commits are ignored:",
    "skipped_commit",
  );
  return `The following updates are detected:

| module   | from    | to      | type  |
|----------|---------|---------|-------|
${table}

Please ensure:
- [ ] Versions in deno.json files are updated correctly
- [ ] Releases.md is updated correctly

${unknownCommitsNotes}

${unknownRangesNotes}

${missingRangesNotes}

${ignoredCommitsNotes}

---

To make edits to this PR:

\`\`\`sh
git fetch upstream ${releaseBranch} && git checkout -b ${releaseBranch} upstream/${releaseBranch}
\`\`\`
`;
  function createDiagnosticsNotes(
    note: string,
    type: string,
  ) {
    const diagnostics_ = diagnostics.filter((d) => d.type === type);
    if (diagnostics_.length === 0) {
      return "";
    }
    return `${note}\n\n` +
      diagnostics_.map((d) =>
        `- [${d.commit.subject}](/${githubRepo}/commit/${d.commit.hash})`
      ).join("\n");
  }
}

export function createReleaseBranchName(date: Date) {
  return "release-" +
    date.toISOString().replace("T", "-").replaceAll(":", "-").replace(
      /\..+/,
      "",
    );
}

export function createReleaseTitle(d: Date) {
  const year = d.getUTCFullYear();
  const month = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const date = d.getUTCDate().toString().padStart(2, "0");
  return `${year}.${month}.${date}`;
}

export async function createIndividualPRs({
  updates,
  modules,
  diagnostics,
  now,
  gitUserName,
  gitUserEmail,
  githubToken,
  githubRepo,
  base,
  releaseNotePath,
  root,
  dryRun,
}: {
  updates: VersionUpdateResult[];
  modules: WorkspaceModule[];
  diagnostics: Diagnostic[];
  now: Date;
  gitUserName: string;
  gitUserEmail: string;
  githubToken: string;
  githubRepo: string;
  base: string;
  releaseNotePath: string;
  root: string;
  dryRun: boolean | "git";
}) {
  if (dryRun === "git") {
    console.log(cyan("Git dry run mode - skipping individual PR creation"));
    for (const update of updates) {
      const module = getModule(update.summary.module, modules)!;
      const branchName = createPackageReleaseBranchName(
        module.name,
        update.to,
        now,
      );
      console.log(`Would create branch: ${branchName} for ${module.name}`);
      console.log(
        `Would create PR: chore(${module.name}): release ${update.to}`,
      );
    }
    return;
  }

  const octoKit = new Octokit({ auth: githubToken });
  const [owner, repo] = githubRepo.split("/");

  for (const update of updates) {
    const module = getModule(update.summary.module, modules)!;
    const branchName = createPackageReleaseBranchName(
      module.name,
      update.to,
      now,
    );

    console.log(`Creating individual PR for ${cyan(module.name)}`);

    // Create branch for this package
    await $`git checkout -b ${branchName}`;

    // Create package-specific release note in package directory
    const packageDir = getPackageDir(module, root);
    const packageReleaseNotePath = join(packageDir, releaseNotePath);
    const packageReleaseNote = createPackageReleaseNote(update, now);

    await ensureFile(packageReleaseNotePath);
    const existingContent = await Deno.readTextFile(packageReleaseNotePath)
      .catch(() => "");
    await Deno.writeTextFile(
      packageReleaseNotePath,
      packageReleaseNote + "\n" + existingContent,
    );
    await $`git add ${packageReleaseNotePath}`;

    await $`git add .`;
    await $`git -c "user.name=${gitUserName}" -c "user.email=${gitUserEmail}" commit -m "chore(${module.name}): release ${update.to}"`;
    await $`git push origin ${branchName}`;

    // Create PR for this package
    const packageDiagnostics = diagnostics.filter((d) =>
      update.summary.commits.some((c) => c.hash === d.commit.hash)
    );

    const openedPr = await octoKit.request(
      "POST /repos/{owner}/{repo}/pulls",
      {
        owner,
        repo,
        base: base,
        head: branchName,
        draft: false,
        title: `chore(${module.name}): release ${update.to}`,
        body: createPackagePrBody(
          update,
          packageDiagnostics,
          githubRepo,
          branchName,
        ),
      },
    );

    console.log(
      `Created PR for ${module.name}: ${cyan(openedPr.data.html_url)}`,
    );

    // Switch back to base branch for next iteration
    await $`git checkout ${base}`;
  }
}

export async function createSinglePRWithPackageBreakdown({
  updates,
  modules,
  diagnostics,
  now,
  gitUserName,
  gitUserEmail,
  githubToken,
  githubRepo,
  base,
  individualReleaseNotes,
  releaseNotePath,
  root,
  dryRun,
}: {
  updates: VersionUpdateResult[];
  modules: WorkspaceModule[];
  diagnostics: Diagnostic[];
  now: Date;
  gitUserName: string;
  gitUserEmail: string;
  githubToken: string;
  githubRepo: string;
  base: string;
  individualReleaseNotes: boolean;
  releaseNotePath: string;
  root: string;
  dryRun: boolean | "git";
}) {
  // Create individual release notes in package directories
  if (individualReleaseNotes) {
    for (const update of updates) {
      const module = getModule(update.summary.module, modules)!;
      const packageDir = getPackageDir(module, root);
      const packageReleaseNotePath = join(packageDir, releaseNotePath);
      const packageReleaseNote = createPackageReleaseNote(update, now);

      await ensureFile(packageReleaseNotePath);
      const existingContent = await Deno.readTextFile(packageReleaseNotePath)
        .catch(() => "");
      await Deno.writeTextFile(
        packageReleaseNotePath,
        packageReleaseNote + "\n" + existingContent,
      );
    }
  }

  // Also create the main release note in workspace root
  const releaseNote = createReleaseNote(updates, modules, now);
  const workspaceReleaseNotePath = join(root, releaseNotePath);
  await ensureFile(workspaceReleaseNotePath);
  const existingWorkspaceContent = await Deno.readTextFile(
    workspaceReleaseNotePath,
  ).catch(() => "");
  await Deno.writeTextFile(
    workspaceReleaseNotePath,
    releaseNote + "\n" + existingWorkspaceContent,
  );

  const branchName = createReleaseBranchName(now);

  if (dryRun === "git") {
    console.log(cyan("Git dry run mode - skipping git operations"));
    console.log(`Would create branch: ${branchName}`);
    console.log(
      `Would create PR: chore: release packages ${createReleaseTitle(now)}`,
    );
    return;
  }

  console.log(`Creating single PR with per-package breakdown`);
  await $`git checkout -b ${branchName}`;

  const octoKit = new Octokit({ auth: githubToken });
  const [owner, repo] = githubRepo.split("/");

  await $`deno fmt ${workspaceReleaseNotePath}`;
  await $`git add .`;
  await $`git -c "user.name=${gitUserName}" -c "user.email=${gitUserEmail}" commit -m "chore: release packages ${
    createReleaseTitle(now)
  }"`;
  await $`git push origin ${branchName}`;

  // Create PR
  const openedPr = await octoKit.request(
    "POST /repos/{owner}/{repo}/pulls",
    {
      owner,
      repo,
      base: base,
      head: branchName,
      draft: true,
      title: `chore: release packages ${createReleaseTitle(now)}`,
      body: createPerPackagePrBody(
        updates,
        diagnostics,
        githubRepo,
        branchName,
      ),
    },
  );

  console.log("New pull request:", cyan(openedPr.data.html_url));
}

export async function createIndividualTags(
  updates: VersionUpdateResult[],
  modules: WorkspaceModule[],
  _gitUserName: string,
  _gitUserEmail: string,
) {
  console.log("Creating individual tags for each package");

  for (const update of updates) {
    const module = getModule(update.summary.module, modules)!;
    const tagName = `${module.name}@${update.to}`;
    const tagMessage = `Release ${module.name} ${update.to}`;

    console.log(`Creating tag: ${cyan(tagName)}`);
    await $`git tag -a ${tagName} -m ${tagMessage}`;
    await $`git push origin ${tagName}`;
  }
}

export function createPackageReleaseNote(
  update: VersionUpdateResult,
  date: Date,
): string {
  const heading = `### ${update.summary.module} ${update.to} (${
    createReleaseTitle(date)
  })\n\n`;
  return heading +
    update.summary.commits.map((c) => `- ${c.subject}\n`).join("");
}

export function createPackagePrBody(
  update: VersionUpdateResult,
  diagnostics: Diagnostic[],
  githubRepo: string,
  releaseBranch: string,
): string {
  const module = update.summary.module;

  return `Release ${module} ${update.to}

**Changes:**
${update.summary.commits.map((c) => `- ${c.subject}`).join("\n")}

**Version Info:**
- From: ${update.from}
- To: ${update.to}
- Type: ${update.diff}

${
    diagnostics.length > 0
      ? `
**Diagnostics:**
${
        diagnostics.map((d) =>
          `- [${d.commit.subject}](/${githubRepo}/commit/${d.commit.hash}): ${d.reason}`
        ).join("\n")
      }
`
      : ""
  }

---

To make edits to this PR:

\`\`\`sh
git fetch upstream ${releaseBranch} && git checkout -b ${releaseBranch} upstream/${releaseBranch}
\`\`\`
`;
}

export function createPerPackagePrBody(
  updates: VersionUpdateResult[],
  diagnostics: Diagnostic[],
  githubRepo: string,
  releaseBranch: string,
): string {
  const table = updates.map((u) =>
    "|" + [u.summary.module, u.from, u.to, u.diff].join("|") + "|"
  ).join("\n");

  const packageSections = updates.map((update) => {
    return `### ${update.summary.module} ${update.to}

${update.summary.commits.map((c) => `- ${c.subject}`).join("\n")}
`;
  }).join("\n");

  return `Release multiple packages:

| Package | From | To | Type |
|---------|------|----|----- |
${table}

## Package Details

${packageSections}

${
    diagnostics.length > 0
      ? `
## Diagnostics

${
        diagnostics.map((d) =>
          `- [${d.commit.subject}](/${githubRepo}/commit/${d.commit.hash}): ${d.reason}`
        ).join("\n")
      }
`
      : ""
  }

---

To make edits to this PR:

\`\`\`sh
git fetch upstream ${releaseBranch} && git checkout -b ${releaseBranch} upstream/${releaseBranch}
\`\`\`
`;
}

export function createPackageReleaseBranchName(
  packageName: string,
  version: string,
  date: Date,
): string {
  const safeName = packageName.replace("@", "").replace("/", "-");
  const dateStr = date.toISOString().replace("T", "-").replaceAll(":", "-")
    .replace(/\..+/, "");
  return `release-${safeName}-${version}-${dateStr}`;
}

export function getPackageDir(module: WorkspaceModule, root: string): string {
  // Extract directory path from the module's deno.json path
  const configPath = module[pathProp];

  // For single-package repos, the config path is the root deno.json
  const packageDir = configPath.replace(/\/deno\.jsonc?$/, "");

  // If packageDir is already absolute, return it as-is
  if (isAbsolute(packageDir)) {
    return packageDir;
  }

  // For single-package repos where configPath might just be "deno.json"
  if (packageDir === configPath) {
    return root;
  }

  // Otherwise it's relative, so join with root
  return join(root, packageDir);
}

/**
 * Captures the current git state for later restoration
 */
async function captureGitState(
  options: GitContextOptions = {},
): Promise<GitState | null> {
  try {
    const cwd = options.workingDirectory || Deno.cwd();

    // Get current branch using compatible method
    const branch = await getCurrentGitBranch();

    // Check for uncommitted changes
    const status = await $`git status --porcelain`.text();
    const hasUncommittedChanges = status.trim().length > 0;

    if (!options.quiet) {
      console.log(
        `Capturing git state: branch="${branch}", uncommitted=${hasUncommittedChanges}`,
      );
    }

    return {
      branch: branch.trim(),
      workingDirectory: cwd,
      hasUncommittedChanges,
    };
  } catch (error) {
    if (!options.quiet) {
      console.warn("Failed to capture git state:", error);
    }
    return null;
  }
}

/**
 * Restores git state to a previously captured state
 */
async function restoreGitState(
  state: GitState,
  options: GitContextOptions = {},
): Promise<boolean> {
  try {
    const currentBranch = await getCurrentGitBranch();

    if (currentBranch.trim() !== state.branch) {
      if (!options.quiet) {
        console.log(
          `Restoring git branch: ${state.branch} (was on: ${currentBranch.trim()})`,
        );
      }
      await $`git checkout ${state.branch}`.quiet();
    } else {
      if (!options.quiet) {
        console.log(`Already on target branch: ${state.branch}`);
      }
    }

    if (!options.quiet) {
      console.log(`Git state restored successfully`);
    }
    return true;
  } catch (error) {
    if (!options.quiet) {
      console.warn(
        `Failed to restore git state to branch "${state.branch}":`,
        error,
      );
      console.warn(
        `You may need to manually run: git checkout ${state.branch}`,
      );
    }
    return false;
  }
}

/**
 * Executes a callback function while managing git state backup and restoration.
 *
 * This utility automatically:
 * - Captures the current git state (branch, working directory, etc.)
 * - Executes your callback function
 * - Restores the original git state afterwards (even if callback throws)
 *
 * @param callback - The function to execute within the git context
 * @param options - Configuration options for git context management
 * @returns Promise resolving to the callback's return value
 *
 * @example
 * ```typescript
 * // Simple usage
 * await withGitContext(async () => {
 *   await $`git checkout some-branch`;
 *   await $`git checkout -b feature-branch`;
 *   // Do work...
 *   // Original branch is automatically restored
 * });
 *
 * // With options
 * await withGitContext(async () => {
 *   // Git operations here
 * }, {
 *   quiet: true,
 *   stashChanges: true
 * });
 * ```
 */
export async function withGitContext<T>(
  callback: () => Promise<T>,
  options: GitContextOptions = {},
): Promise<T> {
  // Capture current git state
  const initialState = await captureGitState(options);

  if (!initialState) {
    if (!options.quiet) {
      console.warn(
        "Could not capture git state - proceeding without restoration",
      );
    }
    // Still execute callback, but without restoration
    return await callback();
  }

  try {
    // Execute the callback
    const result = await callback();
    return result;
  } finally {
    // Always restore git state, even if callback threw
    await restoreGitState(initialState, options);
  }
}

/**
 * Specialized version for testing scenarios
 */
export async function withGitContextForTesting<T>(
  callback: () => Promise<T>,
): Promise<T> {
  return withGitContext(callback, {
    quiet: true, // Don't spam test output
  });
}

/**
 * Get current git branch, compatible with older git versions and detached HEAD
 */
export async function getCurrentGitBranch(): Promise<string> {
  try {
    // Try modern approach first (Git 2.22+)
    const result = await $`git branch --show-current`.text();
    if (result.trim()) {
      return result.trim();
    }
  } catch {
    // Fallback - ignore the error and try alternatives
  }

  try {
    // Fallback for older Git versions or detached HEAD
    const output = await $`git rev-parse --abbrev-ref HEAD`.text();
    const branch = output.trim();
    // If we get "HEAD", we're in detached state, try to get a meaningful name
    if (branch === "HEAD") {
      try {
        // Try to get a tag or describe
        const described = await $`git describe --exact-match HEAD`.text();
        return described.trim();
      } catch {
        // Return the short SHA if nothing else works
        const sha = await $`git rev-parse --short HEAD`.text();
        return `detached-${sha.trim()}`;
      }
    }
    return branch;
  } catch {
    // Final fallback
    return "unknown";
  }
}
