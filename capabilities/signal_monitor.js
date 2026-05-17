// Signal Monitoring Cron Job
// Scans all accounts for intent signals and triggers SDR actions

const memory = require('../memory')
const webSearch = require('../integrations/web_search')

// Main scan function — called by cron
async function scanAllAccountsForSignals() {
  console.log('[SignalScan] Starting account scan...')
  
  const accounts = memory.longTerm.listAccounts()
  console.log(`[SignalScan] Found ${accounts.length} accounts to monitor`)
  
  const results = []
  
  for (const account of accounts) {
    try {
      const signals = await checkAccountSignals(account.accountId)
      
      if (signals.length > 0) {
        console.log(`[SignalScan] ${account.name}: ${signals.length} new signals`)
        
        // Save signals to account
        const existing = memory.longTerm.loadAccount(account.accountId)
        const existingSignals = existing.signals || []
        
        // Only add new signals (compare by type + detail)
        const newSignals = signals.filter(s => 
          !existingSignals.some(es => es.type === s.type && es.detail === s.detail)
        )
        
        if (newSignals.length > 0) {
          memory.longTerm.saveAccount(account.accountId, {
            signals: [...existingSignals, ...newSignals]
          })
          
          // Trigger SDR action for new signals
          await triggerSDR(account.accountId, newSignals)
          
          results.push({
            accountId: account.accountId,
            newSignals: newSignals.length,
            signals: newSignals
          })
        }
      }
    } catch (e) {
      console.error(`[SignalScan] Error scanning ${account.accountId}: ${e.message}`)
    }
    
    // Rate limit between accounts
    await delay(1000)
  }
  
  console.log(`[SignalScan] Scan complete. ${results.length} accounts have new signals.`)
  return results
}

// Check single account for signals
async function checkAccountSignals(accountId) {
  const account = memory.longTerm.loadAccount(accountId)
  const name = account.name || accountId.replace(/_/g, ' ')
  const signals = []
  
  // Check funding
  const fundingResults = await webSearch.search(`${name} funding raised 2024 2025`)
  if (fundingResults.funding) {
    signals.push({
      type: 'funding',
      severity: 'high',
      detail: fundingResults.funding,
      date: fundingResults.fundingDate,
      source: 'news'
    })
  }
  
  // Check hiring growth
  const hiringResults = await webSearch.search(`${name} hiring jobs 2024 2025`)
  if (hiringResults.jobCount && hiringResults.jobCount > 10) {
    signals.push({
      type: 'hiring',
      severity: 'medium',
      detail: `${hiringResults.jobCount} new jobs`,
      count: hiringResults.jobCount,
      source: 'job postings'
    })
  }
  
  // Check executive changes
  const execResults = await webSearch.search(`${name} new CEO CFO CTO 2024 2025`)
  if (execResults.newExecutive) {
    signals.push({
      type: 'executive_change',
      severity: 'high',
      detail: execResults.newExecutive,
      source: 'news'
    })
  }
  
  // Check recent news
  const newsResults = await webSearch.search(`${name} news today`)
  if (newsResults.snippets?.length > 0) {
    const topNews = newsResults.snippets[0]
    if (topNews.title && !topNews.title.includes('Jobs') && !topNews.title.includes('Careers')) {
      signals.push({
        type: 'news',
        severity: 'low',
        detail: topNews.title,
        snippet: topNews.snippet?.substring(0, 100),
        source: 'news'
      })
    }
  }
  
  return signals
}

// Trigger SDR action based on signal type
async function triggerSDR(accountId, signals) {
  const account = memory.longTerm.loadAccount(accountId)
  
  for (const signal of signals) {
    console.log(`[SignalScan] Triggering SDR for ${accountId}: ${signal.type}`)
    
    // Log the trigger
    memory.longTerm.addNote(accountId, `Signal detected: ${signal.type} - ${typeof signal.detail === 'string' ? signal.detail : JSON.stringify(signal.detail)}`)
    
    // In production, this would:
    // 1. Look up contacts with emails
    // 2. Personalize email based on signal
    // 3. Queue email for sending
    // 4. Update CRM with signal
    
    // For now, just log
    if (signal.type === 'funding') {
      console.log(`[SignalScan] 🚀 High priority: ${accountId} raised ${signal.detail}`)
    } else if (signal.type === 'executive_change') {
      console.log(`[SignalScan] 👔 New exec at ${accountId}: ${JSON.stringify(signal.detail)}`)
    } else if (signal.type === 'hiring') {
      console.log(`[SignalScan] 📈 Hiring spike at ${accountId}: ${signal.detail}`)
    }
  }
}

// Run scan (called by OpenClaw cron)
async function run() {
  try {
    const results = await scanAllAccountsForSignals()
    return {
      success: true,
      accountsScanned: results.length,
      results
    }
  } catch (e) {
    console.error(`[SignalScan] Fatal error: ${e.message}`)
    return {
      success: false,
      error: e.message
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  scanAllAccountsForSignals,
  checkAccountSignals,
  triggerSDR,
  run
}