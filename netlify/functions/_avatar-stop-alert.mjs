/**
 * Operator alert when a LiveAvatar stop has failed after retries.
 *
 * Always writes a structured log line. If OPERATOR_EMAILS is set AND a from
 * address + RESEND_API_KEY are already configured, also emails those
 * operators. Never invents an operator or from address. If OPERATOR_EMAILS
 * is unset, fails quietly to the log.
 */

export const STOP_FAIL_ALERT_AFTER = 5;

export function operatorEmailsFromEnv(env = process.env) {
  return String(env.OPERATOR_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s.includes('@'));
}

export async function alertPermanentStopFailure({
  session,
  error,
  failCount,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const id = session?.id || 'unknown';
  const live = session?.liveavatar_session_id || '';
  console.error(
    `[avatar-reaper] PERMANENT_STOP_FAILURE id=${id} liveavatar=${live} fails=${failCount}: ${error || ''}`,
  );

  const emails = operatorEmailsFromEnv(env);
  if (!emails.length) {
    console.error('[avatar-reaper] PERMANENT_STOP_FAILURE: OPERATOR_EMAILS unset; log-only');
    return { emailed: false, reason: 'operator_emails_unset' };
  }

  const from = String(env.RESEND_FROM || env.OPERATOR_ALERT_FROM || '').trim();
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  if (!from || !apiKey) {
    console.error('[avatar-reaper] PERMANENT_STOP_FAILURE: mail transport unset; log-only');
    return { emailed: false, reason: 'mail_transport_unset' };
  }

  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: emails,
        subject: `A-Gent: LiveAvatar stop failed permanently (${id})`,
        text: [
          'A LiveAvatar session could not be stopped after retries.',
          `avatar_sessions.id: ${id}`,
          `liveavatar_session_id: ${live || '(none)'}`,
          `fail_count: ${failCount}`,
          `error: ${error || '(none)'}`,
          'The local row was left open so the reaper can keep retrying.',
        ].join('\n'),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[avatar-reaper] PERMANENT_STOP_FAILURE: email send failed', res.status, text);
      return { emailed: false, reason: `email_failed:${res.status}` };
    }
    return { emailed: true, reason: 'sent' };
  } catch (err) {
    console.error('[avatar-reaper] PERMANENT_STOP_FAILURE: email send threw:', err.message);
    return { emailed: false, reason: 'email_threw' };
  }
}
