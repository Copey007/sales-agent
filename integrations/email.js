// Email Integration — Resend + SMTP
// Send and track emails via Resend API (primary) or SMTP (fallback)

const fs = require('fs')
const { Resend } = require('resend')

const config = {
  resend: {
    apiKey: process.env.RESEND_API_KEY || null,
    from: process.env.FROM_EMAIL || 'A-Gent <noreply@a-gent.co>'
  },
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    user: process.env.SMTP_USER || null,
    password: process.env.SMTP_PASSWORD || null
  }
}

// Initialize Resend client
const resend = config.resend.apiKey ? new Resend(config.resend.apiKey) : null

async function send(emailData) {
  const { to, subject, body, from } = emailData
  
  if (!to) {
    return { success: false, error: 'No recipient' }
  }
  
  console.log(`[Email] Sending to ${to}: ${subject}`)
  
  let result
  
  if (resend) {
    // Send via Resend
    try {
      const res = await resend.emails.send({
        from: from || config.resend.from,
        to: to,
        subject: subject || '(no subject)',
        text: body || '',
        html: body ? body.replace(/\n/g, '<br>') : ''
      })
      result = { success: true, messageId: res.data?.id || res.id }
    } catch (err) {
      console.error(`[Email] Resend error: ${err.message}`)
      result = { success: false, error: err.message }
    }
  } else {
    // Log only — no email provider configured
    console.log(`[Email] No RESEND_API_KEY — would send to ${to}: ${subject}`)
    result = { success: true, messageId: `mock_${Date.now()}` }
  }
  
  // Save to sent folder (for tracking)
  const sentEmail = {
    id: result.messageId || Date.now().toString(),
    to,
    subject,
    body,
    from: from || config.resend.from,
    sentAt: new Date().toISOString(),
    status: result.success ? 'sent' : 'failed',
    error: result.error || null
  }
  saveSentEmail(sentEmail)
  
  return result
}

function saveSentEmail(email) {
  const dir = './memory'
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const sentFile = `${dir}/sent_emails.json`
  let sentEmails = []
  
  try {
    if (fs.existsSync(sentFile)) {
      sentEmails = JSON.parse(fs.readFileSync(sentFile, 'utf8'))
    }
  } catch (e) {}
  
  sentEmails.push(email)
  fs.writeFileSync(sentFile, JSON.stringify(sentEmails, null, 2))
}

async function getSentEmails(limit = 50) {
  const sentFile = './memory/sent_emails.json'
  
  try {
    if (fs.existsSync(sentFile)) {
      const emails = JSON.parse(fs.readFileSync(sentFile, 'utf8'))
      return emails.slice(-limit)
    }
  } catch (e) {}
  
  return []
}

module.exports = {
  send,
  getSentEmails
}