const API = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";

const schema = {
  type: "OBJECT",
  properties: {
    date: { type: "STRING", description: "UTC date, YYYY-MM-DD" },
    time: { type: "STRING", description: "UTC time, HH:MM (24h)" },
    message: { type: "STRING", description: "What to be reminded of" },
  },
  required: ["date", "time", "message"],
};

const pad = (n) => String(n).padStart(2, "0");

// Wall-clock "YYYY-MM-DD HH:MM" for a given instant at a fixed UTC offset (seconds).
const localStamp = (now, offsetSec) => {
  const d = new Date(now.getTime() + offsetSec * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

const offsetLabel = (offsetSec) => {
  const sign = offsetSec < 0 ? "-" : "+";
  const abs = Math.abs(offsetSec);
  return `UTC${sign}${pad(Math.floor(abs / 3600))}:${pad(Math.floor((abs % 3600) / 60))}`;
};

const systemPrompt = (now, tz, offsetSec) =>
  [
    "You turn a reminder request into JSON with the fields date, time and message.",
    `The user's timezone is ${tz} (${offsetLabel(offsetSec)}).`,
    `Current time: ${localStamp(now, offsetSec)} user-local, ${localStamp(now, 0)} UTC.`,
    "Resolve relative and local times (\"in 15 days\", \"tomorrow at 5pm\") against the current time.",
    "Times the user states are in their local timezone. Convert them to UTC: date is YYYY-MM-DD and time is HH:MM (24h), both UTC, and the date must be the UTC date after conversion.",
    "If no time of day is given for a date, use 09:00 user-local, converted to UTC.",
    "message is the user's wording verbatim, minus only the scheduling words (e.g. \"remind me in 15 days to check on the dog\" -> \"check on the dog\"). Do not paraphrase.",
    "Copy Slack tokens in angle brackets exactly as written, brackets included: mentions like <@U123ABC>, <#C123ABC|general> or <!subteam^S123ABC>, and links like <https://example.slack.com/archives/C123/p456>. Never turn them into names or plain text.",
  ].join("\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// Gemini sheds load with 503s in spikes; retry a few times with backoff.
async function fetchWithRetry(url, init, attempts = 4) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, init);
    if (res.ok || !RETRYABLE.has(res.status) || i >= attempts) return res;
    await sleep(500 * 2 ** (i - 1));
  }
}

export async function parseTime(text, { tz, tzOffset }) {
  const res = await fetchWithRetry(`${API}/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt(new Date(), tz, tzOffset) }] },
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0, thinkingConfig: { thinkingLevel: "medium" } },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API returned ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const body = await res.json();
  const raw = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!raw) throw new Error("Gemini returned no content");

  const out = JSON.parse(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date) || !/^\d{2}:\d{2}$/.test(out.time) || !out.message) {
    throw new Error(`Gemini returned malformed fields: ${raw.slice(0, 200)}`);
  }
  return { date: out.date, time: out.time, message: out.message };
}
