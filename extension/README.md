# WeekWise — Chrome Extension

## Install (Developer Mode)

1. Open Chrome → `chrome://extensions/`
2. Enable **"Developer mode"** (toggle in top right)
3. Click **"Load unpacked"**
4. Select the `weekwise/extension` folder
5. Extension appears in toolbar (click to open popup)

## Files

```
extension/
├── manifest.json   # Chrome extension config
├── background.js    # Background tracking service worker
├── popup.html       # Extension popup UI
├── popup.js         # Popup logic
├── icons/           # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── package.json
```

## Testing

1. Install via chrome://extensions/ (Developer mode)
2. Click the WeekWise icon in toolbar
3. Enter any email to start tracking
4. Browse around (Gmail, Salesforce, Slack, etc.)
5. Open popup again to see stats

## What it tracks

- Active tab time
- Category (email, crm, chat, docs, web, other)
- Domain and URL
- Duration

## To publish to Chrome Web Store

1. Create developer account: https://chrome.google.com/webstore/dev
2. Pay $5 one-time registration fee
3. Zip the `extension` folder
4. Upload to Web Store
5. Wait 1-3 days for review

## Category mapping

Edit `background.js` → `categoryMap` to add/remove domains.

Default categories:
- email: Gmail, Outlook, Yahoo
- crm: Salesforce, HubSpot, Dynamics
- chat: Slack, Teams, Discord, Zoom, Meet
- docs: Google Docs, Office, Notion, Dropbox
- web: search engines
- other: everything else