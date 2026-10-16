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

const save = () => {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(reminders));
  renameSync(`${FILE}.tmp`, FILE);
};

export function addReminder(reminder) {
  reminders.push(reminder);
  save();
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
