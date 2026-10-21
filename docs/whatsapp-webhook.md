# WhatsApp Cloud API webhook (Phase 1)

This project is a Vite + React SPA on Vercel. Incoming Meta webhooks are handled by a **server-only** function at:

`/api/webhooks/whatsapp`

Do not put WhatsApp or Meta secrets in `VITE_` variables. Those values are bundled into the browser.

Phase 1 **receives** verification requests, inbound messages, and delivery-status updates. It does **not** send WhatsApp messages and does not change the React UI or existing tables (`profiles`, `tasks`, `queries`).

## Required Vercel environment variables (server-only)

Set these in the Vercel project (Production, and Preview if you test there). Never prefix them with `VITE_`.

| Name | Purpose |
| --- | --- |
| `WHATSAPP_VERIFY_TOKEN` | Shared token you create. Meta sends it on GET verification. Must match the Verify Token in the Meta App Dashboard. |
| `META_APP_SECRET` | Meta app secret. Used to verify `X-Hub-Signature-256` on POST. |
| `SUPABASE_URL` | Supabase project URL for **server** writes. Do not rely on `VITE_SUPABASE_URL` in this function. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key. Used only inside the webhook to upsert events. Never expose this to the client. |

Existing SPA variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) stay as they are for the React app.

## Database (new table only)

In the Supabase SQL editor, run `supabase/whatsapp_webhook_events.sql`.

That creates `whatsapp_webhook_events` with a unique `event_key` so Meta retries are not processed twice. Row Level Security is enabled with **no** anon/authenticated policies, so the browser cannot read or write this table. The service role used by the function bypasses RLS.

The table stores message IDs, types, and status names. It does **not** store message bodies.

Without this table (or without the server Supabase env vars), GET verification can still succeed. POST events are accepted after a valid signature, but persistence and idempotency are skipped if the database env is missing. If the table is missing while env vars are set, POST returns **503** so Meta retries after you run the SQL.

## Deploy

1. Run the SQL above in Supabase.
2. Add the four server env vars in Vercel. Redeploy so the function sees them.
3. Deploy the repo as usual (`git push` to the connected branch, or `vercel --prod`).
4. Confirm the webhook URL (use your real Vercel domain):

   `https://YOUR_DOMAIN/api/webhooks/whatsapp`

Vite’s `npm run dev` does **not** serve `/api`. For a local tunnel test use `vercel dev`, then a public tunnel to that URL.

Do **not** add a Vercel rewrite that sends all paths (including `/api`) to `index.html`. That would break this webhook.

## If Meta says the callback URL or verify token failed

Meta’s subscribe request is a **GET**. It only succeeds if that GET hits this function and the tokens match.

1. **Use the production HTTPS URL** (no trailing slash, no `.js`, no query string):

   `https://YOUR_DOMAIN/api/webhooks/whatsapp`

2. **Redeploy after setting env vars.** `WHATSAPP_VERIFY_TOKEN` must be set on the same Vercel environment you deployed (Production vs Preview). It must match the Meta “Verify token” field exactly. It is **not** the App Secret.

3. **Turn off Vercel Deployment Protection** on that URL (SSO / Vercel Authentication / password). Meta’s servers cannot log in; they receive an HTML login page and verification fails. Production should be public, or add a protection exception for `/api/webhooks/*`.

4. **Confirm the function, not the React app.** Open the callback URL in a browser. You should get plain text `Forbidden` (HTTP 403), **not** the CTH Daily Tasks UI. If you see the app, `/api` is not deployed as a function.

5. `npm run dev` does not serve `/api`. Only a Vercel deployment or `vercel dev` does.

Then click **Verify and save** again in the Meta dashboard.

## Meta App Dashboard

1. [Meta for Developers](https://developers.facebook.com/) → your app → **WhatsApp** → **Configuration** (or **Webhooks**).
2. Callback URL: `https://YOUR_DOMAIN/api/webhooks/whatsapp`
3. Verify token: the same value as `WHATSAPP_VERIFY_TOKEN` on Vercel (not the app secret).
4. After GET verification succeeds, subscribe to the **`messages`** field on the WhatsApp Business Account. That field includes inbound messages and status updates (`sent`, `delivered`, `read`, `failed`).
5. Ensure the app secret used for signing is the one stored as `META_APP_SECRET`.

Meta signs POST bodies with HMAC-SHA256. The function hashes the **raw** body and compares `X-Hub-Signature-256`. Invalid signatures return **401**.

## What success looks like

- GET with `hub.mode=subscribe` and the correct token returns `hub.challenge` as plain text (HTTP 200).
- Valid signed POST returns HTTP 200 quickly.
- Retries of the same inbound message ID or the same `(message id, status)` pair insert once (`event_key` unique).
- Function logs include event counts only. They do not include message bodies, tokens, signatures, or secrets.

## Out of scope (later phases)

- Sending WhatsApp messages
- Task reminders / cron
- Phone numbers on `profiles`
- Any React UI changes
