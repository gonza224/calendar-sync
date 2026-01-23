# Calendar Sync

A Cloudflare Worker that syncs your Outlook calendar to Google Calendar every minute using an ICS feed. I built this because I wanted my work Outlook calendar visible alongside my personal Google Calendar without manually copying events.

This could run on any serverless platform (Vercel, AWS Lambda, Deno Deploy, etc.) but I went with Cloudflare Workers.

## What it does

- Fetches your Outlook calendar via its public ICS link
- Creates/updates/deletes events in a Google Calendar to match
- Runs every minute
- Tracks synced events so it won't duplicate or lose changes

## Limitations

- One-way sync only (Outlook → Google)
- No attendee info (Outlook's ICS feed strips this for privacy)
- Events sync within a window of -30 days to +1 year

## Setup

### 1. Get your Outlook ICS URL

1. Go to Outlook → Settings → Calendar → Shared calendars
2. Under "Publish a calendar", select your calendar and publish it
3. Copy the ICS link

### 2. Set up Google Cloud

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project
3. Enable the **Google Calendar API**
4. Go to **APIs & Services → OAuth consent screen**
   - Set up as External
   - Add scope: `https://www.googleapis.com/auth/calendar`
   - Add yourself as a test user
5. Go to **APIs & Services → Credentials**
   - Create an **OAuth 2.0 Client ID** (Web application)
   - Add `http://localhost:3000/callback` as an authorized redirect URI
   - Copy the Client ID and Client Secret

### 3. Create a destination calendar in Google

1. In Google Calendar, create a new calendar (e.g., "Work")
2. Go to its settings → Integrate calendar → Copy the **Calendar ID**

### 4. Configure and deploy

```bash
# Clone and install
git clone <repo-url>
cd calendar-sync
npm install

# Add your credentials to .env
cp .env.example .env
# Edit .env with your values (ICS URL, Google Client ID, Secret, Calendar ID)

# Get your Google refresh token
npm run auth

# Add the refresh token to .env
# Generate a random token for SYNC_TOKEN (e.g., openssl rand -hex 32)

# Deploy secrets to Cloudflare
npx wrangler secret put OUTLOOK_ICS_URL
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put GOOGLE_CALENDAR_ID
npx wrangler secret put SYNC_TOKEN

# Deploy
npm run deploy
```

### 5. Test

Trigger a manual sync (token required):
```bash
curl "https://your-worker.workers.dev/sync?token=YOUR_SYNC_TOKEN"
```

## Logs

View real-time logs:
```bash
npx wrangler tail
```

## License

MIT
