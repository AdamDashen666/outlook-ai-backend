import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function isImapConfigured() {
  return Boolean(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
}

export function getImapAccountInfo() {
  return {
    provider: process.env.MAIL_PROVIDER || "imap",
    email: process.env.IMAP_USER || "",
    host: process.env.IMAP_HOST || "",
    port: Number(process.env.IMAP_PORT || 993),
    secure: boolEnv("IMAP_SECURE", true),
    inboxMailbox: process.env.IMAP_INBOX_MAILBOX || "INBOX",
    junkMailbox: process.env.IMAP_JUNK_MAILBOX || "",
    trashMailbox: process.env.IMAP_TRASH_MAILBOX || ""
  };
}

function createClient() {
  const info = getImapAccountInfo();
  return new ImapFlow({
    host: info.host,
    port: info.port,
    secure: info.secure,
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASS
    },
    logger: false
  });
}

function htmlToText(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstAddress(addressObject) {
  const value = addressObject?.value?.[0];
  return {
    name: value?.name || value?.address || "未知发件人",
    address: value?.address || ""
  };
}

function parseAddressLine(value = "") {
  const line = String(value).trim().replace(/^"|"$/g, "");
  const angle = line.match(/^(.*?)\s*<([^>]+)>/);
  if (angle) return { name: angle[1].replace(/^"|"$/g, "").trim() || angle[2].trim(), address: angle[2].trim() };
  const email = line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email) return { name: line.replace(email[0], "").replace(/[<>]/g, "").trim() || email[0], address: email[0] };
  return { name: line || "未知发件人", address: "" };
}

function findHeader(text, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*[:：]\\s*(.+)`, "i");
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function extractForwardedMeta(text) {
  const compact = String(text || "").replace(/\r\n/g, "\n");
  const from = findHeader(compact, ["From", "发件人", "寄件者", "寄件人"]);
  const subject = findHeader(compact, ["Subject", "主题", "主旨"]);
  const date = findHeader(compact, ["Sent", "Date", "发送时间", "日期"]);
  const to = findHeader(compact, ["To", "收件人"]);
  return {
    from: from ? parseAddressLine(from) : null,
    subject,
    date,
    to
  };
}

function cleanSubject(subject = "") {
  return String(subject)
    .replace(/^(fw|fwd|转发|转寄)\s*[:：]\s*/i, "")
    .trim() || "无标题";
}

export async function testImapConnection() {
  if (!isImapConfigured()) {
    return { ok: false, error: "IMAP is not configured" };
  }

  const client = createClient();
  await client.connect();

  try {
    const info = getImapAccountInfo();

    const lock = await client.getMailboxLock(info.inboxMailbox);
    try {
      const status = await client.status(info.inboxMailbox, {
        messages: true,
        unseen: true
      });

      return {
        ok: true,
        account: info.email,
        host: info.host,
        inboxMailbox: info.inboxMailbox,
        messages: status.messages || 0,
        unseen: status.unseen || 0
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function fetchUnseenFromMailbox(client, mailbox, sourceFolder) {
  const lock = await client.getMailboxLock(mailbox);
  try {
    const uids = await client.search({ seen: false }, { uid: true });
    if (!uids.length) return [];

    const messages = [];
    for await (const item of client.fetch(uids, { uid: true, source: true, envelope: true, flags: true }, { uid: true })) {
      const parsed = await simpleParser(item.source);
      const text = (parsed.text || htmlToText(parsed.html || "")).trim();
      const original = extractForwardedMeta(text);
      const parsedFrom = firstAddress(parsed.from);
      const from = original.from || parsedFrom;
      const subject = original.subject || cleanSubject(parsed.subject || "");
      const received = parsed.date instanceof Date ? parsed.date.toISOString() : new Date().toISOString();

      messages.push({
        id: `imap_${mailbox}_${item.uid}`,
        uid: item.uid,
        mailbox,
        sourceFolder,
        subject,
        from: {
          emailAddress: {
            name: from.name || from.address || parsedFrom.name,
            address: from.address || parsedFrom.address
          }
        },
        receivedDateTime: received,
        bodyPreview: text.slice(0, 6000),
        originalForwarded: Boolean(original.from || original.subject),
        originalHeaders: {
          from: original.from,
          subject: original.subject || "",
          date: original.date || "",
          to: original.to || ""
        }
      });
    }
    return messages;
  } finally {
    lock.release();
  }
}

export async function getUnreadImapMessages() {
  if (!isImapConfigured()) return [];
  const client = createClient();
  const info = getImapAccountInfo();
  await client.connect();
  try {
    const all = [];
    all.push(...await fetchUnseenFromMailbox(client, info.inboxMailbox, "inbox"));
    if (info.junkMailbox) {
      try {
        all.push(...await fetchUnseenFromMailbox(client, info.junkMailbox, "junkemail"));
      } catch (err) {
        console.warn(`Unable to scan junk mailbox ${info.junkMailbox}:`, err.message);
      }
    }
    const map = new Map();
    for (const msg of all) map.set(msg.id, msg);
    return [...map.values()];
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function markImapMessageSummarized(message) {
  if (!isImapConfigured() || !message?.uid || !message?.mailbox) return;
  const client = createClient();
  await client.connect();
  try {
    const lock = await client.getMailboxLock(message.mailbox);
    try {
      await client.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function cleanupImapMessages(store, user, deleteAfterDays = 30) {
  if (!isImapConfigured()) return { skipped: true, reason: "IMAP not configured" };
  const info = getImapAccountInfo();
  if (!info.trashMailbox) return { skipped: true, reason: "IMAP_TRASH_MAILBOX not configured, skip destructive cleanup" };

  const cutoff = Date.now() - deleteAfterDays * 24 * 60 * 60 * 1000;
  const targets = Object.values(store.summarizedMessages || {})
    .filter(record => record.userId === user.id)
    .filter(record => record.uid && record.mailbox && !store.deletedMessages?.[record.messageId])
    .filter(record => new Date(record.summarizedAt).getTime() <= cutoff);

  const client = createClient();
  await client.connect();
  const moved = [];
  try {
    const byMailbox = new Map();
    for (const record of targets) {
      if (!byMailbox.has(record.mailbox)) byMailbox.set(record.mailbox, []);
      byMailbox.get(record.mailbox).push(record);
    }

    for (const [mailbox, records] of byMailbox.entries()) {
      const lock = await client.getMailboxLock(mailbox);
      try {
        for (const record of records) {
          try {
            await client.messageMove(record.uid, info.trashMailbox, { uid: true });
            store.deletedMessages[record.messageId] = {
              userId: user.id,
              messageId: record.messageId,
              uid: record.uid,
              mailbox: info.trashMailbox,
              deletedAt: new Date().toISOString(),
              reason: "summarized_older_than_retention_days"
            };
            moved.push(record.messageId);
          } catch (err) {
            console.warn("IMAP move summarized message failed", record.messageId, err.message);
          }
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return { moved: moved.length, permanentlyDeleted: 0 };
}
