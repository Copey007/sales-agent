# A-Gent Fleet — AI SDR platform with human-approved outbound

A-Gent Fleet researches accounts, explains *why now* with source-linked signals (Signal Engine), drafts outreach, and sends **only after a human approves it** in the Review Queue. This repository powers the operator app (currently `aisdr.a-gent.co`).

---

## Plans

Pricing is published at **https://a-gent.co/pricing/** (source of truth). This README intentionally does not repeat prices.

| Plan | For | Summary |
|------|-----|---------|
| **Trial** | New workspaces | 15-day free trial with Starter features; every send requires human approval |
| **Starter** | Founder-led / small teams | Included prospecting volume + mailbox, Review Queue, Signal Engine |
| **Growth** | SDR/AE teams | Higher limits, Loop Engine, CRM sync, Mission Control |
| **Custom Build** | Revenue leaders | Consulting-led build on top of Fleet (GTM Brain, integrations, managed ops) |

---

## What It Does

**Workflow Tracking**
- Chrome extension tracks time across Email, CRM, Chat, Docs, Social, Web
- Daily popup shows today's hours and session count
- Category breakdown with color-coded dots

**Click Intelligence**
- Counts repetitive actions per week
- "You send 40 follow-ups manually" → that's an automation candidate

**Automations (Starter and Growth)**
- CRM Auto-Sync (Salesforce/HubSpot)
- Email Sequences (multi-step outreach)
- Contact Enrichment (Hunter.io)
- Account Research (company intel)
- Signal Detection (intent alerts)

---

## Install

### Chrome Extension (Developer Mode)

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. Click the 🎩 icon in your toolbar

### Marketing Site

The `index.html` at the root deploys to Netlify. Already configured with `netlify.toml`.

---

## Structure

```
sales-agent/
├── index.html           # Legacy marketing page (superseded by a-gent.co)
├── netlify.toml         # Netlify deploy config
├── package.json
├── cli.js               # Agent command line
├── integrate.js
├── cron_signal_scan.js
├── README.md
├── ARCHITECTURE.md
│
├── extension/           # Chrome extension
│   ├── manifest.json
│   ├── background.js    # Service worker — tracking logic
│   ├── popup.html       # Extension popup UI
│   ├── popup.js
│   ├── privacy.html     # Privacy policy
│   └── icons/
│
├── core/                # Agent brain
├── capabilities/        # Skills
├── integrations/        # API wrappers
├── dashboard/           # Web dashboard
└── memory/              # File-based storage
```

---

## Quick Start

```bash
# Research an account
node cli.js "research acme corp"

# Scan for signals
node cli.js "scan accounts"

# Check what we know
node cli.js "check acme corp"
```

---

## Status

**Built:**
- ✅ Agent core (Telegram-ready)
- ✅ Account research (Serper API)
- ✅ Email enrichment (Hunter.io)
- ✅ Signal detection (cron job)
- ✅ Chrome extension
- ✅ Legacy marketing page (superseded by a-gent.co)

**Waiting on:**
- ⏳ Chrome Web Store account (appealing suspension)
- ⏳ Netlify dashboard deploy

---

## Tech Stack

- **Agent:** Node.js, file-based memory
- **Extension:** Chrome Extension API (Manifest V3)
- **Dashboard:** Static HTML + API calls
- **Search:** Serper.dev
- **Email:** SMTP + Hunter.io
- **Hosting:** Netlify + Mac mini backend

---

*Part of the GTM Revolution ecosystem*