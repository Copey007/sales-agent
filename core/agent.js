// Sales Agent Core — Main Loop & Decision Engine
// Orchestrates all capabilities, manages task queue, handles memory

const memory = require('../memory')
const research = require('../capabilities/research')
const sdr = require('../capabilities/sdr')
const signals = require('../capabilities/signals')
const { hubspot, salesforce } = require('../integrations/crm')
const email = require('../integrations/email')

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
    
    // Research command
    if (lower.includes('research') || lower.includes('find info on') || lower.includes('look up')) {
      const accountId = this.extractAccountId(command)
      tasks.push({
        type: 'research',
        action: 'research',
        accountId,
        priority: 'normal'
      })
    }
    
    // Prospect outreach command
    if (lower.includes('prospect') || lower.includes('reach out') || lower.includes('send email')) {
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
    // Remove common phrases to get company name
    let account = command
      .replace(/research|find|look up|check|what do you know about|info on/gi, '')
      .replace(/for|about|with/gi, ' ')
      .trim()
    
    // Clean up
    account = account.replace(/[^a-zA-Z0-9\s]/g, '').trim()
    
    // Simple slug for now
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