/**
 * Inbound Webhook — Reply Capture
 * 
 * Receives inbound email events from Resend (email.received),
 * forwards the reply to mark.cope.roarr@gmail.com via Resend,
 * and logs it to the multi-campaign replies store (Netlify Blobs).
 */

export default async function handler(req) {
  // Only accept POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const payload = await req.json();

    // Resend sends { type: "email.received", data: { ... } }
    const eventType = payload.type || 'unknown';
    const data = payload.data || payload;

    // Extract reply fields from Resend inbound payload
    const from = data.from || data.sender || 'unknown@unknown.com';
    const to = data.to || data.recipient || '';
    const subject = data.subject || '(no subject)';
    const textBody = data.text || data.body || '';
    const htmlBody = data.html || '';
    const messageId = data.message_id || data.id || '';
    const inReplyTo = data.in_reply_to || data.headers?.['in-reply-to'] || '';
    const receivedAt = new Date().toISOString();

    // --- 1. Forward the reply to mark.cope.roarr@gmail.com via Resend ---
    const RESEND_KEY = (typeof Netlify !== 'undefined' && Netlify.env?.get('RESEND_API_KEY'))
      ? Netlify.env.get('RESEND_API_KEY')
      : (process.env.RESEND_API_KEY || '');
    
    if (RESEND_KEY) {
      const forwardSubject = `[Reply Received] ${subject}`;
      const forwardBody = `
--- Inbound Reply Captured by A-Gent Fleet ---

From: ${from}
To: ${to}
Subject: ${subject}
Received: ${receivedAt}
Message-ID: ${messageId}
In-Reply-To: ${inReplyTo}

--- Reply Body ---
${textBody || '(no text body — check HTML below)'}

--- HTML Body ---
${htmlBody || '(none)'}
`.trim();

      try {
        const sendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'A-Gent Fleet <fleet@a-gent.co>',
            to: ['mark.cope.roarr@gmail.com'],
            subject: forwardSubject,
            text: forwardBody
          })
        });
        const sendResult = await sendRes.json();
        console.log('[inbound-webhook] Forward result:', JSON.stringify(sendResult));
      } catch (fwdErr) {
        console.error('[inbound-webhook] Forward failed:', fwdErr.message);
      }
    } else {
      console.warn('[inbound-webhook] No RESEND_API_KEY — cannot forward reply');
    }

    // --- 2. Log the reply to Netlify Blobs (replies store) ---
    let blobsLogged = false;
    try {
      const { getStore } = await import('@netlify/blobs');
      const repliesStore = getStore('replies');

      // Try to attribute this reply to a campaign/email_send
      // We look for the In-Reply-To header which should match the original Message-ID
      const replyRecord = {
        id: `reply_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        from: from,
        to: to,
        subject: subject,
        text_body: textBody,
        html_body: htmlBody,
        message_id: messageId,
        in_reply_to: inReplyTo,
        received_at: receivedAt,
        sentiment: 'unclassified', // Phase 2: LLM classification
        campaign_id: null, // Will be attributed in Phase 2 via in_reply_to matching
        email_send_id: null, // Will be attributed in Phase 2
        forwarded_to: 'mark.cope.roarr@gmail.com',
        event_type: eventType
      };

      await repliesStore.setJSON(replyRecord.id, replyRecord);
      blobsLogged = true;
      console.log('[inbound-webhook] Reply logged:', replyRecord.id);
    } catch (blobErr) {
      console.error('[inbound-webhook] Blobs logging failed:', blobErr.message);
    }

    return new Response(JSON.stringify({
      success: true,
      reply_from: from,
      subject: subject,
      forwarded: !!RESEND_KEY,
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
}
