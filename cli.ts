// Copyright 2024 the Deno authors. All rights reserved. MIT license.

import { parseArgs } from "@std/cli/parse-args";
import { bumpWorkspaces } from "./mod.ts";

function argToBoolean(
  arg: boolean | string | undefined,
  defaultValue: boolean,
): boolean {
  if (arg === undefined) return defaultValue;
  if (arg === "false") return false;
  return true; // Any other value (including empty string) is truthy
}

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
 * Different strategies:
 *
 * ```sh
 * # Default: Workspace strategy (consolidated tags + consolidated release notes)
 * deno run -A jsr:@esroyo/deno-bump-workspaces/cli
 *
 * # Per-package strategy (individual tags + individual release notes)
 * deno run -A jsr:@esroyo/deno-bump-workspaces/cli --individual-tags --individual-release-notes
 *
 * # Per-package strategy with custom release note filename
 * deno run -A jsr:@esroyo/deno-bump-workspaces/cli --individual-tags --individual-release-notes --release-note-path CHANGELOG.md
 *
 * # With automatic tag creation (opt-in)
 * deno run -A jsr:@esroyo/deno-bump-workspaces/cli --git-tag
 * ```
 *
 * Tag formats are standardized:
 * - Single packages: v1.2.3
 * - Multi-package individual tags: @scope/package@1.2.3
 * - Multi-package consolidated tags: release-YYYY.MM.DD
 *
 * @module
 */

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: [
      "import-map",
      "individual-tags",
      "individual-release-notes",
      "release-note-path",
      "git-tag",
    ],
    boolean: [
      "dry-run",
    ],
    negatable: [
      "individual-tags",
      "individual-release-notes",
      "git-tag",
    ],
  });

  await bumpWorkspaces({
    dryRun: args["dry-run"],
    importMap: args["import-map"],
    releaseNotePath: args["release-note-path"],
    // Use explicit flag values or defaults
    individualTags: argToBoolean(args["individual-tags"], false),
    individualReleaseNotes: argToBoolean(
      args["individual-release-notes"],
      false,
    ),
    gitTag: argToBoolean(args["git-tag"], false), // Default to false for compatibility
  });
}
