/**
 * Inbound Webhook — Reply Capture & Forward
 *
 * Receives inbound email.received events from Resend,
 * forwards a polished notification to mark.cope.roarr@gmail.com
 * (with Reply-To set to the PROSPECT so hitting reply goes directly to them),
 * and logs each reply to the Netlify Blobs 'replies' store for Loop Engine Phase 2.
 */

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const payload = await req.json();

    const eventType = payload.type || 'unknown';
    const data = payload.data || payload;

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
        sentiment: 'unclassified',
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

    return new Response(JSON.stringify({
      success: true,
      reply_id: replyId,
      reply_from: from,
      subject: subject,
      forwarded: forwarded,
      logged: blobsLogged,
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
