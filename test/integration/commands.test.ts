/* eslint-disable no-console */
import test from "ava";
import glob from "fast-glob";

import { createShell, Shell } from "universal-shell";
import { existsSync } from "fs";
import { unlink, writeFile } from "fs/promises";
import { resolve } from "path";
import { tmpdir } from "os";

import { createTestAssets, cleanTestDir, writeTestFile, readTextFile, sleep } from "./utils";
import { build, specification } from "../../dist/index.js";

const { testName: defaultTest, testDir: defaultTestDir } = await cleanTestDir("test-default");
const { testName: reactTest, testDir: reactTestDir } = await cleanTestDir("test-react");

console.log({ defaultTestDir, reactTestDir });

test.before("[create] should create all template types", async () => {
  if (process.env.SKIP_TEST_SETUP) {
    return;
  }

  const shell = createShell();
  process.chdir(tmpdir());

  /**
   * Install dependencies for tests serially to prevent yarn cache errors.
   */
  await shell.run(`tsmodule create --react ${reactTest}`);
  await shell.run(`tsmodule create ${defaultTest}`);

  const dirsToCopyDevInto: string[] = [];

  await Promise.all(
    dirsToCopyDevInto.map(async (dirToCopyInto) => {
      const shell = createShell();
      await shell.run(`cp -rf ${defaultTestDir} ${dirToCopyInto}`);
    })
  );

  for (const dirToLink of [
    defaultTestDir,
    reactTestDir,
    ...dirsToCopyDevInto,
  ]) {
    process.chdir(dirToLink);
    await shell.run("npm link -f @tsmodule/tsmodule --no-save --scripts-prepend-node-path");
  }
});

const dev = async (shell: Shell) => {
  try {
    await shell.run(`yarn tsmodule dev ${defaultTest}`);
  } catch (e) {
    console.log({ e });
  }
};

const stdinImportStatement = "import { test } from \"./stdin-import\";\nconsole.log(test);";
const writeStdinImportFile = async () =>
  await writeFile(resolve(defaultTestDir, "src/stdin-import.ts"), "export const test = 42;");

test.serial("[create --react] should create Next.js component library", async (t) => {
  process.chdir(reactTestDir);

  const pkgJson = await readTextFile(resolve(reactTestDir, "package.json"));
  const { dependencies } = JSON.parse(pkgJson);

  t.assert("react" in dependencies, "should add react dependency");
  t.assert("react-dom" in dependencies, "should add react-dom dependency");
});

test.serial("[create --react] should create expected files", async (t) => {
  process.chdir(reactTestDir);

  for (const filePattern of specification.default.files) {
    t.assert(glob.sync(filePattern).length, `should create default file ${filePattern}`);
  }

  for (const filePattern of specification.react.files) {
    t.assert(glob.sync(filePattern).length, `should create React-specific file ${filePattern}`);
  }
});

test.serial("[build --binary] should create binaries", async (t) => {
  process.chdir(defaultTestDir);

  await build({
    binary: true,
  });

  const binaries = glob.sync("./bin-*");
  t.snapshot(binaries);
});

test.serial("[dev] should watch for file changes", async (t) => {
  process.chdir(defaultTestDir);
  const shell = createShell();

  await Promise.allSettled([
    dev(shell),
    (async () => {
      await writeTestFile(
        defaultTest,
        "src/update.ts",
        "export const hello = 'world';"
      );
      await sleep(5000);
      shell.kill();
    })(),
  ]);

  const emittedDevFile = resolve(defaultTestDir, "dist/update.js");
  const emittedDevModule = await readTextFile(emittedDevFile);

  t.snapshot(emittedDevModule);
});

test("[dev] dist/ clearing", async (t) => {
  process.chdir(defaultTestDir);
  const shell = createShell();

  t.assert(
    existsSync(resolve(defaultTestDir, "dist/update.js")),
    "should begin this test with dist/ files"
  );

  await unlink(resolve(defaultTestDir, "src/update.ts"));

  await Promise.allSettled([
    dev(shell),
    (async () => {
      await sleep();
      shell.kill();
    })(),
  ]);

  t.assert(
    !existsSync(resolve(defaultTestDir, "dist/update.js")),
    "should clear dist/ files on dev start"
  );
});

test("[dev] should notice new file", async (t) => {
  process.chdir(defaultTestDir);
  const shell = createShell();

  await Promise.allSettled([
    dev(shell),
    (async () => {
      await writeTestFile(
        defaultTest,
        "src/path/to/newFile.ts",
        "export const abc = 123;"
      );

      shell.kill();

      const emittedDevFile = resolve(defaultTestDir, "dist/path/to/newFile.js");
      const emittedDevModule = await readTextFile(emittedDevFile);

      t.snapshot(emittedDevModule);
    })(),
  ]);

  t.pass();
});

test.serial("[dev] should copy new non-source files to dist/", async (t) => {
  process.chdir(defaultTestDir);
  const shell = createShell();

  await Promise.all([
    (async () => {
      await dev(shell);
    })(),
    (async () => {
      await createTestAssets(defaultTestDir);
      console.log("Created test assets.");
      shell.kill();
    })(),
  ]);

  const emittedPng = resolve(defaultTestDir, "dist/path/to/assets/tsmodule.png");
  const emittedCss = await readTextFile(resolve(defaultTestDir, "dist/index.css"));

  t.assert(
    existsSync(emittedPng),
    "should copy test PNG to dist/"
  );

  t.snapshot(
    emittedCss,
    "should copy src/index.css to dist/"
  );
});

test.serial("[create --react] library should build with Next", async (t) => {
  if (process.platform === "win32") {
    t.pass();
    return;
  }

  process.chdir(reactTestDir);
  const shell = createShell();

  await shell.run("yarn build");
  t.pass();
});

test.serial("[build --stdin] should build source provided via stdin", async (t) => {
  process.chdir(defaultTestDir);
  const shell = createShell();

  await writeStdinImportFile();

  await t.notThrowsAsync(
    async () => await build({
      stdin: stdinImportStatement,
      stdinFile: "src/stdin-nobundle.ts",
    }),
    "[non-bundle] should build source provided programmatically via { stdin } arg"
  );

  t.snapshot(
    await readTextFile(resolve(defaultTestDir, "dist/stdin-nobundle.js")),
    "[non-bundle] emitted stdin output should match snapshot"
  );

  await t.notThrowsAsync(
    async () => await build({
      stdin: stdinImportStatement,
      stdinFile: "src/stdin-bundle.ts",
      bundle: true,
    }),
    "[bundle] should build source provided programmatically via { stdin } arg"
  );

  t.assert(
    !existsSync("dist/stdin-nobundle.js"),
    "[build] should clear dist/ before building"
  );

  t.snapshot(
    await readTextFile(resolve(defaultTestDir, "dist/stdin-bundle.js")),
    "[bundle] emitted stdin bundle should match snapshot"
  );

  if (process.platform !== "win32") {
    await t.notThrowsAsync(
      async () => {
        await shell.run("echo \"console.log(42)\" | yarn tsmodule build --stdin --stdin-file src/stdin-pipe.ts");
      }
    );

    t.snapshot(
      await readTextFile(resolve(defaultTestDir, "dist/stdin-pipe.js")),
      "[pipe] emitted stdin bundle should match snapshot"
    );
  }
});

test.serial("[build -r] should copy non-source files to dist/", async (t) => {
  process.chdir(defaultTestDir);
  const shell = createShell();

  await createTestAssets(defaultTest);
  await shell.run("yarn tsmodule build -r");

  await sleep();

  t.assert(existsSync(resolve(defaultTestDir, "dist/path/to/assets/tsmodule.png")));
  t.snapshot(await readTextFile(resolve(defaultTestDir, "dist/index.css")));
  t.snapshot(await readTextFile(resolve(defaultTestDir, "dist/index.css")));
});

test.serial("[build -b] should bundle output", async (t) => {
  process.chdir(defaultTestDir);
  const shell = createShell();

  await writeFile(
    resolve(defaultTestDir, "src/bundle-a.ts"),
    "import { b } from \"./bundle-b\";\nconsole.log(b);"
  );

  await writeFile(
    resolve(defaultTestDir, "src/bundle-b.ts"),
    "export const b = 42;"
  );

  await sleep(5000);

  await t.notThrowsAsync(
    async () => await shell.run("yarn tsmodule build -b"),
    "should bundle non-React projects"
  );

  const bundle = await readTextFile(resolve(defaultTestDir, "dist/bundle-a.js"));
  t.assert(
    !bundle.includes("console.log(42)"),
    "should not inline relative imports in emitted bundles"
  );

  process.chdir(reactTestDir);
  await t.notThrowsAsync(
    async () => await shell.run("yarn tsmodule build -b"),
    "should bundle React projects"
  );

  const bundleCss = await readTextFile(resolve(reactTestDir, "dist/bundle.css"));
  t.snapshot(bundleCss, "should bundle CSS in-place");

  const componentsCss = await readTextFile(resolve(reactTestDir, "dist/components/index.css"));
  t.snapshot(componentsCss, "components CSS should match snapshot");

  const loadComponent = async () => await import(resolve(reactTestDir, "dist/pages/index.js"));
  await t.notThrowsAsync(loadComponent, "bundled component modules should load");

  const { default: bundledComponent } = await loadComponent();
  const renderedComponent = bundledComponent();
  t.snapshot(renderedComponent["$$typeof"], "bundled component should render");
});

// test.serial("[build --js-only] should not build styles", async (t) => {
//   process.chdir(reactTestDir);

//   await t.notThrowsAsync(
//     async () => await build({
//       jsOnly: true,
//     }),
//   );

//   t.assert(!existsSync(resolve(defaultTestDir, "dist/bundle.css")));
// });

// test.serial("[build --no-write] should return transformed code", async (t) => {
//   process.chdir(defaultTestDir);
//   let sourceCode;

//   writeStdinImportFile();

//   await t.notThrowsAsync(
//     async () => {
//       sourceCode = await build({
//         stdin: stdinImportStatement,
//         stdinFile: "src/stdin-nowrite.ts",
//         noWrite: true,
//       });
//     },
//     "[--no-write] should return transformed source code"
//   );

//   t.assert(!existsSync(resolve(defaultTestDir, "dist/stdin-nowrite.js")), "[--no-write] should not write to disk");
//   t.snapshot({ sourceCode }, "build() should return source code with { noWrite: true }");
// });

// test.serial("[create --react] library should build and execute", async (t) => {
//   process.chdir(reactTestDir);
//   const shell = createShell();

//   if (process.platform === "win32") {
//     t.pass();
//     return;
//   }

//   await t.notThrowsAsync(
//     async () => await shell.run("yarn tsmodule build && node dist/index.js"),
//     "should build and execute"
//   );

//   t.snapshot(
//     await readTextFile(resolve(reactTestDir, "dist/bundle.css")),
//     "[react] should build production CSS to dist/bundle.css"
//   );
// });

// test.serial("[build] command", async (t) => {
//   process.chdir(defaultTestDir);
//   const shell = createShell();

//   await t.notThrowsAsync(
//     async () => await shell.run("yarn tsmodule build && node dist/index.js"),
//     "should build and execute"
//   );

//   const emittedFile = resolve(defaultTestDir, "dist/index.js");
//   const emittedModule = await readTextFile(emittedFile);

//   t.snapshot(emittedModule, "emitted module should match snapshot");

//   t.assert(
//     existsSync(resolve(defaultTestDir, "dist/index.d.ts")),
//     "should generate .d.ts files"
//   );
// });