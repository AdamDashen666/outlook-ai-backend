import fs from "node:fs";
import path from "node:path";

const dataDir = path.resolve("data");
const dataFile = path.join(dataDir, "store.json");

function defaultStore() {
  return {
    devices: {},
    users: {},
    authStates: {},
    summaries: {},
    summarizedMessages: {},
    deletedMessages: {}
  };
}

export function loadStore() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify(defaultStore(), null, 2));
  }
  try {
    return { ...defaultStore(), ...JSON.parse(fs.readFileSync(dataFile, "utf8")) };
  } catch {
    return defaultStore();
  }
}

export function saveStore(store) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(store, null, 2));
}

export function updateStore(mutator) {
  const store = loadStore();
  const result = mutator(store);
  saveStore(store);
  return result ?? store;
}

export function nowIso() {
  return new Date().toISOString();
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function isDue(user) {
  if (!user?.settings?.enabled) return false;
  const last = user.lastRunAt ? new Date(user.lastRunAt) : new Date(0);
  const now = new Date();
  const freq = user.settings.frequency || "daily";

  if (freq === "sixHours") return now - last >= 6 * 60 * 60 * 1000;
  if (freq === "monthly") {
    if (!user.lastRunAt) return true;
    return now.getUTCMonth() !== last.getUTCMonth() || now.getUTCFullYear() !== last.getUTCFullYear();
  }
  return now - last >= 24 * 60 * 60 * 1000;
}
