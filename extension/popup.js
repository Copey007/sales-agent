// WeekWise Popup Script

const signupScreen = document.getElementById('signupScreen');
const dashboardScreen = document.getElementById('dashboardScreen');
const emailInput = document.getElementById('emailInput');
const startBtn = document.getElementById('startBtn');
const statusIndicator = document.getElementById('statusIndicator');
const viewDashboardBtn = document.getElementById('viewDashboardBtn');

// Check if user already signed up
chrome.storage.local.get(['userEmail'], (result) => {
  if (result.userEmail) {
    showDashboard();
  } else {
    showSignup();
  }
});

// Start tracking
startBtn.addEventListener('click', () => {
  const email = emailInput.value.trim();
  
  if (!email || !email.includes('@')) {
    emailInput.style.borderColor = '#d44a9a';
    return;
  }
  
  // Send to background
  chrome.runtime.sendMessage({
    action: 'startTracking',
    email: email
  }, (response) => {
    if (response.success) {
      showDashboard();
    }
  });
});

// View full dashboard
viewDashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://weekwise.app/dashboard' });
});

function showSignup() {
  signupScreen.classList.remove('hidden');
  dashboardScreen.classList.add('hidden');
}

function showDashboard() {
  signupScreen.classList.add('hidden');
  dashboardScreen.classList.remove('hidden');
  updateStats();
  
  // Refresh stats every 30 seconds
  setInterval(updateStats, 30000);
}

function updateStats() {
  chrome.runtime.sendMessage({ action: 'getStats' }, (stats) => {
    if (!stats) return;
    
    document.getElementById('totalHours').textContent = stats.totalHours || '0.0';
    document.getElementById('sessionCount').textContent = stats.sessionCount || '0';
    
    // Update category list
    const categoryList = document.getElementById('categoryList');
    if (stats.categoryBreakdown && stats.categoryBreakdown.length > 0) {
      categoryList.innerHTML = stats.categoryBreakdown.map(cat => `
        <div class="category-row">
          <div class="category-dot ${cat.category}"></div>
          <span class="category-name">${capitalize(cat.category)}</span>
          <span class="category-time">${cat.hours}h</span>
        </div>
      `).join('');
    } else {
      categoryList.innerHTML = '<p style="color:#888;font-size:0.85rem;text-align:center;padding:1rem;">No data yet. Start browsing!</p>';
    }
    
    // Update last updated time
    if (stats.lastUpdated) {
      statusIndicator.textContent = `Updated ${stats.lastUpdated}`;
    }
  });
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}