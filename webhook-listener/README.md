# Shopify Orders Updated Webhook Listener

Standalone Node.js + Express listener that receives `orders/updated` webhooks, validates Shopify HMAC signatures, stores only the latest two payloads per order in memory, and renders a diff dashboard.

## Features

- `POST /webhook/orders-updated`
  - Validates `X-Shopify-Hmac-Sha256` with `SHOPIFY_WEBHOOK_SECRET`
  - Rejects invalid signatures with `401`
  - Stores only the latest 2 payloads per order (`previous` + `current`) in memory
  - Computes diffs on tracked fields only
  - Appends to a global circular diff log (max 200 entries)
  - Responds `200` on valid webhook handling
- `GET /`
  - Plain HTML dashboard
  - Auto-refreshes every 10 seconds
  - Shows newest diff entries first
  - Expand row to view full key/value diff table (`previous -> new`)
  - Shows `Ghost update — no visible changes` when nothing changed

## 1. Run locally

From the repo root:

```bash
npm install
cp webhook-listener/.env.example webhook-listener/.env
# set SHOPIFY_WEBHOOK_SECRET in webhook-listener/.env
PORT=3000 SHOPIFY_WEBHOOK_SECRET=your_secret node webhook-listener/app.js
# if needed in restricted environments:
HOST=127.0.0.1 PORT=3000 SHOPIFY_WEBHOOK_SECRET=your_secret node webhook-listener/app.js
# optional debug mode to diff full payload:
DEBUG_FULL_DIFF=true HOST=127.0.0.1 PORT=3000 SHOPIFY_WEBHOOK_SECRET=your_secret node webhook-listener/app.js
```

Open dashboard at: `http://localhost:3000/`

## 2. Install as systemd service

1. Copy files to server (example path):

```bash
sudo mkdir -p /opt/webhook-listener
sudo cp webhook-listener/app.js /opt/webhook-listener/app.js
sudo cp webhook-listener/.env.example /opt/webhook-listener/.env
# edit /opt/webhook-listener/.env and set real secret
```

2. Install unit file:

```bash
sudo cp webhook-listener/deploy/webhook-listener.service /etc/systemd/system/webhook-listener.service
sudo systemctl daemon-reload
sudo systemctl enable webhook-listener
sudo systemctl start webhook-listener
sudo systemctl status webhook-listener
```

3. View logs:

```bash
sudo journalctl -u webhook-listener -f
```

Note: default unit uses `/opt/webhook-listener` and user `www-data`. Adjust if needed.

## 3. Configure nginx + certbot (HTTPS)

1. Install nginx and certbot:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

2. Install nginx site config:

```bash
sudo cp webhook-listener/deploy/nginx-webhook-listener.conf /etc/nginx/sites-available/webhook-listener.conf
sudo ln -s /etc/nginx/sites-available/webhook-listener.conf /etc/nginx/sites-enabled/webhook-listener.conf
sudo nginx -t
sudo systemctl reload nginx
```

3. Issue certificate for `webhooks.motoscoot.net`:

```bash
sudo certbot --nginx -d webhooks.motoscoot.net
```

4. Verify auto-renew:

```bash
sudo certbot renew --dry-run
```

Certbot updates nginx to serve HTTPS with Let's Encrypt certificates.

## 4. Deploy on Render (quickest public URL)

This folder is Render-ready with:

- `webhook-listener/package.json`
- `webhook-listener/render.yaml`

Steps:

1. Push this repository to GitHub (private is fine).
2. In Render, click **New +** -> **Blueprint**.
3. Select your repository.
4. Render will detect `render.yaml` and create the web service.
5. In Render dashboard, set secret env var:
   - `SHOPIFY_WEBHOOK_SECRET=...` (same secret configured in Shopify webhook)
6. Deploy.

After deploy:

- Public app URL: `https://<your-service>.onrender.com`
- Webhook endpoint to use in Shopify:
  - `https://<your-service>.onrender.com/webhook/orders-updated`
- Dashboard:
  - `https://<your-service>.onrender.com/`

## Optional Docker

An optional Dockerfile is included at `webhook-listener/Dockerfile`.

Build and run:

```bash
docker build -f webhook-listener/Dockerfile -t webhook-listener .
docker run --rm -p 3000:3000 --env HOST=0.0.0.0 --env PORT=3000 --env SHOPIFY_WEBHOOK_SECRET=your_secret webhook-listener
```

## Tracked diff fields

- `tags`
- `financial_status`
- `fulfillment_status`
- `updated_at`
- `cancel_reason`
- `cancelled_at`
- `note`
- `fulfillments[].status`
- `fulfillments[].tracking_number`
- `fulfillments[].tracking_url`
- `fulfillments[].updated_at`
- `shipping_address` (full object)
- `line_items`
- `shipping_lines`
- `discount_codes`
- `transactions`
- `refunds`
- `customer`

## Important behavior

- Storage is strictly in memory only (no database, no file writes).
- The app keeps only the last two payloads per order.
- The global diff log is capped at 200 entries.
- Set `DEBUG_FULL_DIFF=true` to include full payload-level differences for deep troubleshooting.
