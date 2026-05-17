// Email Enrichment — Hunter.io API
// Find email addresses for contacts

const https = require('https')

const HUNTER_API_KEY = process.env.HUNTER_API_KEY || 'a341d203d878f7bf66fbbd7b0cd9fc04b4398378'
const HUNTER_API_URL = 'api.hunter.io'

// Find email by person + company
async function findEmail(firstName, lastName, domain) {
  if (!domain) {
    return { found: false, email: null, source: 'no_domain' }
  }
  
  return new Promise((resolve, reject) => {
    const path = `/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${HUNTER_API_KEY}`
    
    const options = {
      hostname: HUNTER_API_URL,
      port: 443,
      path,
      method: 'GET'
    }
    
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const result = JSON.parse(data)
          if (result.data && result.data.email) {
            resolve({
              found: true,
              email: result.data.email,
              score: result.data.score,
              source: result.data.source || 'hunter'
            })
          } else {
            resolve({ found: false, email: null, source: 'not_found' })
          }
        } catch (e) {
          resolve({ found: false, email: null, source: 'error' })
        }
      })
    })
    
    req.on('error', e => resolve({ found: false, email: null, source: 'error' }))
    req.end()
  })
}

// Search for company domain
async function findCompanyDomain(companyName) {
  return new Promise((resolve, reject) => {
    const path = `/v2/email-finder?domain=${encodeURIComponent(companyName)}.com&api_key=${HUNTER_API_KEY}`
    
    const options = {
      hostname: HUNTER_API_URL,
      port: 443,
      path,
      method: 'GET'
    }
    
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const result = JSON.parse(data)
          if (result.data && result.data.domain) {
            resolve({ found: true, domain: result.data.domain })
          } else {
            resolve({ found: false, domain: null })
          }
        } catch (e) {
          resolve({ found: false, domain: null })
        }
      })
    })
    
    req.on('error', e => resolve({ found: false, domain: null }))
    req.end()
  })
}

// Bulk enrich a list of contacts
async function enrichContacts(contacts, companyDomain) {
  const results = []
  
  for (const contact of contacts) {
    const nameParts = contact.name.split(/\s+/)
    const firstName = nameParts[0] || ''
    const lastName = nameParts.slice(1).join(' ') || ''
    
    const emailResult = await findEmail(firstName, lastName, companyDomain)
    
    results.push({
      ...contact,
      email: emailResult.found ? emailResult.email : null,
      emailScore: emailResult.score || null,
      emailSource: emailResult.source
    })
    
    // Rate limit: Hunter free tier is 25/month, add small delay
    await delay(500)
  }
  
  return results
}

// Check Hunter API quota
async function getQuota() {
  return new Promise((resolve, reject) => {
    const path = `/v2/account?api_key=${HUNTER_API_KEY}`
    
    const options = {
      hostname: HUNTER_API_URL,
      port: 443,
      path,
      method: 'GET'
    }
    
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const result = JSON.parse(data)
          resolve({
            searchesUsed: result.data?.searches || 0,
            searchesLimit: result.data?.plan_limits?.searches || 0
          })
        } catch (e) {
          resolve({ searchesUsed: 0, searchesLimit: 0 })
        }
      })
    })
    
    req.on('error', e => resolve({ searchesUsed: 0, searchesLimit: 0 }))
    req.end()
  })
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  findEmail,
  findCompanyDomain,
  enrichContacts,
  getQuota
}