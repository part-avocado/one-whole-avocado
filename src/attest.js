import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const FILE = process.env.ATTESTATIONS_FILE ?? "data/attestations.json";

// SELF is replaced by a mention of the person signing.
const SELF = "\u0000SELF\u0000";
const STATEMENT =
  `I, ${SELF}, being of sound mind and acting of my own free will, do hereby attest and affirm that I applied for admission to this channel voluntarily and without coercion. ` +
  `I acknowledge that I may receive information pertaining to @partavocado, ` +
  `and I covenant and agree that I shall not disclose, distribute, or otherwise disseminate any aforementioned information absent express prior permission to do so. ` +
  `I further acknowledge that any breach of the foregoing will result in removal from this channel.`;

// pending: userId -> { reason, approverChannel, approverTs, dmChannel, dmTs, approvedAt }: approved, not yet signed.
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

// Forgives whitespace, smart quotes and a missing final period; everything else must match exactly.
const normalize = (s) =>
  s
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");

// Returns null if the attestation matches, otherwise an error message for the modal.
// `partavocadoId` is the user ID that an autocompleted @partavocado mention resolves to.
export const checkAttestation = (richText, signerId, partavocadoId) => {
  let foreign = false;
  const typed = flatten(richText, (id) => {
    if (id === signerId) return SELF;
    if (id === partavocadoId) return "@partavocado";
    foreign = true;
    return "@someone";
  });
  if (foreign) return "The only person you can mention in place of yourself is you.";

  const got = normalize(typed);
  const want = normalize(STATEMENT);
  if (got === want) return null;

  if (!got.includes(SELF)) {
    return "Mention yourself where it says @you: type @ and pick your own name from the list.";
  }
  let i = 0;
  while (i < got.length && got[i] === want[i]) i++;
  const start = want.lastIndexOf(" ", Math.max(0, i - 1)) + 1;
  const expected = want.slice(start, start + 40).replace(SELF, "@you");
  return i >= want.length
    ? "There's extra text at the end. Remove everything after the final sentence."
    : `That doesn't match, starting at: "${expected}…"`;
};
