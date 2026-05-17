// Signal Monitor Cron Entry Point
// Run this script periodically to scan accounts for signals

const { run } = require('./capabilities/signal_monitor')

// Run and report
run().then(result => {
  console.log('\n=== Signal Scan Complete ===')
  console.log('Success:', result.success)
  if (result.accountsScanned) {
    console.log('Accounts scanned:', result.accountsScanned)
  }
  if (result.results) {
    result.results.forEach(r => {
      console.log(`  - ${r.accountId}: ${r.newSignals} new signals`)
    })
  }
  if (result.error) {
    console.error('Error:', result.error)
  }
  process.exit(result.success ? 0 : 1)
}).catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})