# Provisioner Agent Architecture
## How A-Gent Scales: "Me + Agents" at $1M+ ARR

---

## Core Concept

A **Provisioner Agent** orchestrates the entire client lifecycle — onboarding, agent creation, monitoring, and teardown — without Mark doing manual work. Mark becomes the quality control layer: agents report to him when human judgment is needed.

```
┌─────────────────────────────────────────────────────┐
│                   MARK (human)                       │
│            Quality control, exception handling       │
└──────────────────────┬──────────────────────────────┘
                       │ escalate only
                       ▼
┌─────────────────────────────────────────────────────┐
│              PROVISIONER AGENT                       │
│   - Onboards new clients                            │
│   - Spins up isolated client agents                 │
│   - Monitors health & usage                         │
│   - Handles billing/tracking                        │
│   - Tears down churned clients                      │
└──────────────────────┬──────────────────────────────┘
                       │ provisions
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   Client A        Client B       Client N
   Agent           Agent          Agent
   (isolated)      (isolated)     (isolated)
```

---

## Client Isolation Model

### Per-Client Workspace

Each client gets a completely isolated workspace:

```
/opt/agent-gent/
├── clients/
│   ├── client_a_uuid/
│   │   ├── workspace/          # Client agent files
│   │   │   ├── AGENTS.md
│   │   │   ├── MEMORY.md
│   │   │   ├── USER.md         # Client preferences
│   │   │   ├── credentials/
│   │   │   │   ├── hubspot.enc  # Encrypted API keys
│   │   │   │   ├── gmail.enc
│   │   │   │   └── salesforce.enc
│   │   │   ├── sessions/       # OpenClaw sessions
│   │   │   │   └── main/        # Client's main session
│   │   │   └── memory/
│   │   │       └── daily/       # Client's daily logs
│   │   └── config/
│   │       └── client.json     # Plan, limits, channels
│   └── client_b_uuid/
│       └── ...
├── templates/                  # Agent blueprints
│   ├── sales-agent/
│   ├── sdr-agent/
│   └── researcher-agent/
└── provisioner/
    ├── provisioner.js          # The orchestrator
    └── jobs/                   # Cron job definitions
```

### Secrets Management

Client credentials are stored encrypted, never in plain text:

```javascript
// Encrypted credential storage
// Uses AES-256-GCM, key derived from master key + client salt
// Master key lives in environment variable, never in code

credentials/
├── vault.key          # Encrypted master key (backed up to secure storage)
└── clients/
    └── {client_id}/
        └── credentials.enc   # Per-client encrypted credential bundle
```

**Providers evaluated:** HashiCorp Vault (self-hosted), AWS Secrets Manager, 1Password Business. Recommendation: **AWS Secrets Manager** for simplicity at scale, or **HashiCorp Vault** if you need full self-control.

### Channel Isolation

Each client has their own Telegram bot/token (or similar channel identity). The provisioner routes all client communication through their dedicated channel — clients never see other clients' data.

---

## Agent Template System

### Base Templates

```
templates/
├── sales-agent/
│   ├── SKILL.md
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── capabilities/          # Pre-built skills
│   │   ├── research.js
│   │   ├── outreach.js
│   │   ├── follow_up.js
│   │   └── crm_sync.js
│   └── config/
│       └── defaults.json
└── researcher-agent/
    └── ...
```

### Template Instantiation

When a new client signs up:

1. Provisioner copies template to `clients/{uuid}/workspace/`
2. Fills in client-specific values (name, brand voice, CRM credentials)
3. Creates encrypted credential bundle
4. Starts OpenClaw session with client workspace
5. Sends onboarding message via client's Telegram channel

---

## Provisioner Agent Role

### What It Does

```javascript
// Core provisioner responsibilities
{
  "onboard": "New client sign-up → agent creation → handoff",
  "monitor": "Track agent health, usage, errors, uptime",
  "billing": "Track usage against plan limits",
  "escalate": "Alert Mark when something needs human input",
  "offboard": "Churn detection → graceful teardown → data export"
}
```

### Onboarding Flow

```
Client signs up
        ↓
Provisioner receives webhook (Stripe payment confirmed)
        ↓
Generate client UUID + per-client encryption key
        ↓
Copy agent template → client workspace
        ↓
Store encrypted credentials (HubSpot, Gmail, etc.)
        ↓
Initialize client OpenClaw session
        ↓
Send welcome message on client's Telegram channel
        ↓
Run discovery interview (ask about goals, preferences, workflows)
        ↓
Configure agent with client-specific instructions
        ↓
Agent begins work — Mark gets summary notification
```

### Discovery Interview (automated)

The agent asks the client:

1. "What's your biggest time sink in sales right now?"
2. "Which CRM do you use — HubSpot or Salesforce?"
3. "What does your ideal outbound week look like?"
4. "Any specific prospects or accounts you want us to focus on?"

Answers populate the client's `USER.md` and agent configuration automatically.

---

## Escalation Model

Agents only escalate to Mark when:
- **Exception:** Something failed 3x and needs manual fix (e.g., CRM auth expired)
- **Decision required:** Agent hit a policy guardrail (e.g., trying to send email to a scraped lead)
- **Client unhappy:** Negative sentiment detected in client channel
- **Billing event:** Usage approaching plan limits, or churn signal detected

### Escalation Format

```
🚨 ESCALATION: Client {name} — {issue type}

What happened: {plain english description}
What I tried: {steps already attempted}
What I need: {specific human decision or action}
Timeline: {urgency}

Reply with: /approve {action} or /deny {reason}
```

Mark spends minutes per day managing exceptions, not doing operational work.

---

## Scaling Tiers

| Plan | Clients per host | Isolation | Memory limit |
|------|-----------------|-----------|--------------|
| **Starter** ($99/mo) | 1-5 | Shared container | 512MB |
| **Pro** ($299/mo) | 5-20 | Isolated container | 1GB |
| **Enterprise** ($999/mo) | 1-5 | Dedicated VM | 4GB+ |

At 20 clients per host × $200 avg = $4,000/month per server. Easy economics.

---

## Infrastructure Architecture

```
                    ┌──────────────────┐
                    │   Load Balancer   │
                    │   (Cloudflare)   │
                    └────────┬─────────┘
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
   │  Host 1      │   │  Host 2      │   │  Host N      │
   │ (5-20 clients)│   │ (5-20 clients)│   │ (scaling)   │
   │ Ubuntu 22.04│   │ Ubuntu 22.04│   │             │
   │ Docker      │   │ Docker      │   │             │
   │             │   │             │   │             │
   │ [c-a][c-b]  │   │ [c-c][c-d]  │   │             │
   │ [c-e][c-f]  │   │ [c-g][c-h]  │   │             │
   └─────────────┘   └─────────────┘   └─────────────┘
          │                  │
          └──────────────────┘
                    │
           ┌────────┴────────┐
           │  Provisioner   │
           │  Agent (Mark)  │
           └────────────────┘
```

### Host Specs (initial)

- **Provider:** Hetzner Cloud (CPX31 ~$18/mo) or AWS t3.medium
- **OS:** Ubuntu 22.04 LTS
- **Container runtime:** Docker + Docker Compose
- **Monitoring:** Uptime Kuma (uptimechecks), Grafana (metrics)
- **Backups:** rclone to Backblaze B2

---

## Provisioner API (internal)

```javascript
// Internal REST API for provisioning
POST   /clients              // Create new client
GET    /clients/:id          // Get client status
PATCH  /clients/:id          // Update plan, settings
DELETE /clients/:id          // Offboard client

GET    /clients/:id/usage    // Usage metrics
GET    /clients/:id/health   // Agent health score

POST   /clients/:id/escalate // Trigger Mark escalation
```

---

## Security Considerations

1. **No shared credentials** — each client's API keys are encrypted at rest
2. **Network isolation** — containers can't talk to each other directly
3. **Inbound credentials** — only the provisioner can decrypt client credentials; client agents receive them pre-decrypted via secure in-process handoff
4. **Audit log** — every API call, credential access, and agent action is logged with timestamp + client ID
5. **Compliance** — data retention policy: delete client workspace 30 days after offboarding; export available during grace period

---

## What Mark Does vs What Agents Do

### Mark's Role (hours per week)
- Exception review: ~30 min/day
- New client approval (still manual for now): 5 min/client
- Product decisions, strategy: as needed

### Agents' Role (continuous)
- Onboarding: fully automated after signup
- Monitoring: 24/7 health checks, uptime alerts
- Billing tracking: automatic, invoices generated
- Churn detection: agent watches for usage drop, flags before cancellation

---

## Next Steps

1. **Week 1-2:** Provisioner agent core — webhook handler, client creation, credential storage
2. **Week 3-4:** Template system — build first reusable agent template
3. **Week 5-6:** First real client onboarding — test the full flow
4. **Week 7+:** Automation of exceptions, escalation refinement, scaling

---

*This document is the foundational architecture for A-Gent's managed agent service. Updates as the product evolves.*