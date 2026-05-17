// Skills Registry — Define what the agent can do
// Maps natural language to actions

const research = require('../capabilities/research')
const sdr = require('../capabilities/sdr')
const signals = require('../capabilities/signals')

const skills = {
  // Account Research
  research: {
    triggers: [
      'research {account}',
      'look up {account}',
      'find info on {account}',
      'tell me about {account}',
      'what do you know about {account}'
    ],
    action: async (params, agent) => {
      return await research.research(params.account)
    }
  },
  
  // Prospect Outreach
  prospect: {
    triggers: [
      'prospect {account}',
      'reach out to {account}',
      'send email to {account}',
      'email {account}',
      'contact {account}'
    ],
    action: async (params, agent) => {
      return await sdr.runOutbound(params.account, {
        emailTemplate: agent.defaultEmailTemplate(),
        senderEmail: agent.senderEmail,
        senderName: agent.senderName
      })
    }
  },
  
  // Signal Monitoring
  signals: {
    triggers: [
      'scan accounts',
      'check signals',
      'monitor accounts',
      'look for signals',
      'any news on accounts'
    ],
    action: async (params, agent) => {
      return await signals.scanAllAccounts()
    }
  },
  
  // Check Account
  lookup: {
    triggers: [
      'check {account}',
      'status of {account}',
      'what do we know about {account}'
    ],
    action: async (params, agent) => {
      return await agent.lookupAccount(params.account)
    }
  }
}

// Match a command to a skill
function matchSkill(command) {
  const lower = command.toLowerCase()
  
  for (const [skillName, skill] of Object.entries(skills)) {
    for (const trigger of skill.triggers) {
      // Convert trigger pattern to regex
      const pattern = trigger
        .replace('{account}', '(.+)')
        .replace(/\s+/g, '\\s+')
      
      const regex = new RegExp(pattern, 'i')
      const match = lower.match(regex)
      
      if (match) {
        return {
          skill: skillName,
          action: skill.action,
          params: { account: match[1]?.trim() }
        }
      }
    }
  }
  
  return null
}

// Get all skill names
function listSkills() {
  return Object.keys(skills)
}

module.exports = {
  skills,
  matchSkill,
  listSkills
}