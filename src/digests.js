import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const FILE = process.env.DIGESTS_FILE ?? "data/digests.json";

// "<source channel>:<source thread_ts>:<first|full>" -> { dest, rootTs, forwarded: [source ts] }
// Plain and full digests of the same thread are tracked separately, so each keeps its own
// destination thread.
let digests = {};
try {
  digests = JSON.parse(readFileSync(FILE, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") console.error(`could not load ${FILE}:`, err);
}

const save = () => {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(digests));
  renameSync(`${FILE}.tmp`, FILE);
};

const key = (channel, threadTs, full) => `${channel}:${threadTs}:${full ? "full" : "first"}`;

export const getDigest = (channel, threadTs, full) => digests[key(channel, threadTs, full)];

export function recordForwarded(channel, threadTs, full, dest, rootTs, sourceTs) {
  const k = key(channel, threadTs, full);
  digests[k] ??= { dest, rootTs, forwarded: [] };
  if (!digests[k].forwarded.includes(sourceTs)) digests[k].forwarded.push(sourceTs);
  save();
}

export function forgetDigest(channel, threadTs, full) {
  delete digests[key(channel, threadTs, full)];
  save();
}
