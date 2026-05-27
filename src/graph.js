const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export function buildMicrosoftAuthUrl({ deviceId, state }) {
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    response_type: "code",
    redirect_uri: process.env.MS_REDIRECT_URI,
    response_mode: "query",
    scope: process.env.MS_SCOPES || "offline_access User.Read Mail.ReadWrite",
    state: `${deviceId}:${state}`,
    prompt: "select_account"
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
}

export async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    code,
    redirect_uri: process.env.MS_REDIRECT_URI,
    grant_type: "authorization_code"
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body: params });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function refreshToken(refreshTokenValue) {
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    refresh_token: refreshTokenValue,
    redirect_uri: process.env.MS_REDIRECT_URI,
    grant_type: "refresh_token"
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body: params });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function graphFetch(accessToken, path, options = {}) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: 'IdType="ImmutableId"',
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error(`Graph API failed: ${res.status} ${path} ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

export async function getMe(accessToken) {
  return graphFetch(accessToken, "/me?$select=id,displayName,userPrincipalName,mail");
}

export async function getUnreadMessages(accessToken) {
  const select = "id,subject,from,receivedDateTime,bodyPreview,webLink,isRead,categories,parentFolderId";
  const folders = ["inbox", "junkemail"];
  const all = [];

  for (const folder of folders) {
    let next = `/me/mailFolders/${folder}/messages?$top=50&$select=${select}&$filter=${encodeURIComponent("isRead eq false")}&$orderby=receivedDateTime desc`;
    while (next) {
      const data = await graphFetch(accessToken, next.startsWith("https://") ? next.replace(GRAPH_BASE, "") : next);
      all.push(...(data.value || []).map(message => ({ ...message, sourceFolder: folder })));
      next = data["@odata.nextLink"] || null;
    }
  }

  const map = new Map();
  for (const msg of all) map.set(msg.id, msg);
  return [...map.values()];
}

export async function getReadOlderThan(accessToken, days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const select = "id,subject,receivedDateTime,webLink,isRead,parentFolderId";
  const folders = ["inbox", "junkemail"];
  const all = [];

  for (const folder of folders) {
    const filter = encodeURIComponent(`isRead eq true and receivedDateTime le ${cutoff}`);
    let next = `/me/mailFolders/${folder}/messages?$top=50&$select=${select}&$filter=${filter}`;
    while (next) {
      const data = await graphFetch(accessToken, next.startsWith("https://") ? next.replace(GRAPH_BASE, "") : next);
      all.push(...(data.value || []).map(message => ({ ...message, sourceFolder: folder })));
      next = data["@odata.nextLink"] || null;
    }
  }
  return all;
}

export async function markMessageSummarized(accessToken, message) {
  const categories = Array.isArray(message.categories) ? message.categories : [];
  const nextCategories = [...new Set([...categories, "AI Summarized"])]
  return graphFetch(accessToken, `/me/messages/${message.id}`, {
    method: "PATCH",
    body: JSON.stringify({ categories: nextCategories })
  });
}

export async function moveToDeletedItems(accessToken, messageId) {
  return graphFetch(accessToken, `/me/messages/${messageId}`, { method: "DELETE" });
}

export async function permanentDelete(accessToken, messageId) {
  return graphFetch(accessToken, `/me/messages/${messageId}/permanentDelete`, { method: "POST" });
}
