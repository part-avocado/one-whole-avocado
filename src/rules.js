import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const FILE = process.env.PENDING_RULES_FILE ?? "data/pending-rules.json";

// userId -> { joinedAt, messages }: users who joined but haven't answered the rules prompt.
let pending = {};
try {
  pending = JSON.parse(readFileSync(FILE, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") console.error(`could not load ${FILE}:`, err);
}

const save = () => {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(pending));
  renameSync(`${FILE}.tmp`, FILE);
};

export const addPending = (userId) => {
  pending[userId] = { joinedAt: Date.now(), messages: 0 };
  save();
};

export const getPending = (userId) => pending[userId];

export const countMessage = (userId) => {
  if (!pending[userId]) return 0;
  const n = ++pending[userId].messages;
  save();
  return n;
};

export const removePending = (userId) => {
  if (!pending[userId]) return;
  delete pending[userId];
  save();
};

export const allPending = () => Object.entries(pending).map(([userId, p]) => ({ userId, ...p }));
