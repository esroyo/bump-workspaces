// Copyright 2024 the Deno authors. All rights reserved. MIT license.

import { parseArgs } from "@std/cli/parse-args";
import { bumpWorkspaces } from "./mod.ts";

/**
 * The CLI entrypoint of the package. You can directly perform the version bump behavior from CLI:
 *
 * ```sh
 * deno run -A jsr:@esroyo/deno-bump-workspaces/cli
 * ```
 *
 * The endpoint supports --dry-run option:
 *
 * ```sh
 * deno run -A jsr:@esroyo/deno-bump-workspaces/cli --dry-run
 * ```
 *
 * You can specify import map path by `--import-map` option (Default is deno.json(c) at the root):
 *
 * ```sh
 * deno run -A jsr:@esroyo/deno-bump-workspaces/cli --import-map ./import_map.json
 * ```
 *
 * For per-package publishing mode:
 *
 * ```sh
 * # Per-package mode (individual tags and release notes by default)
 * deno run -A jsr:@esroyo/deno-bump-workspaces/cli --publish-mode per-package
 *
 * # Per-package mode with individual PRs
 * deno run -A jsr:@esroyo/deno-bump-workspaces/cli --publish-mode per-package --individual-prs
 *
 * # Per-package mode but opt out of individual release notes
 * deno run -A jsr:@esroyo/deno-bump-workspaces/cli --publish-mode per-package --no-individual-release-notes
 * ```
 *
 * @module
 */

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: [
      "import-map",
      "release-note-path",
      "publish-mode",
    ],
    boolean: [
      "dry-run",
      "individual-prs",
      "individual-tags",
      "individual-release-notes",
    ],
    negatable: [
      "individual-prs",
      "individual-tags",
      "individual-release-notes",
    ],
  });

  // Validate publish mode
  const publishMode = args["publish-mode"];
  if (publishMode && !["workspace", "per-package"].includes(publishMode)) {
    console.error(
      "Error: --publish-mode must be either 'workspace' or 'per-package'",
    );
    Deno.exit(1);
  }

  // Warn if per-package options are used without per-package mode
  if (
    publishMode !== "per-package" &&
    (args["individual-prs"] || args["individual-tags"] ||
      args["individual-release-notes"])
  ) {
    console.warn(
      "Warning: individual-* options are only effective when --publish-mode is 'per-package'",
    );
  }

  // Set defaults based on publish mode
  const isPerPackageMode = publishMode === "per-package";

  await bumpWorkspaces({
    dryRun: args["dry-run"],
    importMap: args["import-map"],
    releaseNotePath: args["release-note-path"],
    publishMode: publishMode as "workspace" | "per-package" | undefined,
    // Use CLI args if provided, otherwise use mode-appropriate defaults
    individualPRs: args["individual-prs"] ?? false,
    individualTags: args["individual-tags"] ?? isPerPackageMode,
    individualReleaseNotes: args["individual-release-notes"] ??
      isPerPackageMode,
  });
}
