# Sales Agent

Autonomous AI sales agent built for the GTM Revolution ecosystem.

## What it does

- **Account Research** — gather company info, contacts, signals
- **AI SDR** — automated outbound prospecting and email sequences
- **Signal Detection** — monitor accounts for intent triggers
- **CRM Sync** — write results to HubSpot/Salesforce

## Architecture

```
┌─────────────────────────────────────────┐
│           AGENT CORE                    │
│  Task queue, decision engine, main loop  │
├─────────────────────────────────────────┤
│           MEMORY LAYER                  │
│  Short-term | Long-term | Working      │
├─────────────────────────────────────────┤
│         CAPABILITY MODULES              │
│  Research | SDR | Signals              │
├─────────────────────────────────────────┤
│         INTEGRATION LAYER               │
│  HubSpot | Salesforce | Email | Web    │
└─────────────────────────────────────────┘
```

## Quick Start

```bash
# Research an account
node cli.js "research acme corp"

# Send outreach
node cli.js "prospect acme corp"

# Scan all accounts for signals
node cli.js "scan accounts"

# Check what we know
node cli.js "check acme corp"
```

## Environment Variables

```bash
HUBSPOT_API_KEY=      # HubSpot API key
SALESFORCE_ACCESS_TOKEN=  # Salesforce access token
SALESFORCE_INSTANCE_URL=  # Salesforce instance URL
SMTP_HOST=            # SMTP server
SMTP_USER=            # SMTP username
SMTP_PASSWORD=        # SMTP password
SENDER_EMAIL=          # Email address to send from
SENDER_NAME=           # Sender name
CRM=hubspot           # 'hubspot' or 'salesforce'
```

## File Structure

```
sales-agent/
├── core/
│   ├── agent.js      # Main loop & decision engine
│   ├── task_queue.js # FIFO task execution
│   └── skills.js     # Natural language → action mapping
├── memory/
│   ├── short_term.js # Session memory
│   ├── long_term.js  # Account persistence
│   └── working.js    # Task working data
├── capabilities/
│   ├── research.js   # Company & contact research
│   ├── sdr.js        # Outbound prospecting
│   └── signals.js    # Intent signal detection
├── integrations/
│   ├── crm.js        # HubSpot & Salesforce
│   ├── email.js      # Email sending
│   └── web_search.js # Web search
├── cli.js            # CLI entry point
└── package.json
```

## Status

MVP complete. Needs:
- Real search API (Brave/SerpAPI)
- Email credentials
- CRM credentials
- OpenClaw skill integration