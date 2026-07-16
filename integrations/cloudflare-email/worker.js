// Cloudflare Email Worker — forwards inbound (received) email to the DenchClaw CRM.
//
// Cloudflare Email Routing delivers a matching message to this Worker; we parse it
// and POST a normalized JSON payload to the CRM's inbound webhook, which resolves
// the contact, opens/updates the email conversation, and records the reply.
//
// Bind two values (see wrangler.toml / README):
//   CRM_WEBHOOK_URL     — plaintext var, e.g. https://staging.usetantra.com/webhooks/email/inbound
//   CRM_WEBHOOK_SECRET  — secret, must equal INBOUND_WEBHOOK_SECRET in the CRM .env
import PostalMime from 'postal-mime';

export default {
  async email(message, env) {
    let parsed = {};
    try {
      const raw = await new Response(message.raw).arrayBuffer();
      parsed = await PostalMime.parse(raw);
    } catch (e) {
      // Parsing failed — fall back to envelope + headers so we still capture the reply.
    }

    const payload = {
      from: message.from,                                   // envelope sender (the contact)
      to: message.to,                                       // envelope recipient (your routed address)
      subject: parsed.subject || message.headers.get('subject') || '',
      text: parsed.text || '',
      html: parsed.html || '',
      message_id: parsed.messageId || message.headers.get('message-id') || null,
    };

    const r = await fetch(env.CRM_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': env.CRM_WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
    });

    // Reject on failure so Cloudflare surfaces it in logs (and can retry).
    if (!r.ok) throw new Error(`CRM webhook responded ${r.status}`);
  },
};
