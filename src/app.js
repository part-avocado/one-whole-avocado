import "dotenv/config";
import bolt from "@slack/bolt";
import { gatherInfo } from "./info.js";
import { gatherBuild, trackErrors, deployInfo } from "./build.js";

const { App, LogLevel } = bolt;

const REQUEST_CHANNEL = "C0C26M2E3FT"; 
const TARGET_CHANNEL = "C0C962U4JSW";
const APPROVER = "U0A06EPFV45";
const PING_GROUP_ID = "S0C9DFYS90T";
const PING_GROUP_HANDLE = "cutavocados";
const NDA_API = "https://nda.hackclub.com/api/v1/nda_status";
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

const requestBlocks = (userId, reason, footer, ndaUnverified) => [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        `:door: *Channel access request*\n` +
        `*User:* <@${userId}> (\`${userId}\`)\n` +
        `*Ping:* <@${userId}>\n` +
        (ndaUnverified ? `:warning: *NDA status could not be verified* — please check manually.\n` : "") +
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
            value: JSON.stringify({ userId, reason, ndaUnverified }),
          },
          {
            type: "button",
            action_id: "reject_request",
            text: { type: "plain_text", text: "Reject" },
            style: "danger",
            value: JSON.stringify({ userId, reason, ndaUnverified }),
          },
        ],
      },
];

// Legacy signatures are valid agreements, so any "signed" status passes.
const hasSignedNda = async (slackId) => {
  const res = await fetch(`${NDA_API}/${encodeURIComponent(slackId)}`);
  if (!res.ok) throw new Error(`NDA API returned ${res.status}`);
  return (await res.json()).status === "signed";
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

  let ndaUnverified = false;
  try {
    if (!(await hasSignedNda(command.user_id))) {
      return respond({
        response_type: "ephemeral",
        text: "woah! you need an NDA to do that...",
      });
    }
  } catch (err) {
    // Fail open: the approver makes the final call, so flag it instead of blocking.
    app.logger.error(err);
    ndaUnverified = true;
  }

  try {
    const { channel } = await client.conversations.open({ users: APPROVER });
    await client.chat.postMessage({
      channel: channel.id,
      text: `Channel access request from <@${command.user_id}>`,
      blocks: requestBlocks(command.user_id, reason, undefined, ndaUnverified),
    });
  } catch (err) {
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

const decide = (approved) => async ({ ack, body, action, client }) => {
  await ack();

  if (body.user.id !== APPROVER) return;

  const { userId, reason, ndaUnverified } = JSON.parse(action.value);
  let footer;

  if (approved) {
    try {
      await client.conversations.invite({ channel: TARGET_CHANNEL, users: userId });
      footer = `:white_check_mark: Approved — <@${userId}> added to <#${TARGET_CHANNEL}>`;
    } catch (err) {
      if (err.data?.error === "already_in_channel") {
        footer = `:white_check_mark: Approved — <@${userId}> was already in <#${TARGET_CHANNEL}>`;
      } else {
        app.logger.error(err);
        footer = `:warning: Invite failed (\`${err.data?.error ?? err.message}\`). Buttons removed; retry manually.`;
      }
    }
  } else {
    footer = ":x: Rejected — the user was not notified.";
  }

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: footer,
    blocks: requestBlocks(userId, reason, footer, ndaUnverified),
  });
};

app.action("approve_request", decide(true));
app.action("reject_request", decide(false));

// ---- ?ping / ?info / ?build (any channel the bot is in) ----

app.message(/^\?(ping|info|build)\s*$/i, async ({ message, context, client, say }) => {
  if (message.subtype || message.bot_id) return;
  const cmd = context.matches[1].toLowerCase();
  const thread_ts = message.thread_ts;

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

  if (cmd === "build") return say({ thread_ts, text: "```\n" + gatherBuild() + "\n```" });

  const info = await gatherInfo();
  return say({ thread_ts, text: "```\n" + info + "\n```" });
});

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

app.event("member_joined_channel", async ({ event, client }) => {
  if (event.channel !== REQUEST_CHANNEL) return;
  botUserId ??= (await client.auth.test()).user_id;
  if (event.user === botUserId) return;

  await client.chat.postEphemeral({
    channel: REQUEST_CHANNEL,
    user: event.user,
    ...rulesMessage(event.user),
  });
});

app.event("member_left_channel", async ({ event, client }) => {
  if (event.channel !== REQUEST_CHANNEL) return;
  botUserId ??= (await client.auth.test()).user_id;
  if (event.user === botUserId) return;

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
  await respond({ replace_original: true, ...groupMessage(action.value) });
});

app.action("rules_decline", async ({ ack, body, action, client, respond }) => {
  await ack();
  if (!ownButton(body, action)) return;
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

// Announce new deploys in the private channel. The commit is stored in message metadata so
// restarts/crash loops of the same commit don't repeat the announcement.
const announceDeploy = async () => {
  const { version, commit, commitMessage, dirty } = deployInfo;
  if (process.env.NODE_ENV !== "production" || commit === "unknown" || dirty) return;
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
