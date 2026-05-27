# Outlook AI Summary Backend v3 QQ IMAP

This backend supports two modes:

- `MAIL_PROVIDER=qq` or `imap`: read a QQ mailbox through IMAP. This is the recommended workaround when Outlook emails are forwarded to QQ Mail.
- `MAIL_PROVIDER=graph`: old Microsoft Graph OAuth mode.

## v3 QQ IMAP behavior

- Outlook forwards or redirects new email to QQ Mail.
- Backend connects to QQ Mail IMAP.
- Backend reads unread INBOX emails, parses original sender and subject from forwarded Outlook messages, summarizes in Chinese, and pushes to the iOS app.
- Summarized IMAP messages are marked as read to avoid repeated summaries.
- Destructive cleanup is disabled unless a trash mailbox is configured.

## Render setup for QQ Mail

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

Required environment variables:

```text
MAIL_PROVIDER=qq
IMAP_HOST=imap.qq.com
IMAP_PORT=993
IMAP_SECURE=true
IMAP_USER=your_qq_email@qq.com
IMAP_PASS=your_qq_mail_auth_code
AI_BASE_URL=https://api.openai.com/v1/chat/completions
AI_API_KEY=your_ai_key
AI_MODEL=gpt-4o-mini
DELETE_AFTER_DAYS=30
PERMANENT_DELETE_AFTER_DAYS=7
AUTO_DELETE_ENABLED=true
```

Do not hardcode mailbox codes or AI keys into the repository.

## Test IMAP

After deployment, open:

```text
https://your-render-service.onrender.com/imap/test
```

Expected successful response:

```json
{"ok":true,"account":"your_qq_email@qq.com","unseen":1}
```

## App usage

1. Put the Render backend URL in Settings.
2. Tap refresh state.
3. The device is auto-linked to the QQ IMAP account when the backend has IMAP variables configured.
4. Tap “现在总结一次”.
