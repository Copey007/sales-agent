// AI SDR Capability
// Automated outbound prospecting and email sequences

const memory = require('../memory')
const email = require('../integrations/email')

// Main SDR loop
async function runOutbound(accountId, campaignId) {
  console.log(`[SDR] Starting outbound for ${accountId}`)
  
  // Load account data
  const account = memory.longTerm.loadAccount(accountId)
  if (!account.contacts || account.contacts.length === 0) {
    throw new Error(`No contacts found for ${accountId}. Run research first.`)
  }
  
  // Load campaign config
  const campaign = memory.working.loadWorking(campaignId)
  
  const results = {
    accountId,
    emailsSent: [],
    replies: [],
    bounces: [],
    startedAt: new Date().toISOString()
  }
  
  // Personalize and send to each contact
  for (const contact of account.contacts) {
    const emailResult = await sendPersonalizedEmail(account, contact, campaign)
    
    if (emailResult.status === 'sent') {
      results.emailsSent.push(emailResult)
      
      // Log to CRM
      memory.longTerm.addNote(accountId, `Email sent to ${contact.name}: ${emailResult.subject}`)
    } else if (emailResult.status === 'bounced') {
      results.bounces.push(emailResult)
    }
  }
  
  return results
}

// Personalize email based on account/contact data
async function sendPersonalizedEmail(account, contact, campaign) {
  if (!contact.email) {
    return { contactId: contact.id, status: 'bounced', reason: 'no email' }
  }
  
  // Get latest signal for personalization
  const latestSignal = account.signals && account.signals.length > 0 
    ? account.signals[account.signals.length - 1] 
    : null
  
  const signalText = latestSignal 
    ? (typeof latestSignal.detail === 'string' ? latestSignal.detail : latestSignal.detail?.name || JSON.stringify(latestSignal.detail))
    : 'recent activity'
  
  const template = campaign.emailTemplate || ''
  const campaignSubject = campaign.subject || 'Quick question about {{companyName}}'
  
  // Variable substitution
  const personalizedBody = template
    .replace(/\{\{firstName\}\}/g, contact.firstName || contact.name?.split(' ')[0] || 'there')
    .replace(/\{\{contact\.name\}\}/g, contact.name || 'there')
    .replace(/\{\{companyName\}\}/g, account.name || '')
    .replace(/\{\{account\.name\}\}/g, account.name || '')
    .replace(/\{\{signal\.detail\.name\}\}/g, signalText)
    .replace(/\{\{signals\}\}/g, signalText)
    .replace(/\{\{myName\}\}/g, campaign.senderName || 'Mark')
  
  const personalizedSubject = campaignSubject
    .replace(/\{\{firstName\}\}/g, contact.firstName || contact.name?.split(' ')[0] || 'there')
    .replace(/\{\{contact\.name\}\}/g, contact.name || 'there')
    .replace(/\{\{companyName\}\}/g, account.name || '')
    .replace(/\{\{account\.name\}\}/g, account.name || '')
  
  const emailData = {
    to: contact.email,
    subject: personalizedSubject,
    body: personalizedBody,
    from: campaign.senderEmail
  }
  
  // Send via email integration
  const result = await email.send(emailData)
  
  return {
    contactId: contact.id,
    to: contact.email,
    subject: personalizedSubject,
    status: result.success ? 'sent' : 'failed',
    messageId: result.messageId
  }
}

// Create a sequence (multi-step cadence)
async function createSequence(accountId, steps) {
  const sequence = {
    accountId,
    steps,
    currentStep: 0,
    createdAt: new Date().toISOString()
  }
  
  memory.working.saveWorking(`sequence_${accountId}`, sequence)
  return sequence
}

// Process next step in sequence
async function processNextStep(accountId) {
  const sequence = memory.working.loadWorking(`sequence_${accountId}`)
  
  if (!sequence || sequence.currentStep >= sequence.steps.length) {
    return { done: true }
  }
  
  const currentStep = sequence.steps[sequence.currentStep]
  
  // Execute step (email, LinkedIn, etc.)
  // ...implementation...
  
  sequence.currentStep++
  memory.working.saveWorking(`sequence_${accountId}`, sequence)
  
  return {
    done: false,
    step: currentStep,
    nextStepIn: currentStep.delayHours
  }
}

module.exports = {
  runOutbound,
  createSequence,
  processNextStep
}