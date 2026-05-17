// WeekWise - Background Service Worker
// Tracks active tab and time spent

let currentTab = null;
let currentTabStart = null;
let currentCategory = 'other';
let trackingData = [];
let userEmail = null;
let isTracking = false;

// Default category mapping for common domains
const categoryMap = {
  // Email
  'mail.google.com': 'email',
  'outlook.live.com': 'email',
  'outlook.office365.com': 'email',
  'mail.yahoo.com': 'email',
  'fastmail.com': 'email',
  
  // CRM
  'salesforce.com': 'crm',
  'hubspot.com': 'crm',
  'dynamics.microsoft.com': 'crm',
  'pipedrive.com': 'crm',
  
  // Chat
  'slack.com': 'chat',
  'teams.microsoft.com': 'chat',
  'discord.com': 'chat',
  'zoom.us': 'chat',
  'meet.google.com': 'chat',
  
  // Docs
  'docs.google.com': 'docs',
  'office.com': 'docs',
  'notion.so': 'docs',
  'evernote.com': 'docs',
  'dropbox.com': 'docs',
  
  // Social
  'linkedin.com': 'social',
  'twitter.com': 'social',
  'x.com': 'social',
  
  // Web / Research
  'chrome.google.com': 'other',
  'search.google.com': 'web',
  'bing.com': 'web',
};

// Get category from URL
function getCategory(url) {
  try {
    const hostname = new URL(url).hostname;
    return categoryMap[hostname] || 'web';
  } catch {
    return 'other';
  }
}

// Record a session
function recordSession(tabId, url, startTime, endTime) {
  const duration = Math.floor((endTime - startTime) / 1000); // seconds
  if (duration < 5) return; // Ignore sessions less than 5 seconds
  
  const session = {
    id: Date.now().toString(),
    userId: userEmail || 'anonymous',
    tabId,
    url,
    domain: new URL(url).hostname,
    category: getCategory(url),
    startTime,
    endTime,
    duration,
    date: new Date().toISOString().split('T')[0]
  };
  
  trackingData.push(session);
  saveData();
}

// Save to local storage
function saveData() {
  chrome.storage.local.set({ 
    trackingData,
    userEmail,
    lastUpdated: Date.now()
  });
}

// Load from local storage
function loadData() {
  chrome.storage.local.get(['trackingData', 'userEmail'], (result) => {
    if (result.trackingData) trackingData = result.trackingData;
    if (result.userEmail) userEmail = result.userEmail;
  });
}

// Handle tab updates
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!isTracking || !userEmail) return;
  
  // Record previous tab
  if (currentTab && currentTabStart) {
    recordSession(currentTab.id, currentTab.url, currentTabStart, Date.now());
  }
  
  // Get new tab
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (tab && tab.url && !tab.url.startsWith('chrome://')) {
      currentTab = { id: tab.id, url: tab.url };
      currentTabStart = Date.now();
    }
  });
});

// Handle URL changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!isTracking || !userEmail) return;
  
  if (changeInfo.url && currentTab && currentTab.id === tabId) {
    // URL changed in same tab - record previous
    recordSession(tabId, currentTab.url, currentTabStart, Date.now());
    currentTab = { id: tabId, url: changeInfo.url };
    currentTabStart = Date.now();
  }
});

// Periodic check every 30 seconds
setInterval(() => {
  if (!isTracking || !userEmail || !currentTab) return;
  
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].url && !tabs[0].url.startsWith('chrome://')) {
      // Check if URL changed
      if (tabs[0].url !== currentTab.url) {
        recordSession(currentTab.id, currentTab.url, currentTabStart, Date.now());
        currentTab = { id: tabs[0].id, url: tabs[0].url };
        currentTabStart = Date.now();
      }
    }
  });
}, 30000);

// Message handlers
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startTracking') {
    userEmail = request.email;
    isTracking = true;
    saveData();
    sendResponse({ success: true });
  }
  
  if (request.action === 'stopTracking') {
    isTracking = false;
    saveData();
    sendResponse({ success: true });
  }
  
  if (request.action === 'getData') {
    sendResponse({ 
      trackingData: trackingData.slice(-100), // last 100 sessions
      userEmail,
      isTracking 
    });
  }
  
  if (request.action === 'getStats') {
    const stats = getStats();
    sendResponse(stats);
  }
  
  return true;
});

// Calculate statistics
function getStats() {
  const today = new Date().toISOString().split('T')[0];
  const todayData = trackingData.filter(s => s.date === today);
  
  const categoryTotals = {};
  let totalSeconds = 0;
  
  todayData.forEach(session => {
    totalSeconds += session.duration;
    categoryTotals[session.category] = (categoryTotals[session.category] || 0) + session.duration;
  });
  
  const categoryBreakdown = Object.entries(categoryTotals).map(([cat, secs]) => ({
    category: cat,
    hours: (secs / 3600).toFixed(1),
    percentage: Math.round((secs / totalSeconds) * 100) || 0
  })).sort((a, b) => b.hours - a.hours);
  
  const topTools = todayData
    .filter(s => s.category !== 'other')
    .reduce((acc, session) => {
      const existing = acc.find(t => t.domain === session.domain);
      if (existing) {
        existing.duration += session.duration;
      } else {
        acc.push({ domain: session.domain, duration: session.duration });
      }
      return acc;
    }, [])
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5)
    .map(t => ({
      ...t,
      hours: (t.duration / 3600).toFixed(1)
    }));
  
  return {
    totalHours: (totalSeconds / 3600).toFixed(1),
    sessionCount: todayData.length,
    categoryBreakdown,
    topTools,
    lastUpdated: new Date().toLocaleTimeString()
  };
}

// Initialize
loadData();