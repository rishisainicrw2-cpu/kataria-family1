// WhatsApp alerts via Meta's official WhatsApp Cloud API (Graph API over plain HTTPS — no SDK needed).
// Credentials come from WHATSAPP_TOKEN / WHATSAPP_PHONE_ID env vars only; never hardcoded, never exposed
// to the frontend. See server/mailer.js for the same approach applied to email.
//
// IMPORTANT LIMITATION while only Meta's default "hello_world" template is approved: WhatsApp Business
// accounts cannot send freely-worded business-initiated messages — either the recipient messaged the bot
// number in the last 24 hours (a "session"), or the message uses a template Meta has approved in advance.
// Until custom templates (match_reminder, new_message_alert, admin_alert, etc.) are approved, sendTemplate()
// with the built-in 'hello_world' template is the only message guaranteed to go through to someone who
// hasn't messaged the bot — useful for confirming the connection works, not yet for real alert text.
const API = 'https://graph.facebook.com/v21.0';

function creds() {
  const token = (process.env.WHATSAPP_TOKEN || '').trim(), phoneId = (process.env.WHATSAPP_PHONE_ID || '').trim();
  if (!token || !phoneId) throw new Error('WhatsApp is not configured on this server.');
  return { token, phoneId };
}
async function call(payload) {
  const { token, phoneId } = creds();
  const res = await fetch(`${API}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `WhatsApp API error (${res.status})`);
  return data;
}
// to: E.164-ish digits (country code + number, no '+', e.g. "919876543210")
function sendTemplate(to, template = 'hello_world', lang = 'en_US', params = []) {
  return call({ to, type: 'template', template: { name: template, language: { code: lang }, ...(params.length ? { components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t) })) }] } : {}) } });
}
// Only works within 24h of the recipient messaging the bot, or once your own approved templates exist
// and you route through those instead. Kept here for when a 24h session is already open.
function sendText(to, body) { return call({ to, type: 'text', text: { body } }); }

module.exports = { sendTemplate, sendText };
