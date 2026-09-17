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

// Strip single-line and multi-line comments to avoid false positives on documentation/comments.
// Preserves string literals so URLs containing '//' (e.g. "https://...") are not truncated.
function stripComments(content) {
  return content.replace(
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)/g,
    (match, _str, comment) => {
      if (comment) {
        return match.replace(/[^\r\n]/g, " ");
      }
      return match;
    },
  );
}

export function scanFileForAntipatterns(filePath, content) {
  const findings = [];
  const lines = content.split("\n");
  const stripped = stripComments(content);
  const strippedLines = stripped.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const strippedLine = strippedLines[i];

    // Check 1: Access-Control-Allow-Credentials: true combined with wildcard or reflected origin
    if (/access-control-allow-credentials/i.test(strippedLine)) {
      if (/['"]?true['"]?/i.test(strippedLine)) {
        // Check surrounding lines (within 10 lines) for wildcard or reflected origin
        const windowStart = Math.max(0, i - 8);
        const windowEnd = Math.min(strippedLines.length, i + 9);

        let hasWildcardOrReflectedOrigin = false;
        for (const wLine of strippedLines.slice(windowStart, windowEnd)) {
          if (/access-control-allow-origin/i.test(wLine)) {
            const afterHeader = wLine.replace(
              /^.*?access-control-allow-origin['"]?\s*[,:]?\s*/i,
              "",
            );
            const trimmed = afterHeader
              .trim()
              .replace(/[,;)]*$/, "")
              .trim();
            const quotedMatch = /^(['"`])(.*)\1$/.exec(trimmed);
            if (quotedMatch) {
              // Quoted static literal — only dangerous if wildcard
              if (quotedMatch[2] === "*") {
                hasWildcardOrReflectedOrigin = true;
                break;
              }
            } else {
              // Unquoted dynamic/reflected origin expression
              if (
                /^\*|['"]\*['"]/.test(trimmed) ||
                /\breq(\.|uest\.)headers\b/i.test(trimmed) ||
                /\bheaders\[['"]origin['"]\]/i.test(trimmed) ||
                /\breq(\.|uest\.)header\(['"]origin['"]\)/i.test(trimmed) ||
                /\b(origin|clientOrigin|requestOrigin)\b/.test(trimmed)
              ) {
                hasWildcardOrReflectedOrigin = true;
                break;
              }
            }
          }
        }

        if (hasWildcardOrReflectedOrigin && !line.includes("pragma: allowlist cors-credentials")) {
          findings.push({
            file: filePath,
            line: i + 1,
            rule: "cors-misconfiguration-for-credentials",
            message:
              "Access-Control-Allow-Credentials must not be enabled when origins are reflected or wildcard (CodeQL js/cors-misconfiguration-for-credentials)",
          });
        }
      }
    }

    // Check 2: Fastify CORS with credentials: true and origin: true / origin: '*' / regex /.*/ or callback reflection
    if (/\bcredentials:\s*true\b/.test(strippedLine)) {
      // Check surrounding lines for origin: true, origin: "*", regex, or reflection callback cb(null, true)
      const windowStart = Math.max(0, i - 8);
      const windowEnd = Math.min(strippedLines.length, i + 9);
      const windowContent = strippedLines.slice(windowStart, windowEnd).join("\n");

      const hasDangerousOrigin =
        /origin:\s*(true|\*|['"]\*['"]|\/\.\*\/)/.test(windowContent) ||
        /cb\(\s*null\s*,\s*true\s*\)/.test(windowContent) ||
        /cb\(\s*undefined\s*,\s*true\s*\)/.test(windowContent) ||
        /origin:\s*\([^)]*\)\s*=>\s*true/.test(windowContent);

      if (hasDangerousOrigin && !line.includes("pragma: allowlist cors-credentials")) {
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
export function cli(args = process.argv.slice(2)) {
  const targetDir = args[0] ? path.resolve(args[0]) : path.join(root, "src");
  const findings = scanDirectory(targetDir);

  if (findings.length > 0) {
    console.error(`\nSecurity anti-pattern check failed with ${findings.length} finding(s):\n`);
    for (const f of findings) {
      const relPath = path.relative(root, f.file);
      console.error(`  ${relPath}:${f.line} [${f.rule}] ${f.message}`);
    }
    console.error("");
    return 1;
  } else {
    console.log("OK — no security anti-patterns detected in source files.");
    return 0;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  process.exit(cli());
}
