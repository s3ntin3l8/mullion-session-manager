#!/usr/bin/env node
// Static check for security anti-patterns that CodeQL or security scanners flag.
// Specifically targets:
// 1. Unsafe CORS credential reflection (CodeQL js/cors-misconfiguration-for-credentials):
//    - Access-Control-Allow-Credentials: true with dynamic/reflected origin or wildcard
//    - @fastify/cors configured with credentials: true and dynamic/wildcard origin
// 2. Dangerous origin reflections without validation

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function collectSourceFiles(dir, fileList = []) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== ".git") {
        collectSourceFiles(fullPath, fileList);
      }
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

// Strip single-line and multi-line comments to avoid false positives on documentation/comments
function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length))
    .replace(/\/\/.*/g, (match) => " ".repeat(match.length));
}

export function scanFileForAntipatterns(filePath, content) {
  const findings = [];
  const lines = content.split("\n");
  const stripped = stripComments(content);
  const strippedLines = stripped.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const strippedLine = strippedLines[i];

    // Check 1: Access-Control-Allow-Credentials set to true
    if (/access-control-allow-credentials/i.test(strippedLine)) {
      if (/['"]?true['"]?/i.test(strippedLine) || /true/i.test(strippedLine)) {
        // Check if allowlisted
        if (!line.includes("pragma: allowlist cors-credentials")) {
          findings.push({
            file: filePath,
            line: i + 1,
            rule: "cors-misconfiguration-for-credentials",
            message:
              "Access-Control-Allow-Credentials must not be enabled when origins are reflected or unauthenticated (CodeQL js/cors-misconfiguration-for-credentials)",
          });
        }
      }
    }

    // Check 2: Fastify CORS with credentials: true and origin: true / origin: '*' / regex /.*/
    if (/\bcredentials:\s*true\b/.test(strippedLine)) {
      // Check surrounding lines (within 10 lines) for origin: true, origin: "*", or origin reflection
      const windowStart = Math.max(0, i - 5);
      const windowEnd = Math.min(strippedLines.length, i + 6);
      const windowContent = strippedLines.slice(windowStart, windowEnd).join("\n");

      if (
        /origin:\s*(true|\*|['"]\*['"]|\/\.\*\/)/.test(windowContent) &&
        !line.includes("pragma: allowlist cors-credentials")
      ) {
        findings.push({
          file: filePath,
          line: i + 1,
          rule: "cors-misconfiguration-for-credentials",
          message: "CORS credentials enabled with wildcard or unvalidated origin reflection",
        });
      }
    }
  }

  return findings;
}

export function scanDirectory(dir) {
  const files = collectSourceFiles(dir);
  const allFindings = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const findings = scanFileForAntipatterns(file, content);
    allFindings.push(...findings);
  }
  return allFindings;
}

// Direct execution
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "src");
  const findings = scanDirectory(targetDir);

  if (findings.length > 0) {
    console.error(`\nSecurity anti-pattern check failed with ${findings.length} finding(s):\n`);
    for (const f of findings) {
      const relPath = path.relative(root, f.file);
      console.error(`  ${relPath}:${f.line} [${f.rule}] ${f.message}`);
    }
    console.error("");
    process.exit(1);
  } else {
    console.log("OK — no security anti-patterns detected in source files.");
    process.exit(0);
  }
}
