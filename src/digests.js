import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const FILE = process.env.DIGESTS_FILE ?? "data/digests.json";

// "<source channel>:<source thread_ts>:<first|full>" -> { dest, rootTs, forwarded: [source ts], posted: [dest ts] }
// Entries recorded before posted was tracked have no posted list.
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

export function recordForwarded(channel, threadTs, full, dest, rootTs, sourceTs, postedTs) {
  const k = key(channel, threadTs, full);
  digests[k] ??= { dest, rootTs, forwarded: [], posted: [] };
  if (!digests[k].forwarded.includes(sourceTs)) digests[k].forwarded.push(sourceTs);
  digests[k].posted?.push(postedTs);
  save();
}

// Every digest whose source thread or destination thread is channel/threadTs.
export const findDigests = (channel, threadTs) =>
  Object.entries(digests)
    .map(([k, d]) => {
      const [source, sourceTs, mode] = k.split(":");
      return { ...d, channel: source, threadTs: sourceTs, full: mode === "full" };
    })
    .filter((d) => (d.channel === channel && d.threadTs === threadTs) || (d.dest === channel && d.rootTs === threadTs));

export function setPosted(channel, threadTs, full, posted) {
  const d = digests[key(channel, threadTs, full)];
  if (!d) return;
  d.posted = posted;
  save();
}

export function forgetDigest(channel, threadTs, full) {
  delete digests[key(channel, threadTs, full)];
  save();
}
