# A-Gent — Your Personal AI Butler 🎩

> "A-Gent: A gentleman who never rests."

A-Gent is an AI-powered sales agent that tracks your workflows, learns your patterns, and executes automations — all with the precision of a gentleman's personal assistant.

**The metaphor:** Think English butler. Proper. Precise. Always at attention. Your work is tracked, categorized, and reported back to you with aristocratic calm.

---

## The Tiers

| Member | Price | Role |
|--------|-------|------|
| **Associate** | $0/mo | Entry-level — tracks your day, reports back |
| **Butler** | $29/mo | Full service — all automations, CRM sync, email sequences |
| **Estate Manager** | $99/mo | Complete autonomy — AI works while you sleep |

---

## What It Does

**Workflow Tracking**
- Chrome extension tracks time across Email, CRM, Chat, Docs, Social, Web
- Daily popup shows today's hours and session count
- Category breakdown with color-coded dots

**Click Intelligence**
- Counts repetitive actions per week
- "You send 40 follow-ups manually" → that's an automation candidate

**Automations (Butler tier)**
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
├── index.html           # Marketing site (butler theme)
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
│   ├── popup.html       # Butler-themed popup UI
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
- ✅ Chrome extension (butler-themed UI)
- ✅ Marketing site (butler-themed)

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