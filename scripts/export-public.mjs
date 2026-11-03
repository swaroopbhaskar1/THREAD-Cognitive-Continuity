#!/usr/bin/env node
/**
 * Source-only publication. Never pushes the originating workspace's Git history.
 * --audit (default): scan candidates. --prepare: create/reconcile an isolated
 * export. --push: prepare, commit and push that export; visibility is unchanged.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "generated-artifacts/github-public");
const repo = "swaroopbhaskar1/THREAD-Cognitive-Continuity";
const flags = new Set(process.argv.slice(2));
if ([...flags].some(flag => !["--audit", "--prepare", "--push"].includes(flag))) {
  throw new Error("Use --audit, --prepare or --push. No visibility/deployment changes are supported.");
}
const git = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const roots = new Set([
  ".gitignore", ".npmrc", ".env.example", ".replit.example", "README.md", "LICENSE",
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.base.json",
]);
function allowed(path) {
  return (roots.has(path) || /^(artifacts\/(thread|api-server|mockup-sandbox)\/|lib\/|scripts\/|docs\/portfolio\/)/.test(path))
    && !/(^|\/)(node_modules|dist|\.git|\.local|\.agents|coverage|\.cache)(\/|$)/.test(path)
    && !/\.tsbuildinfo$|\.(log|dump|sqlite3?|bak|pem|key|p12|pfx|zip|tar|gz)$/.test(path)
    && (!/(^|\/)\.env(?:\.|$)/.test(path) || path === ".env.example");
}
const candidates = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  .split("\0").filter(path => path && allowed(path)))].sort();
for (const required of [...roots, "lib/db/dev-checkpoint-guard.sql", "docs/portfolio/SETUP.md", "docs/portfolio/VERIFICATION.md"]) {
  if (!candidates.includes(required)) throw new Error(`Required public source missing: ${required}`);
}
const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ["secret-api-key", /\b(?:sk_(?:live|test)_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,})\b/g],
  ["service-token", /\b(?:AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|re_[A-Za-z0-9_]{24,})\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g],
  ["database-credential-url", /postgres(?:ql)?:\/\/[^/\s"'<>]+:[^@\s"'<>]+@[^\s"'<>]+/g],
  ["deployment-database-host", /\bep-[a-z0-9-]+\.[a-z0-9.-]*neon\.tech\b/gi],
  ["non-example-email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  ["assigned-secret", /(?:api_?key|access_?token|_authToken|password|secret)\s*[:=]\s*["'][A-Za-z0-9_+/-]{24,}["']/gi],
];
const findings = [];
let totalBytes = 0;
for (const path of candidates) {
  const bytes = readFileSync(resolve(root, path));
  totalBytes += bytes.length;
  if (bytes.length > 2_000_000) throw new Error(`Oversized public candidate: ${path}`);
  if ([".jpg", ".jpeg", ".png", ".webp", ".ico"].includes(extname(path))) continue;
  if (bytes.includes(0)) throw new Error(`Unexpected binary file: ${path}`);
  const text = bytes.toString("utf8");
  const fixture = /\/tests\/|\.test\./.test(path);
  for (const [rule, pattern] of rules) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (rule === "non-example-email" && /@(?:example\.(?:com|org|net)|[^@]+\.(?:test|invalid)|resend\.dev|users\.noreply\.github\.com)$/i.test(value)) continue;
      if (fixture && rule === "deployment-database-host") continue;
      if (fixture && rule === "secret-api-key" && /fixture|dummy|fake|example|not.?real|test.?only/i.test(value)) continue;
      if (fixture && rule === "database-credential-url") {
        try {
          const url = new URL(value);
          if (["password", "pass", "secret", "test", "p", "placeholder", "dummy"].includes(url.password)
            && (url.hostname === "localhost" || url.hostname === "127.0.0.1"
              || /\.(invalid|test|example)$/.test(url.hostname))) continue;
        } catch { /* Unrecognized URL remains a finding. */ }
      }
      // Never print the matched value or full source line.
      findings.push({ path, rule, line: text.slice(0, match.index).split("\n").length });
    }
  }
}
console.log(JSON.stringify({ files: candidates.length, bytes: totalBytes, findings }, null, 2));
if (findings.length) throw new Error("Public export blocked: review reported locations without printing credentials.");
if (!flags.has("--prepare") && !flags.has("--push")) process.exit(0);

// The marker prevents deleting arbitrary files if this directory is repurposed.
if (existsSync(destination) && !existsSync(resolve(destination, ".git/thread-source-export"))) {
  throw new Error("Export directory exists without our ownership marker; refusing to modify it.");
}
mkdirSync(destination, { recursive: true });
if (!existsSync(resolve(destination, ".git"))) {
  git(["init", "--initial-branch=main"], destination);
  writeFileSync(resolve(destination, ".git/thread-source-export"), "THREAD public source only\n");
}
const publicUrl = `https://github.com/${repo}.git`;
let transport = publicUrl;
try {
  const existing = git(["remote", "get-url", "origin"]);
  const url = new URL(existing);
  if (!url.username && !url.password
    && ["github.com", "github.replit.internal"].includes(url.hostname)
    && url.pathname.replace(/\.git$/, "").toLowerCase() === `/${repo}`.toLowerCase()) transport = existing;
} catch { /* A normal clone can use GitHub's own credential helper. */ }
if (git(["remote"], destination).split("\n").includes("origin")) git(["remote", "set-url", "origin", transport], destination);
else git(["remote", "add", "origin", transport], destination);
const remoteHead = git(["ls-remote", "--heads", "origin", "main"], destination);
if (remoteHead) {
  const trustedPath = resolve(destination, ".git/thread-source-last-pushed");
  if (!existsSync(trustedPath) || readFileSync(trustedPath, "utf8").trim() !== remoteHead.split(/\s+/)[0]) {
    throw new Error("Remote main changed outside this reviewed export. Review its history first; never force-push private workspace history.");
  }
  git(["fetch", "--quiet", "origin", "main"], destination);
  // Generated export only; never resets the originating workspace.
  git(["reset", "--mixed", "FETCH_HEAD"], destination);
}
for (const entry of readdirSync(destination)) {
  if (entry !== ".git") rmSync(resolve(destination, entry), { recursive: true, force: true });
}
for (const path of candidates) {
  const target = resolve(destination, path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(root, path), target);
}
git(["add", "--all"], destination);
const staged = git(["ls-files"], destination).split("\n").filter(Boolean);
if (staged.length !== candidates.length || staged.some(path => !allowed(path))) {
  throw new Error("Export tree does not match the audited allowlist.");
}
// Preserve generated API source byte-for-byte, including its extra final newline.
git(["-c", "core.whitespace=-blank-at-eof", "diff", "--cached", "--check"], destination);
console.log(`Prepared ${staged.length} reviewed files at ${relative(root, destination)}. No workspace history copied.`);
if (flags.has("--push")) {
  const user = JSON.parse(execFileSync("gh", ["api", "user", "--jq", "{login,id}"], { encoding: "utf8" }));
  git(["config", "user.name", user.login], destination);
  git(["config", "user.email", `${user.id}+${user.login}@users.noreply.github.com`], destination);
  if (git(["diff", "--cached", "--name-only"], destination)) {
    git(["commit", "-m", remoteHead ? "Update reviewed THREAD source and portfolio docs" : "THREAD: initial reviewed public source release"], destination);
  }
  git(["push", "origin", "main"], destination);
  writeFileSync(resolve(destination, ".git/thread-source-last-pushed"), git(["rev-parse", "HEAD"], destination) + "\n");
  console.log(`Pushed reviewed source to https://github.com/${repo}; repository visibility unchanged.`);
}
