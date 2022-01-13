#!/usr/bin/env tsm

import { build, postBuild } from "./commands/build";
import { Command } from "commander";
import { execute } from "./commands/execute";

if (process.argv.length >= 2) {
  const program = new Command();

  program
    .command("build")
    .option("-d, --dev", "Build development version (default: production)")
    .description("Builds TS in src/ to output in dist/.")
    .action(async ({ dev }) => await build(!dev));

  program 
    .command("postBuild")
    .description("Optimizes the built files.")
    .action(async () => await postBuild());

  program
    .command("execute <file>", { isDefault: true })
    .description("Run the given TS program, analogous to `node <file>`.")
    .action(execute);
  // .action(async () => {
  //   // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  //   //@ts-ignore Need to force the dist runtime.
  //   await import("../dist/runtime/bin.js");
  // });

  program
    .command("version")
    .description("Print the current version.")
    .action(() => {
      if (typeof PACKAGE_JSON === "undefined") {
        console.log("Cannot read version in development mode.");
      } else {
        console.log(`v${PACKAGE_JSON.version}`);
      }
    });

  program.parse(process.argv);
}