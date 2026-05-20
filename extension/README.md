# A-Gent — Your Personal AI Butler 🎩

A-Gent is an AI-powered sales agent that tracks your workflows, learns your patterns, and executes automations — all with the precision of a gentleman's personal assistant.

> "A-Gent: A gentleman who never rests."

## Install (Developer Mode)

1. Open Chrome → `chrome://extensions/`
2. Enable **"Developer mode"** (toggle in top right)
3. Click **"Load unpacked"**
4. Select this folder
5. Click the A-Gent icon in your toolbar to begin

## The Butler Theme

- **A-Gent** = "A gentleman" — proper, precise, always at attention
- **Associate** = Free tier (the entry-level membership)
- **Butler** = $29/mo (full service)
- **Estate Manager** = $99/mo (complete AI autonomy)

## Files

```
extension/
├── manifest.json   # Chrome extension config
├── background.js    # Background tracking service worker
├── popup.html       # Extension popup UI (butler styling)
├── popup.js         # Popup logic
├── icons/           # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── index.html       # Marketing site
├── privacy.html     # Privacy policy page
└── README.md
```

## What It Tracks

- Active tab time by category
- Categories: Email, CRM, Chat, Docs, Social, Web, Other
- Session counts and daily totals
- Domain-level data (not individual URLs)

## Testing

1. Install via `chrome://extensions/` (Developer mode)
2. Click the A-Gent 🎩 icon in toolbar
3. Enter your work email to begin service
4. Browse naturally (Gmail, Salesforce, Slack, etc.)
5. Open popup to see your daily stats

## Category Mapping

Edit `background.js` → `categoryMap` to customize domain→category assignments.

Default categories:
- **email:** Gmail, Outlook, Yahoo
- **crm:** Salesforce, HubSpot, Dynamics, Pipedrive
- **chat:** Slack, Teams, Discord, Zoom, Meet
- **docs:** Google Docs, Office, Notion, Dropbox
- **web:** search engines
- **other:** everything else

## Publishing to Chrome Web Store

1. Create/appeal developer account: https://chrome.google.com/webstore/dev
2. Zip this entire folder
3. Upload to Web Store
4. Submit for review (1-3 days)
5. Live! 🎉

## Privacy

Your data stays local. We track aggregate categories only — never your URLs or page content. See `privacy.html` for details.