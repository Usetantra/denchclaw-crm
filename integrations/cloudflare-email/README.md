# Inbound email → CRM (Cloudflare Email Routing)

Turns a reply email into an inbox message. Cloudflare receives the email, a Worker
parses it and POSTs it to the CRM's inbound webhook (`POST /webhooks/email/inbound`),
which resolves the contact, opens/updates the email conversation, dedupes, advances
the marketing stage on reply, and scores the lead.

```
reply → Cloudflare Email Routing → this Worker → POST /webhooks/email/inbound → CRM
```

## Prerequisites

1. **A public URL for the CRM webhook.** Local `:3100` isn't reachable from Cloudflare.
   Either deploy the CRM to a public host (e.g. `https://staging.usetantra.com`, with
   nginx forwarding `/webhooks/` to the app) or use a tunnel (`cloudflared tunnel` /
   `ngrok http 3100`) for testing. This URL becomes `CRM_WEBHOOK_URL`.
2. **The shared secret.** Copy `INBOUND_WEBHOOK_SECRET` from the CRM's `.env` — the
   Worker sends it as `x-webhook-secret`; the CRM rejects anything else with 401.
3. **A routing address whose MX can point to Cloudflare.**
   ⚠️ Email Routing takes over a zone's MX records. If `growthclub.org` uses Google
   Workspace, do **not** enable it on the apex (it would break your mail). Use a
   domain/subdomain dedicated to CRM replies whose MX you can hand to Cloudflare
   (e.g. a spare domain, or a subdomain zone). The routed address (e.g.
   `crm-reply@…`) is what recipients reply to.

## Deploy the Worker

```bash
cd integrations/cloudflare-email
npm install
# set the public webhook URL in wrangler.toml (CRM_WEBHOOK_URL), then:
npx wrangler secret put CRM_WEBHOOK_SECRET   # paste INBOUND_WEBHOOK_SECRET from the CRM .env
npx wrangler deploy
```

## Route email to the Worker (Cloudflare dashboard)

1. **Email → Email Routing** on the routing zone → enable it (adds Cloudflare MX).
2. **Routing address** → add e.g. `crm-reply@yourdomain` → action **Send to a Worker**
   → pick `denchclaw-crm-inbound`. (Or set a catch-all → Worker.)

## Multi-tenant routing (`INBOUND_ROUTING`)

The **recipient address decides which tenant owns the email**. Single-tenant (today's
model) needs no config — everything resolves to `DEFAULT_COMPANY_ID`. For more than
one company, map receiving addresses (or bare domains) to company ids:

```
INBOUND_ROUTING={"crm@growthclub.org":"tantra","@acme.com":"acme"}
```

Resolution order: exact address → `@domain` → `domain`. When `INBOUND_ROUTING` is set
and a recipient maps to nothing, the delivery is **rejected with 422** rather than
silently filed under the default tenant.

## Close the loop: make replies come back

Set the CRM to stamp that address as **Reply-To** on outbound email, so a recipient's
reply is delivered to Cloudflare → this Worker → the webhook. In the CRM `.env`:

```
INBOUND_REPLY_TO=crm-reply@yourdomain
```

Now: send from the inbox → recipient replies → the reply appears in the same contact's
email thread, advances their stage, and scores the lead.

## Test without real DNS

You can exercise the CRM side directly (this is exactly what the Worker posts):

```bash
curl -X POST https://PUBLIC-HOST/webhooks/email/inbound \
  -H 'content-type: application/json' \
  -H 'x-webhook-secret: <INBOUND_WEBHOOK_SECRET>' \
  -d '{"from":"Jane <jane@example.com>","to":"crm-reply@yourdomain","subject":"Re: hi","text":"Sounds good!","message_id":"test-1"}'
```
