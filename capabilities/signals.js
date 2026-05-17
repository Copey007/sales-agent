// Signal Detection Capability
// Monitor accounts for intent signals and trigger actions

const memory = require('../memory')
const webSearch = require('../integrations/web_search')
const sdr = require('./sdr')

// Scan all accounts for signals
async function scanAllAccounts() {
  const accounts = memory.longTerm.listAccounts()
  const findings = []
  
  for (const account of accounts) {
    const signals = await checkAccountSignals(account.accountId)
    if (signals.length > 0) {
      findings.push({
        accountId: account.accountId,
        signals,
        detectedAt: new Date().toISOString()
      })
      
      // Save signals to account
      memory.longTerm.saveAccount(account.accountId, { signals })
      
      // Trigger action based on signal type
      await triggerAction(account.accountId, signals)
    }
  }
  
  return findings
}

// Check specific account for signals
async function checkAccountSignals(accountId) {
  const account = memory.longTerm.loadAccount(accountId)
  const signals = []
  
  // Funding signal
  const fundingResults = await webSearch.search(`${account.name} funding raised 2024`)
  if (fundingResults.funding) {
    signals.push({
      type: 'funding',
      severity: 'high',
      detail: `Raised ${fundingResults.funding}`,
      source: 'news'
    })
  }
  
  // Hiring growth
  const hiringResults = await webSearch.search(`${account.name} hiring spree jobs`)
  if (hiringResults.jobCount && hiringResults.jobCount > 10) {
    signals.push({
      type: 'hiring_growth',
      severity: 'medium',
      detail: `${hiringResults.jobCount} new job postings`,
      source: 'careers page'
    })
  }
  
  // Executive change
  const execResults = await webSearch.search(`${account.name} new CTO CFO CEO`)
  if (execResults.newExecutive) {
    signals.push({
      type: 'executive_change',
      severity: 'high',
      detail: `New ${execResults.newExecutive.role}: ${execResults.newExecutive.name}`,
      source: 'news'
    })
    
    // New exec = high priority trigger
    await triggerAction(accountId, [{
      type: 'executive_change',
      detail: execResults.newExecutive.name
    }])
  }
  
  return signals
}

// Trigger appropriate action based on signal
async function triggerAction(accountId, signals) {
  const account = memory.longTerm.loadAccount(accountId)
  
  for (const signal of signals) {
    switch (signal.type) {
      case 'funding':
        // Funding = company has money = good time to sell
        await sdr.runOutbound(accountId, {
          emailTemplate: {
            subject: `Congratulations on the recent funding, ${account.name}!`,
            body: `Hi {{firstName}},\n\nI saw that ${account.name} recently raised funding. Congratulations! This is often when companies look to scale quickly...\n\nBest,\n{{myName}}`
          },
          senderName: 'Your Name',
          senderEmail: 'you@yourdomain.com'
        })
        break
        
      case 'executive_change':
        // New exec = high priority outreach
        memory.longTerm.addNote(accountId, `HIGH PRIORITY: New executive detected - ${signal.detail}`)
        break
        
      case 'hiring_growth':
        // Growing team = expanding needs
        await sdr.runOutbound(accountId, {
          emailTemplate: {
            subject: `Saw ${account.name} is growing fast`,
            body: `Hi {{firstName}},\n\nI noticed ${account.name} is growing quickly with ${signal.detail}. When companies scale, new challenges often emerge...\n\nBest,\n{{myName}}`
          },
          senderName: 'Your Name',
          senderEmail: 'you@yourdomain.com'
        })
        break
    }
  }
}

module.exports = {
  scanAllAccounts,
  checkAccountSignals,
  triggerAction
}