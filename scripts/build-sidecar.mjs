#!/usr/bin/env node

/**
 * Builds the `@glassbeetle/api` self-contained sidecar binary for Tauri.
 *
 * This script:
 * 1. Identifies the target architecture triple (e.g. `aarch64-apple-darwin`).
 * 2. Ensures the NestJS API is compiled (`tsc`).
 * 3. Collects production dependencies from `node_modules` (including `better-sqlite3`
 *    and its native `.node` binding) and the host Node.js runtime executable.
 * 4. Bundles them into a compressed archive (`payload.tar.gz`).
 * 5. Compiles the Rust sidecar runner (`apps/desktop/src-tauri/src/bin/sidecar.rs`)
 *    with the embedded payload using `rustc`.
 * 6. Writes the final self-contained executable to
 *    `apps/desktop/src-tauri/binaries/glassbeetle-api-<target-triple>`.
 *
 * Usage:
 *   node scripts/build-sidecar.mjs
 *   node scripts/build-sidecar.mjs --target aarch64-apple-darwin
 */

import { execFileSync, execSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

// ── Target Resolution ────────────────────────────────────────────────────────

function resolveTargetTriple(explicitTarget) {
  if (explicitTarget) {
    return explicitTarget;
  }

  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "linux") {
    return arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : "x86_64-unknown-linux-gnu";
  }
  if (platform === "win32") {
    return "x86_64-pc-windows-msvc";
  }

  throw new Error(`Unsupported platform/architecture: ${platform}/${arch}`);
}

// Parse command line arguments
let targetTriple;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--target" && process.argv[i + 1]) {
    targetTriple = process.argv[++i];
  }
}
targetTriple = resolveTargetTriple(targetTriple);

console.log(`[build-sidecar] Target: ${targetTriple}`);

// ── 1. Ensure API is built ──────────────────────────────────────────────────

const apiDistDir = join(REPO_ROOT, "apps", "api", "dist");
if (!existsSync(join(apiDistDir, "main.js"))) {
  console.log("[build-sidecar] Building @glassbeetle/api...");
  execSync("npm run build -w @glassbeetle/api", {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
} else {
  console.log("[build-sidecar] @glassbeetle/api dist already built.");
}

// ── 2. Collect Transitive Production Dependencies ───────────────────────────

console.log("[build-sidecar] Resolving production dependencies...");

const visitedPackages = new Set();

function collectDependencies(pkgJsonPath) {
  if (!existsSync(pkgJsonPath)) return;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    const deps = Object.keys(pkg.dependencies || {});
    for (const dep of deps) {
      if (visitedPackages.has(dep)) continue;
      visitedPackages.add(dep);
      collectDependencies(join(REPO_ROOT, "node_modules", dep, "package.json"));
    }
  } catch (err) {
    console.warn(
      `[build-sidecar] Warning reading ${pkgJsonPath}:`,
      err.message,
    );
  }
}

collectDependencies(join(REPO_ROOT, "apps", "api", "package.json"));

console.log(
  `[build-sidecar] Found ${visitedPackages.size} production packages.`,
);

// ── 3. Stage Payload Directory ──────────────────────────────────────────────

const stagingDir = join(
  REPO_ROOT,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "sidecar-staging",
);
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

// Copy compiled API dist
console.log("[build-sidecar] Staging dist/ and package.json...");
cpSync(apiDistDir, join(stagingDir, "dist"), { recursive: true });
copyFileSync(
  join(REPO_ROOT, "apps", "api", "package.json"),
  join(stagingDir, "package.json"),
);

// Copy production node_modules
console.log("[build-sidecar] Staging production node_modules...");
const stagingNodeModules = join(stagingDir, "node_modules");
mkdirSync(stagingNodeModules, { recursive: true });

for (const pkgName of visitedPackages) {
  const src = join(REPO_ROOT, "node_modules", pkgName);
  const dest = join(stagingNodeModules, pkgName);
  if (!existsSync(src)) continue;
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true });
}

// Copy Node runtime executable
console.log("[build-sidecar] Staging Node.js runtime binary...");
const nodeBinStagingDir = join(stagingDir, "bin");
mkdirSync(nodeBinStagingDir, { recursive: true });

const realNodePath = realpathSync(process.execPath);
const destNodeName = process.platform === "win32" ? "node.exe" : "node";
const destNodePath = join(nodeBinStagingDir, destNodeName);

copyFileSync(realNodePath, destNodePath);
if (process.platform !== "win32") {
  chmodSync(destNodePath, 0o755);
}

// ── 4. Create Archive ───────────────────────────────────────────────────────

console.log("[build-sidecar] Packaging payload archive...");
const archivePath = join(
  REPO_ROOT,
  "apps",
  "desktop",
  "src-tauri",
  "sidecar_payload.tar.gz",
);
mkdirSync(dirname(archivePath), { recursive: true });

// Use system tar for speed and native fidelity
execFileSync("tar", ["-czf", archivePath, "-C", stagingDir, "."], {
  stdio: "inherit",
});

const archiveStat = statSync(archivePath);
console.log(
  `[build-sidecar] Archive size: ${(archiveStat.size / (1024 * 1024)).toFixed(1)} MB`,
);

// ── 5. Compile Rust Sidecar Binary ──────────────────────────────────────────

const binariesDir = join(REPO_ROOT, "apps", "desktop", "src-tauri", "binaries");
mkdirSync(binariesDir, { recursive: true });

const binaryName =
  process.platform === "win32"
    ? `glassbeetle-api-${targetTriple}.exe`
    : `glassbeetle-api-${targetTriple}`;
const outputBinaryPath = join(binariesDir, binaryName);

const sidecarSourcePath = join(
  REPO_ROOT,
  "apps",
  "desktop",
  "src-tauri",
  "src",
  "bin",
  "sidecar.rs",
);

console.log(
  `[build-sidecar] Compiling Rust sidecar runner to ${outputBinaryPath}...`,
);

const rustcCmd = process.env.RUSTC || "rustc";
const compileCommand = `"${rustcCmd}" --cfg has_payload -O "${sidecarSourcePath}" -o "${outputBinaryPath}"`;

execSync(compileCommand, {
  stdio: "inherit",
  env: {
    ...process.env,
    SIDECAR_PAYLOAD_PATH: archivePath,
  },
});

if (process.platform !== "win32") {
  chmodSync(outputBinaryPath, 0o755);
}

// Cleanup staging directory (leave archivePath so Cargo build.rs can embed it)
rmSync(stagingDir, { recursive: true, force: true });

// If target/release directory exists, also copy binary there to ensure Tauri bundle uses it
const targetReleaseDir = join(
  REPO_ROOT,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "release",
);
if (existsSync(targetReleaseDir)) {
  const releaseDest = join(
    targetReleaseDir,
    process.platform === "win32" ? "glassbeetle-api.exe" : "glassbeetle-api",
  );
  copyFileSync(outputBinaryPath, releaseDest);
}

const binStat = statSync(outputBinaryPath);
console.log(
  `[build-sidecar] Successfully built sidecar binary: ${outputBinaryPath} (${(binStat.size / (1024 * 1024)).toFixed(1)} MB)`,
);
