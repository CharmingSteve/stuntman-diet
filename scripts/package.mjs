import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist", "stuntman-diet.zip");
const staging = mkdtempSync(resolve(root, ".package-"));

try {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Build the Web Function package on Linux x64 so better-sqlite3 matches the Node.js 24 runtime");
  }
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  for (const file of ["package.json", "package-lock.json"]) {
    cpSync(resolve(root, file), resolve(staging, file));
  }
  execFileSync("npm", ["ci", "--omit=dev"], { cwd: staging, stdio: "inherit" });
  for (const directory of ["dist", "public", "docs", "seeds"]) {
    if (directory === "dist") {
      mkdirSync(resolve(staging, directory));
      const { readdirSync } = await import("node:fs");
      for (const file of readdirSync(resolve(root, directory))) {
        if (!file.endsWith(".zip")) cpSync(resolve(root, directory, file), resolve(staging, directory, file), { recursive: true });
      }
      continue;
    }
    cpSync(resolve(root, directory), resolve(staging, directory), { recursive: true });
  }
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(resolve(staging, "index.js"), 'import "./dist/server.js";\n', { mode: 0o644 })
  );
  execFileSync("zip", ["-q", "-r", output, "."], { cwd: staging, stdio: "inherit" });
  console.info(`Created ${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
