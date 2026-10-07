# OpenWA Dashboard

A small web dashboard for a self-hosted [OpenWA](https://github.com/rmyndharis/openwa) WhatsApp gateway.
It runs as one Node 22 / Express container that serves a static page and proxies API calls to OpenWA,
so the OpenWA API key never reaches the browser. Caddy in front handles HTTPS automatically.

## Features (v0.1)

- Gateway health pill in the header, polled every 5 seconds
- Sessions: create, list with colour coded status, start, scan QR (auto refresh, hides when ready)
- Send test message: pick a ready session, check a number on WhatsApp, send text, retry on 409
- Toast notifications and a clear message when the gateway is unreachable (HTTP 502)
- Inbox panel placeholder for future webhooks

## File tree

```
.
├── .env.example
├── .gitignore
├── Caddyfile
├── README.md
├── docker-compose.yml
└── dashboard/
    ├── .dockerignore
    ├── Dockerfile
    ├── package.json
    ├── server.js
    └── public/
        ├── index.html
        ├── styles.css
        └── app.js
```

## Deploy on AWS EC2 (Ubuntu 22.04 / 24.04)

1. In the EC2 security group, allow inbound TCP 80 and 443 (and 22 for SSH). Do not open 2785 or 3000.
2. Point a DNS A record (for example `wa.example.com`) at the instance's public IP. Caddy needs this to get a certificate.
3. Install Docker and the Compose plugin:

   ```bash
   sudo apt-get update
   sudo apt-get install -y ca-certificates curl git
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER
   newgrp docker
   ```

4. Clone the repo and create your env file:

   ```bash
   git clone <your-repo-url> openwa-dashboard
   cd openwa-dashboard
   cp .env.example .env
   nano .env   # set DOMAIN, DASHBOARD_USER, DASHBOARD_PASS
   ```

5. Start OpenWA first and get its API key (see the OpenWA docs for how your version issues keys):

   ```bash
   docker compose up -d openwa
   docker compose logs -f openwa
   ```

   Put the key into `OPENWA_API_KEY` in `.env`.

6. Start everything:

   ```bash
   docker compose up -d --build
   docker compose ps
   docker compose logs -f dashboard caddy
   ```

7. Open `https://<your DOMAIN>` and log in with `DASHBOARD_USER` / `DASHBOARD_PASS`.

### Useful commands

```bash
docker compose restart dashboard            # after editing .env
docker compose up -d --build dashboard      # after changing dashboard code
docker compose pull && docker compose up -d # update OpenWA and Caddy images
docker compose down                         # stop (WhatsApp session data is kept in the openwa_data volume)
```

To reach OpenWA's own port from your laptop: `ssh -L 2785:127.0.0.1:2785 ubuntu@<server>`, then open `http://localhost:2785`.

### Local test

Set `DOMAIN=localhost` in `.env`, run `docker compose up -d --build`, and open `https://localhost`
(Caddy uses a local self-signed certificate, so accept the browser warning).

## Security notes

- The OpenWA key lives only in the dashboard container's environment and is sent only to OpenWA.
- Basic auth uses timing-safe comparison. Use a long random password, since it is the only gate.
- All inputs are validated in the proxy: session name regex, UUID session ids, digits-only phone, message length.
- OpenWA is bound to 127.0.0.1 on the host, so it is not reachable from the internet.

## Next features (not built yet)

1. **Webhook receiver and inbox**: a `/webhooks/openwa` endpoint with a shared secret, storing inbound messages
   in SQLite and streaming them to the Inbox panel over Server-Sent Events.
2. **Auto-reply rules UI**: keyword or regex rules per session (with business hours and a cooldown per contact)
   evaluated by the webhook handler before anything else.
3. **AI reply handler**: route unmatched inbound messages to an LLM with a per-session system prompt,
   conversation history from the inbox store, a human handoff keyword, and rate limits.
