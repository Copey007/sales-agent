import { createHmac, timingSafeEqual } from 'node:crypto';
/**
 * Inbound Webhook — Reply Capture & Forward
 *
 * Receives inbound email.received events from Resend,
 * forwards a polished notification to mark.cope.roarr@gmail.com
 * (with Reply-To set to the PROSPECT so hitting reply goes directly to them),
 * and logs each reply to the Netlify Blobs 'replies' store for Loop Engine Phase 2.
 */


/**
 * Verify a Resend (Svix / Standard Webhooks) signature over the RAW body.
 * Headers: svix-id, svix-timestamp, svix-signature ("v1,<base64> ...").
 * Secret: RESEND_WEBHOOK_SECRET ("whsec_<base64>") from the Resend dashboard.
 */
function verifyResendSignature(req, rawBody) {
  const secret = (typeof Netlify !== 'undefined' && Netlify.env?.get('RESEND_WEBHOOK_SECRET'))
    || process.env.RESEND_WEBHOOK_SECRET || '';
  if (!secret) return { ok: false, reason: 'RESEND_WEBHOOK_SECRET not configured' };
  const id = req.headers.get('svix-id') || req.headers.get('webhook-id');
  const ts = req.headers.get('svix-timestamp') || req.headers.get('webhook-timestamp');
  const sigHeader = req.headers.get('svix-signature') || req.headers.get('webhook-signature');
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'missing signature headers' };
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!Number.isFinite(age) || age > 300) return { ok: false, reason: 'timestamp outside tolerance' };
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
  const exp = Buffer.from(expected);
  const match = sigHeader.split(' ').some(part => {
    const sig = part.split(',')[1] || '';
    const got = Buffer.from(sig);
    return got.length === exp.length && timingSafeEqual(got, exp);
  });
  return match ? { ok: true } : { ok: false, reason: 'bad signature' };
}

const __handler = async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Unsigned requests could forge "prospect replies" into the Loop Engine
    // and trigger forwarded email → verify the Svix signature before parsing.
    const rawBody = await req.text();
    const verdict = verifyResendSignature(req, rawBody);
    if (!verdict.ok) {
      console.warn('[inbound-webhook] rejected:', verdict.reason);
      return new Response(JSON.stringify({ error: 'invalid signature' }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }
    const payload = JSON.parse(rawBody);

    const eventType = payload.type || 'unknown';
    const data = payload.data || payload;
    const resendId = data.email_id || data.id || '';

    // Bounce / complaint / provider suppression: never treat these as replies.
    if (eventType === 'email.bounced' || eventType === 'email.complained' || eventType === 'email.suppressed') {
      const emails = [...new Set([...extractEmails(data.to), ...extractEmails(data.recipient)])];
      const reason = eventType === 'email.complained' ? 'complaint'
        : eventType === 'email.suppressed' ? 'provider_suppressed'
        : 'bounce';
      const suppressed = await suppressAddresses(emails, { reason, eventType, resendId });
      return new Response(JSON.stringify({ ok: true, event: eventType, suppressed }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    if (eventType !== 'email.received') {
      return new Response(JSON.stringify({ ok: true, ignored: eventType }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    // --- Extract all relevant fields from the Resend inbound payload ---
    const from        = data.from        || data.sender     || 'unknown@unknown.com';
    const to          = data.to          || data.recipient  || '';
    const subject     = data.subject     || '(no subject)';
    const textBody    = data.text        || data.body       || '';
    const htmlBody    = data.html        || '';
    const messageId   = data.message_id  || data.id         || '';
    const inReplyTo   = data.in_reply_to || data.headers?.['in-reply-to'] || '';
    const receivedAt  = new Date().toISOString();

    // Parse display name + email from the From field (e.g. "Jane Smith <jane@acme.com>")
    const fromMatch   = from.match(/^(.*?)\s*<([^>]+)>$/);
    const prospectName  = fromMatch ? fromMatch[1].trim() : from.split('@')[0];
    const prospectEmail = fromMatch ? fromMatch[2].trim() : from;

    const RESEND_KEY = (typeof Netlify !== 'undefined' && Netlify.env?.get('RESEND_API_KEY'))
      ? Netlify.env.get('RESEND_API_KEY')
      : (process.env.RESEND_API_KEY || '');

    // --- 1. Build the polished forwarded email ---
    let forwarded = false;
    if (RESEND_KEY) {
      // Prefer the prospect's own HTML if available; otherwise convert plain text to HTML
      const replyHtml = htmlBody
        ? htmlBody
        : textBody
          .split('\n')
          .map(line => line.trim() === '' ? '<br>' : `<p style="margin:0 0 8px 0">${escHtml(line)}</p>`)
          .join('\n');

      // Plain-text version: always use the text body if available, else strip HTML tags
      const replyText = textBody || stripHtml(htmlBody);

      const forwardHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f5;margin:0;padding:24px">
  <div style="max-width:600px;margin:0 auto">

    <!-- Header banner -->
    <div style="background:#1a1a2e;border-radius:8px 8px 0 0;padding:16px 24px;display:flex;align-items:center;gap:12px">
      <div style="background:#d4af37;border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#1a1a2e;font-size:14px;flex-shrink:0">SDR</div>
      <div>
        <div style="color:#d4af37;font-weight:700;font-size:13px;letter-spacing:.08em;text-transform:uppercase">A-Gent Fleet · Reply Received</div>
        <div style="color:#aaa;font-size:11px;margin-top:2px">${receivedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</div>
      </div>
    </div>

    <!-- Prospect meta -->
    <div style="background:#fff;border-left:4px solid #d4af37;padding:16px 24px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><td style="color:#888;padding:3px 0;width:100px">From</td><td style="color:#111;font-weight:600">${escHtml(from)}</td></tr>
        <tr><td style="color:#888;padding:3px 0">To</td><td style="color:#555">${escHtml(to)}</td></tr>
        <tr><td style="color:#888;padding:3px 0">Subject</td><td style="color:#111">${escHtml(subject)}</td></tr>
        ${messageId ? `<tr><td style="color:#888;padding:3px 0">Message-ID</td><td style="color:#555;font-size:11px;font-family:monospace">${escHtml(messageId)}</td></tr>` : ''}
        ${inReplyTo ? `<tr><td style="color:#888;padding:3px 0">In-Reply-To</td><td style="color:#555;font-size:11px;font-family:monospace">${escHtml(inReplyTo)}</td></tr>` : ''}
      </table>
    </div>

    <!-- Reply body -->
    <div style="background:#fff;padding:20px 24px;border-top:1px solid #eee">
      <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px">Reply Content</div>
      <div style="font-size:14px;color:#222;line-height:1.65;border-left:3px solid #e0e0e0;padding-left:16px">
        ${replyHtml}
      </div>
    </div>

    <!-- CTA footer -->
    <div style="background:#f9f9f9;border-top:1px solid #eee;border-radius:0 0 8px 8px;padding:14px 24px;font-size:12px;color:#888;text-align:center">
      Hit <strong>Reply</strong> to respond directly to <strong>${escHtml(prospectName)}</strong> at <strong>${escHtml(prospectEmail)}</strong>.
      This reply has been logged to the Fleet reply store for Loop Engine metrics.
    </div>

  </div>
</body>
</html>`;

      const forwardText = [
        '=== A-Gent Fleet — Reply Received ===',
        '',
        `From:        ${from}`,
        `To:          ${to}`,
        `Subject:     ${subject}`,
        `Received:    ${receivedAt}`,
        messageId  ? `Message-ID:  ${messageId}`  : '',
        inReplyTo  ? `In-Reply-To: ${inReplyTo}`  : '',
        '',
        '--- Reply ---',
        replyText || '(no plain-text body)',
        '',
        `Hit Reply to respond directly to ${prospectName} <${prospectEmail}>.`
      ].filter(l => l !== undefined).join('\n');

      try {
        const sendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: `A-Gent Fleet <fleet@a-gent.co>`,
            to: ['mark.cope.roarr@gmail.com'],
            reply_to: prospectEmail,          // ← hitting Reply goes to the PROSPECT
            subject: `[Reply] ${subject}`,
            text: forwardText,
            html: forwardHtml,
            headers: {
              // Carry the original Message-ID and In-Reply-To so Gmail threads correctly
              ...(messageId  ? { 'X-Original-Message-ID': messageId }  : {}),
              ...(inReplyTo  ? { 'X-Original-In-Reply-To': inReplyTo } : {})
            }
          })
        });
        const sendResult = await sendRes.json();
        forwarded = sendRes.ok;
        console.log('[inbound-webhook] Forward result:', JSON.stringify(sendResult));
      } catch (fwdErr) {
        console.error('[inbound-webhook] Forward failed:', fwdErr.message);
      }
    } else {
      console.warn('[inbound-webhook] No RESEND_API_KEY — cannot forward reply');
    }

    // --- 2. Log the reply to Netlify Blobs (replies store) with campaign attribution ---
    let blobsLogged = false;
    let replyId = `reply_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let attributedCampaignId = null;
    let attributedSendId = null;
    try {
      const { getStore } = await import('@netlify/blobs');
      const repliesStore = getStore('replies');
      const sendsStore = getStore('email_sends');

      // Campaign attribution: find the originating email_send by scanning sends store
      // Match by in_reply_to header or by prospect email address
      try {
        const sendsList = await sendsStore.list();
        const sendBlobs = sendsList.blobs || [];
        // Check up to 100 recent sends for attribution (newest first by key)
        const recentSends = sendBlobs.slice(-100).reverse();
        for (const blob of recentSends) {
          if (attributedCampaignId) break;
          try {
            const send = await sendsStore.get(blob.key, { type: 'json' });
            if (!send) continue;
            // Match by message_id (if in_reply_to matches the send's message_id)
            if (inReplyTo && send.message_id && inReplyTo.includes(send.message_id)) {
              attributedCampaignId = send.campaign_id;
              attributedSendId = send.id;
              break;
            }
            // Fallback: match by prospect email on the send record
            if (prospectEmail && send.prospect_email && send.prospect_email.toLowerCase() === prospectEmail.toLowerCase()) {
              attributedCampaignId = send.campaign_id;
              attributedSendId = send.id;
              // Don't break — keep looking for a message_id match (stronger signal)
            }
          } catch { /* skip unreadable send */ }
        }
      } catch (attrErr) {
        console.warn('[inbound-webhook] Attribution lookup failed:', attrErr.message);
      }

      // Second fallback: look up prospect by email in prospects store, then find their campaign
      if (!attributedCampaignId && prospectEmail) {
        try {
          const prospectsStore = getStore('prospects');
          const prospectsList = await prospectsStore.list();
          const prospectBlobs = prospectsList.blobs || [];
          let foundProspectId = null;
          for (const blob of prospectBlobs.slice(-200)) {
            try {
              const p = await prospectsStore.get(blob.key, { type: 'json' });
              if (p && p.email && p.email.toLowerCase() === prospectEmail.toLowerCase()) {
                foundProspectId = p.id || blob.key;
                break;
              }
            } catch { /* skip */ }
          }
          if (foundProspectId) {
            const cpStore = getStore('campaign_prospects');
            const cpList = await cpStore.list();
            for (const blob of cpList.blobs || []) {
              try {
                const cp = await cpStore.get(blob.key, { type: 'json' });
                if (cp && cp.prospect_id === foundProspectId) {
                  attributedCampaignId = cp.campaign_id;
                  break;
                }
              } catch { /* skip */ }
            }
          }
        } catch (fallbackErr) {
          console.warn('[inbound-webhook] Prospect-based attribution failed:', fallbackErr.message);
        }
      }

      const replyRecord = {
        id: replyId,
        from: from,
        from_name: prospectName,
        from_email: prospectEmail,
        to: to,
        subject: subject,
        text_body: textBody,
        html_body: htmlBody,
        message_id: messageId,
        in_reply_to: inReplyTo,
        received_at: receivedAt,
        sentiment: isOptOutMessage(subject, textBody) ? 'unsubscribe' : 'unclassified',
        campaign_id: attributedCampaignId,
        email_send_id: attributedSendId,
        forwarded_to: 'mark.cope.roarr@gmail.com',
        forwarded: forwarded,
        event_type: eventType
      };

      await repliesStore.setJSON(replyId, replyRecord);
      blobsLogged = true;
      console.log('[inbound-webhook] Reply logged:', replyId, 'campaign:', attributedCampaignId);
    } catch (blobErr) {
      console.error('[inbound-webhook] Blobs logging failed:', blobErr.message);
    }

    // --- 3. Reply correlation: stop the machine for this prospect ---
    // Mark the prospect replied and cancel every still-queued send for them
    // across ALL campaigns, so a reply immediately halts the cadence.
    // EXCEPTION: out-of-office/auto-replies are not engagement — forward and
    // log them, but keep the cadence alive for when the person is back.
    const isAutoReply = /^(automatic reply|auto(matic)? response|out of office|abwesenheit|absence)/i.test(subject || '') ||
      /auto-?submitted:\s*auto/i.test(String(data.headers?.['auto-submitted'] || ''));
    const isOptOut = !isAutoReply && isOptOutMessage(subject, textBody);
    if (isOptOut && prospectEmail) {
      try {
        await suppressAddresses([String(prospectEmail).toLowerCase()], {
          reason: 'unsubscribe', eventType: 'email.received', resendId: messageId
        });
      } catch (supErr) {
        console.error('[inbound-webhook] opt-out suppression failed:', supErr.message);
      }
    }
    let cancelledSends = 0;
    if (isAutoReply) {
      console.log('[inbound-webhook] Auto-reply detected — cadence left running for', prospectEmail);
    } else try {
      const {
        putProspect, listRecords, putEmailSend, logActivity
      } = await import('./_campaign-store.mjs');

      // Inbound mail carries no tenant. Match the sender against EVERY
      // tenant's prospects (the same address can exist in more than one) and
      // stop the cadence wherever it exists — a reply/opt-out must always win.
      const emailLower = (prospectEmail || '').toLowerCase();
      const prospects = (await listRecords('prospects'))
        .filter(p => (p.email || '').toLowerCase() === emailLower);
      if (prospects.length) {
        const prospectIds = new Set();
        for (const prospect of prospects) {
          prospect.replied_at = prospect.replied_at || receivedAt;
          prospect.status = 'replied';
          prospect.last_reply_id = replyId;
          await putProspect(prospect);
          prospectIds.add(prospect.id);
        }

        for (const send of await listRecords('email_sends')) {
          if (prospectIds.has(send.prospect_id) && ['queued', 'dispatched'].includes(send.status)) {
            send.status = 'cancelled_replied';
            send.cancelled_at = receivedAt;
            send.cancelled_reason = `prospect replied (${replyId})`;
            await putEmailSend(send);
            cancelledSends++;
          }
        }

        await logActivity({
          type: 'reply_received',
          prospect_id: prospects[0].id,
          prospect_email: prospectEmail,
          prospect_name: prospectName,
          campaign_id: attributedCampaignId,
          reply_id: replyId,
          subject,
          followups_cancelled: cancelledSends
        });
        console.log(`[inbound-webhook] Correlated: ${prospects.length} prospect record(s) marked replied, ${cancelledSends} pending send(s) cancelled`);
      } else {
        console.log('[inbound-webhook] No prospect record for', prospectEmail, '— reply logged without correlation');
      }
    } catch (corrErr) {
      console.error('[inbound-webhook] Reply correlation failed:', corrErr.message);
    }

    return new Response(JSON.stringify({
      success: true,
      reply_id: replyId,
      reply_from: from,
      subject: subject,
      forwarded: forwarded,
      logged: blobsLogged,
      followups_cancelled: cancelledSends,
      received_at: receivedAt
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[inbound-webhook] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const config = {
  path: "/api/inbound-webhook"
};

// --- Helpers ---
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function extractEmails(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  const out = [];
  for (const item of list) {
    const raw = typeof item === 'string' ? item : (item?.email || item?.address || '');
    const m = String(raw).match(/<([^>]+)>/);
    const addr = (m ? m[1] : raw).trim().toLowerCase();
    if (addr && addr.includes('@')) out.push(addr);
  }
  return [...new Set(out)];
}

/** First-line opt-out language (unsubscribe / stop / etc.). Quoted signatures are ignored by only scanning the first lines. */
function isOptOutMessage(subject, text) {
  const head = `${subject || ''}\n${text || ''}`.split('\n').slice(0, 8).join('\n');
  return /^\s*(unsubscribe|stop\b|stop sending|opt[ -]?out|remove me|please remove|do not (email|contact)|don't (email|contact))/im.test(head);
}

async function suppressAddresses(emails, { reason, eventType, resendId } = {}) {
  const { addToSuppressionList, listRecords, putEmailSend, logActivity, DEFAULTS } = await import('./_campaign-store.mjs');
  const addrs = [...new Set((emails || []).map((e) => String(e || '').trim().toLowerCase()).filter((e) => e.includes('@')))];
  const tenants = new Set();
  const prospects = (await listRecords('prospects')).filter((p) => addrs.includes(String(p.email || '').toLowerCase()));
  const prospectIds = new Set();
  for (const p of prospects) {
    tenants.add(p.tenant_id || DEFAULTS.TENANT_ID);
    if (p.id) prospectIds.add(p.id);
  }
  const sends = await listRecords('email_sends');
  const nowIso = new Date().toISOString();
  for (const send of sends) {
    const rid = send.resend_result?.resend_id || send.resend_id;
    if (resendId && rid === resendId) {
      tenants.add(send.tenant_id || DEFAULTS.TENANT_ID);
      if (send.prospect_id) prospectIds.add(send.prospect_id);
      send.status = reason === 'complaint' ? 'complained'
        : reason === 'unsubscribe' ? 'cancelled_unsubscribed'
        : 'bounced';
      send.suppressed_at = nowIso;
      send.suppression_reason = reason;
      await putEmailSend(send);
    }
  }
  for (const send of sends) {
    if (prospectIds.has(send.prospect_id) && ['queued', 'dispatched', 'pending_approval'].includes(send.status)) {
      tenants.add(send.tenant_id || DEFAULTS.TENANT_ID);
      send.status = 'cancelled_suppressed';
      send.cancelled_at = nowIso;
      send.cancelled_reason = reason;
      await putEmailSend(send);
    }
  }
  if (tenants.size === 0) tenants.add('*');
  const suppressed = [];
  for (const email of addrs) {
    for (const tenant of tenants) {
      await addToSuppressionList({
        tenant_id: tenant,
        email,
        reason,
        source: eventType || 'webhook',
        resend_id: resendId || null,
        suppressed_at: nowIso,
      });
      suppressed.push({ email, tenant_id: tenant });
    }
  }
  try {
    await logActivity({
      type: 'suppression_event',
      reason,
      source: eventType || 'webhook',
      resend_id: resendId || null,
      emails: addrs,
      tenants: [...tenants],
      count: suppressed.length,
    });
  } catch (err) {
    console.error('[inbound-webhook] activity log failed:', err.message);
  }
  return suppressed;
}

// 2026-11 lockdown: Svix signature verification (RESEND_WEBHOOK_SECRET).
export { verifyResendSignature, extractEmails, isOptOutMessage, suppressAddresses };
export default __handler;  // server-to-server webhook: no CORS
