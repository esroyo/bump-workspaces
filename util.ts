// Copyright 2024 the Deno authors. All rights reserved. MIT license.
import { $ } from "@david/dax";
import { Octokit } from "npm:octokit@^3.1";
import { cyan, magenta } from "@std/fmt/colors";
import { ensureFile } from "@std/fs/ensure-file";
import { expandGlob } from "@std/fs/expand-glob";
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

export type VersionUpdateResult = {
  from: string;
  to: string;
  diff: VersionUpdate;
  path: string;
  summary: VersionBumpSummary;
};

export interface ReleaseNoteConfig {
  date: Date;
  githubRepo?: string;
  individualTags?: boolean;
  previousTag?: string;
}

export type ReleaseNoteContext =
  | { type: "single-package" }
  | { type: "workspace"; modules: WorkspaceModule[] }
  | { type: "individual-package"; modules: WorkspaceModule[] };

export interface TagSearchConfig {
  individualTags?: boolean;
  isSinglePackage?: boolean;
  modules?: WorkspaceModule[];
  quiet?: boolean;
}

/**
 * Git context state that can be captured and restored
 */
interface GitState {
  branch: string;
  hasUncommittedChanges: boolean;
}

/**
 * Options for git context management
 */
interface GitContextOptions {
  /** Custom working directory (default: current directory) */
  workingDirectory?: string;
  /** Whether to suppress restoration logging (default: false) */
  quiet?: boolean;
}

// Options interface for controlling behavior
interface GetWorkspaceModulesOptions {
  defaultName?: string;
  defaultVersion?: string;
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

export async function getWorkspaceModules(
  root: string,
  options: GetWorkspaceModulesOptions = {},
): Promise<[string, WorkspaceModule[]]> {
  const { throwOnError = false, quiet = false } = options;

  const [path, denoConfig] = await tryGetDenoConfig(root);
  const workspaces = denoConfig.workspaces || denoConfig.workspace;

  // Handle single-package repos (non-workspace)
  if (!workspaces) {
    if (!denoConfig.name && options.defaultName) {
      denoConfig.name = options.defaultName;
    }
    if (!denoConfig.version && options.defaultVersion) {
      denoConfig.version = options.defaultVersion;
    }
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
  const absoluteCommonPath = resolve(root).replace(root, "");
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
    const expandedWorkspaces = await Array.fromAsync(
      expandGlob(workspace, { root }),
    );
    for (const { path: expandedWorkspace } of expandedWorkspaces) {
      const [path, workspaceConfig] = await tryGetDenoConfig(
        expandedWorkspace.replace(absoluteCommonPath, ""),
      );
      if (!workspaceConfig.name) {
        continue;
      }
      result.push({ ...workspaceConfig, [pathProp]: path });
    }
  }
  return [path, result];
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
    // Write the updated module to its deno.json file
    const moduleJson = JSON.stringify(module, null, 2) + "\n";
    await Deno.writeTextFile(path, moduleJson);
    console.log(`Updated ${path} with version ${module.version}`);
  }

  // Update the import map content (for workspace packages)
  // For single packages, this might be the same content, but we still need to update it
  denoJson = denoJson.replace(
    new RegExp(`${module.name}@([^~]?)${currentVersionStr}`, "g"),
    `${module.name}@$1${newVersionStr}`,
  );

  // For single packages, also update the version field in the JSON content
  if (denoJson.includes(`"version": "${currentVersionStr}"`)) {
    denoJson = denoJson.replace(
      `"version": "${currentVersionStr}"`,
      `"version": "${newVersionStr}"`,
    );
    console.log(`Updated version field in import map content`);
  }

  return [denoJson, {
    from: currentVersionStr,
    to: newVersionStr,
    diff,
    summary,
    path,
  }];
}

/**
 * Unified release note creation function
 */
export function createReleaseNote(
  updates: VersionUpdateResult | VersionUpdateResult[],
  context: ReleaseNoteContext,
  config: ReleaseNoteConfig,
): string {
  const updatesArray = Array.isArray(updates) ? updates : [updates];
  const releaseTitle = createReleaseTitle(config.date);

  switch (context.type) {
    case "single-package":
      return buildSinglePackageNote(updatesArray[0], releaseTitle, config);

    case "workspace":
      return buildWorkspaceNote(
        updatesArray,
        context.modules,
        releaseTitle,
        config,
      );

    case "individual-package":
      return buildIndividualPackageNote(
        updatesArray[0],
        context.modules,
        releaseTitle,
        config,
      );
  }
}

function buildSinglePackageNote(
  update: VersionUpdateResult,
  releaseTitle: string,
  config: ReleaseNoteConfig,
): string {
  const { fromTag, toTag } = createSinglePackageTags(
    update,
    config.previousTag,
  );
  const versionText = formatVersionWithLink(
    update.to,
    config.githubRepo,
    fromTag,
    toTag,
  );

  return `### ${versionText} (${releaseTitle})\n\n${
    formatCommitList(update.summary.commits, config.githubRepo)
  }`;
}

function buildWorkspaceNote(
  updates: VersionUpdateResult[],
  modules: WorkspaceModule[],
  releaseTitle: string,
  config: ReleaseNoteConfig,
): string {
  const heading = `### ${releaseTitle}\n\n`;

  const moduleNotes = updates.map((update) => {
    const module = getModule(update.summary.module, modules)!;
    const { fromTag, toTag } = createWorkspaceTags(
      module,
      update,
      config.individualTags,
      releaseTitle,
      config.previousTag,
    );
    const versionText = formatVersionWithLink(
      update.to,
      config.githubRepo,
      fromTag,
      toTag,
    );
    const commits = formatCommitList(update.summary.commits, config.githubRepo);

    return `#### ${module.name} ${versionText} (${update.diff})\n${commits}`;
  }).join("\n");

  return heading + moduleNotes;
}

function buildIndividualPackageNote(
  update: VersionUpdateResult,
  modules: WorkspaceModule[],
  releaseTitle: string,
  config: ReleaseNoteConfig,
): string {
  const module = getModule(update.summary.module, modules);

  const { fromTag, toTag } = createWorkspaceTags(
    module!,
    update,
    config.individualTags,
    releaseTitle,
    config.previousTag,
  );
  const versionText = formatVersionWithLink(
    update.to,
    config.githubRepo,
    fromTag,
    toTag,
  );

  return `### ${versionText} (${releaseTitle})\n\n${
    formatCommitList(update.summary.commits, config.githubRepo)
  }`;
}

function createSinglePackageTags(
  update: VersionUpdateResult,
  previousTag?: string,
): { fromTag: string; toTag: string } {
  return {
    fromTag: previousTag || `v${update.from}`,
    toTag: `v${update.to}`,
  };
}

function createWorkspaceTags(
  module: WorkspaceModule,
  update: VersionUpdateResult,
  individualTags = false,
  releaseTitle: string,
  previousTag?: string,
): { fromTag: string; toTag: string } {
  if (individualTags) {
    return {
      fromTag: `${module.name}@${update.from}`,
      toTag: `${module.name}@${update.to}`,
    };
  }

  return {
    fromTag: previousTag || "",
    toTag: `release-${releaseTitle}`,
  };
}

function formatVersionWithLink(
  version: string,
  githubRepo?: string,
  fromTag?: string,
  toTag?: string,
): string {
  if (githubRepo && fromTag && toTag) {
    return `[${version}](https://github.com/${githubRepo}/compare/${fromTag}...${toTag})`;
  }
  return version;
}

function formatCommitList(
  commits: Array<{ subject: string; hash: string }>,
  githubRepo?: string,
): string {
  return commits.map((commit) => {
    const shortHash = commit.hash.substring(0, 7);
    const commitLink = githubRepo
      ? ` ([${shortHash}](https://github.com/${githubRepo}/commit/${commit.hash}))`
      : "";
    return `- ${commit.subject}${commitLink}\n`;
  }).join("");
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
- [ ] Release notes are updated correctly

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

export async function createPullRequest({
  updates,
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
  newBranchName: string;
  gitUserName?: string;
  gitUserEmail?: string;
  githubToken?: string;
  githubRepo?: string;
  base: string;
  gitTag?: boolean;
  individualTags: boolean;
  individualReleaseNotes: boolean;
  isSinglePackage: boolean;
}) {
  gitUserName ??= Deno.env.get("GIT_USER_NAME");
  gitUserEmail ??= Deno.env.get("GIT_USER_EMAIL");
  githubToken ??= Deno.env.get("GITHUB_TOKEN");
  githubRepo ??= Deno.env.get("GITHUB_REPOSITORY");

  // Get previous consolidated tag if we're using consolidated releases
  let previousTag: string | undefined;
  if (!individualTags && !isSinglePackage) {
    previousTag = await resolveTag("previous-consolidated", { quiet: true });
  }

  let workspaceReleaseNote: string | undefined;
  const workspaceReleaseNotePath = join(root, releaseNotePath);
  const packageReleaseNotes: Array<[string, string]> = [];

  if (isSinglePackage) {
    // Single-package repos: Use simple format at root
    if (updates.length > 0) {
      workspaceReleaseNote = createReleaseNote(
        updates[0],
        { type: "single-package" },
        { date: now, githubRepo, individualTags, previousTag },
      );
    }
  } else if (individualReleaseNotes) {
    // Multi-package with individual notes: Create individual notes ONLY
    for (const update of updates) {
      const module = getModule(update.summary.module, modules)!;
      const packageDir = getPackageDir(module, root);
      const packageReleaseNotePath = join(packageDir, releaseNotePath);
      const packageReleaseNote = createReleaseNote(
        update,
        { type: "individual-package", modules },
        { date: now, githubRepo, individualTags, previousTag },
      );
      packageReleaseNotes.push([packageReleaseNotePath, packageReleaseNote]);
    }
    // No workspace-level release note for individual strategy
  } else {
    // Multi-package default: Create workspace-level note only
    workspaceReleaseNote = createReleaseNote(
      updates,
      { type: "workspace", modules },
      { date: now, githubRepo, individualTags, previousTag },
    );
  }

  if (dryRun === true) {
    console.log();

    if (individualReleaseNotes && !isSinglePackage) {
      // Multi-package with individual notes: show each individual note
      console.log(cyan("Individual release notes that would be created:"));
      console.log();

      for (
        const [packageReleaseNotePath, packageReleaseNote]
          of packageReleaseNotes
      ) {
        console.log(magenta(`✍${packageReleaseNotePath}:`));
        console.log(packageReleaseNote);
        console.log(); // Add spacing between notes
      }

      console.log(cyan("No workspace-level release note would be created."));
    } else {
      // Multi-package workspace strategy: show workspace note
      // Single-package: show the single release note
      if (workspaceReleaseNote) {
        console.log(cyan("The release note:"));
        console.log(workspaceReleaseNote);
      }
    }

    if (gitTag) {
      console.log();
      console.log(cyan("Tags that would be created:"));

      if (individualTags && !isSinglePackage) {
        // Individual package tags: @scope/package@1.2.3
        for (const update of updates) {
          const module = getModule(update.summary.module, modules)!;
          console.log(`${module.name}@${update.to}`);
        }
      } else if (isSinglePackage) {
        // Single package semver tag: v1.2.3
        for (const update of updates) {
          console.log(`v${update.to}`);
        }
      } else {
        // Consolidated release tag: release-YYYY.MM.DD
        console.log(`release-${createReleaseTitle(now)}`);
      }
    }

    console.log();
    console.log(cyan("Skip making a commit."));
    console.log(cyan("Skip making a pull request."));
  } else {
    // Updates deno.json
    await Deno.writeTextFile(importMapPath, importMapJson);

    // Write workspace release note only if we have one
    if (workspaceReleaseNote) {
      await ensureFile(workspaceReleaseNotePath);
      const existingContent = await Deno.readTextFile(workspaceReleaseNotePath)
        .catch(() => "");
      await Deno.writeTextFile(
        workspaceReleaseNotePath,
        workspaceReleaseNote + "\n" + existingContent,
      );
      await $`deno fmt ${workspaceReleaseNotePath}`;
    }

    for (
      const [packageReleaseNotePath, packageReleaseNote] of packageReleaseNotes
    ) {
      await ensureFile(packageReleaseNotePath);
      const existingContent = await Deno.readTextFile(packageReleaseNotePath)
        .catch(() => "");
      await Deno.writeTextFile(
        packageReleaseNotePath,
        packageReleaseNote + "\n" + existingContent,
      );
      await $`deno fmt ${packageReleaseNotePath}`;
    }

    if (dryRun === false) {
      if (gitUserName === undefined) {
        console.error("GIT_USER_NAME is not set.");
        Deno.exit(1);
      }
      if (gitUserEmail === undefined) {
        console.error("GIT_USER_EMAIL is not set.");
        Deno.exit(1);
      }
      if (githubToken === undefined) {
        console.error("GITHUB_TOKEN is not set.");
        Deno.exit(1);
      }
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

      if (gitTag) {
        console.log("Creating version tags...");

        if (individualTags && !isSinglePackage) {
          // Create individual package tags: @scope/package@1.2.3
          for (const update of updates) {
            const module = getModule(update.summary.module, modules)!;
            const tagName = `${module.name}@${update.to}`;

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
        } else if (isSinglePackage) {
          // Single package: v1.2.3
          for (const update of updates) {
            const tagName = `v${update.to}`;

            try {
              await $`git rev-parse ${tagName}`.quiet();
              console.log(`Tag ${cyan(tagName)} already exists, skipping`);
            } catch {
              await $`git tag ${tagName}`;
              console.log(`Created tag: ${cyan(tagName)}`);
            }
          }
        } else {
          // Consolidated release tag: release-YYYY.MM.DD
          const tagName = `release-${createReleaseTitle(now)}`;

          try {
            await $`git rev-parse ${tagName}`.quiet();
            console.log(`Tag ${cyan(tagName)} already exists, skipping`);
          } catch {
            await $`git tag ${tagName}`;
            console.log(`Created tag: ${cyan(tagName)}`);
          }
        }
      }

      console.log(`Pushing the new branch ${magenta(newBranchName)}.`);
      if (gitTag) {
        // Push branch and tags together
        await $`git push origin ${newBranchName} --tags`;
        console.log("Tags pushed along with branch");
      } else {
        // Just push the branch
        await $`git push origin ${newBranchName}`;
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

export async function resolveTag(
  purpose: "start",
  config: TagSearchConfig,
): Promise<string>;
export async function resolveTag(
  purpose: "previous-consolidated",
  config: TagSearchConfig,
): Promise<string | undefined>;
export async function resolveTag(
  purpose: "start" | "previous-consolidated",
  config: TagSearchConfig,
): Promise<string | undefined> {
  const { quiet = false } = config;

  if (purpose === "previous-consolidated") {
    return await getPreviousConsolidatedTagLogic(quiet);
  }

  return await getStartTagLogic(config);
}

async function getPreviousConsolidatedTagLogic(
  quiet: boolean,
): Promise<string | undefined> {
  try {
    const tags = await $`git tag -l "release-*" --sort=-version:refname`.text();
    const tagList = tags.trim().split("\n").filter(Boolean);

    if (tagList.length > 0) {
      const previousTag = tagList[0];
      if (!quiet) {
        console.log(`Found previous consolidated tag: ${previousTag}`);
      }
      return previousTag;
    }

    if (!quiet) {
      console.log("No previous consolidated tags found");
    }
    return undefined;
  } catch (error) {
    if (!quiet) {
      console.warn("Failed to get previous consolidated tag:", error);
    }
    return undefined;
  }
}

async function getStartTagLogic(config: TagSearchConfig): Promise<string> {
  const { individualTags, isSinglePackage, modules = [], quiet = false } =
    config;

  try {
    if (individualTags && !isSinglePackage) {
      // Per-package workspace: find most recent tag across all packages by DATE
      if (!quiet) {
        console.log("Detecting per-package workspace tags...");
      }

      const packageTags: Array<{ tag: string; date: Date; package: string }> =
        [];

      for (const module of modules) {
        try {
          const packagePattern = `${module.name}@*`;
          const packageTag =
            await $`git describe --tags --abbrev=0 --match=${packagePattern}`
              .text();

          if (packageTag.trim()) {
            // Get the tag date for sorting
            const tagDate =
              await $`git log -1 --format=%ai ${packageTag.trim()}`.text();
            packageTags.push({
              tag: packageTag.trim(),
              date: new Date(tagDate.trim()),
              package: module.name,
            });

            if (!quiet) {
              console.log(`Found ${module.name}: ${packageTag.trim()}`);
            }
          }
        } catch {
          if (!quiet) {
            console.log(`No tags found for ${module.name}`);
          }
        }
      }

      if (packageTags.length > 0) {
        // Return the most recent tag across all packages BY DATE
        packageTags.sort((a, b) => b.date.getTime() - a.date.getTime());
        const mostRecentTag = packageTags[0].tag;

        if (!quiet) {
          console.log(`Using most recent tag: ${mostRecentTag}`);
        }
        return mostRecentTag;
      }
    } else if (isSinglePackage) {
      // Single package: look for version tags with v prefix
      try {
        const versionPattern = `v*`;
        const latestTag =
          await $`git describe --tags --abbrev=0 --match=${versionPattern}`
            .text();

        if (!quiet) {
          console.log(`Found single-package tag: ${latestTag.trim()}`);
        }
        return latestTag.trim();
      } catch {
        if (!quiet) {
          console.log(`No v* tags found, trying fallback...`);
        }
      }
    }

    // Fallback to original behavior
    const fallbackTag = await $`git describe --tags --abbrev=0`.text();
    if (!quiet) {
      console.log(`Using fallback tag: ${fallbackTag.trim()}`);
    }
    return fallbackTag.trim();
  } catch {
    // No tags at all
    if (!quiet) {
      console.log("No tags found, analyzing all history");
    }
    try {
      const firstCommit = await $`git rev-list --max-parents=0 HEAD`.text();
      return firstCommit.trim().split("\n")[0];
    } catch {
      return "";
    }
  }
}

/**
 * Get current git branch, compatible with older git versions and detached HEAD
 */
export async function getCurrentGitBranch(): Promise<string> {
  try {
    // Try modern approach first
    const result = await $`git branch --show-current`.text();
    if (result.trim()) return result.trim();

    // Fallback for older versions
    const branch = await $`git rev-parse --abbrev-ref HEAD`.text().then((s) =>
      s.trim()
    );
    if (branch === "HEAD") {
      // Detached HEAD - try to get meaningful name
      try {
        return await $`git describe --exact-match HEAD`.text().then((s) =>
          s.trim()
        );
      } catch {
        const sha = await $`git rev-parse --short HEAD`.text();
        return `detached-${sha.trim()}`;
      }
    }
    return branch;
  } catch {
    return "unknown";
  }
}

/**
 * Captures the current git state for later restoration
 */
async function captureGitState(
  options: GitContextOptions = {},
): Promise<GitState | null> {
  try {
    const branch = await getCurrentGitBranch();
    const status = await $`git status --porcelain`.text();
    const hasUncommittedChanges = status.trim().length > 0;

    if (!options.quiet) {
      console.log(
        `Capturing git state: branch="${branch}", uncommitted=${hasUncommittedChanges}`,
      );
    }

    return { branch, hasUncommittedChanges };
  } catch (error) {
    if (!options.quiet) console.warn("Failed to capture git state:", error);
    return null;
  }
}

/**
 * Restores git state to a previously captured state
 */
async function restoreGitState(
  state: GitState,
  options: GitContextOptions = {},
): Promise<void> {
  try {
    const currentBranch = await getCurrentGitBranch();

    if (currentBranch !== state.branch) {
      if (!options.quiet) {
        console.log(
          `Restoring git branch: ${state.branch} (was on: ${currentBranch})`,
        );
      }
      await $`git checkout ${state.branch}`.quiet();
    } else if (!options.quiet) {
      console.log(`Already on target branch: ${state.branch}`);
    }

    if (!options.quiet) console.log("Git state restored successfully");
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
  }
}

/**
 * Executes a callback function while managing git state backup and restoration.
 *
 * @param callback - The function to execute within the git context
 * @param options - Configuration options for git context management
 * @returns Promise resolving to the callback's return value
 *
 * @example
 * ```typescript
 * await withGitContext(async () => {
 *   await $`git checkout feature-branch`;
 *   // Do work... original branch is automatically restored
 * });
 * ```
 */
export async function withGitContext<T>(
  callback: () => Promise<T>,
  options: GitContextOptions = {},
): Promise<T> {
  const initialState = await captureGitState(options);

  if (!initialState) {
    if (!options.quiet) {
      console.warn(
        "Could not capture git state - proceeding without restoration",
      );
    }
    return await callback();
  }

  try {
    return await callback();
  } finally {
    await restoreGitState(initialState, options);
  }
}
