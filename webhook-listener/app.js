import crypto from 'crypto';
import express from 'express';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || '';
const DEBUG_FULL_DIFF = process.env.DEBUG_FULL_DIFF === 'true';

// orderId -> { order_name, payloads: [previous?, current] }
const orderStore = new Map();

// Circular buffer (max 200 entries)
const DIFF_LOG_MAX = 200;
const diffLog = [];
const WEBHOOK_ID_MAX = 500;
const recentWebhookIds = [];
const recentWebhookIdSet = new Set();

function safeStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeValue(value) {
  if (value === undefined) return null;
  return value;
}

function getByPath(obj, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, obj);
}

function addChange(changes, key, previous, current) {
  const prevVal = normalizeValue(previous);
  const currVal = normalizeValue(current);
  if (JSON.stringify(prevVal) !== JSON.stringify(currVal)) {
    changes.push({ key, previous: prevVal, current: currVal });
  }
}

function collectFulfillmentChanges(prevPayload, currPayload, changes) {
  const prevFulfillments = Array.isArray(prevPayload?.fulfillments)
    ? prevPayload.fulfillments
    : [];
  const currFulfillments = Array.isArray(currPayload?.fulfillments)
    ? currPayload.fulfillments
    : [];

  const maxLength = Math.max(prevFulfillments.length, currFulfillments.length);
  for (let i = 0; i < maxLength; i += 1) {
    const prevItem = prevFulfillments[i] || {};
    const currItem = currFulfillments[i] || {};
    addChange(changes, `fulfillments[${i}].status`, prevItem.status, currItem.status);
    addChange(
      changes,
      `fulfillments[${i}].tracking_number`,
      prevItem.tracking_number,
      currItem.tracking_number,
    );
    addChange(
      changes,
      `fulfillments[${i}].tracking_url`,
      prevItem.tracking_url,
      currItem.tracking_url,
    );
    addChange(
      changes,
      `fulfillments[${i}].updated_at`,
      prevItem.updated_at,
      currItem.updated_at,
    );
  }
}

function collectFullPayloadChanges(previous, current, changes, path = '') {
  const prevVal = normalizeValue(previous);
  const currVal = normalizeValue(current);

  if (JSON.stringify(prevVal) === JSON.stringify(currVal)) {
    return;
  }

  const prevIsObj = prevVal && typeof prevVal === 'object';
  const currIsObj = currVal && typeof currVal === 'object';

  if (prevIsObj && currIsObj && !Array.isArray(prevVal) && !Array.isArray(currVal)) {
    const keys = new Set([...Object.keys(prevVal), ...Object.keys(currVal)]);
    for (const key of keys) {
      const nextPath = path ? `${path}.${key}` : key;
      collectFullPayloadChanges(prevVal[key], currVal[key], changes, nextPath);
    }
    return;
  }

  if (prevIsObj && currIsObj && Array.isArray(prevVal) && Array.isArray(currVal)) {
    const maxLength = Math.max(prevVal.length, currVal.length);
    for (let i = 0; i < maxLength; i += 1) {
      const nextPath = `${path}[${i}]`;
      collectFullPayloadChanges(prevVal[i], currVal[i], changes, nextPath);
    }
    return;
  }

  changes.push({
    key: path || '(root)',
    previous: prevVal,
    current: currVal,
  });
}

function diffOrderPayloads(previous, current) {
  if (!previous || !current) {
    return {
      changed: false,
      summary: 'No previous payload to compare yet',
      changes: [],
    };
  }

  const changes = [];
  const directFields = [
    'tags',
    'financial_status',
    'fulfillment_status',
    'updated_at',
    'cancel_reason',
    'cancelled_at',
    'note',
  ];

  for (const field of directFields) {
    addChange(changes, field, getByPath(previous, field), getByPath(current, field));
  }

  addChange(
    changes,
    'shipping_address',
    getByPath(previous, 'shipping_address'),
    getByPath(current, 'shipping_address'),
  );

  addChange(changes, 'line_items', getByPath(previous, 'line_items'), getByPath(current, 'line_items'));
  addChange(
    changes,
    'shipping_lines',
    getByPath(previous, 'shipping_lines'),
    getByPath(current, 'shipping_lines'),
  );
  addChange(
    changes,
    'discount_codes',
    getByPath(previous, 'discount_codes'),
    getByPath(current, 'discount_codes'),
  );
  addChange(
    changes,
    'transactions',
    getByPath(previous, 'transactions'),
    getByPath(current, 'transactions'),
  );
  addChange(changes, 'refunds', getByPath(previous, 'refunds'), getByPath(current, 'refunds'));
  addChange(changes, 'customer', getByPath(previous, 'customer'), getByPath(current, 'customer'));

  collectFulfillmentChanges(previous, current, changes);

  if (DEBUG_FULL_DIFF) {
    const fullChanges = [];
    collectFullPayloadChanges(previous, current, fullChanges);
    for (const item of fullChanges) {
      if (!changes.some((c) => c.key === item.key)) {
        changes.push(item);
      }
    }
  }

  return {
    changed: changes.length > 0,
    summary:
      changes.length > 0
        ? `Changed: ${changes.map((item) => item.key).join(', ')}`
        : 'Ghost update — no visible changes',
    changes,
  };
}

function pushDiffLog(entry) {
  diffLog.push(entry);
  if (diffLog.length > DIFF_LOG_MAX) {
    diffLog.shift();
  }
}

function markWebhookIdSeen(webhookId) {
  if (!webhookId) return false;
  const alreadySeen = recentWebhookIdSet.has(webhookId);
  if (alreadySeen) return true;
  recentWebhookIds.push(webhookId);
  recentWebhookIdSet.add(webhookId);
  if (recentWebhookIds.length > WEBHOOK_ID_MAX) {
    const evicted = recentWebhookIds.shift();
    if (evicted) recentWebhookIdSet.delete(evicted);
  }
  return false;
}

function classifyUpdate(diff, metadata) {
  const keys = diff?.changes?.map((c) => c.key) || [];
  const onlyUpdatedAt = keys.length === 1 && keys[0] === 'updated_at';
  const noVisibleChanges = keys.length === 0;

  if (metadata.is_test) return 'test_webhook';
  if (metadata.duplicate_delivery) return 'duplicate_delivery';
  if (noVisibleChanges) return 'ghost_system_touch';
  if (onlyUpdatedAt) return 'timestamp_only_touch';
  return 'business_change';
}

function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  const received = Buffer.from(hmacHeader, 'utf8');
  const generated = Buffer.from(digest, 'utf8');
  if (received.length !== generated.length) return false;

  return crypto.timingSafeEqual(received, generated);
}

function renderDashboard(entries) {
  const rows = entries
    .map((entry, idx) => {
      const metadataRows = `
        <tr><td>_meta.topic</td><td>-</td><td>${safeStringify(entry.topic)}</td></tr>
        <tr><td>_meta.webhook_id</td><td>-</td><td>${safeStringify(entry.webhook_id)}</td></tr>
        <tr><td>_meta.triggered_at</td><td>-</td><td>${safeStringify(entry.triggered_at)}</td></tr>
        <tr><td>_meta.shop_domain</td><td>-</td><td>${safeStringify(entry.shop_domain)}</td></tr>
        <tr><td>_meta.api_version</td><td>-</td><td>${safeStringify(entry.api_version)}</td></tr>
        <tr><td>_meta.request_id</td><td>-</td><td>${safeStringify(entry.request_id)}</td></tr>
        <tr><td>_meta.user_agent</td><td>-</td><td>${safeStringify(entry.user_agent)}</td></tr>
        <tr><td>_meta.remote_ip</td><td>-</td><td>${safeStringify(entry.remote_ip)}</td></tr>
        <tr><td>_meta.payload_sha256</td><td>-</td><td>${safeStringify(entry.payload_sha256)}</td></tr>
        <tr><td>_meta.classification</td><td>-</td><td>${safeStringify(entry.classification)}</td></tr>
      `;

      const changeRows =
        entry.diff.changes.length === 0
          ? '<tr><td colspan="3">Ghost update — no visible changes</td></tr>'
          : entry.diff.changes
              .map(
                (c) =>
                  `<tr><td>${c.key}</td><td>${safeStringify(c.previous)}</td><td>${safeStringify(c.current)}</td></tr>`,
              )
              .join('');
      const detailsRows = `${metadataRows}${changeRows}`;

      return `
        <tr class="summary" data-target="details-${idx}">
          <td>${entry.order_name || '(unknown order)'}</td>
          <td>${entry.received_at}</td>
          <td>${entry.diff.summary}</td>
        </tr>
        <tr id="details-${idx}" class="details-row">
          <td colspan="3">
            <table class="inner-table">
              <thead>
                <tr><th>Field</th><th>Previous</th><th>New</th></tr>
              </thead>
              <tbody>${detailsRows}</tbody>
            </table>
          </td>
        </tr>
      `;
    })
    .join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Shopify Orders Updated Diff Log</title>
  <meta http-equiv="refresh" content="10" />
  <style>
    body { font-family: sans-serif; margin: 24px; background: #f7f7f7; color: #1a1a1a; }
    h1 { margin: 0 0 8px; }
    p { margin: 0 0 18px; color: #555; }
    table { width: 100%; border-collapse: collapse; background: #fff; }
    th, td { border: 1px solid #ddd; padding: 10px; text-align: left; vertical-align: top; }
    thead th { background: #f0f0f0; }
    tr.summary { cursor: pointer; }
    tr.summary:hover { background: #fafafa; }
    tr.details-row { display: none; background: #fcfcfc; }
    .inner-table th, .inner-table td { font-size: 13px; }
    .empty { padding: 16px; background: #fff; border: 1px solid #ddd; }
  </style>
</head>
<body>
  <h1>Orders Updated Diff Log</h1>
  <p>Auto-refresh every 10 seconds. Click any row to expand details.</p>
  ${
    entries.length === 0
      ? '<div class="empty">No webhook entries yet.</div>'
      : `<table><thead><tr><th>Order</th><th>Received At</th><th>Summary</th></tr></thead><tbody>${rows}</tbody></table>`
  }
  <script>
    document.querySelectorAll('tr.summary').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-target');
        const target = document.getElementById(id);
        if (!target) return;
        target.style.display = target.style.display === 'table-row' ? 'none' : 'table-row';
      });
    });
  </script>
</body>
</html>`;
}

app.get('/', (_req, res) => {
  const newestFirst = [...diffLog].reverse();
  res.status(200).type('html').send(renderDashboard(newestFirst));
});

app.get('/api/diff-log', (req, res) => {
  const { order_id: orderIdFilter } = req.query;
  const newestFirst = [...diffLog].reverse();
  const filtered = orderIdFilter
    ? newestFirst.filter((entry) => String(entry.order_id) === String(orderIdFilter))
    : newestFirst;
  res.status(200).json({
    count: filtered.length,
    entries: filtered,
  });
});

app.get('/api/ghost-updates', (req, res) => {
  const { order_id: orderIdFilter } = req.query;
  const newestFirst = [...diffLog].reverse();
  const ghostEntries = newestFirst.filter((entry) => {
    const noVisibleChanges = entry?.diff?.changes?.length === 0;
    const onlyUpdatedAt =
      entry?.diff?.changes?.length === 1 && entry?.diff?.changes?.[0]?.key === 'updated_at';
    const matchesOrder = orderIdFilter
      ? String(entry.order_id) === String(orderIdFilter)
      : true;
    return matchesOrder && (noVisibleChanges || onlyUpdatedAt);
  });
  res.status(200).json({
    count: ghostEntries.length,
    entries: ghostEntries,
  });
});

app.post('/webhook/orders-updated', express.raw({ type: 'application/json' }), (req, res) => {
  const rawBody = req.body;
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  const topicHeader = req.get('X-Shopify-Topic') || '';
  const webhookIdHeader = req.get('X-Shopify-Webhook-Id') || '';
  const triggeredAtHeader = req.get('X-Shopify-Triggered-At') || '';
  const shopDomainHeader = req.get('X-Shopify-Shop-Domain') || '';
  const apiVersionHeader = req.get('X-Shopify-Api-Version') || '';
  const isTestHeader = req.get('X-Shopify-Test') || '';
  const requestIdHeader = req.get('X-Request-Id') || req.get('x-request-id') || '';
  const remoteIp = req.ip || req.socket?.remoteAddress || '';
  const userAgent = req.get('User-Agent') || '';

  if (!Buffer.isBuffer(rawBody)) {
    res.status(401).send('Invalid body');
    return;
  }

  const isValid = verifyShopifyHmac(rawBody, hmacHeader, SHOPIFY_WEBHOOK_SECRET);
  if (!isValid) {
    res.status(401).send('Invalid HMAC');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // Valid signature but invalid JSON; acknowledge to prevent retries storm.
    res.status(200).send('ok');
    return;
  }

  const orderId = payload?.id;
  const orderName = payload?.name || '';
  const receivedAt = new Date().toISOString();
  const payloadSha256 = crypto.createHash('sha256').update(rawBody).digest('hex');
  const duplicateDelivery = markWebhookIdSeen(webhookIdHeader);

  if (orderId !== undefined && orderId !== null) {
    const existing = orderStore.get(orderId);
    const previous = existing?.payloads?.[existing.payloads.length - 1] || null;

    const nextPayloads = previous ? [previous, payload] : [payload];
    orderStore.set(orderId, {
      order_name: orderName,
      payloads: nextPayloads,
    });

    const diff = diffOrderPayloads(previous, payload);
    const classification = classifyUpdate(diff, {
      is_test: isTestHeader === 'true',
      duplicate_delivery: duplicateDelivery,
    });
    pushDiffLog({
      order_id: orderId,
      order_name: orderName,
      received_at: receivedAt,
      topic: topicHeader,
      webhook_id: webhookIdHeader,
      triggered_at: triggeredAtHeader,
      shop_domain: shopDomainHeader,
      api_version: apiVersionHeader,
      request_id: requestIdHeader,
      user_agent: userAgent,
      remote_ip: remoteIp,
      payload_sha256: payloadSha256,
      is_test: isTestHeader === 'true',
      duplicate_delivery: duplicateDelivery,
      classification,
      diff,
    });
  }

  res.status(200).send('ok');
});

app.listen(PORT, HOST, () => {
  console.log(`Webhook listener running on http://${HOST}:${PORT}`);
});
