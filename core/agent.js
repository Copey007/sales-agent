// Sales Agent Core — Main Loop & Decision Engine
// Orchestrates all capabilities, manages task queue, handles memory

const memory = require('../memory')
const research = require('../capabilities/research')
const sdr = require('../capabilities/sdr')
const signals = require('../capabilities/signals')
const { hubspot, salesforce } = require('../integrations/crm')
const email = require('../integrations/email')
const hunter = require('../integrations/email_enrichment')
const webSearch = require('../integrations/web_search')

class SalesAgent {
  constructor(config = {}) {
    this.name = config.name || 'Sales Agent'
    this.crm = config.crm || 'hubspot' // 'hubspot' or 'salesforce'
    this.senderEmail = config.senderEmail || process.env.SENDER_EMAIL
    this.senderName = config.senderName || process.env.SENDER_NAME || 'Sales Agent'
    
    // Task queue (FIFO)
    this.taskQueue = []
    this.currentTask = null
    
    // Initialize memory
    memory.shortTerm.load()
  }
  
  // Main entry point — receive a command/task
  async handle(command) {
    console.log(`\n[Agent] Received: ${command}`)
    
    // Parse command into tasks
    const tasks = this.parseCommand(command)
    
    // Add to queue
    for (const task of tasks) {
      this.taskQueue.push(task)
    }
    
    // Process queue (single-threaded)
    return await this.processQueue()
  }
  
  // Parse natural language command into structured tasks
  parseCommand(command) {
    const lower = command.toLowerCase()
    const tasks = []
    
    // Research + Email command (research and send email to contacts)
    if ((lower.includes('research') && lower.includes('email')) || 
        (lower.includes('prospect') && lower.includes('email')) ||
        lower.includes('research and email') ||
        lower.includes('research then email') ||
        lower.includes('email contacts')) {
      const accountId = this.extractAccountId(command.replace(/and email|then email|email the contacts|prospect and email/gi, ''))
      tasks.push({
        type: 'research_email',
        action: 'researchAndEmail',
        accountId,
        priority: 'high'
      })
    }
    // Research command
    else if (lower.includes('research') || lower.includes('find info on') || lower.includes('look up')) {
      const accountId = this.extractAccountId(command)
      tasks.push({
        type: 'research',
        action: 'research',
        accountId,
        priority: 'normal'
      })
    }
    
    // Prospect outreach command
    else if (lower.includes('prospect') || lower.includes('reach out') || lower.includes('send email')) {
      const accountId = this.extractAccountId(command)
      tasks.push({
        type: 'outbound',
        action: 'runOutbound',
        accountId,
        priority: 'normal'
      })
    }
    
    // Signal scan command
    if (lower.includes('scan') || lower.includes('check signals') || lower.includes('monitor')) {
      tasks.push({
        type: 'signals',
        action: 'scanAllAccounts',
        priority: 'normal'
      })
    }
    
    // Update CRM command
    if (lower.includes('update crm') || lower.includes('sync') || lower.includes('write to crm')) {
      const accountId = this.extractAccountId(command)
      tasks.push({
        type: 'crm_update',
        action: 'syncToCRM',
        accountId,
        priority: 'high'
      })
    }
    
    // Check account command
    if (lower.includes('check') || lower.includes('status') || lower.includes('what do you know')) {
      const accountId = this.extractAccountId(command)
      tasks.push({
        type: 'lookup',
        action: 'lookupAccount',
        accountId,
        priority: 'high'
      })
    }
    
    // If no tasks matched, treat as research by default
    if (tasks.length === 0) {
      const accountId = this.extractAccountId(command)
      if (accountId) {
        tasks.push({
          type: 'research',
          action: 'research',
          accountId,
          priority: 'normal'
        })
      }
    }
    
    return tasks
  }
  
  // Extract account/company name from command
  extractAccountId(command) {
    let account = command
      .replace(/research|prospect|find|look up|check|what do you know about|info on|and email|then email|email the contacts|prospect and email|and prospect/gi, '')
      .replace(/for|about|with|to|from/gi, ' ')
      .replace(/the contacts|contacts/gi, '')
      .trim()
    
    account = account.replace(/[^a-zA-Z0-9\s]/g, '').trim()
    
    return account.toLowerCase().replace(/\s+/g, '_')
  }
  
  // Process the task queue (single-threaded, FIFO)
  async processQueue() {
    const results = []
    
    while (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift()
      
      console.log(`[Agent] Processing: ${task.type} → ${task.action}`)
      memory.shortTerm.setCurrentTask(task)
      
      try {
        const result = await this.executeTask(task)
        results.push({ task, success: true, result })
      } catch (error) {
        console.error(`[Agent] Task failed: ${error.message}`)
        results.push({ task, success: false, error: error.message })
      }
      
      // Small delay between tasks
      await this.delay(100)
    }
    
    return this.formatResults(results)
  }
  
  // Execute a single task based on its type/action
  async executeTask(task) {
    switch (task.action) {
      case 'research':
        return await research.research(task.accountId)
        
      case 'researchAndEmail':
        return await this.researchAndEmail(task.accountId)
        
      case 'runOutbound':
        return await sdr.runOutbound(task.accountId, {
          senderEmail: this.senderEmail,
          senderName: this.senderName,
          emailTemplate: this.defaultEmailTemplate()
        })
        
      case 'scanAllAccounts':
        return await signals.scanAllAccounts()
        
      case 'syncToCRM':
        return await this.syncAccountToCRM(task.accountId)
        
      case 'lookupAccount':
        return await this.lookupAccount(task.accountId)
        
      default:
        throw new Error(`Unknown action: ${task.action}`)
    }
  }
  
  // Research account AND send emails to found contacts
  async researchAndEmail(accountId) {
    console.log(`[Agent] Running research + email for ${accountId}`)
    
    // Step 1: Research
    const researchResult = await research.research(accountId)
    
    // Step 2: Load account and get contacts
    const account = memory.longTerm.loadAccount(accountId)
    const contacts = account.contacts || []
    
    if (contacts.length === 0) {
      return {
        accountId,
        researched: true,
        contactsFound: 0,
        emailsSent: 0,
        message: 'Researched but no contacts found. Need more signals or contact enrichment.'
      }
    }
    
    // Step 3: Find company domain if not available
    let domain = account.domain
    if (!domain) {
      const domainResults = await webSearch.search(`${account.name || accountId} website`)
      if (domainResults.snippets && domainResults.snippets.length > 0) {
        // Try to extract domain from snippet
        const firstLink = domainResults.snippets.find(s => s.link)?.link || ''
        const domainMatch = firstLink.match(/https?:\/\/([^\/]+)/)
        if (domainMatch) {
          domain = domainMatch[1]
        }
        // Fallback: construct from company name
        if (!domain) {
          domain = `${accountId.replace(/_/g, '')}.com`
        }
      }
      console.log(`[Agent] Using domain: ${domain}`)
    }
    
    // Step 4: Enrich emails with Hunter.io
    const enrichedContacts = await hunter.enrichContacts(contacts, domain)
    
    // Update contacts in memory with emails
    memory.longTerm.saveAccount(accountId, { 
      contacts: enrichedContacts,
      domain: domain 
    })
    
    // Step 5: Compose emails for contacts with valid emails
    const emails = []
    for (const contact of enrichedContacts) {
      if (contact.email && contact.emailScore > 50) {  // Only high-confidence emails
        emails.push({
          to: contact.email,
          toName: contact.name,
          toTitle: contact.title,
          subject: this.personalizeSubject(account.name, account.signals),
          body: this.personalizeEmail(contact.name, account.name, account.signals)
        })
      }
    }
    
    // Step 6: Return summary
    return {
      accountId,
      accountName: account.name || accountId,
      researched: true,
      contactsFound: contacts.length,
      contactsEnriched: enrichedContacts.filter(c => c.email).length,
      domain: domain,
      contacts: enrichedContacts.map(c => ({ 
        name: c.name, 
        title: c.title, 
        hasEmail: !!c.email,
        email: c.email ? c.email : null,
        emailScore: c.emailScore || null
      })),
      emailsQueued: emails.length,
      emails: emails,
      nextSteps: emails.length > 0 
        ? 'Emails enriched and ready. Configure SMTP credentials to send.'
        : 'No high-confidence emails found. Try a different company domain.'
    }
  }
  
  // Personalize subject line based on signals
  personalizeSubject(companyName, signals) {
    if (!signals || signals.length === 0) {
      return `Quick question, ${companyName}`
    }
    
    const topSignal = signals[0]
    switch (topSignal.type) {
      case 'funding':
        return `Congratulations on the ${topSignal.detail}, ${companyName}`
      case 'executive_change':
        return `New leadership at ${companyName}`
      case 'hiring':
        return `Growing fast, ${companyName}`
      case 'news':
        return `${companyName} in the news`
      default:
        return `Quick question, ${companyName}`
    }
  }
  
  // Personalize email body based on company and signals
  personalizeEmail(firstName, companyName, signals) {
    const signalText = signals && signals.length > 0 
      ? this.getSignalContext(signals[0])
      : 'your growth trajectory'
    
    return `Hi ${firstName},

I noticed ${companyName} is doing interesting work in ${signalText}. We help revenue teams like yours move faster and close more deals.

Would you be open to a quick conversation this week?

Best,
${this.senderName}`
  }
  
  getSignalContext(signal) {
    if (!signal) return 'your growth trajectory'
    
    switch (signal.type) {
      case 'funding':
        return `recently raised ${signal.detail}`
      case 'executive_change':
        return typeof signal.detail === 'object' ? `leadership changes with ${signal.detail.name}` : signal.detail
      case 'hiring':
        return `adding ${signal.count || 'many'} new team members`
      case 'news':
        return 'recent developments'
      default:
        return 'your growth trajectory'
    }
  }
  
  // Sync account data to connected CRM
  async syncAccountToCRM(accountId) {
    const account = memory.longTerm.loadAccount(accountId)
    
    if (this.crm === 'hubspot') {
      return await hubspot.updateAccount(accountId, {
        name: account.name,
        industry: account.industry,
        size: account.size,
        signals: account.signals
      })
    } else if (this.crm === 'salesforce') {
      return await salesforce.updateAccount(accountId, account)
    }
  }
  
  // Lookup account info (from memory)
  async lookupAccount(accountId) {
    const account = memory.longTerm.loadAccount(accountId)
    
    // Check if we have data
    if (!account.name && !account.contacts?.length) {
      return {
        found: false,
        message: `No data for ${accountId}. Try "research ${accountId}" first.`
      }
    }
    
    return {
      found: true,
      account,
      canProspect: account.contacts?.length > 0
    }
  }
  
  // Default email template
  defaultEmailTemplate() {
    return {
      subject: 'Quick question, {{companyName}}',
      body: `Hi {{firstName}},

I wanted to reach out because I noticed {{companyName}} is doing some interesting work in {{signals}}.

Would you be open to a quick chat about how we're helping companies like yours with their sales process?

Best,
{{myName}}`
    }
  }
  
  // Format results for display
  formatResults(results) {
    if (results.length === 1) {
      const r = results[0]
      if (!r.success) return `❌ Failed: ${r.error}`
      return this.formatResult(r.result)
    }
    
    const summary = results.map(r => 
      r.success ? `✅ ${r.task.action}` : `❌ ${r.task.action}: ${r.error}`
    )
    return summary.join('\n')
  }
  
  formatResult(result) {
    if (!result) return 'Done.'
    
    // Check if it's an account object
    if (result.accountId) {
      const lines = [`📊 **${result.name || result.accountId}**`]
      
      if (result.size) lines.push(`Size: ${result.size}`)
      if (result.industry) lines.push(`Industry: ${result.industry}`)
      if (result.contacts?.length) lines.push(`Contacts: ${result.contacts.length}`)
      if (result.signals?.length) {
        lines.push(`Signals: ${result.signals.map(s => s.type).join(', ')}`)
      }
      
      return lines.join('\n')
    }
    
    // Generic JSON fallback
    return JSON.stringify(result, null, 2)
  }
  
  // Utility
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

// Export for use
module.exports = { SalesAgent }