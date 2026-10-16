import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const FILE = process.env.REMINDERS_FILE ?? "data/reminders.json";
const TICK_MS = 15_000;

let reminders = [];
try {
  reminders = JSON.parse(readFileSync(FILE, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") console.error(`could not load ${FILE}:`, err);
}

// Reminders saved before ids existed get one on load.
let nextId = reminders.reduce((m, r) => Math.max(m, r.id ?? 0), 0) + 1;
for (const r of reminders) r.id ??= nextId++;

const save = () => {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(reminders));
  renameSync(`${FILE}.tmp`, FILE);
};

export function addReminder(reminder) {
  const added = { ...reminder, id: nextId++ };
  reminders.push(added);
  save();
  return added;
}

export const listReminders = (user) => reminders.filter((r) => r.user === user).sort((a, b) => a.at - b.at);

// Removes a reminder only if it belongs to `user`. Returns the removed reminder or undefined.
export function deleteReminder(id, user) {
  const r = reminders.find((r) => r.id === id && r.user === user);
  if (!r) return undefined;
  reminders = reminders.filter((x) => x !== r);
  save();
  return r;
}

// Fires due reminders via deliver(reminder). A reminder is dropped once delivered;
// on failure it stays queued and is retried on the next tick.
export function startReminders(deliver, logger) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      for (const r of reminders.filter((r) => r.at <= now)) {
        try {
          await deliver(r);
          reminders = reminders.filter((x) => x !== r);
          save();
        } catch (err) {
          logger.error(err);
        }
      }
    } finally {
      busy = false;
    }
  };
  setInterval(tick, TICK_MS).unref?.();
  tick();
}
