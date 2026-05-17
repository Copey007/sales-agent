// Sales Agent — CLI Entry Point
// Run the agent from command line

const { SalesAgent } = require('./agent')

async function main() {
  // Get command from args
  const command = process.argv.slice(2).join(' ')
  
  if (!command) {
    console.log('Sales Agent CLI')
    console.log('Usage: node cli.js "research acme corp"')
    console.log('')
    console.log('Examples:')
    console.log('  node cli.js "research acme corp"')
    console.log('  node cli.js "prospect acme corp"')
    console.log('  node cli.js "scan accounts"')
    console.log('  node cli.js "check acme corp"')
    process.exit(1)
  }
  
  // Create agent
  const agent = new SalesAgent({
    name: 'Sales Agent',
    crm: process.env.CRM || 'hubspot',
    senderEmail: process.env.SENDER_EMAIL,
    senderName: process.env.SENDER_NAME
  })
  
  // Run
  console.log(`\n🤖 ${agent.name}\n`)
  const result = await agent.handle(command)
  console.log('\n' + result)
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error)
}

module.exports = { main }