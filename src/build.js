import fs from "node:fs";
import { execFileSync } from "node:child_process";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const boltPkg = JSON.parse(
  fs.readFileSync(new URL("../node_modules/@slack/bolt/package.json", import.meta.url), "utf8"),
);

const MAX_ERRORS = 5;
const startedAt = new Date();
let errorCount = 0;
const recent = [];

const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

// .git isn't shipped in the Docker image, so fall back to a build-time GIT_COMMIT.
const commit = git("rev-parse", "--short", "HEAD") ?? process.env.GIT_COMMIT?.slice(0, 7) ?? "unknown";
const dirty = git("status", "--porcelain") ? " (dirty)" : "";
const branch = git("rev-parse", "--abbrev-ref", "HEAD");

const duration = (s) => {
  s = Math.floor(s);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`, !d && !h && `${s % 60}s`].filter(Boolean).join(" ");
};

const describe = (e) => {
  const first = e instanceof Error ? e : e?.error instanceof Error ? e.error : null;
  const msg = first ? `${first.data?.error ?? first.code ?? first.name}: ${first.message}` : String(e);
  return msg.replace(/\s+/g, " ").slice(0, 160);
};

export const recordError = (err) => {
  errorCount++;
  recent.push({ at: new Date(), msg: describe(err) });
  if (recent.length > MAX_ERRORS) recent.shift();
};

// Count everything that goes through app.logger.error (including Bolt's own), plus crashes.
export const trackErrors = (logger) => {
  const original = logger.error.bind(logger);
  logger.error = (...args) => {
    recordError(args.find((a) => a instanceof Error) ?? args.join(" "));
    original(...args);
  };
  process.on("unhandledRejection", (reason) => {
    recordError(reason);
    logger.error("unhandledRejection", reason);
  });
  process.on("uncaughtException", (err) => {
    recordError(err);
    logger.error("uncaughtException", err);
    process.exit(1);
  });
};

export function gatherBuild() {
  const rows = [
    ["Version", `v${pkg.version}`],
    ["Commit", `${commit}${dirty}${branch && branch !== "HEAD" ? ` on ${branch}` : ""}`],
    ["Started", startedAt.toISOString()],
    ["Uptime", duration(process.uptime())],
    ["Node", process.version],
    ["Bolt", `v${boltPkg.version}`],
    ["Env", process.env.NODE_ENV ?? "development"],
    ["Errors", errorCount ? `${errorCount} since start` : "none since start"],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  const lines = rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`);
  if (recent.length) {
    lines.push("", "Recent errors:");
    for (const { at, msg } of [...recent].reverse()) lines.push(`  ${at.toISOString().slice(11, 19)}Z  ${msg}`);
  }
  return lines.join("\n");
}
