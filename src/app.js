import "dotenv/config";
import bolt from "@slack/bolt";
import { gatherInfo } from "./info.js";
import { gatherBuild, trackErrors, deployInfo } from "./build.js";
import { parseTime } from "./time.js";
import {
  addPendingAttestation,
  checkAttestation,
  describeDiffs,
  getPendingAttestation,
  recordAttestation,
  closeRequest,
  hasActiveRequest,
  openRequest,
  renderAttestation,
  statementFor,
  updatePendingAttestation,
} from "./attest.js";
import { addReminder, deleteReminder, listReminders, startReminders } from "./reminders.js";
import { REQUEST_CHANNEL, TARGET_CHANNEL, APPROVER, PING_GROUP_ID } from "./config.ts";
import * as S from "./config.ts";

const { App, LogLevel } = bolt;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

trackErrors(app.logger);

const escapeMrkdwn = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// User/channel/usergroup mentions and links (incl. message permalinks) pass through; @here/@channel/@everyone become @/here etc.
const SLACK_TOKEN = /(<(?:@[UW][A-Z0-9]+|#C[A-Z0-9]+|!subteam\^S[A-Z0-9]+|https?:\/\/[^\s<>|]+)(?:\|[^<>]*)?>)/;

// Like escapeMrkdwn, but keeps SLACK_TOKEN links clickable and doesn't re-encode entities Slack already sent.
const escapeKeepLinks = (s) =>
  s
    .split(SLACK_TOKEN)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/<!(here|channel|everyone)(?:\|[^<>]*)?>/g, "@/$1")
            .replace(/@(here|channel|everyone)\b/g, "@/$1")
            .replace(/&(?!amp;|lt;|gt;)/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;"),
    )
    .join("");

const requestBlocks = (userId, reason, footer) => [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: S.request.body(userId, escapeMrkdwn(reason).replace(/\n/g, "\n>")),
    },
  },
  footer
    ? { type: "context", elements: [{ type: "mrkdwn", text: footer }] }
    : {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "approve_request",
            text: { type: "plain_text", text: S.request.approveButton },
            style: "primary",
            value: JSON.stringify({ userId, reason }),
          },
          {
            type: "button",
            action_id: "reject_request",
            text: { type: "plain_text", text: S.request.rejectButton },
            style: "danger",
            value: JSON.stringify({ userId, reason }),
          },
        ],
      },
];

const isTargetMember = async (client, userId) => {
  let cursor;
  do {
    const res = await client.conversations.members({ channel: TARGET_CHANNEL, limit: 1000, cursor });
    if (res.members.includes(userId)) return true;
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return false;
};

app.command("/channelrequest", async ({ command, ack, client, respond }) => {
  await ack();

  if (command.channel_id !== REQUEST_CHANNEL) {
    return respond({
      response_type: "ephemeral",
      text: S.request.wrongChannel,
    });
  }

  const reason = command.text.trim().slice(0, 1000);
  if (!reason) {
    return respond({
      response_type: "ephemeral",
      text: S.request.noReason,
    });
  }

  if (hasActiveRequest(command.user_id)) {
    return respond({
      response_type: "ephemeral",
      text: "You already have a request in progress. Wait for it to be decided (or finish signing the attestation) before applying again.",
    });
  }
  // Claimed before any await so two quick requests can't both get through.
  openRequest(command.user_id);

  try {
    if (await isTargetMember(client, command.user_id)) {
      closeRequest(command.user_id);
      return respond({ response_type: "ephemeral", text: `You're already in <#${TARGET_CHANNEL}>.` });
    }
    const { channel } = await client.conversations.open({ users: APPROVER });
    await client.chat.postMessage({
      channel: channel.id,
      text: S.request.notification(command.user_id),
      blocks: requestBlocks(command.user_id, reason),
    });
  } catch (err) {
    closeRequest(command.user_id);
    app.logger.error(err);
    return respond({
      response_type: "ephemeral",
      text: S.request.deliverFailed(err.data?.error ?? err.message),
    });
  }

  return respond({
    response_type: "ephemeral",
    text: S.request.submitted,
  });
});

const attestPrompt = (userId) => {
  const text =
    `:tada: Your request to join <#${TARGET_CHANNEL}> was approved! ` +
    `Before you're added, you need to sign an attestation.`;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "attest_open",
            text: { type: "plain_text", text: "Sign attestation" },
            style: "primary",
            value: userId,
          },
        ],
      },
    ],
  };
};

const attestModal = (userId) => ({
  type: "modal",
  callback_id: "attest_submit",
  title: { type: "plain_text", text: "Attestation" },
  submit: { type: "plain_text", text: "Sign" },
  close: { type: "plain_text", text: "Cancel" },
  blocks: [
    {
      type: "section",
      text: { type: "mrkdwn", text: "Type the following *exactly*. Where it mentions you, type `@` and pick yourself from the list." },
    },
    { type: "section", text: { type: "mrkdwn", text: `>${statementFor(userId)}` } },
    {
      type: "input",
      block_id: "attest_input",
      label: { type: "plain_text", text: "Your attestation" },
      element: { type: "rich_text_input", action_id: "attest_text" },
    },
  ],
});

const decide = (approved) => async ({ ack, body, action, client }) => {
  await ack();

  if (body.user.id !== APPROVER) return;

  const { userId, reason } = JSON.parse(action.value);
  let footer;

  if (approved) {
    try {
      const { channel } = await client.conversations.open({ users: userId });
      const { ts } = await client.chat.postMessage({ channel: channel.id, ...attestPrompt(userId) });
      addPendingAttestation(userId, {
        reason,
        approverChannel: body.channel.id,
        approverTs: body.message.ts,
        dmChannel: channel.id,
        dmTs: ts,
      });
      footer = `:hourglass_flowing_sand: Approved — waiting for <@${userId}> to sign the attestation`;
    } catch (err) {
      app.logger.error(err);
      closeRequest(userId);
      footer = `:warning: Couldn't send <@${userId}> the attestation (\`${err.data?.error ?? err.message}\`). Buttons removed; follow up manually.`;
    }
  } else {
    closeRequest(userId);
    footer = S.request.rejected;
  }

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: footer,
    blocks: requestBlocks(userId, reason, footer),
  });
};

app.action("approve_request", decide(true));
app.action("reject_request", decide(false));

app.action("attest_open", async ({ ack, body, action, client, respond }) => {
  await ack();
  if (body.user.id !== action.value) return;
  const pending = getPendingAttestation(action.value);
  if (!pending) {
    return respond({ replace_original: true, text: "This approval is no longer valid. Apply again with `/channelrequest`." });
  }
  if (pending.review) return;
  await client.views.open({ trigger_id: body.trigger_id, view: attestModal(action.value) });
});

const quote = (text) => `>${text.replace(/\n/g, "\n>")}`;

const setDm = (client, pending, text, blocks) =>
  client.chat.update({
    channel: pending.dmChannel,
    ts: pending.dmTs,
    text,
    blocks: blocks ?? [{ type: "section", text: { type: "mrkdwn", text } }],
  });

// Records a signed attestation, adds the user, and tells both sides. `note` explains how it was accepted.
const finishAttestation = async (client, userId, pending, signed, note) => {
  recordAttestation(userId, signed);

  let footer;
  let dmText;
  try {
    await client.conversations.invite({ channel: TARGET_CHANNEL, users: userId });
    footer = `:white_check_mark: Attested — <@${userId}> added to <#${TARGET_CHANNEL}>`;
    dmText = `:partavocado-approve: Signed! You've been added to <#${TARGET_CHANNEL}>.`;
  } catch (err) {
    if (err.data?.error === "already_in_channel") {
      footer = `:white_check_mark: Attested — <@${userId}> was already in <#${TARGET_CHANNEL}>`;
      dmText = `:partavocado-approve: Signed! You're already in <#${TARGET_CHANNEL}>.`;
    } else {
      app.logger.error(err);
      footer = `:warning: Attested, but the invite failed (\`${err.data?.error ?? err.message}\`). Add <@${userId}> manually.`;
      dmText = `Signed! I couldn't add you automatically, so you'll be added manually soon.`;
    }
  }

  const results = await Promise.allSettled([
    client.chat.update({
      channel: pending.approverChannel,
      ts: pending.approverTs,
      text: footer,
      blocks: requestBlocks(userId, pending.reason, footer),
    }),
    client.chat.postMessage({
      channel: pending.approverChannel,
      thread_ts: pending.approverTs,
      reply_broadcast: true,
      text: `:memo: <@${userId}> signed the attestation (${note}):\n${quote(signed)}`,
    }),
    setDm(client, pending, dmText),
  ]);
  for (const r of results) if (r.status === "rejected") app.logger.error(r.reason);
};

app.view("attest_submit", async ({ ack, body, view, client }) => {
  const userId = body.user.id;
  const pending = getPendingAttestation(userId);
  if (!pending || pending.review) {
    return ack({
      response_action: "errors",
      errors: { attest_input: pending ? "Your last attempt is already under review." : "This approval is no longer valid. Apply again with /channelrequest." },
    });
  }

  const richText = view.state.values.attest_input.attest_text.rich_text_value;
  const result = checkAttestation(richText, userId, APPROVER);
  if (result.status === "fail") return ack({ response_action: "errors", errors: { attest_input: result.error } });
  await ack();

  const signed = renderAttestation(richText);
  if (result.status === "pass") {
    const note = result.typos ? `lax match: ${describeDiffs(result.diffs)}` : "exact match";
    return finishAttestation(client, userId, pending, signed, note);
  }

  // Close but not close enough: the approver decides.
  updatePendingAttestation(userId, { review: { text: signed } });
  const reviewText = `:mag: <@${userId}>'s attestation doesn't quite match. Differences: ${describeDiffs(result.diffs)}\n${quote(signed)}`;
  const results = await Promise.allSettled([
    client.chat.postMessage({
      channel: pending.approverChannel,
      thread_ts: pending.approverTs,
      reply_broadcast: true,
      text: reviewText,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: reviewText } },
        buttons(userId, { id: "attest_accept", label: "Accept" }, { id: "attest_reject", label: "Make them retry", danger: true }),
      ],
    }),
    setDm(client, pending, ":hourglass_flowing_sand: Your attestation was close but not exact, so it's been sent to partavocado for review."),
  ]);
  for (const r of results) if (r.status === "rejected") app.logger.error(r.reason);
});

const reviewAttestation = (accepted) => async ({ ack, body, action, client, respond }) => {
  await ack();
  if (body.user.id !== APPROVER) return;
  const userId = action.value;
  const pending = getPendingAttestation(userId);
  if (!pending?.review) return respond({ replace_original: true, text: "This attestation is no longer pending." });
  const { text } = pending.review;
  updatePendingAttestation(userId, { review: undefined });

  await respond({
    replace_original: true,
    text: `${accepted ? ":white_check_mark: Accepted" : ":leftwards_arrow_with_hook: Sent back"} <@${userId}>'s attestation:\n${quote(text)}`,
  });
  if (accepted) return finishAttestation(client, userId, pending, text, "accepted on review");

  const retry = attestPrompt(userId);
  retry.text = `partavocado didn't accept your attestation. Please sign it again, typing it exactly.`;
  retry.blocks[0].text.text = retry.text;
  await setDm(client, pending, retry.text, retry.blocks).catch((err) => app.logger.error(err));
};

app.action("attest_accept", reviewAttestation(true));
app.action("attest_reject", reviewAttestation(false));

app.message(/^\?(ping|info|build|help)\s*$/i, async ({ message, context, client, say }) => {
  if (message.subtype || message.bot_id) return;
  const cmd = context.matches[1].toLowerCase();
  const thread_ts = message.thread_ts ?? message.ts;

  if (cmd === "ping") {
    const received = Date.now();
    const eventLag = Math.max(0, received - Number(message.ts) * 1000);
    const t0 = performance.now();
    await client.auth.test();
    const api = Math.round(performance.now() - t0);
    return say({
      thread_ts,
      text: S.pong(api, Math.round(eventLag)),
    });
  }

  if (cmd === "help") return say({ thread_ts, text: S.help });

  if (cmd === "build") return say({ thread_ts, text: "```\n" + gatherBuild() + "\n```" });

  const info = await gatherInfo();
  return say({ thread_ts, text: "```\n" + info + "\n```" });
});

// ---- ?time <reminder> (parsed by Gemini into UTC date/time + message) ----

app.message(/^\?time\s+([\s\S]+)$/i, async ({ message, context, client, say }) => {
  if (message.subtype || message.bot_id) return;
  const thread_ts = message.thread_ts ?? message.ts;
  const text = context.matches[1].trim().slice(0, 500);

  if (/^-a$/i.test(text)) {
    const { user } = await client.users.info({ user: message.user });
    const tz = user.tz ?? "UTC";
    const fmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: tz });
    const mine = listReminders(message.user);
    if (!mine.length) return say({ thread_ts, text: S.time.noReminders });
    const lines = mine.map((r) => S.time.listLine(r.id, fmt.format(r.at), escapeKeepLinks(r.message)));
    return say({ thread_ts, text: S.time.list(tz, lines) });
  }

  const del = text.match(/^(?:(\d+)\s+(?:delete|cancel)|(?:delete|cancel)\s+(\d+))$/i);
  if (del) {
    const id = del[1] ?? del[2];
    const r = deleteReminder(Number(id), message.user);
    return say({
      thread_ts,
      text: r ? S.time.deleted(r.id, escapeKeepLinks(r.message)) : S.time.notFound(id),
    });
  }
  if (/^(?:delete|cancel)$/i.test(text)) {
    const r = deleteReminder(undefined, message.user);
    return say({
      thread_ts,
      text: r ? S.time.deletedLatest(r.id, escapeKeepLinks(r.message)) : S.time.noReminders,
    });
  }

  const reaction = { channel: message.channel, timestamp: message.ts };
  const react = (method, name) =>
    client.reactions[method]({ ...reaction, name }).catch((err) => app.logger.warn(err.data?.error ?? err.message));

  await react("add", "eyes_shaking");
  try {
    const { user } = await client.users.info({ user: message.user });
    const result = await parseTime(text, { tz: user.tz ?? "UTC", tzOffset: user.tz_offset ?? 0 });
    const at = Date.parse(`${result.date}T${result.time}:00Z`);
    if (Number.isNaN(at) || at <= Date.now()) {
      return say({ thread_ts, text: S.time.inPast });
    }
    const { id } = addReminder({ at, user: message.user, channel: message.channel, thread_ts, message: result.message });

    const tz = user.tz ?? "UTC";
    const dateStr = new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: tz }).format(at);
    const timeStr = new Intl.DateTimeFormat("en-US", { timeStyle: "short", timeZone: tz }).format(at);
    await say({
      thread_ts,
      text: S.time.set(dateStr, timeStr, tz, id, escapeKeepLinks(result.message)),
    });
    await react("remove", "eyes_shaking");
    await react("add", "oke");
  } catch (err) {
    app.logger.error(err);
    return say({ thread_ts, text: S.time.parseFailed });
  }
});

// ---- ?digest [full]: mirror a thread into the other avocado channel ----

const isMember = async (client, channel, user) => {
  for await (const page of client.paginate("conversations.members", { channel, limit: 1000 })) {
    if (page.members.includes(user)) return true;
  }
  return false;
};

// Plain-text "@here"/"@handle" don't notify when posted without link_names, so forwarded
// messages can't mass-ping the destination channel.
const defuseBroadcasts = (text) =>
  text
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|@?([^>]*))?>/g, (_, handle) => `@${handle ?? "group"}`);

app.message(/^\?digest(?:\s+(full))?\s*$/i, async ({ message, context, client, say }) => {
  if (message.subtype || message.bot_id) return;
  const thread_ts = message.thread_ts ?? message.ts;

  const dest = { [REQUEST_CHANNEL]: TARGET_CHANNEL, [TARGET_CHANNEL]: REQUEST_CHANNEL }[message.channel];
  if (!dest) return say({ thread_ts, text: S.digest.wrongChannel });
  if (!message.thread_ts) return say({ thread_ts, text: S.digest.notThread });

  const [inPublic, inPrivate] = await Promise.all([
    isMember(client, REQUEST_CHANNEL, message.user),
    isMember(client, TARGET_CHANNEL, message.user),
  ]);
  if (!inPublic || !inPrivate) {
    return say({ thread_ts, text: S.digest.notMember });
  }

  const full = Boolean(context.matches[1]);
  const replies = [];
  for await (const page of client.paginate("conversations.replies", { channel: message.channel, ts: message.thread_ts })) {
    replies.push(...page.messages);
    if (!full) break;
  }
  const toForward = (full ? replies : replies.slice(0, 1)).filter(
    (m) => !(m.user && /^\?digest(?:\s+full)?\s*$/i.test(m.text ?? "")),
  );

  if (!toForward.length) return say({ thread_ts, text: S.digest.nothing });

  const profiles = new Map();
  const authorOf = async (m) => {
    if (!m.user) return { username: m.username ?? m.bot_profile?.name ?? S.digest.botName, icon_url: m.bot_profile?.icons?.image_72 };
    if (!profiles.has(m.user)) {
      const { user } = await client.users.info({ user: m.user });
      profiles.set(m.user, {
        username: user.profile.display_name || user.real_name || user.name,
        icon_url: user.profile.image_192 ?? user.profile.image_72,
      });
    }
    return profiles.get(m.user);
  };

  let rootTs;
  try {
    for (const m of toForward) {
      const files = (m.files ?? []).map((f) => f.permalink).filter(Boolean);
      const text = [defuseBroadcasts(m.text ?? ""), ...files].filter(Boolean).join("\n") || S.digest.emptyMessage;
      const res = await client.chat.postMessage({ channel: dest, thread_ts: rootTs, text, ...(await authorOf(m)) });
      rootTs ??= res.ts;
    }
  } catch (err) {
    app.logger.error(err);
    return say({ thread_ts, text: S.digest.failed(err.data?.error ?? err.message) });
  }

  const { permalink } = await client.chat.getPermalink({ channel: dest, message_ts: rootTs });
  return say({
    thread_ts,
    text: S.digest.done(toForward.length, full, dest, permalink),
  });
});

startReminders(
  ({ channel, thread_ts, user, message }) =>
    app.client.chat.postMessage({
      channel,
      thread_ts,
      text: S.time.fire(user, escapeKeepLinks(message)),
    }),
  app.logger,
);

// Serialized so concurrent read-modify-write updates of the member list don't clobber each other.
let groupQueue = Promise.resolve();
const updateGroup = (client, userId, add) => {
  const job = groupQueue.then(async () => {
    const { users } = await client.usergroups.users.list({ usergroup: PING_GROUP_ID });
    if (users.includes(userId) === add) return;
    await client.usergroups.users.update({
      usergroup: PING_GROUP_ID,
      users: (add ? [...users, userId] : users.filter((u) => u !== userId)).join(","),
    });
  });
  groupQueue = job.catch(() => {});
  return job;
};

const buttons = (userId, yes, no) => ({
  type: "actions",
  elements: [
    {
      type: "button",
      action_id: yes.id,
      text: { type: "plain_text", text: yes.label },
      style: "primary",
      value: userId,
    },
    {
      type: "button",
      action_id: no.id,
      text: { type: "plain_text", text: no.label },
      ...(no.danger && { style: "danger" }),
      value: userId,
    },
  ],
});

const rulesNotice = () => textMessage(S.join.rulesNotice);

const announcePrompt = (userId) => {
  const text = S.join.announcePrompt;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      buttons(userId, { id: "announce_yes", label: S.join.announceYes }, { id: "announce_no", label: S.join.announceNo }),
    ],
  };
};

const textMessage = (text) => ({ text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });

// Ping group membership is opt-out: joining REQUEST_CHANNEL adds you, with a button to leave.
// The public version (mention = true) can't ping the group, and its button works for whoever clicks it.
const groupMessage = (userId, mention = false) => {
  const text = mention ? S.pingGroup.addedPublic(userId) : S.pingGroup.added;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "pinggroup_leave",
            text: { type: "plain_text", text: S.pingGroup.leaveButton },
            value: mention ? "*" : userId,
          },
        ],
      },
    ],
  };
};

let botUserId;

const AVOCADO_CHANNELS = [REQUEST_CHANNEL, TARGET_CHANNEL];

app.event("member_joined_channel", async ({ event, client }) => {
  if (!AVOCADO_CHANNELS.includes(event.channel)) return;
  botUserId ??= (await client.auth.test()).user_id;
  if (event.user === botUserId) return;

  await client.chat.postEphemeral({ channel: event.channel, user: event.user, ...rulesNotice() });
  await client.chat.postEphemeral({ channel: event.channel, user: event.user, ...announcePrompt(event.user) });

  if (event.channel === REQUEST_CHANNEL) {
    await updateGroup(client, event.user, true).catch((err) => app.logger.error(err));
  }
});

app.event("member_left_channel", async ({ event, client }) => {
  if (event.channel !== REQUEST_CHANNEL) return;
  botUserId ??= (await client.auth.test()).user_id;
  if (event.user === botUserId) return;
  closeRequest(event.user);

  try {
    await client.conversations.kick({ channel: TARGET_CHANNEL, user: event.user });
  } catch (err) {
    if (err.data?.error === "not_in_channel") return;
    app.logger.error(err);
    await client.chat
      .postMessage({
        channel: (await client.conversations.open({ users: APPROVER })).channel.id,
        text: S.join.kickFailed(event.user, err.data?.error ?? err.message),
      })
      .catch(() => {});
  }
});

const ownButton = (body, action) => body.user.id === action.value;

// Private joiners of REQUEST_CHANNEL see the ping group opt-out in place of the prompt; announced
// ones get it posted publicly instead (see announce_yes).
const announceAnswered = (channel, userId) =>
  channel === REQUEST_CHANNEL ? groupMessage(userId) : { delete_original: true };

app.action("announce_yes", async ({ ack, body, action, client, respond }) => {
  await ack();
  if (!ownButton(body, action)) return;
  const userId = action.value;
  try {
    await client.chat.postMessage({
      channel: body.channel.id,
      text: S.join.welcome(userId),
    });
    if (body.channel.id === REQUEST_CHANNEL) {
      await client.chat.postMessage({ channel: REQUEST_CHANNEL, ...groupMessage(userId, true) });
    }
  } catch (err) {
    app.logger.error(err);
    return respond({
      replace_original: true,
      ...textMessage(S.join.announceFailed(err.data?.error ?? err.message)),
    });
  }
  await respond({ delete_original: true });
});

app.action("announce_no", async ({ ack, body, action, respond }) => {
  await ack();
  if (!ownButton(body, action)) return;
  await respond({ replace_original: true, ...announceAnswered(body.channel.id, action.value) });
});

app.action("pinggroup_leave", async ({ ack, body, action, client, respond }) => {
  await ack();
  const isPublic = action.value === "*";
  if (!isPublic && !ownButton(body, action)) return;
  let text;
  try {
    await updateGroup(client, body.user.id, false);
    text = S.pingGroup.left;
  } catch (err) {
    app.logger.error(err);
    text = S.pingGroup.leaveFailed(err.data?.error ?? err.message);
  }
  // Leave the public message intact for everyone else; only the clicker sees the result.
  if (isPublic) {
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, ...textMessage(text) });
  } else {
    await respond({ replace_original: true, ...textMessage(text) });
  }
});

await app.start();
console.log("socket mode is running!");

// Announce new deploys in the private channel. The commit is stored in message metadata so
// restarts/crash loops of the same commit don't repeat the announcement.
const announceDeploy = async () => {
  const { version, commit, commitMessage, dirty } = deployInfo;
  if (process.env.NODE_ENV !== "production" || dirty) return;
  if (commit === "unknown") {
    app.logger.warn("deploy announcement skipped: commit unknown (deploy with ./deploy.sh)");
    return;
  }
  const { messages } = await app.client.conversations.history({
    token: process.env.SLACK_BOT_TOKEN,
    channel: TARGET_CHANNEL,
    limit: 50,
    include_all_metadata: true,
  });
  if (messages.some((m) => m.metadata?.event_type === "deploy" && m.metadata.event_payload?.commit === commit)) return;
  await app.client.chat.postMessage({
    token: process.env.SLACK_BOT_TOKEN,
    channel: TARGET_CHANNEL,
    text: S.deployed(version, escapeMrkdwn(commitMessage || commit)),
    metadata: { event_type: "deploy", event_payload: { commit } },
  });
};
announceDeploy().catch((err) => app.logger.error(err));
