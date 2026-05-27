import apn from "@parse/node-apn";

let provider = null;

function getProvider() {
  if (provider) return provider;
  if (!process.env.APNS_KEY_FILE || !process.env.APNS_TEAM_ID || !process.env.APNS_KEY_ID) return null;
  provider = new apn.Provider({
    token: {
      key: process.env.APNS_KEY_FILE,
      keyId: process.env.APNS_KEY_ID,
      teamId: process.env.APNS_TEAM_ID
    },
    production: String(process.env.APNS_PRODUCTION).toLowerCase() === "true"
  });
  return provider;
}

export async function sendSummaryPush(deviceToken, title, body, summaryId) {
  const p = getProvider();
  if (!p || !deviceToken) return { skipped: true, reason: "APNs not configured or no device token" };

  const notification = new apn.Notification();
  notification.topic = process.env.APNS_BUNDLE_ID;
  notification.alert = { title, body };
  notification.sound = "default";
  notification.badge = 1;
  notification.payload = { summaryId };

  return p.send(notification, deviceToken);
}
