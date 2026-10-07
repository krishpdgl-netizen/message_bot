# WhatsApp Sales Dashboard (OpenWA)

A self-hosted dashboard for a WhatsApp number used for sales and leads. It sits on top of
[OpenWA](https://github.com/rmyndharis/openwa) and adds a live inbox, a lead pipeline,
keyword auto-replies and throttled bulk campaigns. Runs with Docker Compose behind Caddy (automatic HTTPS).

## Features

**Overview**
- Gateway health, sessions (create, start, scan QR), inbox connection status per session
- 24 hour stats: inbound messages, new leads, auto-replies, campaign sends, unread chats, open or closed
- Send a test message and check whether a number is on WhatsApp

**Inbox**
- Live conversation list (search, unread, bot paused, opted out filters) with unread counts
- Chat view with delivery and read ticks, labels for auto-replies, campaign and phone-sent messages
- Reply from the dashboard (Enter to send), saved replies with `{{name}}` and `{{first_name}}`
- Human takeover: after you reply manually, the bot stays quiet in that chat for a set time
- Pause or resume the bot per chat
- Lead panel next to the chat: name, stage, tags, notes, opt-out

**Leads (mini CRM)**
- Pipeline: New, Contacted, Qualified, Proposal, Won, Lost, with counts
- Every person who messages you becomes a lead automatically, with their WhatsApp name
- Search, filter by stage, tag or opt-out status, inline stage changes
- Add, edit, delete, CSV import (with tags and stage) and CSV export

**Auto-replies**
- Rules: contains, exact, starts with, regex or any message; comma separated keywords
- Per rule: reply text with variables, priority, cooldown per contact, business hours only or after hours only,
  session filter, add tags, set stage, and "hand off to a human" (pauses the bot for that chat)
- One click starter rules for sales: pricing, catalogue, location, ready to buy, talk to a person
- Rule tester ("which rule would answer this message right now?")
- Welcome message for brand new contacts, away message outside business hours
- STOP / START opt-out handling, max auto-replies per contact per hour (loop protection)

**Campaigns (scheduled and bulk)**
- Audience from pasted numbers, a CSV file, a tag and/or a stage; opted-out contacts are always excluded
- Personalised with `{{name}}`, `{{first_name}}`, `{{phone}}`, live preview
- Send now, schedule for later, or save as a paused draft
- One message at a time with a random pause, daily cap per number, optional business hours only
- Skips numbers that are not on WhatsApp, retries temporary failures, pause, resume, cancel, retry failed
- Live progress and a per-recipient report

**Settings**: business hours and time zone, welcome, away, opt-out keywords and replies, takeover pause,
auto-reply limit, campaign daily cap and default delays.

## How it works

```
Browser ──HTTPS──> Caddy ──> dashboard (Node 22, Express, SQLite) ──X-API-Key──> openwa
                                   ^                                              |
                                   └──── signed webhooks (message, ack, status) ──┘
```

- The browser only talks to the dashboard. The OpenWA URL and API key never leave the server.
- On start (and every 5 minutes) the dashboard registers a webhook on every OpenWA session pointing to
  `http://dashboard:3000/webhooks/openwa`, signed with `WEBHOOK_SECRET` (HMAC SHA-256, verified timing-safe).
- Caddy does not expose `/webhooks/*` to the internet; OpenWA reaches it inside the Docker network.
- Data (leads, messages, rules, campaigns, settings) is stored in SQLite on the `dashboard_data` volume.

## File tree

```
.
├── .env.example
├── .gitignore
├── .github/workflows/deploy.yml   auto deploy to EC2 on every push to main
├── Caddyfile
├── README.md
├── docker-compose.yml
└── dashboard/
    ├── Dockerfile
    ├── package.json
    ├── server.js                  entry: security headers, Basic auth, routes
    ├── src/
    │   ├── config.js              env vars
    │   ├── db.js                  SQLite schema and helpers
    │   ├── openwa.js              OpenWA API client
    │   ├── webhooks.js            signed receiver and auto registration
    │   ├── automation.js          rules, welcome, away, opt-out
    │   ├── campaigns.js           throttled campaign worker
    │   ├── messaging.js           send and record, templates
    │   ├── schedule.js            business hours
    │   ├── events.js              live updates (Server-Sent Events)
    │   ├── validate.js            input validation
    │   └── routes/                gateway, inbox, contacts, automation, campaigns, stats
    └── public/
        ├── index.html
        ├── styles.css
        └── js/                    main, core, overview, inbox, leads, rules, campaigns, settings
```

## Upgrading the server from the first version

1. Copy these files into your repo (replace the old ones) and push. If auto deploy is set up, the server updates itself.
2. On the server, add a webhook secret to `.env` once, then restart:

   ```bash
   cd ~/message_bot
   echo "WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env
   echo "TZ=Asia/Kolkata" >> .env
   docker compose up -d --build
   ```

   `openwa` restarts too, because it now gets `SSRF_ALLOWED_HOSTS=dashboard`. Your linked WhatsApp session is kept
   in its volume.
3. Open the dashboard. In Overview, each session's Inbox column should say **Connected** within a few seconds.
   Send a WhatsApp message to your number from another phone and it appears in the Inbox.

## First time deploy (fresh EC2, Ubuntu)

```bash
sudo apt-get update && sudo apt-get install -y git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # then log out and back in

git clone git@github.com:<you>/<repo>.git ~/message_bot
cd ~/message_bot
cp .env.example .env
nano .env                        # DOMAIN, DASHBOARD_USER, DASHBOARD_PASS, WEBHOOK_SECRET
docker compose up -d openwa      # get the OpenWA API key, put it in OPENWA_API_KEY
docker compose up -d --build
```

Security group: open 22, 80 and 443 only. Point your domain's A record at the instance.

## Auto deploy on push (GitHub Actions)

`.github/workflows/deploy.yml` connects to the server over SSH on every push to `main`, then runs
`git pull` and `docker compose up -d --build`.

1. On the server, create a key for GitHub:

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/gh_actions -N ""
   cat ~/.ssh/gh_actions.pub >> ~/.ssh/authorized_keys
   cat ~/.ssh/gh_actions        # copy the whole private key
   rm ~/.ssh/gh_actions
   ```

2. In GitHub: **Settings, Secrets and variables, Actions**. Add secrets `EC2_HOST` (server IP or domain),
   `EC2_USER` (`ubuntu`) and `EC2_SSH_KEY` (the private key).
3. If the repo is not cloned to `~/message_bot` on the server, add a repository **variable** `APP_DIR`
   with the folder name relative to the home directory (for example `message_bot/openwa-dashboard`).
4. Push. Watch it under the **Actions** tab.

Do not edit files on the server directly; local changes there make `git pull` fail.

## Useful commands

```bash
docker compose logs -f dashboard            # app logs (no secrets are logged)
docker compose restart dashboard            # after editing .env
docker compose pull && docker compose up -d # update OpenWA and Caddy

# Backup the dashboard database
docker compose cp dashboard:/app/data/dashboard.db ./dashboard-backup.db
```

## Using it well (sales number tips)

1. **Settings**: set business hours and time zone, check the welcome and away messages.
2. **Auto-replies**: click "Add starter sales rules", then edit the replies to include your real catalogue link,
   address and prices. Use the tester box to check what a message would trigger.
3. **Inbox**: hot leads get tagged `hot` or `needs-human`. When you reply yourself the bot steps back.
4. **Leads**: move people through the pipeline, and use tags to build campaign audiences.
5. **Campaigns**: keep pauses at 8 to 20 seconds or more, keep the daily cap low on new numbers (50 to 100) and
   increase it slowly. Only message people who opted in or already talk to you.

WhatsApp does not allow unsolicited bulk messaging. Numbers that send many unwanted messages get banned,
and this dashboard cannot prevent that. The throttling and opt-out features reduce risk; they do not remove it.

## Security

- HTTP Basic auth with timing-safe comparison and a lockout after 10 failed attempts per IP for 15 minutes.
- Strict Content Security Policy (no inline scripts or styles), no `innerHTML` anywhere in the frontend.
- All input validated on the server: UUIDs, phone digits, chat ids, lengths, regex patterns, time zones.
- Webhooks verified with HMAC SHA-256 and deduplicated by idempotency key.
- CSV export escapes formula characters so a lead's name cannot run as a spreadsheet formula.

## Next features to consider

1. **AI replies**: answer messages no rule matched with an AI model, using your product info and the chat history,
   with the same takeover and opt-out safeguards.
2. **Follow-up sequences**: automatic follow-ups when a lead goes quiet (for example day 1, day 3, day 7),
   stopped as soon as they reply.
3. **Media and team**: send images and PDFs (catalogues, invoices), plus per-agent logins with chat assignment.
