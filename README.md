# Outlook AI Summary Backend

This backend links an Outlook account through Microsoft OAuth, periodically reads unread Inbox + Junk Email messages, summarizes them with an OpenAI-compatible API, pushes the summary to the iOS app, and cleans old mail.

## Main behavior

- Summary language: Chinese by default.
- Frequency options: daily, every 6 hours, monthly.
- Unread scope: Inbox unread + Junk Email unread.
- Cleanup policy:
  - Read messages older than 30 days are moved to Deleted Items.
  - Summarized messages older than 30 days are moved to Deleted Items.
  - Messages moved by this app are permanently deleted after 7 more days.

## Setup

1. Create a Microsoft Entra app registration.
2. Add redirect URI: `https://your-backend.example.com/auth/callback`. For iPad/iPhone testing, do not use `localhost`; deploy the backend or expose local port 3000 with ngrok/Cloudflare Tunnel and use that HTTPS URL in both Microsoft redirect URI and the App backend field.
3. Give delegated permissions:
   - `offline_access`
   - `User.Read`
   - `Mail.ReadWrite`
4. Copy `.env.example` to `.env` and fill in values.
5. Install and run:

```bash
npm install
npm start
```

## Important production notes

- Replace the JSON file store with a real encrypted database.
- Encrypt per-user AI keys if you store them server-side.
- Put the backend behind HTTPS before using it outside local testing.
- Use APNs production credentials for App Store/TestFlight builds.
- Test cleanup with a dummy mailbox before enabling it on a real mailbox.

## Why localhost does not work on iPhone/iPad

On a real iOS device, `localhost` means the device itself, not your Mac/server. Put a real HTTPS backend URL in **Settings → Backend URL**, then tap **Connect Outlook**.
