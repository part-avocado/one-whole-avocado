export const REQUEST_CHANNEL = "C0C26M2E3FT";
export const TARGET_CHANNEL = "C0C962U4JSW";
export const APPROVER = "U0A06EPFV45";
export const PING_GROUP_ID = "S0C9DFYS90T";
export const PING_GROUP_HANDLE = "cutavocados";
export const RULES_URL = "https://hackclub.enterprise.slack.com/docs/T0266FRGM/F0C9ML51CTB";

// ---- /channelrequest ----

export const request = {
  wrongChannel: "This command can't be used here!",
  noReason: "You need a reason >:( `/channelrequest <reason>`",
  deliverFailed: (code: string) => `:pensive: Couldn't deliver your request (\`${code}\`). Please try again later.`,
  submitted: "Your request has been submitted :thumbs-up:.",

  // The approver's DM
  notification: (userId: string) => `Channel access request from <@${userId}>`,
  body: (userId: string, quotedReason: string) =>
    `:door: *Channel access request*\n` +
    `*User:* <@${userId}> (\`${userId}\`)\n` +
    `*Ping:* <@${userId}>\n` +
    `*Reason:*\n>${quotedReason}`,
  approveButton: "Approve",
  rejectButton: "Reject",
  approved: (userId: string) => `:white_check_mark: Approved!! <@${userId}> added to <#${TARGET_CHANNEL}>`,
  alreadyIn: (userId: string) => `:white_check_mark: Approved!! <@${userId}> was already in <#${TARGET_CHANNEL}>`,
  inviteFailed: (code: string) => `:warning: Invite failed (\`${code}\`). Buttons removed; retry manually.`,
  rejected: ":x: Rejected — the user was not notified.",
};

// ---- ?help / ?ping ----

export const help = [
  "*commands* (send as a message in any channel i'm in):",
  "@ `?ping` - slack api + event delivery latency",
  "@ `?info` - runtime details",
  "@ `?build` - build details",
  "@ `?time <reminder>` - timepheus v2! sets a reminder in plain english, e.g. `?time check on fd apps tomorrow at 2pm`. uses localtime",
  "@ `?time -a` - list your active reminders (with ids)",
  "@ `?time <id> delete` - cancel one of your reminders (`cancel` works too). `?time delete` alone removes your latest",
  `@ \`?digest\` - in a thread, forwards its first message to the other avocado channel as the original poster (members of both <#${REQUEST_CHANNEL}> and n-plus-one-parts-of-an-avocado only)`,
  "@ `?digest full` - same, but forwards the whole thread. digesting a thread again posts into the same copy (full only sends new messages)",
  "@ `?help` - this message",
  "",
  "*slash commands*:",
  `@ \`/channelrequest <reason>\` - request access to n-plus-one-parts-of-an-avocado (only usable in <#${REQUEST_CHANNEL}>)`,
  "",
  "*automatic*:",
  `@ leaving <#${REQUEST_CHANNEL}> removes you from n-plus-one-parts-of-an-avocado`,
  `@ joining <#${REQUEST_CHANNEL}> adds you to @${PING_GROUP_HANDLE} (there's a button to opt out)`,
  "@ joining either channel asks if you want to be announced to the channel",
].join("\n");

export const pong = (apiMs: number, eventMs: number) =>
  `:partavocado-approve: Pong! Slack API RT Delay: *${apiMs} ms* @ event delivery: *${eventMs} ms*`;

// ---- ?time ----

export const time = {
  noReminders: "you don't have any reminders set right now",
  list: (tz: string, lines: string[]) => `here's what i'm reminding you about (${tz}):\n${lines.join("\n")}\n_to cancel one, use \`?time <id> delete\`_`,
  listLine: (id: number | string, when: string, message: string) => `\`${id}\` · ${when} · ${message}`,
  deleted: (id: number | string, message: string) => `okay, i won't remind you about this anymore (\`${id}\`):\n> ${message}`,
  deletedLatest: (id: number | string, message: string) => `okay, cancelled your most recent reminder (\`${id}\`):\n> ${message}`,
  notFound: (id: number | string) => `hmm, you don't have a reminder with id \`${id}\``,
  inPast: "that time's already passed, so i can't remind you then :(",
  set: (date: string, time: string, tz: string, id: number | string, message: string) => `got it! i'll remind you on ${date} at ${time} (${tz}):\n> ${message}\n_id \`${id}\`_`,
  parseFailed: "oops, i couldn't figure out when you meant. try something like `?time tomorrow 3pm call mom`",
  fire: (userId: string, message: string) => `:alarm_clock: hey <@${userId}>, you asked me to remind you:\n> ${message}`,
};

// ---- ?digest ----

export const digest = {
  wrongChannel: "this command can't be used here",
  notThread: "run `?digest` in a thread to forward it",
  notMember: "you need to be in both channels to digest threads",
  nothing: "there's nothing in this thread to digest",
  nothingNew: "everything in this thread has already been digested",
  emptyMessage: "_(empty message)_",
  botName: "bot",
  failed: (code: string) => `:warning: digest failed (\`${code}\`)`,
  missingScope: ":warning: digest needs the `chat:write.customize` scope to post as the original author. reinstall the app to grant it",
  done: (count: number, full: boolean, dest: string, permalink: string, repeat: boolean) =>
    `:partavocado-approve: digested ${full ? `${count} message${count === 1 ? "" : "s"}` : "the first message"} to ${repeat ? "the existing thread in " : ""}<#${dest}> (<${permalink}|view>)`,
};

// ---- joining / leaving ----

export const join = {
  rulesNotice: `by joining and participating in this channel, you agree to follow the <${RULES_URL}|channel rules>!`,
  announcePrompt: "Want me to announce you to the channel?",
  announceYes: "Yes, announce me",
  announceNo: "No thanks",
  welcome: (userId: string) =>
    `ello <@${userId}>!! welcome to <@${APPROVER}>'s channel! we hope you like it here! please read the <${RULES_URL}|rules>!!`,
  announceFailed: (code: string) => `:warning: I couldn't announce you (\`${code}\`).`,
  kickFailed: (userId: string, code: string) =>
    `:warning: <@${userId}> left <#${REQUEST_CHANNEL}> but I couldn't remove them from <#${TARGET_CHANNEL}> (\`${code}\`). Please remove them manually.`,
};

// "@/handle" in the public version so the text can't ping the group.
export const pingGroup = {
  added: `you've been added to the ping group @/${PING_GROUP_HANDLE}!! you can leave at any time (but i'll be sad).`,
  addedPublic: (userId: string) =>
    `<@${userId}> you've been added to the ping group @/${PING_GROUP_HANDLE}!! you can leave at any time (but i'll be sad).`,
  leaveButton: "Leave ping group >:(",
  left: `:partavocado-approve: You've been removed from @${PING_GROUP_HANDLE}.`,
  leaveFailed: (code: string) => `:warning: Couldn't remove you from @${PING_GROUP_HANDLE} (\`${code}\`).`,
};

// ---- deploys ----

export const deployed = (version: string, message: string) => `new version deployed: ${version}\n${message}`;
