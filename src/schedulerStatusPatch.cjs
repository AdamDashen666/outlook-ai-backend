const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const dataDir = path.resolve("data");
const dataFile = path.join(dataDir, "store.json");
const SYNC_RETENTION_DAYS = Number(process.env.SUMMARY_SYNC_RETENTION_DAYS || 7);

function defaultStore() {
  return {
    devices: {},
    users: {},
    authStates: {},
    summaries: {},
    summarizedMessages: {},
    deletedMessages: {},
    summarySyncQueue: {}
  };
}

function loadStore() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, JSON.stringify(defaultStore(), null, 2));

  try {
    return {
      ...defaultStore(),
      ...JSON.parse(fs.readFileSync(dataFile, "utf8"))
    };
  } catch {
    return defaultStore();
  }
}

function saveStore(store) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(store, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function makeSyncId() {
  return `summary_sync_${crypto.randomBytes(12).toString("hex")}`;
}

function retentionMs(days = SYNC_RETENTION_DAYS) {
  return Number(days || 7) * 24 * 60 * 60 * 1000;
}

function cutoffMs(days = SYNC_RETENTION_DAYS) {
  return Date.now() - retentionMs(days);
}

function getTimestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function cleanupSyncQueue(store) {
  store.summarySyncQueue = store.summarySyncQueue || {};
  const cutoff = cutoffMs(SYNC_RETENTION_DAYS);

  for (const [id, record] of Object.entries(store.summarySyncQueue)) {
    const createdAt = getTimestamp(record.createdAt);
    const syncedAt = getTimestamp(record.syncedAt);

    // Unsynced records are temporary and retained for up to 7 days.
    if (!record.synced && createdAt < cutoff) {
      delete store.summarySyncQueue[id];
      continue;
    }

    // Synced records are kept briefly for recovery, then removed after 7 days.
    if (record.synced && (syncedAt || createdAt) < cutoff) {
      delete store.summarySyncQueue[id];
    }
  }
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sanitizeSummaryRecord(record) {
  return {
    id: String(record.id || makeSyncId()),
    createdAt: String(record.createdAt || nowIso()),
    mode: record.mode === "scheduled" ? "scheduled" : "test",
    startTime: String(record.startTime || ""),
    endTime: String(record.endTime || ""),
    processed: toNumber(record.processed, 0),
    importantCount: toNumber(record.importantCount, 0),
    spamCount: toNumber(record.spamCount, 0),
    summary: String(record.summary || ""),
    structured: record.structured && typeof record.structured === "object" ? record.structured : null,
    synced: Boolean(record.synced),
    syncedAt: record.syncedAt || null
  };
}

function publicSummaryRecord(record, { includeSyncState = true } = {}) {
  const safe = sanitizeSummaryRecord(record);
  const publicRecord = {
    id: safe.id,
    createdAt: safe.createdAt,
    mode: safe.mode,
    startTime: safe.startTime,
    endTime: safe.endTime,
    processed: safe.processed,
    importantCount: safe.importantCount,
    spamCount: safe.spamCount,
    summary: safe.summary,
    structured: safe.structured
  };

  if (includeSyncState) {
    publicRecord.synced = safe.synced;
    publicRecord.syncedAt = safe.syncedAt;
  }

  return publicRecord;
}

function saveSuccessfulSummaryPayload(payload) {
  if (!payload || payload.ok !== true || !payload.summary) return;

  const store = loadStore();
  cleanupSyncQueue(store);

  const id = makeSyncId();
  store.summarySyncQueue[id] = sanitizeSummaryRecord({
    id,
    createdAt: nowIso(),
    mode: payload.mode,
    startTime: payload.startTime,
    endTime: payload.endTime,
    processed: payload.processed,
    importantCount: payload.importantCount,
    spamCount: payload.spamCount,
    summary: payload.summary,
    structured: payload.structured,
    synced: false,
    syncedAt: null
  });

  saveStore(store);
}

function checkSyncAuth(req, res) {
  const secret = process.env.SYNC_SECRET;
  if (!secret) return true;

  const auth = req.get("authorization") || "";
  if (auth === `Bearer ${secret}`) return true;

  res.status(401).type("application/json").json({
    ok: false,
    error: "Unauthorized"
  });
  return false;
}

function listSyncSummaries({ pendingOnly = false, days = null } = {}) {
  const store = loadStore();
  cleanupSyncQueue(store);
  saveStore(store);

  const cutoff = days ? cutoffMs(days) : 0;
  return Object.values(store.summarySyncQueue || {})
    .map(sanitizeSummaryRecord)
    .filter(record => pendingOnly ? record.synced === false : true)
    .filter(record => !days || getTimestamp(record.createdAt) >= cutoff)
    .sort((a, b) => getTimestamp(b.createdAt) - getTimestamp(a.createdAt))
    .map(record => publicSummaryRecord(record, { includeSyncState: true }));
}

function markSummariesSynced(ids = []) {
  const store = loadStore();
  cleanupSyncQueue(store);
  store.summarySyncQueue = store.summarySyncQueue || {};

  let marked = 0;
  const now = nowIso();
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id || "")).filter(Boolean))];

  for (const id of uniqueIds) {
    if (!store.summarySyncQueue[id]) continue;

    if (!store.summarySyncQueue[id].synced) {
      marked += 1;
      store.summarySyncQueue[id].syncedAt = now;
    } else if (!store.summarySyncQueue[id].syncedAt) {
      store.summarySyncQueue[id].syncedAt = now;
    }

    store.summarySyncQueue[id].synced = true;
  }

  cleanupSyncQueue(store);
  saveStore(store);
  return marked;
}

if (!express.response.__summaryCloudSyncJsonPatched) {
  express.response.__summaryCloudSyncJsonPatched = true;
  const originalJson = express.response.json;

  express.response.json = function patchedJson(payload) {
    try {
      if (this.req?.method === "POST" && this.req?.path === "/summarize/run" && payload?.ok === true) {
        saveSuccessfulSummaryPayload(payload);
      }
    } catch (err) {
      console.error("Failed to save summary sync record", err);
    }

    return originalJson.call(this, payload);
  };
}

const originalListen = express.application.listen;

express.application.listen = function patchedListen(...args) {
  if (!this.__schedulerStatusEndpointAdded) {
    this.__schedulerStatusEndpointAdded = true;

    this.get("/scheduler/status", (req, res) => {
      try {
        res.type("application/json").json({
          ok: true,
          enabled: true,
          provider: process.env.MAIL_PROVIDER || "imap",
          frequency: "daily",
          message: "Scheduler status endpoint is available"
        });
      } catch (err) {
        res.status(500).type("application/json").json({
          ok: false,
          error: err?.message || "Scheduler status failed"
        });
      }
    });

    this.get("/summaries/pending", (req, res) => {
      try {
        if (!checkSyncAuth(req, res)) return;
        res.type("application/json").json({
          ok: true,
          summaries: listSyncSummaries({ pendingOnly: true })
        });
      } catch (err) {
        res.status(500).type("application/json").json({
          ok: false,
          error: err?.message || "Failed to load pending summaries"
        });
      }
    });

    this.post("/summaries/mark-synced", (req, res) => {
      try {
        if (!checkSyncAuth(req, res)) return;
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        res.type("application/json").json({
          ok: true,
          marked: markSummariesSynced(ids)
        });
      } catch (err) {
        res.status(500).type("application/json").json({
          ok: false,
          error: err?.message || "Failed to mark summaries synced"
        });
      }
    });

    this.get("/summaries/recent", (req, res) => {
      try {
        if (!checkSyncAuth(req, res)) return;
        const requestedDays = Number(req.query?.days || 7);
        const days = Number.isFinite(requestedDays) && requestedDays > 0 ? Math.min(Math.floor(requestedDays), 30) : 7;
        res.type("application/json").json({
          ok: true,
          days,
          summaries: listSyncSummaries({ pendingOnly: false, days })
        });
      } catch (err) {
        res.status(500).type("application/json").json({
          ok: false,
          error: err?.message || "Failed to load recent summaries"
        });
      }
    });
  }

  return originalListen.apply(this, args);
};
