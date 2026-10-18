import "dotenv/config";
import bolt from "@slack/bolt";
import { gatherInfo } from "./info.js";
import { gatherBuild, trackErrors, deployInfo } from "./build.js";
import { parseTime } from "./time.js";
import { addPending, allPending, countMessage, removePending } from "./rules.js";
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

const { App, LogLevel } = bolt;

const REQUEST_CHANNEL = "C0C26M2E3FT"; 
const TARGET_CHANNEL = "C0C962U4JSW";
const APPROVER = "U0A06EPFV45";
const PING_GROUP_ID = "S0C9DFYS90T";
const PING_GROUP_HANDLE = "cutavocados";
const RULES_URL = "https://hackclub.enterprise.slack.com/docs/T0266FRGM/F0C9ML51CTB";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

trackErrors(app.logger);

const escapeMrkdwn = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const requestBlocks = (userId, reason, footer) => [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        `:door: *Channel access request*\n` +
        `*User:* <@${userId}> (\`${userId}\`)\n` +
        `*Ping:* <@${userId}>\n` +
        `*Reason:*\n>${escapeMrkdwn(reason).replace(/\n/g, "\n>")}`,
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
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            value: JSON.stringify({ userId, reason }),
          },
          {
            type: "button",
            action_id: "reject_request",
            text: { type: "plain_text", text: "Reject" },
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
      text: "This command can't be used here.",
    });
  }

  const reason = command.text.trim().slice(0, 1000);
  if (!reason) {
    return respond({
      response_type: "ephemeral",
      text: "Please include a reason: `/channelrequest <reason>`",
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
      text: `Channel access request from <@${command.user_id}>`,
      blocks: requestBlocks(command.user_id, reason),
    });
  } catch (err) {
    closeRequest(command.user_id);
    app.logger.error(err);
    return respond({
      response_type: "ephemeral",
      text: `:warning: Couldn't deliver your request (\`${err.data?.error ?? err.message}\`). Please try again later.`,
    });
  }

  return respond({
    response_type: "ephemeral",
    text: "Your request has been submitted.",
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
    footer = ":x: Rejected — the user was not notified.";
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

const HELP = [
  "*commands* (send as a message in any channel i'm in):",
  "@ `?ping` - slack api + event delivery latency",
  "@ `?info` - runtime details",
  "@ `?build` - build details",
  "@ `?time <reminder>` - timepheus v2! sets a reminder in plain english, e.g. `?time check on fd apps tomorrow at 2pm`. uses localtime",
  "@ `?time -a` - list your active reminders (with ids)",
  "@ `?time <id> delete` - cancel one of your reminders (`cancel` works too). `?time delete` alone removes your latest",
  "@ `?help` - this message",
  "",
  "*slash commands*:",
  `@ \`/channelrequest <reason>\` - request access to n-plus-one-parts-of-an-avocado (only usable in <#${REQUEST_CHANNEL}>)`,
  "",
  "*automatic*:",
  `@ leaving <#${REQUEST_CHANNEL}> removes you from n-plus-one-parts-of-an-avocado`,
].join("\n");

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
      text: `:partavocado-approve: Pong! Slack API RT Delay: *${api} ms* @ event delivery: *${Math.round(eventLag)} ms*`,
    });
  }

  if (cmd === "help") return say({ thread_ts, text: HELP });

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
    if (!mine.length) return say({ thread_ts, text: "you have no active reminders" });
    const lines = mine.map((r) => `\`${r.id}\` — ${fmt.format(r.at)} — ${escapeMrkdwn(r.message)}`);
    return say({ thread_ts, text: `your active reminders (${tz}):\n${lines.join("\n")}\n_cancel one with \`?time <id> delete\`_` });
  }

  const del = text.match(/^(?:(\d+)\s+(?:delete|cancel)|(?:delete|cancel)\s+(\d+))$/i);
  if (del) {
    const id = del[1] ?? del[2];
    const r = deleteReminder(Number(id), message.user);
    return say({
      thread_ts,
      text: r ? `deleted reminder \`${r.id}\`\n> ${escapeMrkdwn(r.message)}` : `i couldn't find a reminder of yours with id \`${id}\``,
    });
  }
  if (/^(?:delete|cancel)$/i.test(text)) {
    const r = deleteReminder(undefined, message.user);
    return say({
      thread_ts,
      text: r ? `deleted your latest reminder \`${r.id}\`\n> ${escapeMrkdwn(r.message)}` : "you have no active reminders",
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
      return say({ thread_ts, text: "that time is already in the past, so i can't remind you :(" });
    }
    const { id } = addReminder({ at, user: message.user, channel: message.channel, thread_ts, message: result.message });

    const tz = user.tz ?? "UTC";
    const dateStr = new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: tz }).format(at);
    const timeStr = new Intl.DateTimeFormat("en-US", { timeStyle: "short", timeZone: tz }).format(at);
    await say({
      thread_ts,
      text: `got it! i'll remind you on ${dateStr} @ ${timeStr} (${tz}) [id \`${id}\`]\n> ${escapeMrkdwn(result.message)}`,
    });
    await react("remove", "eyes_shaking");
    await react("add", "oke");
  } catch (err) {
    app.logger.error(err);
    return say({ thread_ts, text: "oopsies! i couldn't parse that" });
  }
});

startReminders(
  ({ channel, thread_ts, user, message }) =>
    app.client.chat.postMessage({
      channel,
      thread_ts,
      text: `:alarm_clock: <@${user}> reminder: ${escapeMrkdwn(message)}`,
    }),
  app.logger,
);

let groupQueue = Promise.resolve();
const addToGroup = (client, userId) => {
  const job = groupQueue.then(async () => {
    const { users } = await client.usergroups.users.list({ usergroup: PING_GROUP_ID });
    if (users.includes(userId)) return;
    await client.usergroups.users.update({
      usergroup: PING_GROUP_ID,
      users: [...users, userId].join(","),
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

const rulesMessage = (userId) => {
  const text =
    `Hiya! <@${userId}>! Before you continue, please read the <${RULES_URL}|channel rules>.\n\n` +
    `*Do you agree to follow aforementioned rules?* If you do not consent, you will be removed from this channel.`;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      buttons(userId, { id: "rules_agree", label: "I agree" }, { id: "rules_decline", label: "I do not agree", danger: true }),
    ],
  };
};

const groupMessage = (userId) => {
  const text = `Thanks! Would you like to also join the ping group @${PING_GROUP_HANDLE}? (I don't ping a lot)`;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      buttons(userId, { id: "pinggroup_yes", label: "Yes" }, { id: "pinggroup_no", label: "No" }),
    ],
  };
};

let botUserId;

// Users who joined REQUEST_CHANNEL and haven't answered the rules prompt yet. State lives in
// rules.js (persisted); the timers here are rebuilt from it on startup.
const RULES_TIMEOUT_MS = 60 * 60 * 1000;
const RULES_MAX_MESSAGES = 15;
const ruleTimers = new Map();

const clearPending = (userId) => {
  clearTimeout(ruleTimers.get(userId));
  ruleTimers.delete(userId);
  removePending(userId);
};

const scheduleKick = (client, userId, delay) => {
  clearTimeout(ruleTimers.get(userId));
  ruleTimers.set(
    userId,
    setTimeout(() => kickForRules(client, userId).catch((err) => app.logger.error(err)), Math.max(0, delay)),
  );
};

const kickForRules = async (client, userId) => {
  clearPending(userId);
  try {
    await client.conversations.kick({ channel: REQUEST_CHANNEL, user: userId });
  } catch (err) {
    if (err.data?.error === "not_in_channel") return;
    app.logger.error(err);
    await client.chat
      .postMessage({
        channel: APPROVER,
        text: `:warning: <@${userId}> didn't accept the rules in <#${REQUEST_CHANNEL}> but I couldn't remove them (\`${err.data?.error ?? err.message}\`). Please remove them manually.`,
      })
      .catch(() => {});
    return;
  }
  await client.chat
    .postMessage({
      channel: (await client.conversations.open({ users: userId })).channel.id,
      text: `You did not accept the rules >:( You can join back again <#${REQUEST_CHANNEL}>`,
    })
    .catch((err) => app.logger.error(err));
};

app.message(async ({ message, client }) => {
  if (message.channel !== REQUEST_CHANNEL || !message.user) return;
  if (countMessage(message.user) > RULES_MAX_MESSAGES) await kickForRules(client, message.user);
});

app.event("member_joined_channel", async ({ event, client }) => {
  if (event.channel !== REQUEST_CHANNEL) return;
  botUserId ??= (await client.auth.test()).user_id;
  if (event.user === botUserId) return;

  await client.chat.postEphemeral({
    channel: REQUEST_CHANNEL,
    user: event.user,
    ...rulesMessage(event.user),
  });

  addPending(event.user);
  scheduleKick(client, event.user, RULES_TIMEOUT_MS);
});

app.event("member_left_channel", async ({ event, client }) => {
  if (event.channel !== REQUEST_CHANNEL) return;
  botUserId ??= (await client.auth.test()).user_id;
  if (event.user === botUserId) return;
  clearPending(event.user);
  closeRequest(event.user);

  try {
    await client.conversations.kick({ channel: TARGET_CHANNEL, user: event.user });
  } catch (err) {
    if (err.data?.error === "not_in_channel") return;
    app.logger.error(err);
    await client.chat
      .postMessage({
        channel: (await client.conversations.open({ users: APPROVER })).channel.id,
        text: `:warning: <@${event.user}> left <#${REQUEST_CHANNEL}> but I couldn't remove them from <#${TARGET_CHANNEL}> (\`${err.data?.error ?? err.message}\`). Please remove them manually.`,
      })
      .catch(() => {});
  }
});

const ownButton = (body, action) => body.user.id === action.value;

app.action("rules_agree", async ({ ack, body, action, respond }) => {
  await ack();
  if (!ownButton(body, action)) return;
  clearPending(action.value);
  await respond({ replace_original: true, ...groupMessage(action.value) });
});

app.action("rules_decline", async ({ ack, body, action, client, respond }) => {
  await ack();
  if (!ownButton(body, action)) return;
  clearPending(action.value);
  try {
    await client.conversations.kick({ channel: REQUEST_CHANNEL, user: action.value });
    await respond({ delete_original: true });
  } catch (err) {
    app.logger.error(err);
    await respond({
      replace_original: true,
      text: `:oh: I couldn't remove you automatically (\`${err.data?.error ?? err.message}\`). You will be executed shortly.`,
    });
    await client.chat
      .postMessage({
        channel: APPROVER,
        text: `:warning: <@${action.value}> declined the rules in <#${REQUEST_CHANNEL}> but I couldn't remove them (\`${err.data?.error ?? err.message}\`). Please remove them manually.`,
      })
      .catch(() => {});
  }
});

app.action("pinggroup_yes", async ({ ack, body, action, client, respond }) => {
  await ack();
  if (!ownButton(body, action)) return;
  let text;
  try {
    await addToGroup(client, action.value);
    text = `:partavocado-approve: You've been added to @${PING_GROUP_HANDLE}.`;
  } catch (err) {
    app.logger.error(err);
    text = `:warning: Couldn't add you to @${PING_GROUP_HANDLE} (\`${err.data?.error ?? err.message}\`).`;
  }
  await respond({
    replace_original: true,
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  });
});

app.action("pinggroup_no", async ({ ack, body, action, respond }) => {
  await ack();
  if (!ownButton(body, action)) return;
  await respond({ delete_original: true });
});

await app.start();
console.log("socket mode is running!");

// Resume rules deadlines that were pending before a restart (overdue ones are kicked right away).
app.client.token ??= process.env.SLACK_BOT_TOKEN;
for (const { userId, joinedAt, messages } of allPending()) {
  if (messages > RULES_MAX_MESSAGES) await kickForRules(app.client, userId);
  else scheduleKick(app.client, userId, joinedAt + RULES_TIMEOUT_MS - Date.now());
}

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
    text: `new version deployed: ${version}\n${escapeMrkdwn(commitMessage || commit)}`,
    metadata: { event_type: "deploy", event_payload: { commit } },
  });
};
announceDeploy().catch((err) => app.logger.error(err));
