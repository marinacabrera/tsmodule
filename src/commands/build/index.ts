import { createDebugLogger } from "debug-logging";
import { log } from "@tsmodule/log";
import { constants, existsSync } from "fs";
import { copyFile, mkdir, readFile, rm, unlink, writeFile } from "fs/promises";
import { dirname, extname, isAbsolute, resolve, resolve as resolvePath } from "path";
import { build as esbuild, transform, BuildOptions, TransformOptions, CommonOptions, Plugin } from "esbuild";
import { env } from "process";
import chalk from "chalk";
import glob from "fast-glob";
import ora from "ora";
import { getTsconfig } from "get-tsconfig";

import { getEmittedFile, getWorkingDirs } from "../../utils/cwd";
import { isJsOrTs, isTs, isTsxOrJsx } from "../../utils/resolve";
import { emitTsDeclarations } from "./lib/emitTsDeclarations";
import { getPackageJsonFile } from "../../utils/packageJson";
import { normalizeImportSpecifiers } from "../normalize";
import { readStdin } from "../../utils/stdin";
import { showProgress } from "../../utils/showProgress";
import { relativeExternsPlugin } from "../../specification/externs";
import { ESM_REQUIRE_SHIM, removeEsmShim } from "../../specification/removeEsmShim";
import { buildCssEntryPoint, forceModuleTypeInDist, overwriteEntryPoint } from "./lib/buildUtils";
import { bannerLog } from "../../utils/logs";
import { buildBinaries } from "./lib/buildBinaries";
import { tmpdir } from "os";

const REACT_IMPORTS = "import React from \"react\";\nimport ReactDOM from \"react-dom\";\n";
export interface BuildArgs extends CommonOptions {
  /** Input file pattern. */
  input?: string;
  /** Input styles pattern. */
  styles?: string;
  /** Whether to build an executable binary with Vercel's pkg library. */
  binary?: boolean;
  /** Whether to compile bundles for input files. */
  bundle?: boolean;
  /** Whether to compile standalone bundles (no chunks, no imports). */
  standalone?: boolean;
  /** Whether to compile in development mode. */
  dev?: boolean;
  /** Whether to clear the output directory before building. */
  clear?: boolean;
  /** Whether to skip building typedefs or not. */
  runtimeOnly?: boolean;
  /** Whether to only build Javascript (`true` skips CSS etc.). */
  jsOnly?: boolean;
  /** Whether to skip writing files to disk. */
  noWrite?: boolean;
  /** tsconfig to use. */
  tsconfig?: string;
  /** Completed stdin stream to build from instead of a file. */
  stdin?: string;
  /** File name to emulate while reading from stdin. */
  stdinFile?: string;
  /** Packages to mark as external (refuse to inline with `--bundle`). */
  external?: string[];
}

/**
 * Build TS to JS. This will contain incomplete specifiers like `./foo` which
 * could mean many things, all of which is handled by the loader which will
 * resolve them for us.
 */
export const build = async ({
  input = "src/**/*",
  styles = "src/components/index.css",
  target = "esnext",
  format = "esm",
  tsconfig = "tsconfig.json",
  dev = false,
  bundle = false,
  binary = false,
  standalone = false,
  clear = true,
  runtimeOnly = false,
  jsOnly = false,
  noWrite = false,
  stdin = undefined,
  stdinFile = undefined,
  external = [],
}: BuildArgs = {}) => {
  env.NODE_ENV = dev ? "development" : "production";
  const DEBUG = createDebugLogger(build);

  if (dev) {
    runtimeOnly = true;
  }

  if (standalone) {
    bundle = true;
  }

  /**
   * If `clear` is set, remove the output directory.
   */
  if (clear) {
    const outputFiles = await glob("./dist/*");
    await Promise.all(outputFiles.map((file) => unlink(file)));
  }

  const { cwd, srcDir, outDir } = getWorkingDirs();

  /**
   * Initialize build options, and inject process.env for library builds.
   */
  const pkgJsonFile = await getPackageJsonFile();
  const pkgJson = JSON.parse(pkgJsonFile);

  const commonOptions: CommonOptions = {
    treeShaking: bundle,
    target,
    minify: !dev,
    jsx: "transform",
    jsxFactory: "React.createElement",
    format,
    charset: "utf8",
    logLevel: dev ? "warning" : "error",
    define: {
      "process.env.NODE_ENV": dev ? JSON.stringify("development") : JSON.stringify("production"),
    },
  };

  const defaultExterns = ["esbuild", "*.png"];

  const plugins: Plugin[] = [];
  if (!standalone) {
    plugins.push(relativeExternsPlugin);
  }

  if (format === "cjs") {
    plugins.push(removeEsmShim);
  }

  let banner: BuildOptions["banner"] | undefined;
  if (bundle) {
    switch (format) {
      case "esm":
        banner = { "js": ESM_REQUIRE_SHIM };
        break;
    }
  }

  /**
   * Copy the target tsconfig to temp, then override `jsx` and `jsxFactory`.
   */
  DEBUG.log("Copying tsconfig to tmpdir() in order to override JSX settings.");
  const { config } = getTsconfig(tsconfig) ?? {};
  const { compilerOptions } = config ?? {};
  const tsconfigWithOverrides = {
    ...config,
    compilerOptions: {
      ...compilerOptions,
      jsx: "react",
      jsxFactory: "React.createElement"
    }
  };

  const tempCopy = resolve(tmpdir(), `tsconfig.${Date.now()}.json`);
  await writeFile(tempCopy, JSON.stringify(tsconfigWithOverrides, null, 2));
  DEBUG.log("tsconfig copied.");

  const buildOptions: BuildOptions = {
    ...commonOptions,
    tsconfig: tempCopy,
    bundle,
    splitting: !standalone && !stdin && format === "esm" && bundle,
    absWorkingDir: cwd,
    outbase: "src",
    outdir: "dist",
    assetNames: "[name].js",
    format,
    target: "esnext",
    platform: pkgJson?.platform ?? "node",
    write: !noWrite,
    external: !bundle ? undefined : [...defaultExterns, ...external],
    banner,
    plugins,
  };

  DEBUG.log("Build options", buildOptions);

  let stdinSource = "";
  if (stdin) {
    DEBUG.log("Building file from stdin", { stdin, stdinFile, noWrite });

    if (!stdinFile) {
      log(chalk.red("ERROR: --stdin-file must be specified to emulate a file location when using stdin."));
      process.exit(1);
    }

    if (typeof stdin === "string" && stdin.length) {
      stdinSource = stdin;
    } else {
      stdinSource = await readStdin();
    }

    const transformOptions: TransformOptions = {
      ...commonOptions,
      sourcefile: stdinFile,
      loader: "tsx",
      banner: undefined,
      footer: undefined,
    };

    if (noWrite) {
      const build = await transform(stdinSource, transformOptions);
      return build.code;
    } else {
      const stdinBuildConfig = overwriteEntryPoint(stdinSource, stdinFile, "tsx");
      await showProgress(
        async () => await esbuild({
          ...buildOptions,
          ...stdinBuildConfig,
        }),
        {
          start: "Building stdin to dist/.",
          success: "Built stdin to dist/.",
          error: "Error building stdin to dist/.",
        }
      );

      log(chalk.grey("Use --no-write to print to stdout instead."));
      return;
    }
  }

  DEBUG.log("Building", { files: input, dev, runtimeOnly });
  bannerLog(`${chalk.bold("TS Module")} [${env.NODE_ENV}]`);

  /**
   * All files for the build. Ignore .d.ts files.
   */
  const allFiles =
    glob
      .sync(input, { cwd })
      .filter((file) => extname(file) !== ".d.ts")
      .map((file) => resolvePath(file));

  if (isAbsolute(input)) {
    /**
     * fast-glob won't pick up absolute filepaths on Windows. Windows sucks.
     */
    if (!allFiles.length) {
      allFiles.push(input);
    }

    const outfile =
      input
        .replace(srcDir, outDir)
        .replace(isTs, ".js")
        .replace(isTsxOrJsx, ".js");

    DEBUG.log("Cleaning emitted file:", { outfile });
    await rm(outfile, { force: true });
  } else {
    DEBUG.log("Cleaning old output:", { outDir });
    await rm(outDir, { force: true, recursive: true });
  }

  /**
   * TSX/JSX files to compile.
   */
  const tsxJsxInput =
    allFiles
      .filter((file) => isTsxOrJsx.test(file));

  DEBUG.log("Compiling TSX files:", { tsxJsxInput });
  const compilableTsxFiles = tsxJsxInput.filter((file) => !file.endsWith(".d.ts"));

  await showProgress(
    async () => await Promise.all(
      compilableTsxFiles.map(
        async (tsxFile) => {
          /**
          * Prepend the necessary createElement import to the TSX source.
          */
          const tsxFileContents = await readFile(tsxFile, "utf-8");
          const runtimeCode = REACT_IMPORTS + tsxFileContents;

          const tsxConfig = overwriteEntryPoint(runtimeCode, tsxFile, "tsx");
          await esbuild({
            ...buildOptions,
            ...tsxConfig,
          });
        }
      )
    ),
    {
      start: "Compiling TSX files.",
      success: "Compiled TSX files.",
      error: "Failed to compile TSX files.",
    }
  );

  /**
   * Compile TS files.
   */
  const tsJsInput =
    allFiles
      .filter((file) => isTs.test(file))
      .filter((file) => !isTsxOrJsx.test(file));

  DEBUG.log("Compiling TS files:", { tsJsInput });
  await showProgress(
    async () => await esbuild({
      ...buildOptions,
      entryPoints: tsJsInput.filter((file) => !file.endsWith(".d.ts")),
    }),
    {
      start: "Compiling TS/JS files.",
      success: "Compiled TS/JS files.",
      error: "Failed to compile TS/JS files.",
    },
  );

  /**
   * Delete temp tsconfig.
   */
  await rm(tempCopy);
  DEBUG.log("Deleted tsconfig copy in tmpdir().");

  /**
   * Non JS/TS files.
   */
  const nonTsJsInput = allFiles.filter((file) => !isJsOrTs.test(file));

  await showProgress(
    async () => {
      for (const file of nonTsJsInput) {
        const emittedFile = getEmittedFile(file);
        DEBUG.log("Copying non-source file:", { file, emittedFile });

        await mkdir(dirname(emittedFile), { recursive: true });
        await copyFile(file, emittedFile, constants.COPYFILE_FICLONE);
      }
    },
    {
      start: "Copying non-source files to dist/.",
      success: "Copied non-source files to dist/.",
      error: "Failed to copy non-source files to dist/.",
    },
  );

  /**
   * Rewrite import specifiers in emitted output.
   */
  if (!process.env.NO_REWRITES) {
    const emittedJs =
      input
        .replace(srcDir, outDir)
        .replace(/^(\.\/)?src\//, "dist/")
        .replace(isTs, ".js")
        .replace(isTsxOrJsx, ".js");

    DEBUG.log("Normalizing import specifiers in emitted JS.", { emittedJs });

    await showProgress(
      async () => await normalizeImportSpecifiers(
        emittedJs.endsWith(".js") ? emittedJs : `${emittedJs}.js`
      ),
      {
        start: "Normalizing import specifiers.",
        success: "Normalized import specifiers.",
        error: "Failed to normalize import specifiers.",
      }
    );
  }

  /**
   * Ensure that the dist/ package.json has { type: module }.
   *
   * @see https://github.com/vercel/next.js/pull/33637
   * @see https://github.com/timneutkens/next.js/blob/99dceb60faae6b00faed75db795ef24107934227/packages/next/build/index.ts#L537-L540
   */
  const rewrotePkgJson = await forceModuleTypeInDist(format);
  if (rewrotePkgJson) {
    ora({
      text: "Forced \"type\" package.json field in dist.",
      indent: 2,
    }).succeed();
  }

  if (runtimeOnly) {
    return;
  }

  /**
   * Build project styles.
   */
  if (!jsOnly) {
    if (existsSync(resolve(styles))) {
      DEBUG.log("Building styles for production.");
      const { style: bundleOutput = "./dist/bundle.css" } = pkgJson;

      /**
       * Build style bundle.
       */
      DEBUG.log("Building style bundle.", { bundleInput: styles, bundleOutput, dev });
      await showProgress(
        async () => await buildCssEntryPoint(
          styles,
          bundleOutput,
          dev,
          // noStandardStyles
        ),
        {
          start: "Bundling styles with Tailwind.",
          success: "Bundled styles with Tailwind.",
          error: "Failed to bundle styles.",
        },
      );

      /**
     * If using -b bundle mode, bundle copied styles in-place.
     */
      if (bundle) {
        DEBUG.log("Bundling all styles.");
        const cssFiles = glob.sync("dist/**/*.css");

        await showProgress(
          async () => await Promise.all(
            cssFiles.map(
              async (file) => await buildCssEntryPoint(
                file,
                file,
                dev,
                // noStandardStyles,
              )
            )
          ),
          {
            start: "Bundling emitted styles",
            success: `Bundled all styles to ${chalk.bold(bundleOutput)}.`,
            error: "Failed to bundle styles.",
          },
        );
      }
    } else {
      log();
      log(chalk.grey("Bundle styles not found for this project."));
      log("Checked: " + chalk.bold(styles));
    }

    /**
     * If `--binary` is passed, build binaries.
     */
    if (binary) {
      bannerLog("Building binary executables.");
      log("IMPORTANT: Top-level await is not supported yet.", ["bold", "yellow"]);
      log("Your program cannot be built to a binary if it contains TLA. Wrap with an async iife for now.");
      log("See: https://github.com/vercel/pkg/issues/1291");

      await buildBinaries();
    }
  }

  bannerLog("Running post-build setup.");

  await showProgress(
    async () => await emitTsDeclarations(),
    {
      start: "Generating type declarations.",
      success: `Generated declarations for ${allFiles.length} files.`,
      error: "Failed to generate type declarations.",
    },
  );

  log();
  log("Build complete.", ["green"]);
};

export const buildCommand = async (input?: string, options?: BuildArgs) => {
  return await build({
    input,
    ...options,
  });
};