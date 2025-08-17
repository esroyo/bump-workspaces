// Copyright 2024 the Deno authors. All rights reserved. MIT license.
import {
  assert,
  assertEquals,
  assertExists,
  assertObjectMatch,
} from "@std/assert";
import { assertSpyCallArg, spy, stub } from "@std/testing/mock";
import { assertSnapshot } from "@std/testing/snapshot";
import denoJson from "./deno.json" with { type: "json" };
import { join } from "@std/path";
import {
  applyVersionBump,
  calcVersionDiff,
  checkModuleName,
  ConfigurationError,
  createPackageReleaseNote,
  createPrBody,
  createReleaseBranchName,
  createReleaseNote,
  createReleaseTitle,
  defaultParseCommitMessage,
  type Diagnostic,
  getModule,
  getPackageDir,
  getPreviousConsolidatedTag,
  getSmartStartTag,
  getWorkspaceModules,
  getWorkspaceModulesForTesting,
  maxVersion,
  pathProp,
  summarizeVersionBumpsByModule,
  type VersionBump,
  withGitContextForTesting,
  type WorkspaceModule,
} from "./util.ts";
import { tryGetDenoConfig } from "./util.ts";

const emptyCommit = {
  subject: "",
  body: "",
  hash: "",
} as const;

const hash = "0000000000000000000000000000000000000000";

function parse(subject: string, workspaceModules: WorkspaceModule[]) {
  return defaultParseCommitMessage(
    { subject, body: "", hash },
    workspaceModules,
  );
}

Deno.test("defaultParseCommitMessage()", () => {
  const modules: WorkspaceModule[] = [
    { name: "foo", version: "0.0.0", [pathProp]: "" },
    { name: "bar", version: "0.0.0", [pathProp]: "" },
  ];

  assertEquals(parse("feat(foo): add a feature", modules), [
    {
      module: "foo",
      tag: "feat",
      version: "minor",
      commit: {
        subject: "feat(foo): add a feature",
        body: "",
        hash,
      },
    },
  ]);

  assertEquals(parse("fix(foo,bar): add a feature", modules), [
    {
      module: "foo",
      tag: "fix",
      version: "patch",
      commit: {
        subject: "fix(foo,bar): add a feature",
        body: "",
        hash,
      },
    },
    {
      module: "bar",
      tag: "fix",
      version: "patch",
      commit: {
        subject: "fix(foo,bar): add a feature",
        body: "",
        hash,
      },
    },
  ]);

  assertEquals(parse("fix(*): a bug", modules), [
    {
      module: "foo",
      tag: "fix",
      version: "patch",
      commit: {
        subject: "fix(*): a bug",
        body: "",
        hash,
      },
    },
    {
      module: "bar",
      tag: "fix",
      version: "patch",
      commit: {
        subject: "fix(*): a bug",
        body: "",
        hash,
      },
    },
  ]);

  assertEquals(parse("BREAKING(foo): some breaking change", modules), [
    {
      module: "foo",
      tag: "BREAKING",
      version: "major",
      commit: {
        subject: "BREAKING(foo): some breaking change",
        body: "",
        hash,
      },
    },
  ]);

  assertEquals(parse("perf(foo): update", modules), [
    {
      module: "foo",
      tag: "perf",
      version: "patch",
      commit: {
        subject: "perf(foo): update",
        body: "",
        hash,
      },
    },
  ]);

  assertEquals(parse("docs(foo): update", modules), [
    {
      module: "foo",
      tag: "docs",
      version: "patch",
      commit: {
        subject: "docs(foo): update",
        body: "",
        hash,
      },
    },
  ]);

  assertEquals(parse("style(foo): update", modules), [
    {
      module: "foo",
      tag: "style",
      version: "patch",
      commit: {
        subject: "style(foo): update",
        body: "",
        hash,
      },
    },
  ]);

  assertEquals(parse("refactor(foo): update", modules), [
    {
      module: "foo",
      tag: "refactor",
      version: "patch",
      commit: {
        subject: "refactor(foo): update",
        body: "",
        hash,
      },
    },
  ]);

  assertEquals(parse("test(foo): update", modules), [
    {
      module: "foo",
      tag: "test",
      version: "patch",
      commit: {
        subject: "test(foo): update",
        body: "",
        hash,
      },
    },
  ]);

  assertEquals(parse("chore(foo): update", modules), [
    {
      module: "foo",
      tag: "chore",
      version: "patch",
      commit: {
        subject: "chore(foo): update",
        body: "",
        hash,
      },
    },
  ]);

  assertEquals(parse("deprecation(foo): update", modules), [
    {
      module: "foo",
      tag: "deprecation",
      version: "patch",
      commit: {
        subject: "deprecation(foo): update",
        body: "",
        hash,
      },
    },
  ]);

  assertEquals(parse("feat(foo/unstable): a new unstable feature", modules), [
    {
      module: "foo",
      tag: "feat",
      version: "patch",
      commit: {
        subject: "feat(foo/unstable): a new unstable feature",
        body: "",
        hash,
      },
    },
  ]);

  assertEquals(
    parse("BREAKING(unstable/foo): break some unstable feature", modules),
    [
      {
        module: "foo",
        tag: "BREAKING",
        version: "patch",
        commit: {
          subject: "BREAKING(unstable/foo): break some unstable feature",
          body: "",
          hash,
        },
      },
    ],
  );
});

Deno.test("defaultParseCommitMessage() handles scopeless commits in single-package repos", () => {
  // Single package repo
  const singlePackageModules: WorkspaceModule[] = [
    {
      name: "@test/single-package",
      version: "1.0.0",
      [pathProp]: "/path/to/deno.json",
    },
  ];

  // Multi-package repo for comparison
  const multiPackageModules: WorkspaceModule[] = [
    {
      name: "@test/package-a",
      version: "1.0.0",
      [pathProp]: "/path/to/a/deno.json",
    },
    {
      name: "@test/package-b",
      version: "1.0.0",
      [pathProp]: "/path/to/b/deno.json",
    },
  ];

  const hash = "0000000000000000000000000000000000000000";

  // Test scopeless commits in single-package repo - should work
  assertEquals(
    defaultParseCommitMessage(
      { subject: "feat: add new feature", body: "", hash },
      singlePackageModules,
    ),
    [
      {
        module: "@test/single-package",
        tag: "feat",
        version: "minor",
        commit: {
          subject: "feat: add new feature",
          body: "",
          hash,
        },
      },
    ],
  );

  assertEquals(
    defaultParseCommitMessage(
      { subject: "fix: resolve critical bug", body: "", hash },
      singlePackageModules,
    ),
    [
      {
        module: "@test/single-package",
        tag: "fix",
        version: "patch",
        commit: {
          subject: "fix: resolve critical bug",
          body: "",
          hash,
        },
      },
    ],
  );

  assertEquals(
    defaultParseCommitMessage(
      { subject: "BREAKING: remove deprecated API", body: "", hash },
      singlePackageModules,
    ),
    [
      {
        module: "@test/single-package",
        tag: "BREAKING",
        version: "major",
        commit: {
          subject: "BREAKING: remove deprecated API",
          body: "",
          hash,
        },
      },
    ],
  );

  // Test with breaking change marker (with scope - current regex requires this)
  assertEquals(
    defaultParseCommitMessage(
      {
        subject: "feat(@test/single-package)!: add breaking feature",
        body: "",
        hash,
      },
      singlePackageModules,
    ),
    [
      {
        module: "@test/single-package",
        tag: "feat",
        version: "major",
        commit: {
          subject: "feat(@test/single-package)!: add breaking feature",
          body: "",
          hash,
        },
      },
    ],
  );

  // Support feat!: syntax
  assertEquals(
    defaultParseCommitMessage(
      { subject: "feat!: add breaking feature", body: "", hash },
      singlePackageModules,
    ),
    [
      {
        module: "@test/single-package",
        tag: "feat",
        version: "major",
        commit: {
          subject: "feat!: add breaking feature",
          body: "",
          hash,
        },
      },
    ],
  );

  // Test scopeless commits that don't require range (should work in single-package)
  assertEquals(
    defaultParseCommitMessage(
      { subject: "chore: update dependencies", body: "", hash },
      singlePackageModules,
    ),
    [
      {
        module: "@test/single-package",
        tag: "chore",
        version: "patch",
        commit: {
          subject: "chore: update dependencies",
          body: "",
          hash,
        },
      },
    ],
  );

  // Test that multi-package repos still require scopes for required tags
  assertEquals(
    defaultParseCommitMessage(
      { subject: "feat: add new feature", body: "", hash },
      multiPackageModules,
    ),
    {
      type: "missing_range",
      commit: { subject: "feat: add new feature", body: "", hash },
      reason: "The commit message does not specify a module.",
    },
  );

  assertEquals(
    defaultParseCommitMessage(
      { subject: "fix: resolve critical bug", body: "", hash },
      multiPackageModules,
    ),
    {
      type: "missing_range",
      commit: { subject: "fix: resolve critical bug", body: "", hash },
      reason: "The commit message does not specify a module.",
    },
  );

  // Test that non-required tags are still skipped in multi-package repos
  assertEquals(
    defaultParseCommitMessage(
      { subject: "chore: update dependencies", body: "", hash },
      multiPackageModules,
    ),
    {
      type: "skipped_commit",
      commit: { subject: "chore: update dependencies", body: "", hash },
      reason: "The commit message does not specify a module.",
    },
  );

  // Test that scoped commits still work in single-package repos
  assertEquals(
    defaultParseCommitMessage(
      { subject: "feat(api): add new endpoint", body: "", hash },
      singlePackageModules,
    ),
    [
      {
        module: "api",
        tag: "feat",
        version: "minor",
        commit: {
          subject: "feat(api): add new endpoint",
          body: "",
          hash,
        },
      },
    ],
  );
});

Deno.test("checkModuleName()", () => {
  assertEquals(
    checkModuleName({ module: "foo", tag: "chore", commit: emptyCommit }, [
      { name: "foo", version: "0.0.0", [pathProp]: "" },
    ]),
    undefined,
  );

  assertEquals(
    checkModuleName({ module: "foo", tag: "chore", commit: emptyCommit }, [
      { name: "bar", version: "0.0.0", [pathProp]: "" },
    ]),
    {
      type: "unknown_range_commit",
      commit: emptyCommit,
      reason: "Unknown module: foo.",
    },
  );

  assertEquals(
    checkModuleName({ module: "foo", tag: "feat", commit: emptyCommit }, [
      { name: "bar", version: "0.0.0", [pathProp]: "" },
    ]),
    {
      type: "unknown_range_commit",
      commit: emptyCommit,
      reason: "Unknown module: foo.",
    },
  );
});

Deno.test("defaultParseCommitMessage() errors with invalid subject", () => {
  const modules: WorkspaceModule[] = [
    { name: "foo", version: "0.0.0", [pathProp]: "" },
    { name: "bar", version: "0.0.0", [pathProp]: "" },
  ];

  assertEquals(parse("random commit", modules), {
    type: "unknown_commit",
    commit: {
      subject: "random commit",
      body: "",
      hash,
    },
    reason: "The commit message does not match the default pattern.",
  });
  assertEquals(parse("fix: update", modules), {
    type: "missing_range",
    commit: {
      subject: "fix: update",
      body: "",
      hash,
    },
    reason: "The commit message does not specify a module.",
  });
  assertEquals(parse("chore: update", modules), {
    type: "skipped_commit",
    commit: {
      subject: "chore: update",
      body: "",
      hash,
    },
    reason: "The commit message does not specify a module.",
  });
  assertEquals(parse("hey(foo): update", modules), {
    type: "unknown_commit",
    commit: {
      subject: "hey(foo): update",
      body: "",
      hash,
    },
    reason: "Unknown commit tag: hey.",
  });
});

const exampleVersionBumps = [
  {
    module: "tools",
    tag: "feat",
    version: "minor",
    commit: {
      subject:
        "feat(tools,log,http,semver): check mod exports, export items consistently from mod.ts  (#4229)",
      body: "",
      hash,
    },
  },
  {
    module: "log",
    tag: "feat",
    version: "minor",
    commit: {
      subject:
        "feat(tools,log,http,semver): check mod exports, export items consistently from mod.ts  (#4229)",
      body: "",
      hash,
    },
  },
  {
    module: "http",
    tag: "feat",
    version: "minor",
    commit: {
      subject:
        "feat(tools,log,http,semver): check mod exports, export items consistently from mod.ts  (#4229)",
      body: "",
      hash,
    },
  },
  {
    module: "semver",
    tag: "feat",
    version: "minor",
    commit: {
      subject:
        "feat(tools,log,http,semver): check mod exports, export items consistently from mod.ts  (#4229)",
      body: "",
      hash,
    },
  },
  {
    module: "log",
    tag: "BREAKING",
    version: "major",
    commit: {
      subject: "BREAKING(log): remove string formatter (#4239)",
      body: "* BREAKING(log): remove `handlers.ts`\n" +
        "\n" +
        "* fix\n" +
        "\n" +
        "* BREAKING(log): remove string formatter",
      hash,
    },
  },
  {
    module: "streams",
    tag: "BREAKING",
    version: "major",
    commit: {
      subject:
        "BREAKING(streams): remove `readAll()`, `writeAll()` and `copy()` (#4238)",
      body: "",
      hash,
    },
  },
  {
    module: "streams",
    tag: "BREAKING",
    version: "major",
    commit: {
      subject:
        "feat(streams)!: remove `readAll()`, `writeAll()` and `copy()` (#4238)",
      body: "",
      hash,
    },
  },
  {
    module: "log",
    tag: "BREAKING",
    version: "major",
    commit: {
      subject: "BREAKING(log): single-export handler files (#4236)",
      body: "",
      hash,
    },
  },
  {
    module: "io",
    tag: "BREAKING",
    version: "major",
    commit: {
      subject: "BREAKING(io): remove `types.d.ts` (#4237)",
      body: "",
      hash,
    },
  },
  {
    module: "webgpu",
    tag: "refactor",
    version: "patch",
    commit: {
      subject:
        "refactor(webgpu): use internal `Deno.close()` for cleanup of WebGPU resources (#4231)",
      body: "",
      hash,
    },
  },
  {
    module: "collections",
    tag: "feat",
    version: "minor",
    commit: {
      subject:
        "feat(collections): pass `key` to `mapValues()` transformer (#4127)",
      body: "",
      hash,
    },
  },
  {
    module: "semver",
    tag: "deprecation",
    version: "patch",
    commit: {
      subject:
        "deprecation(semver): rename `eq()`, `neq()`, `lt()`, `lte()`, `gt()` and `gte()` (#4083)",
      body: "",
      hash,
    },
  },
  {
    module: "toml",
    tag: "docs",
    version: "patch",
    commit: {
      subject: "docs(toml): complete documentation (#4223)",
      body: "",
      hash,
    },
  },
  {
    module: "path",
    tag: "deprecation",
    version: "patch",
    commit: {
      subject:
        "deprecation(path): split off all constants into their own files and deprecate old names (#4153)",
      body: "",
      hash,
    },
  },
  {
    module: "msgpack",
    tag: "docs",
    version: "patch",
    commit: {
      subject: "docs(msgpack): complete documentation (#4220)",
      body: "",
      hash,
    },
  },
  {
    module: "media_types",
    tag: "docs",
    version: "patch",
    commit: {
      subject: "docs(media_types): complete documentation (#4219)",
      body: "",
      hash,
    },
  },
  {
    module: "log",
    tag: "fix",
    version: "patch",
    commit: {
      subject: "fix(log): make `flattenArgs()` private (#4214)",
      body: "",
      hash,
    },
  },
  {
    module: "streams",
    tag: "docs",
    version: "patch",
    commit: {
      subject: "docs(streams): remove `Deno.metrics()` use in example (#4217)",
      body: "",
      hash,
    },
  },
  {
    module: "log",
    tag: "refactor",
    version: "patch",
    commit: {
      subject: "refactor(log): tidy imports and exports (#4215)",
      body: "",
      hash,
    },
  },
  {
    module: "toml",
    tag: "test",
    version: "patch",
    commit: {
      subject: "test(toml): improve test coverage (#4211)",
      body: "",
      hash,
    },
  },
  {
    module: "console",
    tag: "refactor",
    version: "patch",
    commit: {
      subject: "refactor(console): rename `_rle` to `_run_length.ts` (#4212)",
      body: "",
      hash,
    },
  },
  {
    module: "http",
    tag: "docs",
    version: "patch",
    commit: {
      subject: "docs(http): complete documentation (#4209)",
      body: "",
      hash,
    },
  },
  {
    module: "fmt",
    tag: "fix",
    version: "patch",
    commit: {
      subject: "fix(fmt): correct `stripColor()` deprecation notice (#4208)",
      body: "",
      hash,
    },
  },
  {
    module: "flags",
    tag: "fix",
    version: "patch",
    commit: {
      subject: "fix(flags): correct deprecation notices (#4207)",
      body: "",
      hash,
    },
  },
  {
    module: "toml",
    tag: "fix",
    version: "patch",
    commit: {
      subject:
        "fix(toml): `parse()` duplicates the character next to reserved escape sequences (#4192)",
      body: "",
      hash,
    },
  },
  {
    module: "semver",
    tag: "refactor",
    version: "patch",
    commit: {
      subject:
        "refactor(semver): replace `parseComparator()` with comparator objects (#4204)",
      body: "",
      hash,
    },
  },
  {
    module: "expect",
    tag: "fix",
    version: "patch",
    commit: {
      subject:
        "fix(expect): fix the function signature of `toMatchObject()` (#4202)",
      body: "",
      hash,
    },
  },
  {
    module: "log",
    tag: "feat",
    version: "minor",
    commit: {
      subject: "feat(log): make handlers disposable (#4195)",
      body: "",
      hash,
    },
  },
  {
    module: "crypto",
    tag: "chore",
    version: "patch",
    commit: {
      subject:
        "chore(crypto): upgrade to `rust@1.75.0` and `wasmbuild@0.15.5` (#4193)",
      body: "",
      hash,
    },
  },
  {
    module: "using",
    tag: "refactor",
    version: "patch",
    commit: {
      subject:
        "refactor(using): use `using` keyword for Explicit Resource Management (#4143)",
      body: "",
      hash,
    },
  },
  {
    module: "semver",
    tag: "deprecation",
    version: "patch",
    commit: {
      subject:
        "deprecation(semver): deprecate `SemVerRange`, introduce `Range` (#4161)",
      body: "",
      hash,
    },
  },
  {
    module: "log",
    tag: "refactor",
    version: "patch",
    commit: {
      subject: "refactor(log): replace deprecated imports (#4188)",
      body: "",
      hash,
    },
  },
  {
    module: "semver",
    tag: "deprecation",
    version: "patch",
    commit: {
      subject: "deprecation(semver): deprecate `outside()` (#4185)",
      body: "",
      hash,
    },
  },
  {
    module: "io",
    tag: "feat",
    version: "minor",
    commit: {
      subject: "feat(io): un-deprecate `Buffer` (#4184)",
      body: "",
      hash,
    },
  },
  {
    module: "semver",
    tag: "BREAKING",
    version: "major",
    commit: {
      subject: "BREAKING(semver): remove `FormatStyle` (#4182)",
      body: "",
      hash,
    },
  },
  {
    module: "semver",
    tag: "BREAKING",
    version: "major",
    commit: {
      subject: "BREAKING(semver): remove `compareBuild()` (#4181)",
      body: "",
      hash,
    },
  },
  {
    module: "semver",
    tag: "BREAKING",
    version: "major",
    commit: {
      subject: "BREAKING(semver): remove `rsort()` (#4180)",
      body: "",
      hash,
    },
  },
  {
    module: "http",
    tag: "BREAKING",
    version: "major",
    commit: {
      subject: "BREAKING(http): remove `CookieMap` (#4179)",
      body: "",
      hash,
    },
  },
] as VersionBump[];

Deno.test("summarizeVersionBumpsByModule()", async (t) => {
  await assertSnapshot(t, summarizeVersionBumpsByModule(exampleVersionBumps));
});

Deno.test("maxVersion() returns the bigger version update from the given 2", () => {
  assertEquals(maxVersion("major", "minor"), "major");
  assertEquals(maxVersion("minor", "major"), "major");
  assertEquals(maxVersion("major", "patch"), "major");
  assertEquals(maxVersion("patch", "major"), "major");
  assertEquals(maxVersion("minor", "patch"), "minor");
  assertEquals(maxVersion("patch", "minor"), "minor");
  assertEquals(maxVersion("patch", "patch"), "patch");
});

Deno.test("tryGetDenoConfig()", async () => {
  const [_path, config] = await tryGetDenoConfig(".");
  assertEquals(config.name, denoJson.name);
});

Deno.test("tryGetDenoConfig() error handling", async () => {
  const tempDir = await Deno.makeTempDir();

  const exitSpy = stub(Deno, "exit", function () {} as typeof Deno.exit);

  try {
    // Test with invalid JSON to trigger parse error
    await Deno.writeTextFile(
      join(tempDir, "deno.json"),
      "{ invalid json content",
    );

    try {
      await tryGetDenoConfig(tempDir);
      assert(false, "Should have thrown due to invalid JSON");
    } catch {
      // Expected - invalid JSON should cause exit
      assertSpyCallArg(exitSpy, 0, 0, 1);
    }
  } finally {
    exitSpy.restore();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("getWorkspaceModules()", async (t) => {
  const [_, modules] = await getWorkspaceModules("testdata/basic");
  assertEquals(modules.length, 5);
  assertEquals(modules.map((m) => m.name), [
    "@scope/foo",
    "@scope/bar",
    "@scope/baz",
    "@scope/qux",
    "@scope/quux",
  ]);
  await assertSnapshot(t, modules);
});

Deno.test("getModule", async () => {
  const [_, modules] = await getWorkspaceModules("testdata/basic");
  const mod = getModule("foo", modules);
  assertExists(mod);
  assertObjectMatch(mod, {
    name: "@scope/foo",
    version: "1.2.3",
  });
});

Deno.test("calcVersionDiff() error handling", () => {
  // This should trigger the "Unexpected manual version update" error
  try {
    calcVersionDiff("1.0.0", "1.0.0"); // Same version should throw
    assert(false, "Should have thrown an error");
  } catch (error) {
    assert(
      Error.isError(error) &&
        error.message.includes("Unexpected manual version update"),
    );
  }
});

Deno.test("applyVersionBump() updates the version of the given module", async () => {
  const [denoJson, versionUpdate] = await applyVersionBump(
    {
      module: "foo",
      version: "minor",
      commits: [],
    },
    { name: "@scope/foo", version: "1.0.0", [pathProp]: "foo/deno.json" },
    { name: "@scope/foo", version: "1.0.0", [pathProp]: "foo/deno.json" },
    `{
      "imports": {
        "scope/foo": "jsr:@scope/foo@^1.0.0",
        "scope/bar": "jsr:@scope/bar@^1.0.0"
      }
    }`,
    true,
  );
  assertEquals(versionUpdate.from, "1.0.0");
  assertEquals(versionUpdate.to, "1.1.0");
  assertEquals(versionUpdate.diff, "minor");
  assertEquals(
    denoJson,
    `{
      "imports": {
        "scope/foo": "jsr:@scope/foo@^1.1.0",
        "scope/bar": "jsr:@scope/bar@^1.0.0"
      }
    }`,
  );
});

Deno.test("applyVersionBump() consider major bump for 0.x version as minor bump", async () => {
  const [denoJson, updateResult] = await applyVersionBump(
    {
      module: "foo",
      version: "major",
      commits: [],
    },
    { name: "@scope/foo", version: "0.0.0", [pathProp]: "foo/deno.jsonc" },
    { name: "@scope/foo", version: "0.0.0", [pathProp]: "foo/deno.jsonc" },
    `{
      "imports": {
        "scope/foo": "jsr:@scope/foo@^0.0.0",
        "scope/bar": "jsr:@scope/bar@^1.0.0"
      }
    }`,
    true,
  );
  assertEquals(updateResult.from, "0.0.0");
  assertEquals(updateResult.to, "0.1.0");
  assertEquals(updateResult.diff, "minor");
  assertEquals(
    denoJson,
    `{
      "imports": {
        "scope/foo": "jsr:@scope/foo@^0.1.0",
        "scope/bar": "jsr:@scope/bar@^1.0.0"
      }
    }`,
  );
});

Deno.test("applyVersionBump() consider minor bump for 0.x version as patch bump", async () => {
  const [denoJson, updateResult] = await applyVersionBump(
    {
      module: "foo",
      version: "minor",
      commits: [],
    },
    { name: "@scope/foo", version: "0.1.0", [pathProp]: "foo/deno.jsonc" },
    { name: "@scope/foo", version: "0.1.0", [pathProp]: "foo/deno.jsonc" },
    `{
      "imports": {
        "scope/foo": "jsr:@scope/foo@^0.1.0",
        "scope/bar": "jsr:@scope/bar@^1.0.0"
      }
    }`,
    true,
  );
  assertEquals(updateResult.from, "0.1.0");
  assertEquals(updateResult.to, "0.1.1");
  assertEquals(updateResult.diff, "patch");
  assertEquals(
    denoJson,
    `{
      "imports": {
        "scope/foo": "jsr:@scope/foo@^0.1.1",
        "scope/bar": "jsr:@scope/bar@^1.0.0"
      }
    }`,
  );
});

Deno.test("applyVersionBump() consider any change to prerelease version as prerelease bump", async () => {
  const [denoJson, updateResult] = await applyVersionBump(
    {
      module: "foo",
      version: "minor",
      commits: [],
    },
    { name: "@scope/foo", version: "1.0.0-rc.1", [pathProp]: "foo/deno.jsonc" },
    { name: "@scope/foo", version: "1.0.0-rc.1", [pathProp]: "foo/deno.jsonc" },
    `{
      "imports": {
        "scope/foo": "jsr:@scope/foo@^1.0.0-rc.1",
        "scope/bar": "jsr:@scope/bar@^1.0.0"
      }
    }`,
    true,
  );
  assertEquals(updateResult.from, "1.0.0-rc.1");
  assertEquals(updateResult.to, "1.0.0-rc.2");
  assertEquals(updateResult.diff, "prerelease");
  assertEquals(
    denoJson,
    `{
      "imports": {
        "scope/foo": "jsr:@scope/foo@^1.0.0-rc.2",
        "scope/bar": "jsr:@scope/bar@^1.0.0"
      }
    }`,
  );
});

Deno.test("applyVersionBump() respect manual version upgrade if the version between start and base is different", async () => {
  const [denoJson, updateResult] = await applyVersionBump(
    {
      module: "foo",
      version: "minor", // This version is ignored, instead manually given version is used for calculating actual version diff
      commits: [],
    },
    { name: "@scope/foo", version: "1.0.0-rc.1", [pathProp]: "foo/deno.jsonc" },
    { name: "@scope/foo", version: "0.224.0", [pathProp]: "foo/deno.jsonc" },
    `{
      "imports": {
        "scope/foo": "jsr:@scope/foo@^1.0.0-rc.1",
        "scope/bar": "jsr:@scope/bar@^1.0.0"
      }
    }`,
    true,
  );
  assertEquals(updateResult.from, "0.224.0");
  assertEquals(updateResult.to, "1.0.0-rc.1");
  assertEquals(updateResult.diff, "prerelease");
  assertEquals(
    denoJson,
    `{
      "imports": {
        "scope/foo": "jsr:@scope/foo@^1.0.0-rc.1",
        "scope/bar": "jsr:@scope/bar@^1.0.0"
      }
    }`,
  );
});

Deno.test("applyVersionBump() respect manual version upgrade if the version between start and base is different (the case prerelease is removed)", async () => {
  const [denoJson, updateResult] = await applyVersionBump(
    {
      module: "foo",
      version: "patch", // This version is ignored, instead manually given version is used for calculating actual version diff
      commits: [],
    },
    { name: "@scope/foo", version: "1.0.0", [pathProp]: "foo/deno.jsonc" },
    { name: "@scope/foo", version: "1.0.0-rc.1", [pathProp]: "foo/deno.jsonc" },
    `{
      "imports": {
        "scope/foo": "jsr:@scope/foo@^1.0.0",
        "scope/bar": "jsr:@scope/bar@^1.0.0"
      }
    }`,
    true,
  );
  assertEquals(updateResult.from, "1.0.0-rc.1");
  assertEquals(updateResult.to, "1.0.0");
  assertEquals(updateResult.diff, "major");
  assertEquals(
    denoJson,
    `{
      "imports": {
        "scope/foo": "jsr:@scope/foo@^1.0.0",
        "scope/bar": "jsr:@scope/bar@^1.0.0"
      }
    }`,
  );
});

Deno.test("applyVersionBump() works for new module (the case when oldModule is undefined)", async () => {
  const [denoJson, updateResult] = await applyVersionBump(
    {
      module: "foo",
      version: "patch", // <= this version is ignored, instead manually given version is used for calculating actual version diff
      commits: [],
    },
    { name: "@scope/foo", version: "0.1.0", [pathProp]: "foo/deno.jsonc" },
    undefined,
    `{
      "imports": {
        "scope/foo": "jsr:@scope/foo@^0.1.0",
        "scope/bar": "jsr:@scope/bar@^1.0.0"
      }
    }`,
    true,
  );
  assertEquals(updateResult.from, "0.0.0");
  assertEquals(updateResult.to, "0.1.0");
  assertEquals(updateResult.diff, "minor");
  assertEquals(
    denoJson,
    `{
      "imports": {
        "scope/foo": "jsr:@scope/foo@^0.1.0",
        "scope/bar": "jsr:@scope/bar@^1.0.0"
      }
    }`,
  );
});

async function createVersionUpdateResults(
  versionBumps: VersionBump[],
  modules: WorkspaceModule[],
) {
  const summaries = summarizeVersionBumpsByModule(versionBumps).filter((
    { module },
  ) => getModule(module, modules) !== undefined);
  const diagnostics = versionBumps.map((versionBump) =>
    checkModuleName(versionBump, modules)
  ).filter(Boolean) as Diagnostic[];
  const updates = [];
  for (const summary of summaries) {
    const [_denoJson, versionUpdate] = await applyVersionBump(
      summary,
      getModule(summary.module, modules)!,
      getModule(summary.module, modules)!,
      "",
      true,
    );
    updates.push(versionUpdate);
  }
  return [updates, diagnostics] as const;
}

Deno.test("createReleaseNote()", async (t) => {
  const [_, modules] = await getWorkspaceModules("testdata/std_mock");
  const [updates, _diagnostics] = await createVersionUpdateResults(
    exampleVersionBumps,
    modules,
  );
  await assertSnapshot(t, createReleaseNote(updates, modules, new Date(0)));
});

Deno.test("createReleaseNote() with GitHub links - consolidated tags", async (t) => {
  const [_, modules] = await getWorkspaceModules("testdata/std_mock");
  const [updates, _diagnostics] = await createVersionUpdateResults(
    exampleVersionBumps,
    modules,
  );

  // Test consolidated tags (individualTags=false)
  const releaseNoteConsolidated = createReleaseNote(
    updates,
    modules,
    new Date(0),
    "denoland/deno_std",
    false, // individualTags=false
    "release-2024.12.31", // previousTag
  );
  await assertSnapshot(t, {
    mode: "consolidated",
    content: releaseNoteConsolidated,
  });
});

Deno.test("createReleaseNote() with GitHub links - individual tags", async (t) => {
  const [_, modules] = await getWorkspaceModules("testdata/std_mock");
  const [updates, _diagnostics] = await createVersionUpdateResults(
    exampleVersionBumps,
    modules,
  );

  // Test individual tags (individualTags=true)
  const releaseNoteIndividual = createReleaseNote(
    updates,
    modules,
    new Date(0),
    "denoland/deno_std",
    true, // individualTags=true
  );
  await assertSnapshot(t, {
    mode: "individual",
    content: releaseNoteIndividual,
  });
});

Deno.test("createPackageReleaseNote() with different tag modes", async (t) => {
  const mockUpdate = {
    summary: {
      module: "@scope/test-package",
      version: "minor" as const,
      commits: [
        {
          subject: "feat(test-package): add new feature",
          body: "",
          hash: "abc1234567890abcdef1234567890abcdef123456",
          tag: "feat",
        },
        {
          subject: "fix(test-package): fix critical bug",
          body: "",
          hash: "def4567890abcdef1234567890abcdef12345678",
          tag: "fix",
        },
      ],
    },
    from: "1.0.0",
    to: "1.1.0",
    diff: "minor" as const,
    path: "/path/to/deno.json",
  };

  // Test individual tags mode
  const noteIndividualTags = createPackageReleaseNote(
    mockUpdate,
    new Date(0),
    "owner/repo",
    true, // individualTags=true
    false, // isSinglePackage=false
  );
  await assertSnapshot(t, {
    mode: "individual-tags",
    content: noteIndividualTags,
  });

  // Test consolidated tags mode
  const noteConsolidatedTags = createPackageReleaseNote(
    mockUpdate,
    new Date(0),
    "owner/repo",
    false, // individualTags=false
    false, // isSinglePackage=false
    "release-2024.12.31", // previousTag
  );
  await assertSnapshot(t, {
    mode: "consolidated-tags",
    content: noteConsolidatedTags,
  });

  // Test single package mode
  const noteSinglePackage = createPackageReleaseNote(
    mockUpdate,
    new Date(0),
    "owner/repo",
    false, // individualTags=false (should be ignored for single package)
    true, // isSinglePackage=true
  );
  await assertSnapshot(t, {
    mode: "single-package",
    content: noteSinglePackage,
  });
});

Deno.test("getPreviousConsolidatedTag() functionality", async () => {
  await withGitContextForTesting(async () => {
    // Test the function with different tag prefixes
    const previousTag = await getPreviousConsolidatedTag(true);

    // Should return either a tag or undefined
    if (previousTag) {
      assert(typeof previousTag === "string");
      assert(previousTag.length > 0);
    } else {
      assertEquals(previousTag, undefined);
    }
  });
});

Deno.test("createPackageReleaseNote() backward compatibility", async (t) => {
  const mockUpdate = {
    summary: {
      module: "@scope/test-package",
      version: "minor" as const,
      commits: [
        {
          subject: "feat(test-package): add new feature",
          body: "",
          hash: "abc1234567890abcdef1234567890abcdef123456",
          tag: "feat",
        },
      ],
    },
    from: "1.0.0",
    to: "1.1.0",
    diff: "minor" as const,
    path: "/path/to/deno.json",
  };

  // Test without GitHub repo (backward compatibility)
  const noteWithoutLinks = createPackageReleaseNote(mockUpdate, new Date(0));
  await assertSnapshot(t, noteWithoutLinks);
});

Deno.test("createPrBody()", async (t) => {
  const [_, modules] = await getWorkspaceModules("testdata/std_mock");
  const [updates, diagnostics] = await createVersionUpdateResults(
    exampleVersionBumps,
    modules,
  );
  await assertSnapshot(
    t,
    createPrBody(
      updates,
      diagnostics,
      "denoland/deno_std",
      "release-1970-01-01-00-00-00",
    ),
  );
});

Deno.test("createReleaseBranchName()", () => {
  const date = new Date(0);
  assertEquals(
    createReleaseBranchName(date),
    "release-1970-01-01-00-00-00",
  );
});

Deno.test("createReleaseTitle()", () => {
  const date = new Date(0);
  assertEquals(createReleaseTitle(date), "1970.01.01");
});

Deno.test("createPackageReleaseNote() format", async (t) => {
  const mockUpdate = {
    summary: {
      module: "@scope/test-package",
      version: "minor" as const,
      commits: [
        {
          subject: "feat(test-package): add new feature",
          body: "",
          hash: "abc123",
          tag: "feat",
        },
        {
          subject: "fix(test-package): fix critical bug",
          body: "",
          hash: "def456",
          tag: "fix",
        },
      ],
    },
    from: "1.0.0",
    to: "1.1.0",
    diff: "minor" as const,
    path: "/path/to/deno.json",
  };

  const note = createPackageReleaseNote(mockUpdate, new Date(0));
  await assertSnapshot(t, note);
});

Deno.test("getWorkspaceModules() handles single-package repos", async () => {
  // Create a temporary directory with a single-package deno.json
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

  try {
    const [configPath, modules] = await getWorkspaceModulesForTesting(dir);

    assertEquals(modules.length, 1);
    assertEquals(modules[0].name, "@test/single-package");
    assertEquals(modules[0].version, "1.0.0");
    assertEquals(modules[0][pathProp], configPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("getWorkspaceModules() fails gracefully for invalid single-package repos", async () => {
  const dir = await Deno.makeTempDir();

  // Create deno.json without name/version
  const invalidConfig = {
    exports: "./mod.ts",
  };

  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(invalidConfig, null, 2),
  );

  try {
    let errorThrown = false;
    try {
      await getWorkspaceModulesForTesting(dir);
    } catch (error) {
      errorThrown = true;
      assert(error instanceof ConfigurationError);
      assert(error.message.includes("deno.json must have either"));
    }
    assert(errorThrown, "Expected ConfigurationError to be thrown");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ConfigurationError handling in getWorkspaceModules", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Create invalid workspace config
    await Deno.writeTextFile(
      join(tempDir, "deno.json"),
      JSON.stringify({ workspace: "invalid" }), // Should be array
    );

    try {
      await getWorkspaceModulesForTesting(tempDir);
      assert(false, "Should have thrown ConfigurationError");
    } catch (error) {
      assert(error instanceof ConfigurationError);
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("getPackageDir() works correctly for single-package repos", async () => {
  const root = "/tmp/test-project";
  const module: WorkspaceModule = {
    name: "@test/single",
    version: "1.0.0",
    [pathProp]: "/tmp/test-project/deno.json",
  };

  const packageDir = getPackageDir(module, root);
  assertEquals(packageDir, "/tmp/test-project");
});

Deno.test("getPackageDir() works correctly for relative single-package paths", async () => {
  const root = "./test-project";
  const module: WorkspaceModule = {
    name: "@test/single",
    version: "1.0.0",
    [pathProp]: "deno.json", // Just the filename, indicating root
  };

  const packageDir = getPackageDir(module, root);
  assertEquals(packageDir, "./test-project");
});

Deno.test("getSmartStartTag() with different modes", async () => {
  await withGitContextForTesting(async () => {
    const [_, modules] = await getWorkspaceModules("testdata/basic");

    const consoleSpy = spy(console, "log");

    try {
      // Test per-package mode with logging enabled
      const perPackageTag = await getSmartStartTag(
        true, // individualTags=true
        modules,
        false, // isSinglePackage=false
        false, // Enable logging to verify behavior
      );
      assert(typeof perPackageTag === "string");
      assertEquals(
        perPackageTag.length > 0,
        true,
        "Should return a non-empty tag",
      );

      // Test workspace mode
      const workspaceTag = await getSmartStartTag(
        false, // individualTags=false
        modules,
        false, // isSinglePackage=false
        false, // Enable logging
      );
      assert(typeof workspaceTag === "string");
      assertEquals(
        workspaceTag.length > 0,
        true,
        "Should return a non-empty tag",
      );

      // Test single package mode
      const singlePackageTag = await getSmartStartTag(
        false, // individualTags (ignored for single package)
        [modules[0]], // Single module
        true, // isSinglePackage=true
        false, // Enable logging
      );
      assert(typeof singlePackageTag === "string");
      assertEquals(
        singlePackageTag.length > 0,
        true,
        "Should return a non-empty tag",
      );

      // Verify function logged its detection process
      const logCalls = consoleSpy.calls.map((call) => call.args.join(" "));
      const hasDetectionLog = logCalls.some((log) =>
        log.includes("Detecting") ||
        log.includes("Found") ||
        log.includes("Using") ||
        log.includes("No tags found")
      );
      assertEquals(hasDetectionLog, true, "Should log tag detection process");
    } finally {
      consoleSpy.restore();
    }
  });
});
