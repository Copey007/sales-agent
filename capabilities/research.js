// Account Research Capability
// Research companies: gather info, find contacts, detect signals

const memory = require('../memory')
const webSearch = require('../integrations/web_search')

// Check memory first before doing new research
async function research(accountId, forceRefresh = false) {
  // Check if we already have recent data
  if (!forceRefresh) {
    const existing = await memory.alreadyKnow(accountId, ['name', 'contacts', 'research'])
    if (existing) {
      console.log(`[Research] Using cached data for ${accountId}`)
      return existing
    }
  }
  
  // Load working memory for this task
  const taskId = `research_${accountId}_${Date.now()}`
  memory.working.saveWorking(taskId, { accountId, status: 'in_progress' })
  
  const results = {
    accountId,
    domain: null,
    name: null,
    size: null,
    industry: null,
    techStack: [],
    funding: null,
    contacts: [],
    signals: [],
    sources: [],
    researchedAt: new Date().toISOString()
  }
  
  try {
    // Step 1: Basic company search
    const searchResults = await webSearch.search(`${accountId} company overview`)
    results.name = searchResults.name
    results.domain = searchResults.domain
    results.size = searchResults.size
    results.industry = searchResults.industry
    results.funding = searchResults.funding
    
    // Step 2: Find contacts
    const contacts = await findContacts(accountId, searchResults.domain)
    results.contacts = contacts
    
    // Step 3: Detect signals
    const signals = await detectSignals(accountId, searchResults.name)
    results.signals = signals
    
    // Save to long-term memory
    memory.longTerm.saveAccount(accountId, results)
    
    // Mark working complete
    memory.working.markComplete(taskId)
    
    return results
    
  } catch (error) {
    memory.working.markFailed(taskId, error.message)
    throw error
  }
}

// Find key contacts at the company
async function findContacts(accountId, domain) {
  const contacts = []
  
  // Search for key people
  const execSearch = await webSearch.search(`${accountId} executive team`)
  const revSearch = await webSearch.search(`${accountId} VP sales director`)
  const engSearch = await webSearch.search(`${accountId} engineering manager`)
  
  // Extract contacts from results (simplified)
  const allContacts = [
    ...extractContacts(execSearch),
    ...extractContacts(revSearch),
    ...extractContacts(engSearch)
  ]
  
  // Dedupe and add to memory
  for (const contact of allContacts) {
    const saved = memory.longTerm.addContact(accountId, contact)
    contacts.push(saved)
  }
  
  return contacts
}

// Detect buying signals
async function detectSignals(accountId, companyName) {
  const signals = []
  
  // Funding events
  const fundingSearch = await webSearch.search(`${companyName} funding raised`)
  if (fundingSearch.funding) {
    signals.push({
      type: 'funding',
      detail: fundingSearch.funding,
      date: fundingSearch.fundingDate
    })
  }
  
  // Hiring spree (growth signal)
  const hiringSearch = await webSearch.search(`${companyName} hiring growth`)
  if (hiringSearch.hiringGrowth) {
    signals.push({
      type: 'hiring',
      detail: 'Growth hiring detected',
      count: hiringSearch.jobCount
    })
  }
  
  // Executive changes
  const execSearch = await webSearch.search(`${companyName} new hire executive`)
  if (execSearch.newExecutive) {
    signals.push({
      type: 'executive_change',
      detail: execSearch.newExecutive
    })
  }
  
  return signals
}

// Extract contacts from web search results (placeholder for actual extraction logic)
function extractContacts(searchResults) {
  // In production, this would parse search snippets for names/titles
  // For now, return structured placeholder
  return []
}

module.exports = {
  research,
  findContacts,
  detectSignals
}