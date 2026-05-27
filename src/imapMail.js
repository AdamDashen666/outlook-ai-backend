import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const IMAP_PREVIEW_BYTES = Number(process.env.IMAP_PREVIEW_BYTES || 12000);
const BODY_PREVIEW_CHARS = Number(process.env.BODY_PREVIEW_CHARS || 1500);

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function positiveInt(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
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

function firstEnvelopeAddress(addresses) {
  const value = Array.isArray(addresses) ? addresses[0] : null;
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

function toDate(value, fallback = new Date()) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const parsed = value ? new Date(value) : fallback;
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function sourceToString(source) {
  if (!source) return "";
  if (Buffer.isBuffer(source)) return source.toString("utf8");
  return String(source);
}

async function parsePreview(source) {
  const raw = sourceToString(source);
  if (!raw) return { text: "", original: extractForwardedMeta("") };

  try {
    const parsed = await simpleParser(Buffer.from(raw));
    const text = (parsed.text || htmlToText(parsed.html || "") || raw)
      .replace(/\s+/g, " ")
      .trim();

    return {
      text,
      original: extractForwardedMeta(text),
      parsedFrom: firstAddress(parsed.from),
      parsedSubject: cleanSubject(parsed.subject || "")
    };
  } catch {
    const text = htmlToText(raw).replace(/\s+/g, " ").trim();
    return {
      text,
      original: extractForwardedMeta(text),
      parsedFrom: { name: "未知发件人", address: "" },
      parsedSubject: ""
    };
  }
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

async function fetchUnseenCandidatesFromMailbox(client, mailbox, sourceFolder, options = {}) {
  const { cutoffDate = null, candidateLimit = 31 } = options;
  const lock = await client.getMailboxLock(mailbox);

  try {
    const searchQuery = { seen: false };
    if (cutoffDate) searchQuery.since = cutoffDate;

    const uids = await client.search(searchQuery, { uid: true });
    if (!uids.length) return { candidates: [], hasMore: false };

    const recentUids = [...uids]
      .sort((a, b) => Number(b) - Number(a))
      .slice(0, candidateLimit);

    const candidates = [];
    for await (const item of client.fetch(recentUids, {
      uid: true,
      envelope: true,
      internalDate: true,
      flags: true,
      size: true
    }, { uid: true })) {
      const receivedDate = toDate(item.envelope?.date || item.internalDate);
      if (cutoffDate && receivedDate.getTime() < cutoffDate.getTime()) continue;

      const from = firstEnvelopeAddress(item.envelope?.from);
      candidates.push({
        id: `imap_${mailbox}_${item.uid}`,
        uid: item.uid,
        mailbox,
        sourceFolder,
        subject: cleanSubject(item.envelope?.subject || ""),
        from: {
          emailAddress: {
            name: from.name,
            address: from.address
          }
        },
        receivedDateTime: receivedDate.toISOString(),
        bodyPreview: "",
        originalForwarded: false,
        originalHeaders: {
          from: null,
          subject: "",
          date: "",
          to: ""
        }
      });
    }

    return {
      candidates,
      hasMore: uids.length > recentUids.length
    };
  } finally {
    lock.release();
  }
}

async function attachPreviews(client, messages) {
  const byMailbox = new Map();
  for (const message of messages) {
    if (!byMailbox.has(message.mailbox)) byMailbox.set(message.mailbox, []);
    byMailbox.get(message.mailbox).push(message);
  }

  for (const [mailbox, mailboxMessages] of byMailbox.entries()) {
    const lock = await client.getMailboxLock(mailbox);

    try {
      const uidSet = new Set(mailboxMessages.map(message => Number(message.uid)));
      const messageByUid = new Map(mailboxMessages.map(message => [Number(message.uid), message]));

      for await (const item of client.fetch([...uidSet], {
        uid: true,
        source: {
          start: 0,
          maxLength: IMAP_PREVIEW_BYTES
        }
      }, { uid: true })) {
        const target = messageByUid.get(Number(item.uid));
        if (!target) continue;

        const preview = await parsePreview(item.source);
        const original = preview.original || {};
        const originalFrom = original.from;
        const fallbackFrom = preview.parsedFrom || target.from.emailAddress;

        target.bodyPreview = (preview.text || "").slice(0, BODY_PREVIEW_CHARS);
        target.originalForwarded = Boolean(original.from || original.subject);
        target.originalHeaders = {
          from: original.from || null,
          subject: original.subject || "",
          date: original.date || "",
          to: original.to || ""
        };

        if (original.subject || preview.parsedSubject) {
          target.subject = cleanSubject(original.subject || preview.parsedSubject || target.subject);
        }

        if (originalFrom || fallbackFrom) {
          target.from = {
            emailAddress: {
              name: originalFrom?.name || fallbackFrom?.name || target.from.emailAddress.name,
              address: originalFrom?.address || fallbackFrom?.address || target.from.emailAddress.address
            }
          };
        }
      }
    } finally {
      lock.release();
    }
  }

  return messages;
}

export async function getUnreadImapMessagesForSummary(options = {}) {
  if (!isImapConfigured()) return { messages: [], hasMore: false };

  const mode = options.mode === "test" ? "test" : "scheduled";
  const limit = mode === "test"
    ? positiveInt(options.limit, 3, 5)
    : positiveInt(options.maxMessages, 30, 100);
  const windowHours = mode === "scheduled"
    ? positiveInt(options.windowHours, 24, 24 * 60)
    : null;
  const cutoffDate = windowHours ? new Date(Date.now() - windowHours * 60 * 60 * 1000) : null;
  const candidateLimit = limit + 1;

  const client = createClient();
  const info = getImapAccountInfo();
  await client.connect();

  try {
    const allCandidates = [];
    let hasMore = false;

    const inboxResult = await fetchUnseenCandidatesFromMailbox(client, info.inboxMailbox, "inbox", {
      cutoffDate,
      candidateLimit
    });
    allCandidates.push(...inboxResult.candidates);
    hasMore = hasMore || inboxResult.hasMore;

    if (info.junkMailbox) {
      try {
        const junkResult = await fetchUnseenCandidatesFromMailbox(client, info.junkMailbox, "junkemail", {
          cutoffDate,
          candidateLimit
        });
        allCandidates.push(...junkResult.candidates);
        hasMore = hasMore || junkResult.hasMore;
      } catch (err) {
        console.warn(`Unable to scan junk mailbox ${info.junkMailbox}:`, err.message);
      }
    }

    allCandidates.sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
    if (allCandidates.length > limit) hasMore = true;

    const selected = allCandidates.slice(0, limit);
    await attachPreviews(client, selected);

    return {
      messages: selected,
      hasMore
    };
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function getUnreadImapMessages(options = {}) {
  const { messages } = await getUnreadImapMessagesForSummary({
    mode: "scheduled",
    windowHours: options.windowHours || 24,
    maxMessages: options.maxMessages || 30
  });
  return messages;
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
