// Email Integration — Gmail/SMTP
// Send and track emails

const fs = require('fs')

const config = {
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    user: process.env.SMTP_USER || null,
    password: process.env.SMTP_PASSWORD || null
  },
  gmail: {
    clientId: process.env.GMAIL_CLIENT_ID || null,
    clientSecret: process.env.GMAIL_CLIENT_SECRET || null,
    refreshToken: process.env.GMAIL_REFRESH_TOKEN || null
  }
}

async function send(emailData) {
  const { to, subject, body, from } = emailData
  
  console.log(`[Email] Sending to ${to}: ${subject}`)
  
  // In production, integrate with Gmail API or SMTP
  // For now, log the email
  const sentEmail = {
    id: Date.now().toString(),
    to,
    subject,
    body,
    from: from || config.smtp.user,
    sentAt: new Date().toISOString(),
    status: 'sent'
  }
  
  // Save to sent folder (for tracking)
  saveSentEmail(sentEmail)
  
  return {
    success: true,
    messageId: sentEmail.id
  }
}

function saveSentEmail(email) {
  const sentFile = './memory/sent_emails.json'
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