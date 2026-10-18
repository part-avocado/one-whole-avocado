import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const FILE = process.env.ATTESTATIONS_FILE ?? "data/attestations.json";

// SELF is replaced by a mention of the person signing.
const SELF = "\u0000SELF\u0000";
const STATEMENT =
  `I, ${SELF}, being of sound mind and acting of my own free will, do hereby attest and affirm that I applied for admission to this channel voluntarily and without coercion. ` +
  `I acknowledge that I may receive information pertaining to @partavocado, ` +
  `and I covenant and agree that I shall not disclose, distribute, or otherwise disseminate any aforementioned information absent express prior permission to do so. ` +
  `I further acknowledge that any breach of the foregoing will result in removal from this channel. ` +
  `I declare under penalty of perjury that the foregoing is true and correct.`;

// pending: userId -> { reason, approverChannel, approverTs, dmChannel, dmTs, approvedAt, review? }: approved, not yet
// signed. `review` holds a near-miss attestation waiting on the approver.
// signed: userId -> [{ signedAt, text }]: every attestation a user has submitted.
let state = { pending: {}, signed: {} };
try {
  state = { ...state, ...JSON.parse(readFileSync(FILE, "utf8")) };
} catch (err) {
  if (err.code !== "ENOENT") console.error(`could not load ${FILE}:`, err);
}

const save = () => {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(state));
  renameSync(`${FILE}.tmp`, FILE);
};

export const addPendingAttestation = (userId, data) => {
  state.pending[userId] = { ...data, approvedAt: Date.now() };
  save();
};

export const getPendingAttestation = (userId) => state.pending[userId];

export const updatePendingAttestation = (userId, patch) => {
  if (!state.pending[userId]) return;
  Object.assign(state.pending[userId], patch);
  save();
};

export const removePendingAttestation = (userId) => {
  if (!state.pending[userId]) return;
  delete state.pending[userId];
  save();
};

export const recordAttestation = (userId, text) => {
  (state.signed[userId] ??= []).push({ signedAt: Date.now(), text });
  delete state.pending[userId];
  save();
};

// The statement as Slack mrkdwn, with the signer's mention filled in.
export const statementFor = (userId) => STATEMENT.replace(SELF, `<@${userId}>`);

// Flattens a rich_text_input value. `mention` decides how a user mention is rendered.
const flatten = (node, mention) => {
  if (node.type === "text") return node.text;
  if (node.type === "user") return mention(node.user_id);
  if (node.type === "link") return node.text ?? node.url;
  if (node.type === "emoji") return `:${node.name}:`;
  if (node.type === "usergroup") return `@${node.usergroup_id}`;
  if (node.type === "broadcast") return `@${node.range}`;
  if (node.type === "channel") return `#${node.channel_id}`;
  return (node.elements ?? []).map((n) => flatten(n, mention)).join(node.type === "rich_text" ? "\n" : "");
};

const escapeMrkdwn = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// What the user typed, as mrkdwn (mentions stay pingable). Used for the copy sent to the approver.
export const renderAttestation = (richText) =>
  flatten(richText, (id) => `\u0001${id}\u0001`)
    .split("\u0001")
    .map((part, i) => (i % 2 ? `<@${part}>` : escapeMrkdwn(part)))
    .join("");

// Matching is word by word, ignoring case, spacing and punctuation. A misspelled word (a small edit distance
// from the right one) is a typo; a missing, extra or different word is an error, since dropping a "not" changes
// the meaning. No errors and a few typos passes; a few errors goes to the approver; anything worse is rejected.
const MAX_TYPOS = 6;
const MAX_REVIEW_ERRORS = 10;

const tokenize = (s) =>
  s
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .split(/[^A-Za-z0-9@\u0000]+/)
    .filter(Boolean);

const editDistance = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
};

const isTypo = (got, want) => {
  if (got.includes("\u0000") || want.includes("\u0000")) return false;
  const allowed = want.length >= 8 ? 2 : want.length >= 4 ? 1 : 0;
  return editDistance(got, want) <= allowed;
};

// Aligns the typed words against the statement. Costs: exact 0, typo 1, error ERROR.
const ERROR = 1000;
const align = (got, want) => {
  const g = got.map((w) => w.toLowerCase());
  const w = want.map((x) => x.toLowerCase());
  const dp = Array.from({ length: g.length + 1 }, (_, i) => [i * ERROR]);
  for (let j = 1; j <= w.length; j++) dp[0][j] = j * ERROR;
  const sub = (i, j) => (g[i] === w[j] ? 0 : isTypo(g[i], w[j]) ? 1 : ERROR);
  for (let i = 1; i <= g.length; i++) {
    for (let j = 1; j <= w.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + ERROR, dp[i][j - 1] + ERROR, dp[i - 1][j - 1] + sub(i - 1, j - 1));
    }
  }

  // Walk back to list the differences and find the first error's position in the statement.
  const diffs = [];
  let firstError = Infinity;
  for (let i = g.length, j = w.length; i > 0 || j > 0; ) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + sub(i - 1, j - 1)) {
      const cost = sub(i - 1, j - 1);
      if (cost) diffs.push({ kind: cost === 1 ? "typo" : "changed", got: got[i - 1], want: want[j - 1] });
      if (cost === ERROR) firstError = j - 1;
      i--, j--;
    } else if (j > 0 && dp[i][j] === dp[i][j - 1] + ERROR) {
      diffs.push({ kind: "missing", want: want[j - 1] });
      firstError = j - 1;
      j--;
    } else {
      diffs.push({ kind: "extra", got: got[i - 1] });
      firstError = j;
      i--;
    }
  }
  const cost = dp[g.length][w.length];
  return { errors: Math.floor(cost / ERROR), typos: cost % ERROR, diffs: diffs.reverse(), firstError };
};

const showWord = (word) => word.replace(SELF, "@you");

// Human-readable list of differences, for the approver.
export const describeDiffs = (diffs) =>
  diffs
    .slice(0, 15)
    .map((d) =>
      d.kind === "missing"
        ? `missing "${showWord(d.want)}"`
        : d.kind === "extra"
          ? `extra "${showWord(d.got)}"`
          : `${d.kind === "typo" ? "typo" : "wrong word"} "${showWord(d.got)}" (expected "${showWord(d.want)}")`,
    )
    .join(", ") + (diffs.length > 15 ? `, and ${diffs.length - 15} more` : "");

// Returns { status: "pass" | "review" | "fail", error?, typos, diffs }. `error` is the modal message for "fail".
// `partavocadoId` is the user ID that an autocompleted @partavocado mention resolves to.
export const checkAttestation = (richText, signerId, partavocadoId) => {
  let foreign = false;
  const typed = flatten(richText, (id) => {
    if (id === signerId) return ` ${SELF} `;
    if (id === partavocadoId) return " @partavocado ";
    foreign = true;
    return " @someone ";
  });
  const fail = (error) => ({ status: "fail", error, typos: 0, diffs: [] });
  if (foreign) return fail("The only person you can mention in place of yourself is you.");
  if (!typed.includes(SELF)) {
    return fail("Mention yourself where it says @you: type @ and pick your own name from the list.");
  }

  const want = tokenize(STATEMENT);
  const { errors, typos, diffs, firstError } = align(tokenize(typed), want);
  if (errors === 0 && typos <= MAX_TYPOS) return { status: "pass", typos, diffs };
  if (errors <= MAX_REVIEW_ERRORS) return { status: "review", typos, diffs };
  return fail(
    firstError >= want.length
      ? "There's extra text at the end. Remove everything after the final sentence."
      : `That doesn't match, starting at: "${want.slice(firstError, firstError + 7).map(showWord).join(" ")}…"`,
  );
};
