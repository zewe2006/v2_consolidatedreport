/* ============================================
   Consolidated Report — Application Logic
   ============================================ */

// --- API Config ---
// IMPORTANT: Change this URL to your Railway backend URL after deploying.
// Example: "https://your-app-name.up.railway.app"
// For local development, use: "http://localhost:8000"
const API = "https://overflowing-ambition-production-4b7e.up.railway.app";
let authToken = null;
let currentUser = null;
let chartInstances = {};
let currentReportData = { pl: null, bs: null, cf: null };
let allCompanies = [];

// --- Theme ---
(function initTheme() {
  const dark = matchMedia("(prefers-color-scheme:dark)").matches;
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
})();

function toggleTheme() {
  const html = document.documentElement;
  const next = html.getAttribute("data-theme") === "dark" ? "light" : "dark";
  html.setAttribute("data-theme", next);
  if (authToken) loadDashboard();
}

// --- Mobile Sidebar ---
function toggleMobileSidebar() {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");
  const isOpen = sidebar.classList.contains("mobile-open");
  if (isOpen) {
    closeMobileSidebar();
  } else {
    sidebar.classList.add("mobile-open");
    backdrop.classList.add("active");
    document.body.style.overflow = "hidden";
  }
}

function closeMobileSidebar() {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");
  sidebar.classList.remove("mobile-open");
  backdrop.classList.remove("active");
  document.body.style.overflow = "";
}

// Close sidebar when a nav link is clicked on mobile
document.addEventListener("click", (e) => {
  const navLink = e.target.closest(".sidebar-nav a, .sidebar-nav button");
  if (navLink && window.innerWidth <= 768) {
    closeMobileSidebar();
  }
});

// --- Auth ---
async function doLogin() {
  const email = document.getElementById("login-email").value;
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("auth-error");
  errEl.style.display = "none";
  try {
    const res = await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Login failed");
    const data = await res.json();
    authToken = data.token;
    currentUser = data.user;
    showApp();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = "block";
  }
}

async function doSignUp() {
  const orgName = document.getElementById("signup-org-name").value.trim();
  const name = document.getElementById("signup-name").value.trim();
  const email = document.getElementById("signup-email").value.trim();
  const password = document.getElementById("signup-password").value;
  const confirm = document.getElementById("signup-confirm").value;
  const errEl = document.getElementById("auth-error");
  errEl.style.display = "none";

  if (!name || !email || !password) {
    errEl.textContent = "Please fill in all fields.";
    errEl.style.display = "block";
    return;
  }
  if (password.length < 6) {
    errEl.textContent = "Password must be at least 6 characters.";
    errEl.style.display = "block";
    return;
  }
  if (password !== confirm) {
    errEl.textContent = "Passwords do not match.";
    errEl.style.display = "block";
    return;
  }

  try {
    const res = await fetch(`${API}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name, org_name: orgName }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Registration failed");
    const data = await res.json();
    authToken = data.token;
    currentUser = data.user;
    showApp();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = "block";
  }
}

function showSignUp() {
  document.getElementById("login-form").style.display = "none";
  document.getElementById("signup-form").style.display = "block";
  document.getElementById("auth-error").style.display = "none";
}

function showLogin() {
  document.getElementById("signup-form").style.display = "none";
  document.getElementById("login-form").style.display = "block";
  document.getElementById("auth-error").style.display = "none";
}

function doLogout() {
  fetch(`${API}/api/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}` },
  }).catch(() => {});
  authToken = null;
  currentUser = null;
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("login-page").style.display = "flex";
  // Hide chat widget
  const chatWidget = document.getElementById("chat-widget");
  if (chatWidget) { chatWidget.style.display = "none"; chatOpen = false; }
}

function showApp() {
  document.getElementById("login-page").style.display = "none";
  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("user-display").textContent =
    (currentUser.name || currentUser.email) + (currentUser.role === "admin" ? " (Admin)" : " (Viewer)");
  // Show org name in sidebar brand
  const brandSub = document.querySelector(".sidebar-brand-sub");
  if (brandSub && currentUser.org_name) {
    brandSub.textContent = currentUser.org_name;
  }
  // Show/hide admin-only nav items
  const navUsers = document.getElementById("nav-users");
  if (navUsers) navUsers.style.display = currentUser.role === "admin" ? "" : "none";
  const navBilling = document.getElementById("nav-billing");
  if (navBilling) navBilling.style.display = currentUser.role === "admin" ? "" : "none";
  const navKB = document.getElementById("nav-knowledge-base");
  if (navKB) navKB.style.display = currentUser.role === "admin" ? "" : "none";
  applyRoleRestrictions();
  updateTrialBanner();
  initDefaultDates();
  loadCompanyList();
  navigateTo(location.hash.slice(1) || "dashboard");
  loadDashboard();
  // Show chat widget
  const chatWidget = document.getElementById("chat-widget");
  if (chatWidget) chatWidget.style.display = "block";
}

function applyRoleRestrictions() {
  // Hide write-action elements for viewers
  const isViewer = currentUser.role === "viewer";
  document.querySelectorAll(".admin-only").forEach((el) => {
    el.style.display = isViewer ? "none" : "";
  });
}

function updateTrialBanner() {
  const trialBanner = document.getElementById("trial-banner");
  const expiredBanner = document.getElementById("trial-expired-banner");
  if (!trialBanner || !expiredBanner || !currentUser) return;

  // Hide both by default
  trialBanner.style.display = "none";
  expiredBanner.style.display = "none";

  if (currentUser.trial_active) {
    const days = currentUser.trial_days_remaining || 0;
    const bannerText = document.getElementById("trial-banner-text");
    if (bannerText) {
      bannerText.innerHTML = `<strong>${days} day${days !== 1 ? "s" : ""} left</strong> in your free Business trial`;
    }
    trialBanner.style.display = "flex";
  } else if (currentUser.trial_expired && currentUser.plan === "free") {
    expiredBanner.style.display = "flex";
  }

  // Apply feature gating for free plan users
  applyPlanRestrictions();
}

function applyPlanRestrictions() {
  if (!currentUser) return;
  const isFree = currentUser.plan === "free" && !currentUser.trial_active;
  // Gate Business-only features: period comparison, intercompany journals, account mapping
  document.querySelectorAll(".business-only").forEach((el) => {
    if (isFree) {
      el.style.opacity = "0.5";
      el.style.pointerEvents = "none";
      el.title = "Upgrade to Business plan to use this feature";
    } else {
      el.style.opacity = "";
      el.style.pointerEvents = "";
      el.title = "";
    }
  });
}

// --- API Helpers ---
async function apiGet(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `API Error: ${res.status}`);
  }
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `API Error: ${res.status}`);
  }
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(`${API}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  return res.json();
}

// --- Company List (global) ---
async function loadCompanyList() {
  try {
    allCompanies = await apiGet("/api/companies");
    populateCompanySelectors();
  } catch {
    allCompanies = [];
  }
}

function populateCompanySelectors() {
  // Legacy single-select dropdowns (.company-selector)
  document.querySelectorAll(".company-selector").forEach((sel) => {
    const current = sel.value;
    const hasAll = sel.dataset.includeAll === "true";
    let html = "";
    if (hasAll) html += '<option value="all">All Companies (Consolidated)</option>';
    for (const c of allCompanies) {
      const dot = c.status === "connected" ? " \u2022" : "";
      html += `<option value="${c.id}">${c.name}${dot}</option>`;
    }
    sel.innerHTML = html;
    if (current) sel.value = current;
  });

  // Multi-select company checkboxes for report pages + dashboard
  ["pl", "bs", "cf", "dash"].forEach((prefix) => {
    const optionsDiv = document.getElementById(`${prefix}-company-options`);
    if (!optionsDiv) return;
    let html = '<div class="multi-opt-divider"></div>';
    for (const c of allCompanies) {
      const dotClass = c.status === "connected" ? "connected" : "disconnected";
      html += `<label class="multi-opt"><input type="checkbox" value="${c.id}" onchange="handleCompanyCheck('${prefix}')" checked> <span><i class="status-dot ${dotClass}"></i>${c.name}</span></label>`;
    }
    optionsDiv.innerHTML = html;
    updateMultiSelectLabel(prefix);
  });

  // IC dropdowns
  const srcEl = document.getElementById("ic-source-company");
  const destEl = document.getElementById("ic-dest-company");
  if (srcEl && allCompanies.length) {
    const prevSrc = srcEl.value;
    const prevDest = destEl.value;
    const opts = allCompanies.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
    srcEl.innerHTML = opts;
    destEl.innerHTML = opts;
    if (prevSrc) srcEl.value = prevSrc;
    if (prevDest) destEl.value = prevDest;
    // Auto-load accounts for the selected companies
    icAccountsCache = {};
    loadICAccountsFor("source").then(() => { if (!document.querySelectorAll("#ic-source-lines tr").length) addDefaultICLines("source"); });
    loadICAccountsFor("dest").then(() => { if (!document.querySelectorAll("#ic-dest-lines tr").length) addDefaultICLines("dest"); });
  }
}

function addDefaultICLines(side, count) {
  const n = count || 4;
  const tbody = document.getElementById(`ic-${side}-lines`);
  if (!tbody) return;
  for (let i = 0; i < n; i++) addICLine(side);
}

// --- Multi-select helpers ---
function toggleMultiSelect(prefix) {
  const dd = document.getElementById(`${prefix}-company-dropdown`);
  dd.classList.toggle("hidden");
  // Close other dropdowns
  ["pl", "bs", "cf", "dash"].forEach((p) => {
    if (p !== prefix) {
      const other = document.getElementById(`${p}-company-dropdown`);
      if (other) other.classList.add("hidden");
    }
  });
}

function handleAllToggle(prefix, el) {
  const checked = el.checked;
  const optionsDiv = document.getElementById(`${prefix}-company-options`);
  optionsDiv.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = checked; });
  updateMultiSelectLabel(prefix);
}

function handleCompanyCheck(prefix) {
  const optionsDiv = document.getElementById(`${prefix}-company-options`);
  const boxes = optionsDiv.querySelectorAll('input[type="checkbox"]');
  const allChecked = Array.from(boxes).every((cb) => cb.checked);
  const dd = document.getElementById(`${prefix}-company-dropdown`);
  const allCb = dd.querySelector('input[value="all"]');
  if (allCb) allCb.checked = allChecked;
  updateMultiSelectLabel(prefix);
}

function updateMultiSelectLabel(prefix) {
  const btn = document.getElementById(`${prefix}-company-btn`);
  const optionsDiv = document.getElementById(`${prefix}-company-options`);
  if (!btn || !optionsDiv) return;
  const boxes = optionsDiv.querySelectorAll('input[type="checkbox"]');
  const checked = Array.from(boxes).filter((cb) => cb.checked);
  if (checked.length === 0) {
    btn.textContent = "Select Companies";
  } else if (checked.length === boxes.length) {
    btn.textContent = "All Companies";
  } else if (checked.length === 1) {
    const company = allCompanies.find((c) => c.id === checked[0].value);
    btn.textContent = company ? company.name : "1 Company";
  } else {
    btn.textContent = `${checked.length} Companies`;
  }
}

function getSelectedCompanies(prefix) {
  const optionsDiv = document.getElementById(`${prefix}-company-options`);
  if (!optionsDiv) return { company_id: "all", company_ids: null };
  const boxes = optionsDiv.querySelectorAll('input[type="checkbox"]');
  const checked = Array.from(boxes).filter((cb) => cb.checked).map((cb) => cb.value);
  if (checked.length === 0 || checked.length === boxes.length) {
    return { company_id: "all", company_ids: null };
  }
  if (checked.length === 1) {
    return { company_id: checked[0], company_ids: null };
  }
  return { company_id: "all", company_ids: checked };
}

// Close dropdowns when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest(".multi-company-select")) {
    ["pl", "bs", "cf", "dash"].forEach((p) => {
      const dd = document.getElementById(`${p}-company-dropdown`);
      if (dd) dd.classList.add("hidden");
    });
  }
});

// --- Navigation ---
function navigateTo(page) {
  if (!page) page = "dashboard";
  document.querySelectorAll(".sidebar-nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === page);
  });
  document.querySelectorAll(".page-content").forEach((el) => {
    const match = el.id === `page-${page}`;
    el.classList.toggle("active", match);
    el.style.display = match ? "block" : "none";
  });
  const titles = {
    dashboard: "Dashboard",
    "profit-loss": "Profit & Loss",
    "balance-sheet": "Balance Sheet",
    "cash-flow": "Cash Flow Statement",
    intercompany: "Intercompany Journal Entries",
    companies: "Company Management",
    "account-mapping": "Account Mapping",
    users: "User Management",
    billing: "Billing & Subscription",
    "knowledge-base": "AI Knowledge Base",
    "delivery-import": "UberEats / DoorDash Import",
    receipts: "Receipts — OCR & Matching",
  };
  // Block non-admin from users page
  if (page === "users" && currentUser && currentUser.role !== "admin") {
    page = "dashboard";
  }
  document.getElementById("page-title").textContent = titles[page] || "Dashboard";
  location.hash = page;
  if (page === "companies") loadCompanies();
  if (page === "intercompany") loadICHistory();
  if (page === "account-mapping") loadAccountMappings();
  if (page === "users") loadUsers();
  if (page === "billing") loadBilling();
  if (page === "knowledge-base") loadKnowledgeBase();
  if (page === "delivery-import") diInit();
  if (page === "receipts") rcptInit();
}

window.addEventListener("hashchange", () => {
  if (authToken) navigateTo(location.hash.slice(1));
});

// --- Date Helpers ---
function initDefaultDates() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const first = `${y}-${m}-01`;
  const today = `${y}-${m}-${d}`;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set("pl-start-date", first); set("pl-end-date", today);
  set("bs-end-date", today);
  set("cf-start-date", first); set("cf-end-date", today);
  set("ic-date", today);
}

function applyDateMacro(prefix) {
  if (document.getElementById(`${prefix}-date-macro`).value) {
    const s = document.getElementById(`${prefix}-start-date`);
    const e = document.getElementById(`${prefix}-end-date`);
    if (s) s.value = "";
    if (e) e.value = "";
  }
}

// =====================================================================
//  DASHBOARD
// =====================================================================

function onDashPeriodChange() {
  const sel = document.getElementById("dash-period").value;
  document.getElementById("dash-custom-dates").style.display = sel === "custom" ? "flex" : "none";
}

async function loadDashboard() {
  const periodSel = document.getElementById("dash-period");
  const period = periodSel ? periodSel.value : "last_month";
  let url = `/api/dashboard/summary?period=${period}`;
  if (period === "custom") {
    const sd = document.getElementById("dash-start-date").value;
    const ed = document.getElementById("dash-end-date").value;
    if (sd && ed) url += `&start_date=${sd}&end_date=${ed}`;
  }
  // Company filter
  const sel = getSelectedCompanies("dash");
  if (sel.company_ids && sel.company_ids.length > 0) {
    url += `&company_ids=${sel.company_ids.join(",")}`;
  } else if (sel.company_id && sel.company_id !== "all") {
    url += `&company_ids=${sel.company_id}`;
  }

  // Show loading state on KPIs
  ["kpi-revenue", "kpi-expenses", "kpi-net-income", "kpi-assets"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "...";
  });

  try {
    const data = await apiGet(url);
    if (!data.error) {
      updateKPIs(data);
      updateCharts(data);
      // Show period label
      const lbl = document.getElementById("dash-period-label");
      if (lbl && data.period_label) lbl.textContent = data.period_label;
    }
  } catch (e) { console.warn("Dashboard error:", e); }

  // Update company badge in header
  const connectedCount = allCompanies.filter((c) => c.status === "connected").length;
  const badge = document.getElementById("company-badge");
  if (connectedCount > 0) {
    badge.textContent = `${connectedCount} Connected`;
    badge.style.display = "inline-flex";
  } else {
    badge.style.display = "none";
  }
}

function updateKPIs(data) {
  const secTotal = (rpt, grp) => {
    if (!rpt) return 0;
    try {
      for (const s of (rpt.Rows || {}).Row || [])
        if (s.group === grp && s.Summary?.ColData?.length > 1)
          return parseFloat(s.Summary.ColData[1].value) || 0;
    } catch { /* ignore */ }
    return 0;
  };
  const fmt = (n) => {
    if (!n || isNaN(n)) return "$0";
    const a = Math.abs(n);
    if (a >= 1e6) return (n < 0 ? "-" : "") + "$" + (a / 1e6).toFixed(1) + "M";
    if (a >= 1e3) return (n < 0 ? "-" : "") + "$" + (a / 1e3).toFixed(1) + "K";
    return "$" + n.toFixed(2);
  };

  const pLabel = data.period_label || "Last Month";
  const cur = data.current_pl, prior = data.prior_pl;
  const rev = secTotal(cur, "Income");
  // Expenses = Operating Expenses + COGS + Other Expenses
  // (QBO group keys: COGS and OtherExpenses — not CostOfGoodsSold / OtherExpense)
  const exp = secTotal(cur, "Expenses") + secTotal(cur, "COGS") + secTotal(cur, "OtherExpenses");
  const net = (() => {
    if (!cur) return 0;
    try {
      for (const s of (cur.Rows || {}).Row || [])
        if (s.group === "NetIncome" && s.Summary?.ColData?.length > 1)
          return parseFloat(s.Summary.ColData[1].value) || 0;
    } catch { /* */ }
    return 0;
  })();
  const priorRev = secTotal(prior, "Income");

  // Update KPI labels with period
  const rl = document.getElementById("kpi-revenue-label");
  const el2 = document.getElementById("kpi-expenses-label");
  const nl = document.getElementById("kpi-net-income-label");
  if (rl) rl.textContent = `Revenue`;
  if (el2) el2.textContent = `Expenses`;
  if (nl) nl.textContent = `Net Income`;

  document.getElementById("kpi-revenue").textContent = fmt(rev);
  document.getElementById("kpi-expenses").textContent = fmt(Math.abs(exp));
  document.getElementById("kpi-net-income").textContent = fmt(net);

  // Revenue delta vs prior period
  const revDelta = document.getElementById("kpi-revenue-delta");
  if (priorRev && rev) {
    const pct = ((rev - priorRev) / Math.abs(priorRev) * 100).toFixed(1);
    revDelta.className = `kpi-delta ${parseFloat(pct) >= 0 ? "positive" : "negative"}`;
    revDelta.textContent = `${parseFloat(pct) >= 0 ? "+" : ""}${pct}% vs prior period`;
  } else if (rev && !priorRev) {
    revDelta.className = "kpi-delta neutral";
    revDelta.textContent = "No prior period data";
  } else {
    revDelta.className = "kpi-delta neutral";
    revDelta.textContent = "";
  }

  // Expenses delta (include COGS + Other Expenses to match current-period total)
  const priorExp = secTotal(prior, "Expenses") + secTotal(prior, "COGS") + secTotal(prior, "OtherExpenses");
  const expDelta = document.getElementById("kpi-expenses-delta");
  if (priorExp && exp) {
    const pct = ((Math.abs(exp) - Math.abs(priorExp)) / Math.abs(priorExp) * 100).toFixed(1);
    expDelta.className = `kpi-delta ${parseFloat(pct) <= 0 ? "positive" : "negative"}`;
    expDelta.textContent = `${parseFloat(pct) >= 0 ? "+" : ""}${pct}% vs prior period`;
  } else {
    expDelta.className = "kpi-delta neutral";
    expDelta.textContent = "";
  }

  // Net Income delta
  const priorNet = (() => {
    if (!prior) return 0;
    try {
      for (const s of (prior.Rows || {}).Row || [])
        if (s.group === "NetIncome" && s.Summary?.ColData?.length > 1)
          return parseFloat(s.Summary.ColData[1].value) || 0;
    } catch { /* */ }
    return 0;
  })();
  const netDelta = document.getElementById("kpi-net-delta");
  if (priorNet && net) {
    const pct = ((net - priorNet) / Math.abs(priorNet) * 100).toFixed(1);
    netDelta.className = `kpi-delta ${parseFloat(pct) >= 0 ? "positive" : "negative"}`;
    netDelta.textContent = `${parseFloat(pct) >= 0 ? "+" : ""}${pct}% vs prior period`;
  } else {
    netDelta.className = "kpi-delta neutral";
    netDelta.textContent = "";
  }

  if (data.balance_sheet) {
    const ta = secTotal(data.balance_sheet, "TotalAssets") || secTotal(data.balance_sheet, "Asset");
    document.getElementById("kpi-assets").textContent = fmt(ta);
  }

  const connCount = allCompanies.filter(c => c.status === "connected").length;
  const totalCount = allCompanies.length;
  document.getElementById("kpi-companies").textContent = connCount;
  const totalEl = document.getElementById("kpi-companies-total");
  if (totalEl) totalEl.textContent = totalCount > 0 ? `of ${totalCount} total` : "No companies yet";
}

function updateCharts(data) {
  const dk = document.documentElement.getAttribute("data-theme") === "dark";
  const tc = dk ? "#cdccca" : "#28251d";
  const gc = dk ? "#393836" : "#dcd9d5";
  const colors = ["#20808D", "#A84B2F", "#1B474D", "#BCE2E7", "#944454", "#FFC553"];

  // Load real revenue trend data from API
  const rc = document.getElementById("chart-revenue");
  if (rc) {
    loadRevenueTrendChart(rc, colors, tc, gc);
  }

  const ec = document.getElementById("chart-expenses");
  if (ec) {
    if (chartInstances.expenses) chartInstances.expenses.destroy();
    const cats = extractExpenseCategories(data.current_pl);
    chartInstances.expenses = new Chart(ec, {
      type: "doughnut",
      data: { labels: cats.map((c) => c.name), datasets: [{ data: cats.map((c) => Math.abs(c.value)), backgroundColor: colors, borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { color: tc, font: { size: 12 } } } } },
    });
  }
}

async function loadRevenueTrendChart(canvas, colors, tc, gc) {
  try {
    // Build URL with company filter
    let url = "/api/dashboard/revenue-trend?months=12";
    const sel = getSelectedCompanies("dash");
    if (sel.company_ids && sel.company_ids.length > 0) {
      url += `&company_ids=${sel.company_ids.join(",")}`;
    } else if (sel.company_id && sel.company_id !== "all") {
      url += `&company_ids=${sel.company_id}`;
    }
    const trend = await apiGet(url);
    if (!trend || !trend.months) return;

    if (chartInstances.revenue) chartInstances.revenue.destroy();
    const labels = trend.months.map((m) => m.label);
    const revenueData = trend.months.map((m) => m.revenue);
    const expenseData = trend.months.map((m) => m.expenses);

    chartInstances.revenue = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Revenue",
            data: revenueData,
            borderColor: colors[0],
            backgroundColor: colors[0] + "20",
            fill: true,
            tension: 0.3,
            pointRadius: 3,
          },
          {
            label: "Expenses",
            data: expenseData,
            borderColor: colors[1],
            backgroundColor: colors[1] + "20",
            fill: true,
            tension: 0.3,
            pointRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            labels: { color: tc, font: { size: 12 }, usePointStyle: true, pointStyle: "circle" },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed.y;
                if (Math.abs(v) >= 1e6) return `${ctx.dataset.label}: $${(v / 1e6).toFixed(2)}M`;
                if (Math.abs(v) >= 1e3) return `${ctx.dataset.label}: $${(v / 1e3).toFixed(1)}K`;
                return `${ctx.dataset.label}: $${v.toFixed(2)}`;
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: tc, maxRotation: 45 }, grid: { color: gc } },
          y: {
            ticks: {
              color: tc,
              callback: (v) => {
                if (Math.abs(v) >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
                return "$" + (v / 1000).toFixed(0) + "K";
              },
            },
            grid: { color: gc },
          },
        },
      },
    });
  } catch (e) {
    console.warn("Revenue trend chart error:", e);
  }
}

function extractExpenseCategories(report) {
  const fallback = [{ name: "Cost of Goods", value: 15000 }, { name: "Payroll", value: 12000 }, { name: "Rent", value: 8000 }, { name: "Utilities", value: 3000 }, { name: "Marketing", value: 2000 }, { name: "Other", value: 5000 }];
  if (!report) return fallback;
  const cats = [];
  try {
    for (const sec of (report.Rows || {}).Row || []) {
      if (sec.group === "Expenses" || sec.group === "COGS" || sec.group === "OtherExpenses") {
        for (const row of (sec.Rows?.Row || [])) {
          if (row.type === "Section" && row.Summary) {
            const n = row.Header?.ColData?.[0]?.value || "Other";
            const v = parseFloat(row.Summary?.ColData?.[1]?.value) || 0;
            if (v) cats.push({ name: n, value: v });
          } else if (row.ColData) {
            const n = row.ColData[0]?.value || "Other";
            const v = parseFloat(row.ColData[1]?.value) || 0;
            if (v) cats.push({ name: n, value: v });
          }
        }
      }
    }
  } catch { /* fallback */ }
  return cats.length ? cats.slice(0, 8) : fallback;
}

// =====================================================================
//  REPORTS
// =====================================================================

async function loadPL() {
  const ld = document.getElementById("pl-loading");
  const wr = document.getElementById("pl-table-wrapper");
  ld.innerHTML = '<div class="loading-spinner" style="margin:0 auto;"></div><p class="mt-4">Loading Profit & Loss...</p>';
  ld.classList.remove("hidden"); wr.classList.add("hidden");

  try {
    const sel = getSelectedCompanies("pl");
    const viewEl = document.getElementById("pl-view-mode");
    const byCompany = viewEl ? viewEl.value === "by_company" : false;
    const data = await apiPost("/api/reports/profit-loss", {
      start_date: document.getElementById("pl-start-date").value || null,
      end_date: document.getElementById("pl-end-date").value || null,
      date_macro: document.getElementById("pl-date-macro").value || null,
      accounting_method: document.getElementById("pl-method").value,
      compare_prior_year: document.getElementById("pl-compare").value === "prior_year",
      compare_prior_month: document.getElementById("pl-compare").value === "prior_month",
      company_id: sel.company_id,
      company_ids: sel.company_ids,
      by_company: byCompany,
    });
    currentReportData.pl = data;
    if (byCompany && data.company_breakdowns) {
      renderByCompanyReport(data, "pl-table-wrapper");
    } else {
      renderQBOReport(data, "pl-table-wrapper");
    }
    ld.classList.add("hidden"); wr.classList.remove("hidden");
  } catch (e) { ld.innerHTML = `<p style="color:var(--color-error);">Error: ${e.message}</p>`; }
}

async function loadBS() {
  const ld = document.getElementById("bs-loading");
  const wr = document.getElementById("bs-table-wrapper");
  ld.innerHTML = '<div class="loading-spinner" style="margin:0 auto;"></div><p class="mt-4">Loading Balance Sheet...</p>';
  ld.classList.remove("hidden"); wr.classList.add("hidden");

  try {
    const sel = getSelectedCompanies("bs");
    const viewEl = document.getElementById("bs-view-mode");
    const byCompany = viewEl ? viewEl.value === "by_company" : false;
    const data = await apiPost("/api/reports/balance-sheet", {
      end_date: document.getElementById("bs-end-date").value || null,
      date_macro: document.getElementById("bs-date-macro").value || null,
      accounting_method: document.getElementById("bs-method").value,
      compare_prior_year: document.getElementById("bs-compare").value === "prior_year",
      company_id: sel.company_id,
      company_ids: sel.company_ids,
      by_company: byCompany,
    });
    currentReportData.bs = data;
    if (byCompany && data.company_breakdowns) {
      renderByCompanyReport(data, "bs-table-wrapper");
    } else {
      renderQBOReport(data, "bs-table-wrapper");
    }
    ld.classList.add("hidden"); wr.classList.remove("hidden");
  } catch (e) { ld.innerHTML = `<p style="color:var(--color-error);">Error: ${e.message}</p>`; }
}

async function loadCF() {
  const ld = document.getElementById("cf-loading");
  const wr = document.getElementById("cf-table-wrapper");
  ld.innerHTML = '<div class="loading-spinner" style="margin:0 auto;"></div><p class="mt-4">Loading Cash Flow...</p>';
  ld.classList.remove("hidden"); wr.classList.add("hidden");

  try {
    const sel = getSelectedCompanies("cf");
    const viewEl = document.getElementById("cf-view-mode");
    const byCompany = viewEl ? viewEl.value === "by_company" : false;
    const data = await apiPost("/api/reports/cash-flow", {
      start_date: document.getElementById("cf-start-date").value || null,
      end_date: document.getElementById("cf-end-date").value || null,
      date_macro: document.getElementById("cf-date-macro").value || null,
      compare_prior_year: document.getElementById("cf-compare").value === "prior_year",
      company_id: sel.company_id,
      company_ids: sel.company_ids,
      by_company: byCompany,
    });
    currentReportData.cf = data;
    if (byCompany && data.company_breakdowns) {
      renderByCompanyReport(data, "cf-table-wrapper");
    } else {
      renderQBOReport(data, "cf-table-wrapper");
    }
    ld.classList.add("hidden"); wr.classList.remove("hidden");
  } catch (e) { ld.innerHTML = `<p style="color:var(--color-error);">Error: ${e.message}</p>`; }
}

function renderQBOReport(data, wrapperId) {
  const wrapper = document.getElementById(wrapperId);
  const current = data.current;
  const priorYear = data.prior_year;
  const priorMonth = data.prior_month;
  const hasCmp = priorYear || priorMonth;
  const cmpLabel = priorYear ? "Prior Year" : priorMonth ? "Prior Month" : "";

  let top = "";
  if (data.consolidated) {
    const names = (data.companies || []).map((c) => c.name).join(", ");
    top += `<div class="consolidated-badge"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M3 7v14M21 7v14M7 7V3h10v4M7 11h2M7 15h2M15 11h2M15 15h2M11 21v-4h2v4"/></svg> Consolidated Report \u2014 ${data.companies?.length || 0} companies: ${names}</div>`;
  }
  if (data.cached_at) top += `<div class="cache-badge">Cached: ${data.cached_at}</div>`;
  if (data.message && !current) { wrapper.innerHTML = top + `<p class="text-muted" style="padding:var(--space-4);">${data.message}</p>`; return; }
  if (!current || (!current.Rows && !current.rows)) { wrapper.innerHTML = top + '<p class="text-muted" style="padding:var(--space-4);">No data returned.</p>'; return; }

  const rows = current.Rows || current.rows || {};
  const headerRow = rows.Row || [];
  const priorData = priorYear || priorMonth;
  const priorLookup = buildReportLookup(priorData);

  let html = top + '<table class="data-table"><thead><tr><th>Account</th><th class="num">Current Period</th>';
  if (hasCmp) html += `<th class="num">${cmpLabel}</th><th class="num">$ Change</th><th class="num">% Change</th>`;
  html += "</tr></thead><tbody>";
  html += renderRows(headerRow, 0, priorLookup, hasCmp);
  html += "</tbody></table>";
  wrapper.innerHTML = html;
}

function buildReportLookup(report) {
  const m = {};
  if (!report) return m;
  (function walk(arr) {
    for (const r of arr) {
      if (r.ColData) { const n = r.ColData[0]?.value; if (n) m[n] = parseFloat(r.ColData[1]?.value) || 0; }
      if (r.Summary) { const n = r.Header?.ColData?.[0]?.value || r.group || ""; const v = r.Summary.ColData?.length > 1 ? r.Summary.ColData[1]?.value : "0"; if (n) m[n] = parseFloat(v) || 0; }
      if (r.Rows?.Row) walk(r.Rows.Row);
    }
  })((report.Rows || report.rows || {}).Row || []);
  return m;
}

function renderRows(arr, depth, prior, hasCmp) {
  let h = "";
  for (const r of arr) {
    if (r.type === "Section" || r.group) {
      if (r.Header?.ColData) h += `<tr class="section-header"><td colspan="${hasCmp ? 5 : 2}">${r.Header.ColData[0]?.value || ""}</td></tr>`;
      if (r.Rows?.Row) h += renderRows(r.Rows.Row, depth + 1, prior, hasCmp);
      if (r.Summary?.ColData) {
        const n = r.Summary.ColData[0]?.value || "Total";
        const v = parseFloat(r.Summary.ColData[1]?.value) || 0;
        h += valRow(n, v, prior[r.Header?.ColData?.[0]?.value || ""] || prior[n] || 0, hasCmp, "total-row");
      }
    } else if (r.ColData) {
      const n = r.ColData[0]?.value || "";
      const v = parseFloat(r.ColData[1]?.value) || 0;
      h += valRow(n, v, prior[n] || 0, hasCmp, depth > 0 ? `indent-${Math.min(depth, 2)}` : "");
    }
  }
  return h;
}

function valRow(name, val, pv, hasCmp, cls) {
  const f = (n) => n === 0 ? "$0.00" : (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const escapedName = name.replace(/'/g, "\\'").replace(/"/g, "&quot;");
  const clickable = name && !cls.includes("total-row") && !cls.includes("section-header");
  const valHtml = clickable
    ? `<span class="drilldown-link" onclick="drillDownAccount('${escapedName}')">${f(val)}</span>`
    : f(val);
  let h = `<tr class="${cls}"><td>${name}</td><td class="num">${valHtml}</td>`;
  if (hasCmp) {
    const ch = val - pv;
    const pct = pv ? (ch / Math.abs(pv) * 100) : 0;
    const cc = ch > 0 ? "positive" : ch < 0 ? "negative" : "";
    h += `<td class="num">${f(pv)}</td><td class="num ${cc}">${ch >= 0 ? "+" : ""}${f(ch)}</td><td class="num ${cc}">${pct ? (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%" : "-"}</td>`;
  }
  return h + "</tr>";
}

// --- By Company Report Rendering ---
function renderByCompanyReport(data, wrapperId) {
  const wrapper = document.getElementById(wrapperId);
  const current = data.current;
  const breakdowns = data.company_breakdowns || {};
  const priorBreakdowns = data.company_breakdowns_prior || {};
  const companyNames = Object.keys(breakdowns);
  const priorYear = data.prior_year;
  const priorMonth = data.prior_month;
  const hasCmp = !!(priorYear || priorMonth) && Object.keys(priorBreakdowns).length > 0;
  const cmpLabel = priorYear ? "Prior Year" : priorMonth ? "Prior Month" : "";
  // Build consolidated prior lookup for Total column comparison
  const totalPriorLookup = buildReportLookup(priorYear || priorMonth);

  if (!current || (!current.Rows && !current.rows)) {
    wrapper.innerHTML = '<p class="text-muted" style="padding:var(--space-4);">No data returned.</p>';
    return;
  }

  let top = "";
  if (data.consolidated) {
    top += `<div class="consolidated-badge"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M3 7v14M21 7v14M7 7V3h10v4M7 11h2M7 15h2M15 11h2M15 15h2M11 21v-4h2v4"/></svg> By Company Report \u2014 ${companyNames.length} companies</div>`;
  }

  // Shorten company names for column headers
  const shortName = (n) => {
    return n.replace(/ (LLC|INC|Inc|inc|llc|Group)$/i, "").replace(/^Sweet Hut /, "SH ").replace(/^Food Terminal /, "FT ");
  };

  // Column count: Account + (per company: current [+ prior + $chg + %chg]) + Total [+ prior + $chg + %chg]
  const colsPerCompany = hasCmp ? 4 : 1;
  const totalCols = hasCmp ? 4 : 1;
  const colCount = 1 + (companyNames.length * colsPerCompany) + totalCols;
  const rows = current.Rows || current.rows || {};
  const headerRow = rows.Row || [];

  let html = top + '<table class="data-table by-company-table">';

  // Two-row header when comparison is active
  if (hasCmp) {
    html += "<thead>";
    // Top row: grouped headers
    html += '<tr class="by-co-group-header"><th rowspan="2" class="acct-col">Account</th>';
    for (const cn of companyNames) {
      html += `<th colspan="4" class="num co-col-group" title="${cn}">${shortName(cn)}</th>`;
    }
    html += '<th colspan="4" class="num total-col-group">Total</th></tr>';
    // Sub-header row
    html += "<tr>";
    for (let i = 0; i <= companyNames.length; i++) {
      html += `<th class="num sub-hdr">Current</th><th class="num sub-hdr">${cmpLabel}</th><th class="num sub-hdr">$ Chg</th><th class="num sub-hdr">% Chg</th>`;
    }
    html += "</tr></thead>";
  } else {
    html += '<thead><tr><th class="acct-col">Account</th>';
    for (const cn of companyNames) {
      html += `<th class="num co-col" title="${cn}">${shortName(cn)}</th>`;
    }
    html += '<th class="num total-col">Total</th></tr></thead>';
  }

  html += "<tbody>";
  html += renderByCompanyRows(headerRow, 0, breakdowns, priorBreakdowns, companyNames, colCount, hasCmp, totalPriorLookup);
  html += "</tbody></table>";
  wrapper.innerHTML = html;
}

function renderByCompanyRows(arr, depth, breakdowns, priorBreakdowns, companyNames, colCount, hasCmp, totalPriorLookup) {
  let h = "";
  const f = (n) => n === 0 ? "$0.00" : (n < 0 ? "\u2212" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fChg = (ch) => (ch >= 0 ? "+" : "") + f(ch);
  const fPct = (cur, prev) => { if (!prev) return "-"; const pct = ((cur - prev) / Math.abs(prev)) * 100; return (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%"; };
  const chgClass = (ch) => ch > 0 ? "positive" : ch < 0 ? "negative" : "";

  const renderCmpCells = (cur, prev) => {
    if (!hasCmp) return "";
    const ch = cur - prev;
    const cc = chgClass(ch);
    return `<td class="num">${f(prev)}</td><td class="num ${cc}">${fChg(ch)}</td><td class="num ${cc}">${fPct(cur, prev)}</td>`;
  };

  for (const r of arr) {
    if (r.type === "Section" || r.group) {
      // Section header
      if (r.Header?.ColData) {
        h += `<tr class="section-header"><td colspan="${colCount}">${r.Header.ColData[0]?.value || ""}</td></tr>`;
      }
      // Sub-rows
      if (r.Rows?.Row) {
        h += renderByCompanyRows(r.Rows.Row, depth + 1, breakdowns, priorBreakdowns, companyNames, colCount, hasCmp, totalPriorLookup);
      }
      // Summary / total row
      if (r.Summary?.ColData) {
        const name = r.Summary.ColData[0]?.value || "Total";
        const totalVal = parseFloat(r.Summary.ColData[1]?.value) || 0;
        const sectionName = r.Header?.ColData?.[0]?.value || "";
        const cls = "total-row";
        h += `<tr class="${cls}"><td>${name}</td>`;
        for (const cn of companyNames) {
          const cv = (breakdowns[cn] || {})[name] || (breakdowns[cn] || {})[sectionName] || 0;
          h += `<td class="num">${f(cv)}</td>`;
          if (hasCmp) {
            const pv = (priorBreakdowns[cn] || {})[name] || (priorBreakdowns[cn] || {})[sectionName] || 0;
            h += renderCmpCells(cv, pv);
          }
        }
        const totalPv = totalPriorLookup[sectionName] || totalPriorLookup[name] || 0;
        h += `<td class="num total-col-val">${f(totalVal)}</td>`;
        h += renderCmpCells(totalVal, totalPv);
        h += "</tr>";
      }
    } else if (r.ColData) {
      const name = r.ColData[0]?.value || "";
      const totalVal = parseFloat(r.ColData[1]?.value) || 0;
      const cls = depth > 0 ? `indent-${Math.min(depth, 2)}` : "";
      const escapedName = name.replace(/'/g, "\\'").replace(/"/g, "&quot;");
      h += `<tr class="${cls}"><td>${name}</td>`;
      for (const cn of companyNames) {
        const cv = (breakdowns[cn] || {})[name] || 0;
        const cvHtml = name ? `<span class="drilldown-link" onclick="drillDownAccount('${escapedName}')">${f(cv)}</span>` : f(cv);
        h += `<td class="num">${cvHtml}</td>`;
        if (hasCmp) {
          const pv = (priorBreakdowns[cn] || {})[name] || 0;
          h += renderCmpCells(cv, pv);
        }
      }
      const totalHtml = name ? `<span class="drilldown-link" onclick="drillDownAccount('${escapedName}')">${f(totalVal)}</span>` : f(totalVal);
      const totalPv = totalPriorLookup[name] || 0;
      h += `<td class="num total-col-val">${totalHtml}</td>`;
      h += renderCmpCells(totalVal, totalPv);
      h += "</tr>";
    }
  }
  return h;
}

// --- Export ---
function exportReport(type) {
  const data = currentReportData[type];
  if (!data?.current) { showToast("Run the report first.", "warning"); return; }

  // Check if this is a by-company view
  const viewEl = document.getElementById(`${type}-view-mode`);
  const isByCompany = viewEl && viewEl.value === "by_company" && data.company_breakdowns;

  if (isByCompany) {
    const breakdowns = data.company_breakdowns;
    const priorBk = data.company_breakdowns_prior || {};
    const companyNames = Object.keys(breakdowns);
    const hasCmpCsv = !!(data.prior_year || data.prior_month) && Object.keys(priorBk).length > 0;
    const cmpLbl = data.prior_year ? "Prior Year" : "Prior Month";
    const totalPrior = buildReportLookup(data.prior_year || data.prior_month);

    // Build header
    const header = ["Account"];
    for (const cn of companyNames) {
      header.push(cn);
      if (hasCmpCsv) header.push(`${cn} ${cmpLbl}`, `${cn} $ Chg`, `${cn} % Chg`);
    }
    header.push("Total");
    if (hasCmpCsv) header.push(`Total ${cmpLbl}`, "Total $ Chg", "Total % Chg");
    const rows = [header];

    const pushCmp = (row, cur, prev) => {
      if (!hasCmpCsv) return;
      const ch = cur - prev;
      const pct = prev ? ((ch / Math.abs(prev)) * 100).toFixed(1) + "%" : "-";
      row.push(String(prev), String(ch), pct);
    };

    (function walk(arr, d) {
      for (const r of arr) {
        if (r.type === "Section" || r.group) {
          if (r.Header?.ColData) {
            const row = [r.Header.ColData[0]?.value || ""];
            for (let i = 1; i < header.length; i++) row.push("");
            rows.push(row);
          }
          if (r.Rows?.Row) walk(r.Rows.Row, d + 1);
          if (r.Summary?.ColData) {
            const name = r.Summary.ColData[0]?.value || "Total";
            const totalVal = parseFloat(r.Summary.ColData[1]?.value) || 0;
            const sectionName = r.Header?.ColData?.[0]?.value || "";
            const row = ["  " + name];
            for (const cn of companyNames) {
              const cv = (breakdowns[cn] || {})[name] || (breakdowns[cn] || {})[sectionName] || 0;
              row.push(String(cv));
              if (hasCmpCsv) { const pv = (priorBk[cn] || {})[name] || (priorBk[cn] || {})[sectionName] || 0; pushCmp(row, cv, pv); }
            }
            row.push(String(totalVal));
            if (hasCmpCsv) { const tpv = totalPrior[sectionName] || totalPrior[name] || 0; pushCmp(row, totalVal, tpv); }
            rows.push(row);
          }
        } else if (r.ColData) {
          const name = r.ColData[0]?.value || "";
          const totalVal = parseFloat(r.ColData[1]?.value) || 0;
          const row = ["  ".repeat(d) + name];
          for (const cn of companyNames) {
            const cv = (breakdowns[cn] || {})[name] || 0;
            row.push(String(cv));
            if (hasCmpCsv) { const pv = (priorBk[cn] || {})[name] || 0; pushCmp(row, cv, pv); }
          }
          row.push(String(totalVal));
          if (hasCmpCsv) { const tpv = totalPrior[name] || 0; pushCmp(row, totalVal, tpv); }
          rows.push(row);
        }
      }
    })(data.current.Rows?.Row || [], 0);
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${{ pl: "ProfitAndLoss", bs: "BalanceSheet", cf: "CashFlow" }[type] || "Report"}_ByCompany_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    return;
  }

  const rows = [["Account", "Amount"]];
  (function walk(arr, d) {
    for (const r of arr) {
      if (r.type === "Section" || r.group) {
        if (r.Header?.ColData) rows.push([r.Header.ColData[0]?.value || "", ""]);
        if (r.Rows?.Row) walk(r.Rows.Row, d + 1);
        if (r.Summary?.ColData) rows.push(["  " + (r.Summary.ColData[0]?.value || "Total"), r.Summary.ColData[1]?.value || "0"]);
      } else if (r.ColData) rows.push(["  ".repeat(d) + (r.ColData[0]?.value || ""), r.ColData[1]?.value || "0"]);
    }
  })(data.current.Rows?.Row || [], 0);
  const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${{ pl: "ProfitAndLoss", bs: "BalanceSheet", cf: "CashFlow" }[type] || "Report"}_${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
}

// =====================================================================
//  TRANSACTION DETAIL DRILL-DOWN
// =====================================================================

let currentTxnDetail = null;

function _getActiveReportContext() {
  // Determine which report page is active and grab its filter values
  const pages = ["pl", "bs", "cf"];
  for (const p of pages) {
    const pageEl = document.getElementById(`page-${p === "pl" ? "profit-loss" : p === "bs" ? "balance-sheet" : "cash-flow"}`);
    if (pageEl && !pageEl.classList.contains("hidden") && pageEl.style.display !== "none") {
      const sel = getSelectedCompanies(p);
      return {
        company_id: sel.company_id,
        company_ids: sel.company_ids,
        start_date: document.getElementById(`${p}-start-date`)?.value || null,
        end_date: document.getElementById(`${p}-end-date`)?.value || null,
        date_macro: document.getElementById(`${p}-date-macro`)?.value || null,
        accounting_method: document.getElementById(`${p}-method`)?.value || "Accrual",
      };
    }
  }
  // Fallback: check location hash
  const hash = (location.hash || "").replace("#", "");
  const p = hash === "profit-loss" ? "pl" : hash === "balance-sheet" ? "bs" : hash === "cash-flow" ? "cf" : null;
  if (p) {
    const sel = getSelectedCompanies(p);
    return {
      company_id: sel.company_id,
      company_ids: sel.company_ids,
      start_date: document.getElementById(`${p}-start-date`)?.value || null,
      end_date: document.getElementById(`${p}-end-date`)?.value || null,
      date_macro: document.getElementById(`${p}-date-macro`)?.value || null,
      accounting_method: document.getElementById(`${p}-method`)?.value || "Accrual",
    };
  }
  return {};
}

async function drillDownAccount(accountName) {
  const ctx = _getActiveReportContext();
  const modal = document.getElementById("txn-detail-modal");
  const loading = document.getElementById("txn-detail-loading");
  const table = document.getElementById("txn-detail-table");

  document.getElementById("txn-detail-title").textContent = `Transaction Detail: ${accountName}`;
  document.getElementById("txn-detail-badge").textContent = `Account: ${accountName}`;
  const dm = ctx.date_macro || "";
  const sd = ctx.start_date || "";
  const ed = ctx.end_date || "";
  document.getElementById("txn-detail-date-range").textContent = dm ? dm : (sd && ed ? `${sd} to ${ed}` : "");

  loading.classList.remove("hidden");
  table.innerHTML = "";
  modal.classList.add("active");

  try {
    const data = await apiPost("/api/reports/transaction-detail", {
      account_name: accountName,
      company_id: ctx.company_id || "all",
      company_ids: ctx.company_ids || null,
      start_date: ctx.start_date || null,
      end_date: ctx.end_date || null,
      date_macro: ctx.date_macro || null,
      accounting_method: ctx.accounting_method || "Accrual",
    });
    currentTxnDetail = data;
    loading.classList.add("hidden");
    renderTransactionDetail(data);
  } catch (e) {
    loading.innerHTML = `<p style="color:var(--color-error);padding:var(--space-4);">Error loading transactions: ${e.message}</p>`;
  }
}

function renderTransactionDetail(data) {
  const el = document.getElementById("txn-detail-table");
  const txns = data.transactions || [];

  if (!txns.length) {
    el.innerHTML = '<p class="text-muted" style="padding:var(--space-6);text-align:center;">No transactions found for this account in the selected period.</p>';
    return;
  }

  // Determine columns dynamically from first txn keys (excluding "company")
  // Use a standard set of columns matching Xero-style layout
  const fmt = (v) => {
    if (!v || v === "") return "";
    const n = parseFloat(v);
    if (isNaN(n)) return v;
    return n === 0 ? "$0.00" : (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Map QBO column titles to display names
  const colMap = [
    { key: "company", label: "Company" },
    { key: "Date", label: "Date" },
    { key: "Transaction Type", label: "Type" },
    { key: "Num", label: "Ref #" },
    { key: "Name", label: "Contact" },
    { key: "Memo/Description", label: "Description" },
    { key: "Account", label: "Account" },
    { key: "Debit", label: "Debit", numeric: true },
    { key: "Credit", label: "Credit", numeric: true },
    { key: "Amount", label: "Net", numeric: true },
    { key: "Balance", label: "Balance", numeric: true },
  ];

  // Filter to columns that actually have data
  const activeCols = colMap.filter(c => txns.some(t => t[c.key] && t[c.key] !== ""));

  let html = '<table class="data-table txn-detail-table"><thead><tr>';
  for (const col of activeCols) {
    html += `<th${col.numeric ? ' class="num"' : ''}>${col.label}</th>`;
  }
  html += '</tr></thead><tbody>';

  let totalDebit = 0, totalCredit = 0, totalAmount = 0;

  for (const txn of txns) {
    html += '<tr>';
    for (const col of activeCols) {
      let val = txn[col.key] || "";
      if (col.numeric) {
        const n = parseFloat(val) || 0;
        if (col.key === "Debit") totalDebit += n;
        if (col.key === "Credit") totalCredit += n;
        if (col.key === "Amount") totalAmount += n;
        html += `<td class="num">${val ? fmt(val) : ""}</td>`;
      } else if (col.key === "Date") {
        // Format date nicely — empty dates are opening balances
        if (!val || val === "") {
          html += '<td style="white-space:nowrap;color:var(--color-text-muted);font-style:italic;">Opening Bal.</td>';
        } else {
          try {
            const d = new Date(val + "T00:00:00");
            if (isNaN(d.getTime())) { html += `<td>${val}</td>`; }
            else { html += `<td style="white-space:nowrap;">${d.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" })}</td>`; }
          } catch { html += `<td>${val}</td>`; }
        }
      } else {
        html += `<td>${val}</td>`;
      }
    }
    html += '</tr>';
  }

  // Footer totals
  html += '<tr class="total-row"><td colspan="' + activeCols.filter(c => !c.numeric).length + '" style="text-align:right;font-weight:600;">Total (' + txns.length + ' transactions)</td>';
  for (const col of activeCols) {
    if (!col.numeric) continue;
    if (col.key === "Debit") html += `<td class="num">${fmt(totalDebit)}</td>`;
    else if (col.key === "Credit") html += `<td class="num">${fmt(totalCredit)}</td>`;
    else if (col.key === "Amount") html += `<td class="num">${fmt(totalAmount)}</td>`;
    else html += '<td></td>';
  }
  html += '</tr>';

  html += '</tbody></table>';
  el.innerHTML = html;
}

function exportTransactionDetail() {
  if (!currentTxnDetail?.transactions?.length) { showToast("No data to export.", "warning"); return; }
  const txns = currentTxnDetail.transactions;
  const colMap = [
    { key: "company", label: "Company" },
    { key: "Date", label: "Date" },
    { key: "Transaction Type", label: "Type" },
    { key: "Num", label: "Ref #" },
    { key: "Name", label: "Contact" },
    { key: "Memo/Description", label: "Description" },
    { key: "Account", label: "Account" },
    { key: "Debit", label: "Debit" },
    { key: "Credit", label: "Credit" },
    { key: "Amount", label: "Net" },
    { key: "Balance", label: "Balance" },
  ];
  const activeCols = colMap.filter(c => txns.some(t => t[c.key] && t[c.key] !== ""));
  const rows = [activeCols.map(c => c.label)];
  for (const txn of txns) {
    rows.push(activeCols.map(c => txn[c.key] || ""));
  }
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `TransactionDetail_${currentTxnDetail.account_name}_${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
}

// =====================================================================
//  COMPANIES PAGE
// =====================================================================

async function loadCompanies() {
  await loadCompanyList();
  renderCompaniesTable();

  // Update wizard company count
  const countEl = document.getElementById("wizard-company-count");
  if (countEl) {
    const connected = allCompanies.filter((c) => c.status === "connected").length;
    countEl.textContent = `${allCompanies.length} companies (${connected} connected)`;
  }
}

function renderCompaniesTable() {
  const el = document.getElementById("companies-list");
  if (!allCompanies.length) {
    el.innerHTML = '<p class="text-muted" style="padding:var(--space-4);font-size:var(--text-sm);">No companies yet. Use the chooser above to add your first one.</p>';
    return;
  }
  let html = '<table class="data-table"><thead><tr><th>Company</th><th>Source</th><th>Legal Name</th><th>Status</th><th>Last Synced</th><th>Actions</th></tr></thead><tbody>';
  for (const c of allCompanies) {
    const isManual = (c.source || "qbo") === "manual";
    const srcBadge = isManual
      ? `<span class="source-badge manual">Manual + Plaid</span>`
      : `<span class="source-badge qbo">QuickBooks</span>`;

    let statusBadge, statusLabel;
    if (isManual) {
      statusBadge = "badge-success";
      statusLabel = "Active";
    } else {
      statusBadge = c.status === "connected" ? "badge-success" : c.status === "syncing" ? "badge-warning" : "badge-neutral";
      statusLabel = c.status === "connected" ? "Connected" : c.status === "syncing" ? "Syncing" : "Disconnected";
    }
    const synced = c.last_synced ? new Date(c.last_synced + "Z").toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Never";
    const safeName = c.name.replace(/'/g, "\\'");

    let actionBtns = "";
    if (isManual) {
      actionBtns = `
        <button class="btn btn-sm btn-primary" onclick="connectPlaidBank('${c.id}','${safeName}')">Connect Bank</button>
        <button class="btn btn-sm btn-secondary" onclick="showPlaidTransactions('${c.id}','${safeName}')">Transactions</button>
        <button class="btn btn-sm btn-secondary" onclick="syncPlaidCompany('${c.id}','${safeName}')">Sync</button>
        <button class="btn btn-sm btn-ghost" style="color:var(--color-error);" onclick="removeCompany('${c.id}','${safeName}')">&times;</button>`;
    } else {
      const syncBtn = c.status === "connected"
        ? `<button class="btn btn-sm btn-primary" onclick="syncSingleCompany('${c.id}','${safeName}')">Sync</button>`
        : `<button class="btn btn-sm btn-secondary" onclick="reconnectCompany('${c.id}')">Reconnect</button>`;
      actionBtns = `
        ${syncBtn}
        <button class="btn btn-sm btn-secondary" onclick="viewCompanyAccounts('${c.id}','${safeName}')">Accounts</button>
        <button class="btn btn-sm btn-ghost" style="color:var(--color-error);" onclick="removeCompany('${c.id}','${safeName}')">&times;</button>`;
    }

    html += `<tr>
      <td><strong>${c.name}</strong></td>
      <td>${srcBadge}</td>
      <td>${c.legal_name || "-"}</td>
      <td><span class="badge ${statusBadge}">${statusLabel}</span></td>
      <td class="text-muted" style="font-size:var(--text-xs);">${synced}</td>
      <td style="display:flex;gap:var(--space-2);flex-wrap:wrap;">
        ${actionBtns}
      </td>
    </tr>`;
  }
  html += "</tbody></table>";
  el.innerHTML = html;
}

// =====================================================================
//  QBO OAUTH CONNECTION WIZARD (Direct API)
// =====================================================================

// Listen for postMessage from OAuth popup callback
window.addEventListener("message", async (event) => {
  if (!event.data || !event.data.type) return;

  if (event.data.type === "qbo_auth_success") {
    // OAuth completed — company is now stored with tokens
    const companyId = event.data.company_id;
    const companyName = event.data.company_name;

    showToast(`${companyName || "Company"} connected successfully`, "success");

    // Move wizard to step 3 — sync
    setWizardStep(3);
    const sp = document.getElementById("sync-progress");
    const sr = document.getElementById("sync-result");
    const sa = document.getElementById("sync-actions");
    sp.style.display = "block";
    sr.style.display = "none";
    sa.style.display = "none";
    document.getElementById("sync-detail").textContent = `Connected: ${companyName}. Now syncing financial data...`;

    try {
      const result = await apiPost(`/api/companies/${companyId}/sync`, {});
      sp.style.display = "none";
      sr.style.display = "block";
      sa.style.display = "block";

      sr.innerHTML = `<div class="sync-success-card">
        <div style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-2);">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          <strong>${result.company_name || companyName}</strong>
          <span class="badge badge-success" style="margin-left:var(--space-2);">Synced</span>
        </div>
        <div style="font-size:var(--text-xs);color:var(--color-text-secondary);">
          ${result.reports_cached || 0} reports cached &bull; ${result.accounts_cached || 0} accounts cached<br>
          ${result.errors && result.errors.length ? "Warnings: " + result.errors.join("; ") : "No errors."}
        </div>
      </div>`;

      showToast(`${result.company_name || companyName} synced successfully`, "success");
      await loadCompanyList();
      renderCompaniesTable();
    } catch (e) {
      sp.style.display = "none";
      sr.style.display = "block";
      sa.style.display = "block";
      sr.innerHTML = `<div style="color:var(--color-error);font-size:var(--text-sm);"><strong>Sync failed:</strong> ${e.message}<br><span style="font-size:var(--text-xs);color:var(--color-text-secondary);">The company was connected but data sync failed. You can try syncing from the table below.</span></div>`;
      await loadCompanyList();
      renderCompaniesTable();
    }
  }

  if (event.data.type === "qbo_auth_error") {
    showToast("QBO connection failed: " + (event.data.error || "Unknown error"), "error");
    const cs = document.getElementById("connect-status");
    if (cs) {
      cs.style.display = "block";
      cs.innerHTML = `<span style="color:var(--color-error);">Connection failed: ${event.data.error || "Unknown error"}. Try again.</span>`;
    }
    setWizardStep(1);
    const btn = document.getElementById("connect-btn");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg> Connect QuickBooks Company';
    }
  }
});

function setWizardStep(step) {
  document.querySelectorAll(".wizard-step").forEach((el) => {
    const s = parseInt(el.dataset.step);
    el.classList.toggle("active", s === step);
    el.classList.toggle("done", s < step);
  });
  document.querySelectorAll(".wizard-panel").forEach((el) => {
    el.classList.toggle("active", el.id === `wizard-step-${step}`);
  });
}

function resetWizard() {
  setWizardStep(1);
  const cs = document.getElementById("connect-status");
  if (cs) { cs.style.display = "none"; cs.textContent = ""; }
  const sr = document.getElementById("sync-result");
  if (sr) sr.style.display = "none";
  const sa = document.getElementById("sync-actions");
  if (sa) sa.style.display = "none";
  const sp = document.getElementById("sync-progress");
  if (sp) sp.style.display = "block";
  const btn = document.getElementById("connect-btn");
  if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg> Connect QuickBooks Company'; }
}

async function startQBOConnect() {
  const btn = document.getElementById("connect-btn");
  const cs = document.getElementById("connect-status");
  btn.disabled = true;
  btn.innerHTML = '<div class="loading-spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle;"></div> Getting auth link...';
  cs.style.display = "none";

  try {
    const data = await apiPost("/api/qbo/authorize", { frontend_origin: window.location.origin + window.location.pathname.replace(/\/[^/]*$/, "") });
    if (data.auth_url) {
      window.open(data.auth_url, "qbo_auth", "width=600,height=700,scrollbars=yes");
      setWizardStep(2);
    } else {
      cs.style.display = "block";
      cs.innerHTML = '<span style="color:var(--color-error);">No auth URL returned. Check server logs.</span>';
      btn.disabled = false;
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg> Connect QuickBooks Company';
    }
  } catch (e) {
    cs.style.display = "block";
    cs.innerHTML = `<span style="color:var(--color-error);">Error: ${e.message}</span>`;
    btn.disabled = false;
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg> Connect QuickBooks Company';
  }
}

function openAuthWindow() {
  // Re-trigger a new authorize call (state is one-time-use)
  startQBOConnect();
}

// Per-company sync from companies table
async function syncSingleCompany(companyId, companyName) {
  try {
    showToast(`Syncing ${companyName}...`, "success");
    const result = await apiPost(`/api/companies/${companyId}/sync`, {});
    showToast(`${result.company_name || companyName}: ${result.reports_cached || 0} reports, ${result.accounts_cached || 0} accounts synced`, "success");
    await loadCompanyList();
    renderCompaniesTable();
  } catch (e) {
    showToast("Sync failed: " + e.message, "error");
  }
}

// Reconnect a disconnected company — start new OAuth flow
async function reconnectCompany() {
  startQBOConnect();
}

async function removeCompany(id, name) {
  if (!confirm(`Remove "${name}" and all its cached data? This cannot be undone.`)) return;
  try {
    await apiDelete(`/api/companies/${id}`);
    showToast(`${name} removed.`, "success");
    await loadCompanyList();
    renderCompaniesTable();
  } catch (e) { showToast("Error: " + e.message, "error"); }
}

async function viewCompanyAccounts(companyId, companyName) {
  const modal = document.getElementById("company-accounts-modal");
  const title = document.getElementById("company-accounts-title");
  const body = document.getElementById("company-accounts-body");
  title.textContent = `${companyName} \u2014 Chart of Accounts`;
  body.innerHTML = '<div class="loading-spinner" style="margin:var(--space-4) auto;"></div>';
  modal.classList.add("active");

  try {
    const accounts = await apiGet(`/api/accounts/cached?company_id=${companyId}`);
    if (!accounts.length) { body.innerHTML = '<p class="text-muted">No cached accounts. Sync this company first.</p>'; return; }
    const groups = {};
    for (const a of accounts) { const cls = a.classification || "Other"; if (!groups[cls]) groups[cls] = []; groups[cls].push(a); }
    let html = "";
    for (const [cls, accts] of Object.entries(groups)) {
      html += `<h4 style="margin:var(--space-4) 0 var(--space-2);font-size:var(--text-xs);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.05em;">${cls} (${accts.length})</h4>`;
      html += '<table class="data-table"><thead><tr><th>Name</th><th>Type</th><th class="num">Balance</th></tr></thead><tbody>';
      for (const a of accts) html += `<tr><td>${a.fully_qualified_name || a.name}</td><td style="font-size:var(--text-xs);">${a.account_type}</td><td class="num">$${(a.current_balance || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td></tr>`;
      html += "</tbody></table>";
    }
    body.innerHTML = html;
  } catch (e) { body.innerHTML = `<p style="color:var(--color-error);">Error: ${e.message}</p>`; }
}

function closeModal(id) { const el = document.getElementById(id); el.classList.remove("active"); el.classList.remove("open"); }

// --- Toast ---
function showToast(msg, type) {
  let c = document.getElementById("toast-container");
  if (!c) { c = document.createElement("div"); c.id = "toast-container"; c.style.cssText = "position:fixed;top:var(--space-4);right:var(--space-4);z-index:9999;display:flex;flex-direction:column;gap:var(--space-2);"; document.body.appendChild(c); }
  const t = document.createElement("div");
  const clr = { success: "var(--color-success)", error: "var(--color-error)", warning: "var(--color-warning)" };
  t.style.cssText = `background:var(--color-bg-elevated);border-left:3px solid ${clr[type] || "var(--color-accent)"};padding:var(--space-3) var(--space-4);border-radius:var(--radius-md);box-shadow:var(--shadow-lg);font-size:var(--text-sm);max-width:360px;opacity:0;transform:translateX(20px);transition:all 0.3s ease;`;
  t.textContent = msg; c.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = "1"; t.style.transform = "translateX(0)"; });
  setTimeout(() => { t.style.opacity = "0"; t.style.transform = "translateX(20px)"; setTimeout(() => t.remove(), 300); }, 4000);
}

// =====================================================================
//  INTERCOMPANY
// =====================================================================

function switchTab(group, tab) {
  document.querySelectorAll(`#page-intercompany .tab-btn`).forEach((btn) => btn.classList.toggle("active", btn.textContent.toLowerCase().includes(tab)));
  document.querySelectorAll(`[id^="${group}-tab-"]`).forEach((el) => el.classList.toggle("active", el.id === `${group}-tab-${tab}`));
  if (tab === "history") loadICHistory();
  if (tab === "templates") loadICTemplates();
}

let icHistoryEntries = []; // store for copy feature

async function loadICHistory() {
  try {
    const entries = await apiGet("/api/intercompany");
    icHistoryEntries = entries;
    const el = document.getElementById("ic-history-table");
    if (!entries.length) { el.innerHTML = '<p class="text-muted" style="padding:var(--space-4);font-size:var(--text-sm);">No intercompany entries yet.</p>'; return; }
    let html = '<table class="data-table"><thead><tr><th style="width:30px;"></th><th>Date</th><th>Source</th><th>Destination</th><th>Type</th><th class="num">Amount</th><th>Description</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
    for (const e of entries) {
      const b = e.status === "posted" ? "badge-success" : e.status === "pending" ? "badge-warning" : e.status === "partial" ? "badge-warning" : "badge-neutral";
      const copyBtn = `<button class="btn btn-sm btn-secondary" onclick="copyICEntry('${e.id}')" title="Copy to new entry">Copy</button>`;
      const editBtn = `<button class="btn btn-sm btn-secondary" onclick="editICEntry('${e.id}')" title="Edit entry">Edit</button>`;
      let actions = '';
      if (e.status === "pending" || e.status === "partial") {
        actions = `<button class="btn btn-sm btn-primary" onclick="postICEntry('${e.id}')">Post</button> ${editBtn} ${copyBtn} <button class="btn btn-sm btn-ghost" style="color:var(--color-error);" onclick="deleteICEntry('${e.id}')">&times;</button>`;
      } else {
        actions = `${copyBtn} <button class="btn btn-sm btn-ghost" style="color:var(--color-error);" onclick="deleteICEntry('${e.id}')">&times;</button>`;
      }
      const rowId = `ic-detail-${e.id}`;
      const fmtAmt = parseFloat(e.amount).toLocaleString("en-US", { minimumFractionDigits: 2 });
      const createdAt = e.created_at ? new Date(e.created_at + "Z").toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";
      const entryLabel = e.entry_type ? e.entry_type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : "-";

      html += `<tr style="cursor:pointer;" onclick="toggleICDetail('${rowId}')">`;
      html += `<td style="text-align:center;"><span class="ic-expand-icon" id="icon-${rowId}">&#9654;</span></td>`;
      html += `<td>${e.date}</td>`;
      html += `<td>${e.source_company_name || e.source_company_id}</td>`;
      html += `<td>${e.dest_company_name || e.dest_company_id}</td>`;
      html += `<td>${entryLabel}</td>`;
      html += `<td class="num">$${fmtAmt}</td>`;
      html += `<td>${e.description || "-"}</td>`;
      html += `<td><span class="badge ${b}">${e.status}</span></td>`;
      html += `<td style="display:flex;gap:var(--space-2);" onclick="event.stopPropagation();">${actions}</td>`;
      html += `</tr>`;

      // Expandable detail row
      html += `<tr class="ic-detail-row hidden" id="${rowId}"><td colspan="9" style="padding:0;">`;
      html += `<div class="ic-detail-content">`;
      html += `<div class="ic-detail-grid">`;

      // Render lines grouped by side
      for (const [side, label, jeId] of [["source", e.source_company_name || e.source_company_id, e.source_je_id], ["dest", e.dest_company_name || e.dest_company_id, e.dest_je_id]]) {
        html += `<div class="ic-detail-section">`;
        html += `<div class="ic-detail-label">${side === "source" ? "Source" : "Dest"}: ${label}</div>`;
        const sideLines = (e.lines || []).filter(l => l.side === side);
        if (sideLines.length) {
          for (const ln of sideLines) {
            html += `<div class="ic-detail-item"><span class="ic-detail-key">${ln.posting_type}:</span> ${ln.account_name} — $${parseFloat(ln.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}${ln.description ? ` <span style="color:var(--color-text-muted);font-size:var(--text-xs);">(${ln.description})</span>` : ""}</div>`;
          }
        } else {
          // Legacy fallback
          const db = side === "source" ? e.source_debit_account : e.dest_debit_account;
          const cr = side === "source" ? e.source_credit_account : e.dest_credit_account;
          if (db) html += `<div class="ic-detail-item"><span class="ic-detail-key">Debit:</span> ${db}</div>`;
          if (cr) html += `<div class="ic-detail-item"><span class="ic-detail-key">Credit:</span> ${cr}</div>`;
        }
        if (jeId) html += `<div class="ic-detail-item"><span class="ic-detail-key">QBO JE #:</span> <span class="font-mono">${jeId}</span></div>`;
        html += `</div>`;
      }

      html += `</div>`; // grid
      html += `<div class="ic-detail-meta">Created: ${createdAt} &bull; ID: <span class="font-mono">${e.id.slice(0, 8)}</span></div>`;
      html += `</div></td></tr>`;
    }
    el.innerHTML = html + "</tbody></table>";
  } catch { /* ok */ }
}

function toggleICDetail(rowId) {
  const row = document.getElementById(rowId);
  const icon = document.getElementById(`icon-${rowId}`);
  if (row) {
    row.classList.toggle("hidden");
    if (icon) icon.innerHTML = row.classList.contains("hidden") ? "&#9654;" : "&#9660;";
  }
}

async function postICEntry(entryId) {
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = "Posting..."; }
  try {
    const result = await apiPost(`/api/intercompany/${entryId}/post`, {});
    if (result.status === "posted") {
      showToast(`Journal entries posted to QBO (Source JE #${result.source_je_id || "-"}, Dest JE #${result.dest_je_id || "-"})`, "success");
    } else if (result.status === "partial") {
      showToast(`Partially posted. ${result.errors?.join("; ") || ""}`, "warning");
    }
    loadICHistory();
  } catch (e) {
    showToast("Post failed: " + e.message, "error");
    if (btn) { btn.disabled = false; btn.textContent = "Post"; }
  }
}

async function deleteICEntry(entryId) {
  if (!confirm("Delete this intercompany entry? This cannot be undone.")) return;
  try {
    await apiDelete(`/api/intercompany/${entryId}`);
    showToast("Entry deleted.", "success");
    loadICHistory();
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

// =====================================================================
//  QBO-STYLE MULTI-LINE IC ENTRY FORM
// =====================================================================
let icLineCounter = 0;

function addICLine(side, preset) {
  const tbody = document.getElementById(`ic-${side}-lines`);
  const idx = icLineCounter++;
  const lineNum = tbody.querySelectorAll("tr").length + 1;
  const tr = document.createElement("tr");
  tr.dataset.side = side;
  tr.dataset.idx = idx;

  const companyId = document.getElementById(side === "source" ? "ic-source-company" : "ic-dest-company").value;
  const accountsHtml = icAccountsCache[companyId]
    ? buildAccountOptions(icAccountsCache[companyId])
    : '<option value="">\u2014 Select company first \u2014</option>';

  const presetDebit = preset?.posting_type === "Debit" ? preset.amount || "" : "";
  const presetCredit = preset?.posting_type === "Credit" ? preset.amount || "" : "";

  tr.innerHTML = `
    <td class="ic-je-col-num">${lineNum}</td>
    <td class="ic-je-col-account">
      <select class="form-select" data-field="account_name" onchange="onLineAccountChange(this, '${side}', ${idx})">
        <option value="">\u2014 Select Account \u2014</option>
        ${accountsHtml}
      </select>
      <select class="form-select ic-line-entity hidden" data-field="entity_id" data-idx="${idx}">
        <option value="">\u2014 Select Customer/Vendor \u2014</option>
      </select>
    </td>
    <td class="ic-je-col-amount">
      <input class="form-input" type="number" step="0.01" placeholder="" data-field="debit" oninput="onJEAmountInput(this,'debit','${side}')" value="${presetDebit}">
    </td>
    <td class="ic-je-col-amount">
      <input class="form-input" type="number" step="0.01" placeholder="" data-field="credit" oninput="onJEAmountInput(this,'credit','${side}')" value="${presetCredit}">
    </td>
    <td class="ic-je-col-desc">
      <input class="form-input" type="text" placeholder="" data-field="description" value="${preset?.description || ''}">
    </td>
    <td class="ic-je-col-action">
      <button class="ic-je-line-remove" onclick="removeICLine(this, '${side}')" title="Remove line">&times;</button>
    </td>
  `;
  tbody.appendChild(tr);

  if (preset?.account_name) {
    setTimeout(() => {
      const acctSel = tr.querySelector('[data-field="account_name"]');
      if (acctSel) acctSel.value = preset.account_name;
    }, 100);
  }

  updateICBalance(side);
  return tr;
}

function onJEAmountInput(input, field, side) {
  // If user types in debit, clear credit (and vice versa) — like QBO
  const tr = input.closest("tr");
  const other = field === "debit" ? "credit" : "debit";
  const otherInput = tr.querySelector(`[data-field="${other}"]`);
  if (input.value && otherInput.value) {
    otherInput.value = "";
  }
  updateICBalance(side);
}

function removeICLine(btn, side) {
  btn.closest("tr").remove();
  renumberICLines(side);
  updateICBalance(side);
}

function renumberICLines(side) {
  const tbody = document.getElementById(`ic-${side}-lines`);
  tbody.querySelectorAll("tr").forEach((tr, i) => {
    const numCell = tr.querySelector(".ic-je-col-num");
    if (numCell) numCell.textContent = i + 1;
  });
}

function updateICBalance(side) {
  const tbody = document.getElementById(`ic-${side}-lines`);
  const rows = tbody.querySelectorAll("tr");
  let totalDebit = 0, totalCredit = 0;
  rows.forEach((tr) => {
    totalDebit += parseFloat(tr.querySelector('[data-field="debit"]')?.value) || 0;
    totalCredit += parseFloat(tr.querySelector('[data-field="credit"]')?.value) || 0;
  });

  document.getElementById(`ic-${side}-total-debit`).textContent = `$${totalDebit.toFixed(2)}`;
  document.getElementById(`ic-${side}-total-credit`).textContent = `$${totalCredit.toFixed(2)}`;

  const badge = document.getElementById(`ic-${side}-balance-badge`);
  const diff = Math.abs(totalDebit - totalCredit);
  const hasLines = rows.length > 0;
  const isBalanced = diff < 0.005 && hasLines && (totalDebit > 0 || totalCredit > 0);
  badge.className = `ic-balance-diff ${hasLines ? (isBalanced ? 'balanced' : 'unbalanced') : ''}`;
  badge.textContent = !hasLines ? '' : isBalanced ? 'Balanced' : `Off by $${diff.toFixed(2)}`;
}

function getICLines(side) {
  const tbody = document.getElementById(`ic-${side}-lines`);
  const rows = tbody.querySelectorAll("tr");
  const lines = [];
  rows.forEach((tr) => {
    const account_name = tr.querySelector('[data-field="account_name"]')?.value;
    const debitAmt = parseFloat(tr.querySelector('[data-field="debit"]')?.value) || 0;
    const creditAmt = parseFloat(tr.querySelector('[data-field="credit"]')?.value) || 0;
    const description = tr.querySelector('[data-field="description"]')?.value;
    const entitySel = tr.querySelector('[data-field="entity_id"]');
    const entity_id = entitySel && !entitySel.classList.contains("hidden") ? entitySel.value || null : null;
    if (account_name && debitAmt > 0) {
      lines.push({ side, posting_type: "Debit", account_name, amount: debitAmt, entity_id, description: description || null });
    }
    if (account_name && creditAmt > 0) {
      lines.push({ side, posting_type: "Credit", account_name, amount: creditAmt, entity_id, description: description || null });
    }
  });
  return lines;
}

function clearICLines(side, noDefaults) {
  document.getElementById(`ic-${side}-lines`).innerHTML = "";
  updateICBalance(side);
  if (!noDefaults) addDefaultICLines(side);
}

async function onLineAccountChange(selectEl, side, idx) {
  const tr = selectEl.closest("tr");
  const entitySel = tr.querySelector('[data-field="entity_id"]');
  const selectedOption = selectEl.options[selectEl.selectedIndex];
  const accountType = selectedOption?.dataset?.accountType || "";

  if (accountType === "Accounts Receivable" || accountType === "Accounts Payable") {
    entitySel.classList.remove("hidden");
    const companyId = document.getElementById(side === "source" ? "ic-source-company" : "ic-dest-company").value;
    const entityType = accountType === "Accounts Receivable" ? "customers" : "vendors";
    const cacheKey = `${companyId}_${entityType}`;
    entitySel.innerHTML = `<option value="">Loading ${entityType}...</option>`;
    try {
      let entities = icEntityCache[cacheKey];
      if (!entities) {
        entities = await apiGet(`/api/companies/${companyId}/${entityType}`);
        icEntityCache[cacheKey] = entities;
      }
      if (!entities.length) { entitySel.innerHTML = `<option value="">No ${entityType} found</option>`; return; }
      let html = `<option value="">\u2014 Select ${accountType === "Accounts Receivable" ? "Customer" : "Vendor"} \u2014</option>`;
      for (const e of entities) html += `<option value="${e.id}">${e.name}</option>`;
      entitySel.innerHTML = html;
    } catch (err) {
      entitySel.innerHTML = `<option value="">Error: ${err.message || 'Failed'}</option>`;
    }
  } else {
    entitySel.classList.add("hidden");
    entitySel.innerHTML = '<option value="">\u2014 Select Customer/Vendor \u2014</option>';
  }
}

// --- Populate form from an entry (used by copy & edit) ---
function populateICForm(e, options) {
  switchTab("ic", "new");

  if (e.source_company_id) {
    const srcEl = document.getElementById("ic-source-company");
    if (srcEl) { srcEl.value = e.source_company_id; loadICAccountsFor("source"); }
  }
  if (e.dest_company_id) {
    const destEl = document.getElementById("ic-dest-company");
    if (destEl) { destEl.value = e.dest_company_id; loadICAccountsFor("dest"); }
  }
  if (e.entry_type) {
    const typeEl = document.getElementById("ic-type");
    if (typeEl) typeEl.value = e.entry_type;
  }
  if (e.description) {
    const descEl = document.getElementById("ic-description");
    if (descEl) descEl.value = e.description;
  }

  const dateEl = document.getElementById("ic-date");
  if (options?.keepDate && e.date) {
    dateEl.value = e.date;
  } else {
    const now = new Date();
    dateEl.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  clearICLines("source", true);
  clearICLines("dest", true);

  setTimeout(() => {
    if (e.lines && e.lines.length) {
      for (const line of e.lines) {
        addICLine(line.side, { posting_type: line.posting_type, account_name: line.account_name, amount: line.amount, description: line.description || "" });
      }
    } else {
      if (e.source_debit_account) addICLine("source", { posting_type: "Debit", account_name: e.source_debit_account, amount: e.amount });
      if (e.source_credit_account) addICLine("source", { posting_type: "Credit", account_name: e.source_credit_account, amount: e.amount });
      if (e.dest_debit_account) addICLine("dest", { posting_type: "Debit", account_name: e.dest_debit_account, amount: e.amount });
      if (e.dest_credit_account) addICLine("dest", { posting_type: "Credit", account_name: e.dest_credit_account, amount: e.amount });
    }
    setTimeout(() => { updateICBalance("source"); updateICBalance("dest"); }, 300);
  }, 800);
}

function copyICEntry(entryId) {
  const e = icHistoryEntries.find((h) => h.id === entryId);
  if (!e) { showToast("Entry not found.", "error"); return; }
  icEditingId = null;
  setICFormMode("create");
  populateICForm(e, { keepDate: false });
  showToast("Copied entry to new form. Adjust as needed.", "success");
}

// --- Edit mode for pending entries ---
let icEditingId = null;

function editICEntry(entryId) {
  const e = icHistoryEntries.find((h) => h.id === entryId);
  if (!e) { showToast("Entry not found.", "error"); return; }
  icEditingId = entryId;
  setICFormMode("edit");
  populateICForm(e, { keepDate: true });
  showToast("Editing entry. Make changes and click Update.", "info");
}

function cancelICEdit() {
  icEditingId = null;
  setICFormMode("create");
  clearICLines("source");
  clearICLines("dest");
  document.getElementById("ic-description").value = "";
  document.getElementById("ic-date").value = "";
  showToast("Edit cancelled.", "info");
}

function setICFormMode(mode) {
  const submitBtn = document.getElementById("ic-submit-btn");
  const cancelBtn = document.getElementById("ic-cancel-edit-btn");
  if (mode === "edit") {
    submitBtn.textContent = "Update Entry";
    submitBtn.setAttribute("onclick", "submitICEntry()");
    cancelBtn.style.display = "";
  } else {
    submitBtn.textContent = "Create Entry";
    submitBtn.setAttribute("onclick", "submitICEntry()");
    cancelBtn.style.display = "none";
  }
}

async function submitICEntry() {
  const sourceLines = getICLines("source");
  const destLines = getICLines("dest");
  const allLines = [...sourceLines, ...destLines];

  if (!allLines.length) { showToast("Add at least one line.", "warning"); return; }
  const date = document.getElementById("ic-date").value;
  if (!date) { showToast("Select a date.", "warning"); return; }

  // Validate balance per side
  for (const [side, lines] of [["Source", sourceLines], ["Dest", destLines]]) {
    if (!lines.length) continue;
    const totalD = lines.filter(l => l.posting_type === "Debit").reduce((s, l) => s + l.amount, 0);
    const totalC = lines.filter(l => l.posting_type === "Credit").reduce((s, l) => s + l.amount, 0);
    if (Math.abs(totalD - totalC) >= 0.005) {
      showToast(`${side} side is unbalanced: Debits $${totalD.toFixed(2)} != Credits $${totalC.toFixed(2)}`, "error");
      return;
    }
  }

  const entry = {
    source_company_id: document.getElementById("ic-source-company").value,
    dest_company_id: document.getElementById("ic-dest-company").value,
    entry_type: document.getElementById("ic-type").value,
    date,
    description: document.getElementById("ic-description").value,
    lines: allLines,
  };

  try {
    if (icEditingId) {
      await apiPut(`/api/intercompany/${icEditingId}`, entry);
      showToast("Entry updated.", "success");
      icEditingId = null;
      setICFormMode("create");
    } else {
      await apiPost("/api/intercompany", entry);
      showToast("IC entry created.", "success");
    }
    clearICLines("source");
    clearICLines("dest");
    switchTab("ic", "history");
  } catch (e) { showToast("Error: " + e.message, "error"); }
}

// Keep old name as alias
async function createICEntry() { return submitICEntry(); }

async function saveAsTemplate() {
  const name = prompt("Template name:");
  if (!name) return;
  // Extract first debit/credit per side for legacy template format
  const srcLines = getICLines("source");
  const destLines = getICLines("dest");
  const srcDebit = srcLines.find(l => l.posting_type === "Debit");
  const srcCredit = srcLines.find(l => l.posting_type === "Credit");
  const destDebit = destLines.find(l => l.posting_type === "Debit");
  const destCredit = destLines.find(l => l.posting_type === "Credit");
  try {
    await apiPost("/api/intercompany/templates", {
      name,
      source_company_id: document.getElementById("ic-source-company").value,
      dest_company_id: document.getElementById("ic-dest-company").value,
      entry_type: document.getElementById("ic-type").value,
      source_debit_account: srcDebit?.account_name || "",
      source_credit_account: srcCredit?.account_name || "",
      dest_debit_account: destDebit?.account_name || "",
      dest_credit_account: destCredit?.account_name || "",
      description: document.getElementById("ic-description").value,
    });
    showToast("Template saved.", "success");
  } catch (e) { showToast("Error: " + e.message, "error"); }
}

let allTemplates = [];

async function loadICTemplates() {
  try {
    allTemplates = await apiGet("/api/intercompany/templates");
    const el = document.getElementById("ic-templates-list");
    if (!allTemplates.length) { el.innerHTML = '<p class="text-muted" style="padding:var(--space-4);font-size:var(--text-sm);">No templates yet.</p>'; return; }
    let html = '<table class="data-table"><thead><tr><th>Name</th><th>Type</th><th>Source Accounts</th><th>Dest Accounts</th><th>Description</th><th>Actions</th></tr></thead><tbody>';
    for (const t of allTemplates) {
      const typeLabel = t.entry_type ? t.entry_type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : "-";
      const srcAccts = [t.source_debit_account, t.source_credit_account].filter(Boolean).join(" / ") || "-";
      const destAccts = [t.dest_debit_account, t.dest_credit_account].filter(Boolean).join(" / ") || "-";
      html += `<tr><td><strong>${t.name}</strong></td><td>${typeLabel}</td><td style="font-size:var(--text-xs);">${srcAccts}</td><td style="font-size:var(--text-xs);">${destAccts}</td><td>${t.description || "-"}</td>`;
      html += `<td style="display:flex;gap:var(--space-2);"><button class="btn btn-sm btn-primary" onclick="useTemplate('${t.id}')">Use</button><button class="btn btn-sm btn-secondary" onclick="editTemplate('${t.id}')">Edit</button><button class="btn btn-sm btn-ghost" style="color:var(--color-error);" onclick="deleteTemplate('${t.id}')">&times;</button></td></tr>`;
    }
    el.innerHTML = html + "</tbody></table>";
  } catch { /* ok */ }
}

function useTemplate(templateId) {
  const t = allTemplates.find((tpl) => tpl.id === templateId);
  if (!t) { showToast("Template not found.", "error"); return; }

  switchTab("ic", "new");

  if (t.source_company_id) {
    const srcEl = document.getElementById("ic-source-company");
    if (srcEl) { srcEl.value = t.source_company_id; loadICAccountsFor("source"); }
  }
  if (t.dest_company_id) {
    const destEl = document.getElementById("ic-dest-company");
    if (destEl) { destEl.value = t.dest_company_id; loadICAccountsFor("dest"); }
  }
  if (t.entry_type) {
    const typeEl = document.getElementById("ic-type");
    if (typeEl) typeEl.value = t.entry_type;
  }
  if (t.description) {
    const descEl = document.getElementById("ic-description");
    if (descEl) descEl.value = t.description;
  }

  const now = new Date();
  const dateEl = document.getElementById("ic-date");
  if (dateEl) dateEl.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  clearICLines("source", true);
  clearICLines("dest", true);

  // Populate lines from template (legacy single-line templates)
  setTimeout(() => {
    if (t.source_debit_account) addICLine("source", { posting_type: "Debit", account_name: t.source_debit_account });
    if (t.source_credit_account) addICLine("source", { posting_type: "Credit", account_name: t.source_credit_account });
    if (t.dest_debit_account) addICLine("dest", { posting_type: "Debit", account_name: t.dest_debit_account });
    if (t.dest_credit_account) addICLine("dest", { posting_type: "Credit", account_name: t.dest_credit_account });
  }, 800);

  showToast(`Template "${t.name}" loaded. Set amounts and adjust as needed.`, "success");
}

async function deleteTemplate(templateId) {
  if (!confirm("Delete this template?")) return;
  try {
    await apiDelete(`/api/intercompany/templates/${templateId}`);
    showToast("Template deleted.", "success");
    loadICTemplates();
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

// --- Edit Template ---
let editTplAccountsCache = {};

async function editTemplate(templateId) {
  const t = allTemplates.find((tpl) => tpl.id === templateId);
  if (!t) { showToast("Template not found.", "error"); return; }

  document.getElementById("edit-tpl-id").value = t.id;
  document.getElementById("edit-tpl-name").value = t.name || "";
  document.getElementById("edit-tpl-type").value = t.entry_type || "";
  document.getElementById("edit-tpl-description").value = t.description || "";

  // Populate company dropdowns
  const srcSel = document.getElementById("edit-tpl-source-company");
  const destSel = document.getElementById("edit-tpl-dest-company");
  let opts = '<option value="">-- Select --</option>';
  for (const c of allCompanies.filter((co) => co.status === "connected")) {
    opts += `<option value="${c.id}">${c.name}</option>`;
  }
  srcSel.innerHTML = opts;
  destSel.innerHTML = opts;

  srcSel.value = t.source_company_id || "";
  destSel.value = t.dest_company_id || "";

  // Load accounts for selected companies, then set values
  editTplAccountsCache = {};
  await Promise.all([
    t.source_company_id ? loadEditTplAccounts("source", false) : Promise.resolve(),
    t.dest_company_id ? loadEditTplAccounts("dest", false) : Promise.resolve(),
  ]);

  // Set account values after dropdowns are populated
  setTimeout(() => {
    if (t.source_debit_account) document.getElementById("edit-tpl-source-debit").value = t.source_debit_account;
    if (t.source_credit_account) document.getElementById("edit-tpl-source-credit").value = t.source_credit_account;
    if (t.dest_debit_account) document.getElementById("edit-tpl-dest-debit").value = t.dest_debit_account;
    if (t.dest_credit_account) document.getElementById("edit-tpl-dest-credit").value = t.dest_credit_account;
  }, 100);

  // Show modal
  document.getElementById("edit-template-modal").classList.add("active");
}

async function loadEditTplAccounts(side, clear = true) {
  const companyId = document.getElementById(side === "source" ? "edit-tpl-source-company" : "edit-tpl-dest-company").value;
  const debitSel = document.getElementById(side === "source" ? "edit-tpl-source-debit" : "edit-tpl-dest-debit");
  const creditSel = document.getElementById(side === "source" ? "edit-tpl-source-credit" : "edit-tpl-dest-credit");
  const empty = '<option value="">-- Select --</option>';
  if (!companyId) {
    debitSel.innerHTML = '<option value="">-- Select company first --</option>';
    creditSel.innerHTML = '<option value="">-- Select company first --</option>';
    return;
  }

  let accounts = editTplAccountsCache[companyId];
  if (!accounts) {
    try {
      accounts = await apiGet(`/api/accounts/cached?company_id=${companyId}`);
      editTplAccountsCache[companyId] = accounts;
    } catch {
      debitSel.innerHTML = '<option value="">Error loading</option>';
      creditSel.innerHTML = '<option value="">Error loading</option>';
      return;
    }
  }

  let opts = empty;
  for (const a of accounts) {
    const indent = a.sub_account ? "\u00A0\u00A0\u00A0" : "";
    opts += `<option value="${a.name}">${indent}${a.name}</option>`;
  }
  debitSel.innerHTML = opts;
  creditSel.innerHTML = opts;
}

async function saveTemplateEdit() {
  const tid = document.getElementById("edit-tpl-id").value;
  const name = document.getElementById("edit-tpl-name").value.trim();
  if (!name) { showToast("Template name is required.", "warning"); return; }

  try {
    await apiPut(`/api/intercompany/templates/${tid}`, {
      name,
      source_company_id: document.getElementById("edit-tpl-source-company").value || null,
      dest_company_id: document.getElementById("edit-tpl-dest-company").value || null,
      entry_type: document.getElementById("edit-tpl-type").value || null,
      source_debit_account: document.getElementById("edit-tpl-source-debit").value || null,
      source_credit_account: document.getElementById("edit-tpl-source-credit").value || null,
      dest_debit_account: document.getElementById("edit-tpl-dest-debit").value || null,
      dest_credit_account: document.getElementById("edit-tpl-dest-credit").value || null,
      description: document.getElementById("edit-tpl-description").value || null,
    });
    showToast("Template updated.", "success");
    closeModal("edit-template-modal");
    loadICTemplates();
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

// --- IC Account Dropdowns ---
let icAccountsCache = {}; // keyed by companyId

async function loadICAccountsFor(side, forceRefresh) {
  // side = 'source' | 'dest'
  const companyId = document.getElementById(side === "source" ? "ic-source-company" : "ic-dest-company").value;
  if (!companyId) return;

  try {
    let accounts = forceRefresh ? null : icAccountsCache[companyId];
    if (!accounts) {
      accounts = await apiGet(`/api/companies/${companyId}/accounts`);
      icAccountsCache[companyId] = accounts;
    }
    // Update account selects in existing line rows for this side
    const container = document.getElementById(`ic-${side}-lines`);
    if (container && accounts.length) {
      const html = buildAccountOptions(accounts);
      container.querySelectorAll('[data-field="account_name"]').forEach((sel) => {
        const currentVal = sel.value;
        sel.innerHTML = '<option value="">\u2014 Select Account \u2014</option>' + html;
        if (currentVal) sel.value = currentVal;
      });
    }
  } catch (e) {
    console.error("Error loading accounts for", side, e);
  }
}

function buildAccountOptions(accounts) {
  // Group by classification
  const groups = {};
  for (const a of accounts) {
    const cls = a.classification || a.account_type || "Other";
    if (!groups[cls]) groups[cls] = [];
    groups[cls].push(a);
  }
  let html = "";
  const order = ["Asset", "Liability", "Equity", "Revenue", "Expense", "Other"];
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  for (const cls of sortedKeys) {
    html += `<optgroup label="${cls}">`;
    for (const a of groups[cls]) {
      const name = a.fully_qualified_name || a.name;
      html += `<option value="${name}" data-account-type="${a.account_type || ''}">${name} (${a.account_type || ""})</option>`;
    }
    html += "</optgroup>";
  }
  return html;
}

// --- AR/AP Entity (Customer/Vendor) Handling ---
let icEntityCache = {}; // keyed by companyId_type e.g. "uuid_customers"

async function onAccountChange(side, slot) {
  // side = 'source'|'dest', slot = 'debit'|'credit'
  const prefix = side === "source" ? "ic-src" : "ic-dest";
  const accountSel = document.getElementById(`${prefix}-${slot}`);
  const entitySel = document.getElementById(`${prefix}-${slot}-entity`);
  const selectedOption = accountSel.options[accountSel.selectedIndex];
  const accountType = selectedOption?.dataset?.accountType || "";

  if (accountType === "Accounts Receivable" || accountType === "Accounts Payable") {
    entitySel.classList.remove("hidden");
    const companyId = document.getElementById(side === "source" ? "ic-source-company" : "ic-dest-company").value;
    const entityType = accountType === "Accounts Receivable" ? "customers" : "vendors";
    const cacheKey = `${companyId}_${entityType}`;

    entitySel.innerHTML = `<option value="">Loading ${entityType}...</option>`;
    try {
      let entities = icEntityCache[cacheKey];
      if (!entities) {
        entities = await apiGet(`/api/companies/${companyId}/${entityType}`);
        icEntityCache[cacheKey] = entities;
      }
      if (!entities.length) {
        entitySel.innerHTML = `<option value="">No ${entityType} found</option>`;
        return;
      }
      let html = `<option value="">\u2014 Select ${accountType === "Accounts Receivable" ? "Customer" : "Vendor"} \u2014</option>`;
      for (const e of entities) {
        html += `<option value="${e.id}">${e.name}</option>`;
      }
      entitySel.innerHTML = html;
    } catch (err) {
      console.error(`Error loading ${entityType}:`, err);
      entitySel.innerHTML = `<option value="">Error: ${err.message || 'Failed to load'}</option>`;
    }
  } else {
    entitySel.classList.add("hidden");
    entitySel.innerHTML = '<option value="">\u2014 Select Customer/Vendor \u2014</option>';
  }
}

// =====================================================================
//  ACCOUNT MAPPING
// =====================================================================

async function loadQBOAccounts() {
  const el = document.getElementById("qbo-accounts-list");
  const companyFilter = document.getElementById("mapping-company-filter")?.value;
  el.innerHTML = '<div class="loading-spinner" style="margin:var(--space-4) auto;"></div>';
  try {
    if (companyFilter) {
      const accounts = await apiGet(`/api/accounts/cached?company_id=${companyFilter}`);
      if (!accounts.length) { el.innerHTML = '<p class="text-muted">No cached accounts. Sync this company first.</p>'; return; }
      let html = '<table class="data-table"><thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Classification</th><th class="num">Balance</th><th>Action</th></tr></thead><tbody>';
      for (const a of accounts)
        html += `<tr><td class="font-mono">${a.qbo_account_id}</td><td>${a.fully_qualified_name || a.name}</td><td>${a.account_type || "-"}</td><td>${a.classification || "-"}</td><td class="num">$${(a.current_balance || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td><td><button class="btn btn-sm btn-secondary" onclick="openMappingModal('${a.qbo_account_id}','${(a.fully_qualified_name || a.name).replace(/'/g, "\\'")}','${companyFilter}')">Map</button></td></tr>`;
      el.innerHTML = html + "</tbody></table>";
    } else {
      el.innerHTML = '<p class="text-muted">Select a company first.</p>';
    }
  } catch (e) { el.innerHTML = `<p style="color:var(--color-error);">Error: ${e.message}</p>`; }
}

function openMappingModal(accountId, accountName, companyId) {
  const cat = prompt(`Map "${accountName}" to consolidation category:\n\n(e.g., Revenue, COGS, Operating Expenses, Fixed Assets, Current Liabilities, Equity)`);
  if (!cat) return;
  const sub = prompt("Subcategory (optional):\n\n(e.g., Food Revenue, Rent, Payroll)");
  apiPost("/api/account-mappings", { company_id: companyId, qbo_account_id: accountId, qbo_account_name: accountName, consolidated_category: cat, consolidated_subcategory: sub || null })
    .then(() => { showToast("Mapping saved.", "success"); loadAccountMappings(); })
    .catch((e) => showToast("Error: " + e.message, "error"));
}

async function loadAccountMappings() {
  try {
    const mappings = await apiGet("/api/account-mappings");
    const el = document.getElementById("account-mappings-list");
    if (!mappings.length) { el.innerHTML = '<p class="text-muted" style="padding:var(--space-4);font-size:var(--text-sm);">No mappings yet.</p>'; return; }
    let html = '<table class="data-table"><thead><tr><th>Company</th><th>QBO Account</th><th>Category</th><th>Subcategory</th><th>Action</th></tr></thead><tbody>';
    for (const m of mappings)
      html += `<tr><td>${m.company_name || "-"}</td><td>${m.qbo_account_name}</td><td>${m.consolidated_category}</td><td>${m.consolidated_subcategory || "-"}</td><td><button class="btn btn-sm btn-ghost" onclick="deleteMapping('${m.id}')" style="color:var(--color-error);">Remove</button></td></tr>`;
    el.innerHTML = html + "</tbody></table>";
  } catch { /* ok */ }
}

async function deleteMapping(id) {
  try { await apiDelete(`/api/account-mappings/${id}`); loadAccountMappings(); }
  catch (e) { showToast("Error: " + e.message, "error"); }
}

// =====================================================================
//  USER MANAGEMENT
// =====================================================================

function _renderCompanyCheckboxes(containerId, selectedIds) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!allCompanies.length) {
    el.innerHTML = '<span class="text-muted" style="font-size:var(--text-sm);">No companies available. Connect a QBO company first.</span>';
    return;
  }
  const selected = new Set(selectedIds || []);
  el.innerHTML = allCompanies.map((c) =>
    `<label class="user-company-opt"><input type="checkbox" value="${c.id}"${selected.has(c.id) ? " checked" : ""}> ${c.name}</label>`
  ).join("");
}

function _getCheckedCompanyIds(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} input[type=checkbox]:checked`)).map((cb) => cb.value);
}

async function loadUsers() {
  try {
    const users = await apiGet("/api/users");
    _renderCompanyCheckboxes("new-user-companies", []);
    const el = document.getElementById("users-list");
    if (!users.length) {
      el.innerHTML = '<p class="text-muted" style="padding:var(--space-4);font-size:var(--text-sm);">No users found.</p>';
      return;
    }
    let html = '<table class="data-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Company Access</th><th>Created</th><th>Actions</th></tr></thead><tbody>';
    for (const u of users) {
      const companyNames = u.company_ids.map((cid) => {
        const c = allCompanies.find((x) => x.id === cid);
        return c ? c.name : cid;
      });
      const roleLabel = u.role === "admin"
        ? '<span class="badge badge-success">Admin</span>'
        : '<span class="badge badge-neutral">Viewer</span>';
      const accessLabel = u.role === "admin"
        ? '<span class="text-muted" style="font-size:var(--text-xs);">All (Admin)</span>'
        : (companyNames.length ? companyNames.map((n) => `<span class="badge badge-neutral" style="margin:1px;font-size:10px;">${n}</span>`).join(" ") : '<span class="text-muted" style="font-size:var(--text-xs);">None</span>');
      const isSelf = u.id === currentUser.id;
      html += `<tr>
        <td>${u.name || "-"}</td>
        <td>${u.email}</td>
        <td>${roleLabel}</td>
        <td style="max-width:260px;">${accessLabel}</td>
        <td style="font-size:var(--text-xs);white-space:nowrap;">${u.created_at ? u.created_at.split("T")[0] : "-"}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm btn-secondary" onclick='openEditUser(${JSON.stringify(u).replace(/'/g, "&apos;")})'>Edit</button>
          <button class="btn btn-sm btn-ghost" onclick="openApiTokenModal('${u.id}','${u.name || u.email}','${u.email}')" title="Manage API tokens">&#128273; Token</button>
          ${isSelf ? "" : `<button class="btn btn-sm btn-ghost" style="color:var(--color-error);" onclick="deleteUser('${u.id}','${u.email}')">Delete</button>`}
        </td>
      </tr>`;
    }
    el.innerHTML = html + "</tbody></table>";
  } catch (e) {
    showToast("Error loading users: " + e.message, "error");
  }
}

async function createNewUser() {
  const name = document.getElementById("new-user-name").value.trim();
  const email = document.getElementById("new-user-email").value.trim();
  const password = document.getElementById("new-user-password").value;
  const role = document.getElementById("new-user-role").value;
  const companyIds = _getCheckedCompanyIds("new-user-companies");
  if (!name || !email || !password) { showToast("Name, email, and password are required.", "error"); return; }
  if (password.length < 6) { showToast("Password must be at least 6 characters.", "error"); return; }
  try {
    await apiPost("/api/users", { name, email, password, role, company_ids: companyIds });
    showToast(`User "${name}" created successfully.`, "success");
    document.getElementById("new-user-name").value = "";
    document.getElementById("new-user-email").value = "";
    document.getElementById("new-user-password").value = "";
    document.getElementById("new-user-role").value = "viewer";
    loadUsers();
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

function openEditUser(u) {
  document.getElementById("edit-user-id").value = u.id;
  document.getElementById("edit-user-name").value = u.name || "";
  document.getElementById("edit-user-email").value = u.email;
  document.getElementById("edit-user-role").value = u.role;
  document.getElementById("edit-user-password").value = "";
  _renderCompanyCheckboxes("edit-user-companies", u.company_ids || []);
  document.getElementById("edit-user-modal").classList.add("open");
}

async function saveUserEdit() {
  const userId = document.getElementById("edit-user-id").value;
  const name = document.getElementById("edit-user-name").value.trim();
  const email = document.getElementById("edit-user-email").value.trim();
  const role = document.getElementById("edit-user-role").value;
  const password = document.getElementById("edit-user-password").value;
  const companyIds = _getCheckedCompanyIds("edit-user-companies");
  if (!name || !email) { showToast("Name and email are required.", "error"); return; }
  const body = { name, email, role, company_ids: companyIds };
  if (password) body.password = password;
  try {
    const updated = await apiPut(`/api/users/${userId}`, body);
    showToast(`User "${updated.name}" updated.`, "success");
    closeModal("edit-user-modal");
    // If user edited themselves, update currentUser
    if (userId === currentUser.id) {
      currentUser.name = updated.name;
      currentUser.email = updated.email;
      currentUser.role = updated.role;
      currentUser.company_ids = updated.company_ids;
      document.getElementById("user-display").textContent =
        (currentUser.name || currentUser.email) + (currentUser.role === "admin" ? " (Admin)" : " (Viewer)");
    }
    loadUsers();
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

async function deleteUser(userId, email) {
  if (!confirm(`Delete user "${email}"? This cannot be undone.`)) return;
  try {
    await apiDelete(`/api/users/${userId}`);
    showToast(`User "${email}" deleted.`, "success");
    loadUsers();
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

// --- API Token Management ---
let apiTokenCurrentUserId = null;

async function openApiTokenModal(userId, name, email) {
  apiTokenCurrentUserId = userId;
  document.getElementById("api-token-user-info").innerHTML =
    `<strong>${name}</strong> &middot; ${email}`;
  document.getElementById("api-token-new-container").style.display = "none";
  document.getElementById("api-token-value").value = "";
  document.getElementById("api-token-copy-btn").textContent = "Copy";
  document.getElementById("api-token-modal").classList.add("open");
  await loadApiTokenSessions();
}

async function loadApiTokenSessions() {
  const listEl = document.getElementById("api-token-sessions-list");
  listEl.innerHTML = '<span style="color:var(--color-text-tertiary);">Loading...</span>';
  try {
    const data = await apiGet(`/api/users/${apiTokenCurrentUserId}/sessions`);
    if (!data.sessions || data.sessions.length === 0) {
      listEl.innerHTML = '<span style="color:var(--color-text-tertiary);font-size:var(--text-xs);">No active tokens.</span>';
      return;
    }
    listEl.innerHTML = data.sessions.map(s =>
      `<div style="padding:6px 10px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-sm);margin-bottom:4px;font-family:monospace;font-size:var(--text-xs);">${s.token_preview}</div>`
    ).join("");
  } catch (e) {
    listEl.innerHTML = `<span style="color:var(--color-error);font-size:var(--text-xs);">Error: ${e.message}</span>`;
  }
}

async function generateApiToken() {
  if (!apiTokenCurrentUserId) return;
  try {
    const data = await apiPost(`/api/users/${apiTokenCurrentUserId}/generate-token`, {});
    document.getElementById("api-token-value").value = data.token;
    document.getElementById("api-token-new-container").style.display = "block";
    document.getElementById("api-token-copy-btn").textContent = "Copy";
    showToast("New API token generated.", "success");
    await loadApiTokenSessions();
  } catch (e) {
    showToast("Error generating token: " + e.message, "error");
  }
}

async function copyApiToken() {
  const input = document.getElementById("api-token-value");
  const btn = document.getElementById("api-token-copy-btn");
  try {
    await navigator.clipboard.writeText(input.value);
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  } catch {
    input.select();
    document.execCommand("copy");
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  }
}

async function revokeAllApiTokens() {
  if (!apiTokenCurrentUserId) return;
  const isSelf = apiTokenCurrentUserId === currentUser.id;
  const warn = isSelf
    ? "Revoke ALL your tokens? This will log you out immediately. Continue?"
    : "Revoke ALL API tokens for this user? Any integrations using these tokens will stop working.";
  if (!confirm(warn)) return;
  try {
    const data = await apiDelete(`/api/users/${apiTokenCurrentUserId}/sessions`);
    showToast(`Revoked ${data.revoked} token(s).`, "success");
    if (isSelf) {
      // Log out self
      authToken = null;
      currentUser = null;
      location.reload();
      return;
    }
    await loadApiTokenSessions();
    document.getElementById("api-token-new-container").style.display = "none";
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

// =====================================================================
//  BILLING
// =====================================================================

async function loadBilling() {
  try {
    const res = await fetch(`${API}/api/billing/subscription`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) throw new Error("Failed to load billing");
    const data = await res.json();

    const planName = document.getElementById("billing-plan-name");
    const planPrice = document.getElementById("billing-plan-price");
    const planStatus = document.getElementById("billing-plan-status");
    const compLimit = document.getElementById("billing-company-limit");
    const compUsage = document.getElementById("billing-company-usage");
    const upgradeCard = document.getElementById("billing-upgrade-card");
    const manageCard = document.getElementById("billing-manage-card");

    if (data.trial_active) {
      // Active trial
      planName.textContent = "Business (Trial)";
      planPrice.textContent = "Free for " + data.trial_days_remaining + " more day" + (data.trial_days_remaining !== 1 ? "s" : "");
      planStatus.innerHTML = '<span style="display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600;background:#dbeafe;color:#1a56db;">&#9200; Trial Active</span>';
      upgradeCard.style.display = "block";
      manageCard.style.display = "none";
    } else if (data.plan === "business" && data.subscription_status === "active") {
      planName.textContent = "Business";
      planPrice.textContent = "$49 / month";
      const statusText = data.subscription_status === "active" ? "Active" : data.subscription_status === "past_due" ? "Past Due" : data.subscription_status;
      const statusColor = data.subscription_status === "active" ? "#059669" : "#dc2626";
      planStatus.innerHTML = `<span style="display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600;background:${statusColor}15;color:${statusColor};">${statusText}</span>`;
      upgradeCard.style.display = "none";
      manageCard.style.display = "block";
    } else {
      planName.textContent = "Starter";
      planPrice.textContent = "Free";
      const expiredNote = data.trial_expired ? ' <span style="font-size:11px;color:#dc2626;">(trial ended)</span>' : '';
      planStatus.innerHTML = '<span style="display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600;background:#dbeafe;color:#1d4ed8;">Free Plan</span>' + expiredNote;
      upgradeCard.style.display = "block";
      manageCard.style.display = "none";
    }

    compLimit.textContent = data.max_companies + " companies";
    // Count connected companies
    try {
      const compRes = await fetch(`${API}/api/companies`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (compRes.ok) {
        const companies = await compRes.json();
        const connected = companies.filter(c => c.status === "connected").length;
        compUsage.textContent = `${connected} connected of ${data.max_companies} max`;
      }
    } catch (e) { /* ignore */ }
  } catch (err) {
    console.error("loadBilling error:", err);
    document.getElementById("billing-plan-name").textContent = "Error loading";
  }
}

async function startCheckout() {
  const btn = document.getElementById("btn-upgrade");
  btn.disabled = true;
  btn.textContent = "Redirecting...";
  try {
    const res = await fetch(`${API}/api/billing/create-checkout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.detail || "Failed to create checkout session");
      btn.disabled = false;
      btn.textContent = "Upgrade Now";
      return;
    }
    const data = await res.json();
    window.location.href = data.checkout_url;
  } catch (err) {
    alert("Error: " + err.message);
    btn.disabled = false;
    btn.textContent = "Upgrade Now";
  }
}

async function openBillingPortal() {
  try {
    const res = await fetch(`${API}/api/billing/portal`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.detail || "Failed to open billing portal");
      return;
    }
    const data = await res.json();
    window.open(data.portal_url, "_blank");
  } catch (err) {
    alert("Error: " + err.message);
  }
}

// Check for billing success/cancel in URL
(function checkBillingReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("billing") === "success") {
    setTimeout(() => {
      alert("Subscription activated! Welcome to the Business plan.");
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
      if (authToken) loadBilling();
    }, 500);
  } else if (params.get("billing") === "canceled") {
    setTimeout(() => {
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    }, 100);
  }
})();

// --- Init ---
document.getElementById("login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
document.getElementById("login-email").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

// =====================================================================
//  AI CHAT ASSISTANT
// =====================================================================

let chatOpen = false;
let chatConversation = []; // {role, content}

function toggleChat() {
  chatOpen = !chatOpen;
  const win = document.getElementById("chat-window");
  const iconOpen = document.getElementById("chat-icon-open");
  const iconClose = document.getElementById("chat-icon-close");
  win.style.display = chatOpen ? "flex" : "none";
  iconOpen.style.display = chatOpen ? "none" : "block";
  iconClose.style.display = chatOpen ? "block" : "none";
  if (chatOpen) {
    document.getElementById("chat-input").focus();
    const msgs = document.getElementById("chat-messages");
    msgs.scrollTop = msgs.scrollHeight;
  }
}

function clearChat() {
  chatConversation = [];
  const msgs = document.getElementById("chat-messages");
  msgs.innerHTML = `<div class="chat-msg assistant">
    <div style="background:var(--color-bg-muted);padding:10px 14px;border-radius:12px 12px 12px 4px;font-size:13px;line-height:1.5;max-width:85%;color:var(--color-text-primary);">
      Hi! I can help you with:<br>
      <strong>&#8226;</strong> Create intercompany journal entries<br>
      <strong>&#8226;</strong> Pull P&L, Balance Sheet, or Cash Flow reports<br>
      <strong>&#8226;</strong> Analyze financial data across companies<br>
      <strong>&#8226;</strong> Navigate the app<br><br>
      What would you like to do?
    </div>
  </div>`;
}

function appendChatMsg(role, html) {
  const msgs = document.getElementById("chat-messages");
  const align = role === "user" ? "flex-end" : "flex-start";
  const bg = role === "user" ? "#1a56db" : "var(--color-bg-muted)";
  const color = role === "user" ? "white" : "var(--color-text-primary)";
  const radius = role === "user" ? "12px 12px 4px 12px" : "12px 12px 12px 4px";
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  div.style.cssText = `display:flex;justify-content:${align};`;
  div.innerHTML = `<div style="background:${bg};color:${color};padding:10px 14px;border-radius:${radius};font-size:13px;line-height:1.5;max-width:85%;word-wrap:break-word;">${html}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function showChatTyping() {
  const msgs = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.id = "chat-typing";
  div.className = "chat-msg assistant";
  div.innerHTML = `<div style="background:var(--color-bg-muted);padding:10px 14px;border-radius:12px 12px 12px 4px;font-size:13px;color:var(--color-text-secondary);">
    <span style="display:inline-flex;gap:4px;"><span class="typing-dot">&#9679;</span><span class="typing-dot" style="animation-delay:0.2s;">&#9679;</span><span class="typing-dot" style="animation-delay:0.4s;">&#9679;</span></span>
  </div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function removeChatTyping() {
  const el = document.getElementById("chat-typing");
  if (el) el.remove();
}

async function sendChat() {
  const input = document.getElementById("chat-input");
  const msg = input.value.trim();
  if (!msg) return;
  input.value = "";

  // Show user message
  appendChatMsg("user", escapeHtml(msg));
  chatConversation.push({ role: "user", content: msg });

  // Show typing indicator
  showChatTyping();
  const sendBtn = document.getElementById("chat-send-btn");
  sendBtn.disabled = true;

  try {
    const res = await fetch(`${API}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ message: msg, conversation: chatConversation.slice(-10) }),
    });

    removeChatTyping();

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      appendChatMsg("assistant", `<span style="color:var(--color-error);">${escapeHtml(err.detail || "Something went wrong. Please try again.")}</span>`);
      sendBtn.disabled = false;
      return;
    }

    const data = await res.json();
    const reply = data.reply;
    chatConversation.push({ role: "assistant", content: reply });

    // Parse and render the reply, handling action blocks
    const rendered = renderChatReply(reply);
    appendChatMsg("assistant", rendered);

  } catch (e) {
    removeChatTyping();
    appendChatMsg("assistant", `<span style="color:var(--color-error);">Connection error. Please try again.</span>`);
  }

  sendBtn.disabled = false;
  input.focus();
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function renderChatReply(reply) {
  // Parse action blocks
  let html = reply;

  // Handle ```action:create_je blocks
  html = html.replace(/```action:create_je\n([\s\S]*?)```/g, (match, json) => {
    try {
      const je = JSON.parse(json.trim());
      return `<div style="margin:8px 0;padding:10px;background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:8px;">
        <div style="font-weight:600;font-size:12px;color:var(--color-accent);margin-bottom:6px;">&#9998; Journal Entry Ready</div>
        <div style="font-size:12px;margin-bottom:4px;"><strong>Type:</strong> ${escapeHtml(je.entry_type || '')}</div>
        <div style="font-size:12px;margin-bottom:4px;"><strong>Amount:</strong> $${(je.amount || 0).toLocaleString()}</div>
        <div style="font-size:12px;margin-bottom:4px;"><strong>Date:</strong> ${escapeHtml(je.date || '')}</div>
        <div style="font-size:12px;margin-bottom:8px;"><strong>Description:</strong> ${escapeHtml(je.description || '')}</div>
        <button onclick='executeChatJE(${escapeHtml(JSON.stringify(json.trim()))})' style="padding:6px 14px;background:#1a56db;color:white;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">Create This Entry</button>
      </div>`;
    } catch (e) {
      return `<pre style="font-size:11px;overflow-x:auto;">${escapeHtml(json)}</pre>`;
    }
  });

  // Handle ```action:show_report blocks
  html = html.replace(/```action:show_report\n([\s\S]*?)```/g, (match, json) => {
    try {
      const rpt = JSON.parse(json.trim());
      const label = { "profit-loss": "P&L", "balance-sheet": "Balance Sheet", "cash-flow": "Cash Flow" }[rpt.report_type] || rpt.report_type;
      return `<div style="margin:8px 0;">
        <button onclick='executeChatReport(${escapeHtml(JSON.stringify(json.trim()))})' style="padding:8px 16px;background:var(--color-accent);color:white;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">&#128202; Open ${escapeHtml(label)} Report</button>
      </div>`;
    } catch (e) {
      return match;
    }
  });

  // Handle ```action:navigate blocks
  html = html.replace(/```action:navigate\n([\s\S]*?)```/g, (match, json) => {
    try {
      const nav = JSON.parse(json.trim());
      return `<div style="margin:8px 0;">
        <button onclick="navigateTo('${escapeHtml(nav.page)}')" style="padding:8px 16px;background:var(--color-accent);color:white;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">&#8594; Go to ${escapeHtml(nav.page)}</button>
      </div>`;
    } catch (e) {
      return match;
    }
  });

  // Convert markdown bold
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  // Convert newlines to <br>
  html = html.replace(/\n/g, "<br>");

  return html;
}

async function executeChatJE(jsonStr) {
  try {
    const je = JSON.parse(jsonStr);
    const res = await fetch(`${API}/api/intercompany`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(je),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      appendChatMsg("assistant", `<span style="color:var(--color-error);">Failed to create entry: ${escapeHtml(err.detail || "Unknown error")}</span>`);
      return;
    }
    const data = await res.json();
    appendChatMsg("assistant", `<div style="color:var(--color-success);font-weight:600;">&#10003; Journal entry created successfully! (ID: ${data.id.slice(0,8)}...)</div><div style="margin-top:4px;"><button onclick="navigateTo('intercompany')" style="padding:6px 14px;background:var(--color-accent);color:white;border:none;border-radius:6px;font-size:12px;cursor:pointer;">View in Journal Entries</button></div>`);
  } catch (e) {
    appendChatMsg("assistant", `<span style="color:var(--color-error);">Error: ${escapeHtml(e.message)}</span>`);
  }
}

function executeChatReport(jsonStr) {
  try {
    const rpt = JSON.parse(jsonStr);
    const pageMap = { "profit-loss": "profit-loss", "balance-sheet": "balance-sheet", "cash-flow": "cash-flow" };
    const page = pageMap[rpt.report_type] || "profit-loss";
    navigateTo(page);
    // Could also pre-fill date selectors here in future
  } catch (e) {
    console.error("executeChatReport error:", e);
  }
}

// Add typing animation CSS
(function addChatStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .typing-dot { animation: typingBounce 1.2s infinite; font-size: 8px; }
    @keyframes typingBounce { 0%,60%,100% { opacity: 0.3; } 30% { opacity: 1; } }
    #chat-widget { display: none; }
    @media (max-width: 640px) {
      #chat-window { width: calc(100vw - 20px) !important; right: -10px !important; height: calc(100vh - 140px) !important; bottom: 65px !important; }
    }
    .kb-entry-card { border: 1.5px solid var(--color-border); border-radius: var(--radius-lg); padding: 16px; margin-bottom: 12px; transition: border-color 0.15s; }
    .kb-entry-card:hover { border-color: var(--color-primary); }
    .kb-entry-card.disabled { opacity: 0.5; }
    .kb-entry-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
    .kb-entry-title { font-weight: 600; font-size: var(--text-base); }
    .kb-entry-category { font-size: var(--text-xs); color: white; background: var(--color-primary); padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
    .kb-entry-category.cat-accounting_rules { background: #059669; }
    .kb-entry-category.cat-app_guide { background: #2563eb; }
    .kb-entry-category.cat-general { background: #6b7280; }
    .kb-entry-content { font-size: var(--text-sm); color: var(--color-text-muted); white-space: pre-wrap; line-height: 1.5; max-height: 80px; overflow: hidden; position: relative; }
    .kb-entry-content.expanded { max-height: none; }
    .kb-entry-actions { display: flex; gap: 6px; margin-top: 10px; }
    .kb-filter.active { background: var(--color-primary); color: white; }
  `;
  document.head.appendChild(style);
})();


// =====================================================================
//  KNOWLEDGE BASE
// =====================================================================

let kbEntries = [];
let kbFilterCat = "all";

async function loadKnowledgeBase() {
  const container = document.getElementById("kb-entries-list");
  container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--color-text-muted);">Loading...</div>';
  try {
    const resp = await fetch(`${API}/api/knowledge-base`, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!resp.ok) throw new Error("Failed to load");
    kbEntries = await resp.json();
    renderKBEntries();
  } catch (err) {
    container.innerHTML = '<div style="padding:40px;text-align:center;color:#ef4444;">Failed to load knowledge base.</div>';
    console.error("loadKnowledgeBase error:", err);
  }
}

function renderKBEntries() {
  const container = document.getElementById("kb-entries-list");
  const filtered = kbFilterCat === "all" ? kbEntries : kbEntries.filter(e => e.category === kbFilterCat);
  
  if (filtered.length === 0) {
    container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--color-text-muted);">No entries found. Click "+ Add Entry" to create one.</div>';
    return;
  }

  const catLabels = { accounting_rules: "Accounting Rules", app_guide: "App Guide", general: "General" };
  container.innerHTML = filtered.map(e => `
    <div class="kb-entry-card ${e.enabled ? '' : 'disabled'}" data-id="${e.id}">
      <div class="kb-entry-header">
        <div style="flex:1;">
          <span class="kb-entry-category cat-${e.category}">${catLabels[e.category] || e.category}</span>
          <div class="kb-entry-title" style="margin-top:6px;">${escapeHtml(e.title)}</div>
        </div>
        ${!e.enabled ? '<span style="font-size:var(--text-xs);color:#ef4444;font-weight:500;">Disabled</span>' : ''}
      </div>
      <div class="kb-entry-content" id="kb-content-${e.id}">${escapeHtml(e.content)}</div>
      <div class="kb-entry-actions">
        <button class="btn btn-outline btn-sm" onclick="toggleKBContent('${e.id}')" style="font-size:var(--text-xs);">Show More</button>
        <button class="btn btn-outline btn-sm" onclick="editKBEntry('${e.id}')" style="font-size:var(--text-xs);">Edit</button>
        <button class="btn btn-outline btn-sm" onclick="toggleKBEnabled('${e.id}', ${e.enabled ? 'false' : 'true'})" style="font-size:var(--text-xs);">${e.enabled ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-outline btn-sm" onclick="deleteKBEntry('${e.id}')" style="font-size:var(--text-xs);color:#ef4444;border-color:#ef4444;">Delete</button>
      </div>
    </div>
  `).join("");
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function filterKB(cat) {
  kbFilterCat = cat;
  document.querySelectorAll(".kb-filter").forEach(b => b.classList.toggle("active", b.dataset.cat === cat));
  renderKBEntries();
}

function toggleKBContent(id) {
  const el = document.getElementById(`kb-content-${id}`);
  if (el) el.classList.toggle("expanded");
}

function openKBModal(entry = null) {
  document.getElementById("kb-entry-id").value = entry ? entry.id : "";
  document.getElementById("kb-modal-title").textContent = entry ? "Edit Knowledge Entry" : "Add Knowledge Entry";
  document.getElementById("kb-category").value = entry ? entry.category : "general";
  document.getElementById("kb-title").value = entry ? entry.title : "";
  document.getElementById("kb-content").value = entry ? entry.content : "";
  document.getElementById("kb-enabled").checked = entry ? entry.enabled : true;
  const modal = document.getElementById("kb-modal");
  modal.classList.add("active", "open");
}

function editKBEntry(id) {
  const entry = kbEntries.find(e => e.id === id);
  if (entry) openKBModal(entry);
}

async function saveKBEntry() {
  const id = document.getElementById("kb-entry-id").value;
  const data = {
    category: document.getElementById("kb-category").value,
    title: document.getElementById("kb-title").value.trim(),
    content: document.getElementById("kb-content").value.trim(),
    enabled: document.getElementById("kb-enabled").checked,
  };
  if (!data.title || !data.content) {
    alert("Title and content are required.");
    return;
  }
  try {
    const url = id ? `${API}/api/knowledge-base/${id}` : `${API}/api/knowledge-base`;
    const method = id ? "PUT" : "POST";
    const resp = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(data),
    });
    if (!resp.ok) throw new Error("Failed to save");
    closeModal("kb-modal");
    loadKnowledgeBase();
  } catch (err) {
    alert("Error saving entry: " + err.message);
    console.error("saveKBEntry error:", err);
  }
}

async function toggleKBEnabled(id, enabled) {
  try {
    const resp = await fetch(`${API}/api/knowledge-base/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ enabled }),
    });
    if (!resp.ok) throw new Error("Failed to update");
    loadKnowledgeBase();
  } catch (err) {
    alert("Error updating entry.");
    console.error("toggleKBEnabled error:", err);
  }
}

async function deleteKBEntry(id) {
  if (!confirm("Are you sure you want to delete this knowledge entry?")) return;
  try {
    const resp = await fetch(`${API}/api/knowledge-base/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!resp.ok) throw new Error("Failed to delete");
    loadKnowledgeBase();
  } catch (err) {
    alert("Error deleting entry.");
    console.error("deleteKBEntry error:", err);
  }
}

/* ============================================
   DELIVERY IMPORT (Uber Eats / DoorDash)
   ============================================ */

let diParsedData = null;   // holds parsed response from /api/delivery-import/parse
let diCsvContent = "";     // the raw CSV string for download
let diEntries = [];        // array of journal entry rows for preview

/** Initialise the delivery import page each time it's shown. */
function diInit() {
  const sel = document.getElementById("di-company");
  if (!sel) return;
  // Populate company dropdown with connected companies
  const connected = allCompanies.filter(c => c.status === "connected");
  sel.innerHTML = connected.length
    ? connected.map(c => `<option value="${c.id}">${c.name}</option>`).join("")
    : '<option value="" disabled>No connected companies</option>';

  // Reset to step 1
  diResetUpload();
  _diSetupDragDrop();
  // Load history
  diLoadHistory();
}

/** Wire up drag-and-drop + click-to-browse on the dropzone. */
function _diSetupDragDrop() {
  const dz = document.getElementById("di-dropzone");
  const fi = document.getElementById("di-file-input");
  if (!dz || !fi) return;
  // Remove old listeners by cloning
  const freshDz = dz.cloneNode(true);
  dz.parentNode.replaceChild(freshDz, dz);
  const freshFi = freshDz.querySelector("#di-file-input") || document.getElementById("di-file-input");

  freshDz.addEventListener("click", () => freshFi.click());
  freshDz.addEventListener("dragover", (e) => { e.preventDefault(); freshDz.style.borderColor = "var(--color-primary)"; freshDz.style.background = "var(--color-primary-bg)"; });
  freshDz.addEventListener("dragleave", () => { freshDz.style.borderColor = "var(--color-border)"; freshDz.style.background = ""; });
  freshDz.addEventListener("drop", (e) => {
    e.preventDefault();
    freshDz.style.borderColor = "var(--color-border)";
    freshDz.style.background = "";
    const file = e.dataTransfer.files[0];
    if (file) _diUploadFile(file);
  });
  freshFi.addEventListener("change", (e) => {
    if (e.target.files[0]) _diUploadFile(e.target.files[0]);
  });
}

/** Upload the selected PDF to the parse endpoint. */
async function _diUploadFile(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    _diShowStatus("Only PDF files are supported.", true);
    return;
  }
  const companyId = document.getElementById("di-company").value;
  if (!companyId) {
    _diShowStatus("Please select a company first.", true);
    return;
  }

  _diShowStatus("Uploading and parsing PDF...", false, true);

  const form = new FormData();
  form.append("file", file);

  try {
    const resp = await fetch(`${API}/api/delivery-import/parse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: form,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to parse PDF");
    }
    diParsedData = await resp.json();
    _diShowStatus(`Detected <strong>${diParsedData.platform === "ubereats" ? "Uber Eats" : "DoorDash"}</strong> statement — ${diParsedData.payouts.length} payout(s) found.`, false);

    // Move to mapping step
    await _diShowMappingStep();
  } catch (err) {
    _diShowStatus(err.message, true);
    console.error("Delivery import parse error:", err);
  }
}

/** Show a status message below the dropzone. */
function _diShowStatus(msg, isError, isLoading) {
  const el = document.getElementById("di-upload-status");
  el.style.display = "block";
  el.style.background = isError ? "var(--color-danger-bg, #fef2f2)" : "var(--color-success-bg, #f0fdf4)";
  el.style.color = isError ? "var(--color-danger, #dc2626)" : "var(--color-success, #16a34a)";
  if (isLoading) {
    el.style.background = "var(--color-info-bg, #eff6ff)";
    el.style.color = "var(--color-info, #2563eb)";
  }
  el.innerHTML = (isLoading ? '<span class="loading-spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:8px;"></span>' : "") + msg;
}

/** Populate and show the mapping step. */
async function _diShowMappingStep() {
  const platform = diParsedData.platform;
  const companyId = document.getElementById("di-company").value;

  // Set header label
  const label = document.getElementById("di-platform-label");
  label.textContent = platform === "ubereats" ? "Uber Eats Statement" : "DoorDash Statement";
  const info = document.getElementById("di-store-info");
  info.textContent = [diParsedData.store_name, diParsedData.statement_period].filter(Boolean).join(" \u2014 ");

  // Set default prefix
  document.getElementById("di-prefix").value = platform === "ubereats" ? "UBER" : "DD";

  // Load saved mapping or defaults
  let mapping = {};
  try {
    const resp = await apiGet(`/api/delivery-import/mapping?company_id=${companyId}&platform=${platform}`);
    mapping = resp.mapping || {};
  } catch {
    // Use empty — fields will have defaults below
  }

  // Load chart of accounts for this company
  let accounts = [];
  try {
    accounts = await apiGet(`/api/accounts/cached?company_id=${companyId}`);
  } catch (e) {
    console.warn("Could not load chart of accounts:", e);
  }

  // Define mapping fields based on platform
  const fields = [
    { key: "bank", label: "Bank Account (Net Payout)" },
    { key: "income", label: `${platform === "ubereats" ? "Uber Eats" : "DoorDash"} Income Account` },
    { key: "fees", label: "Platform Fees Account" },
    { key: "marketing", label: "Marketing / Promotions Account" },
    { key: "chargeback", label: platform === "ubereats" ? "Chargeback Account" : "Error Charges Account" },
    { key: "adjustments", label: "Adjustments Account" },
  ];

  const selectStyle = "width:100%;padding:8px 12px;border:1.5px solid var(--color-border);border-radius:var(--radius-md);font-size:var(--text-sm);background:var(--color-surface);color:var(--color-text);";

  const container = document.getElementById("di-mapping-fields");
  container.innerHTML = fields.map(f => `
    <div style="display:flex;flex-direction:column;gap:4px;">
      <label style="font-size:var(--text-xs);font-weight:600;color:var(--color-text-secondary);">${f.label}</label>
      <select data-map-key="${f.key}" style="${selectStyle}">
        <option value="">-- Select Account --</option>
      </select>
    </div>
  `).join("");

  // Build options using DOM API (avoids HTML encoding issues with &, quotes, etc.)
  if (accounts.length) {
    const grouped = {};
    for (const a of accounts) {
      const cls = a.classification || a.account_type || "Other";
      if (!grouped[cls]) grouped[cls] = [];
      grouped[cls].push(a);
    }
    container.querySelectorAll("select[data-map-key]").forEach(sel => {
      for (const [cls, accts] of Object.entries(grouped)) {
        const optgroup = document.createElement("optgroup");
        optgroup.label = cls;
        for (const a of accts) {
          const fqn = a.fully_qualified_name || a.name;
          const displayName = fqn.includes(":") ? "\u00A0\u00A0\u00A0" + fqn : fqn;
          const opt = document.createElement("option");
          opt.value = fqn;
          opt.textContent = displayName;
          optgroup.appendChild(opt);
        }
        sel.appendChild(optgroup);
      }
    });
  }

  console.log("[DI] Mapping from API:", JSON.stringify(mapping));
  console.log("[DI] Accounts loaded:", accounts.length);

  // Set saved mapping values
  for (const f of fields) {
    if (mapping[f.key]) {
      const sel = container.querySelector(`select[data-map-key="${f.key}"]`);
      if (sel) {
        const allValues = [...sel.options].map(o => o.value).filter(Boolean);
        console.log(`[DI] Restoring ${f.key} = "${mapping[f.key]}" | Options count: ${allValues.length}`);
        // Try exact match first
        const exactMatch = [...sel.options].some(o => o.value === mapping[f.key]);
        if (exactMatch) {
          sel.value = mapping[f.key];
          console.log(`[DI]   -> Exact match found for ${f.key}`);
        } else {
          // Try normalized match (trim whitespace, case-insensitive)
          const saved = mapping[f.key].trim().toLowerCase();
          const match = [...sel.options].find(o => {
            if (!o.value) return false;
            const v = o.value.trim().toLowerCase();
            return v === saved || v.endsWith(":" + saved) || o.textContent.trim().toLowerCase() === saved;
          });
          if (match) {
            sel.value = match.value;
            console.log(`[DI]   -> Fuzzy match found for ${f.key}: "${match.value}"`);
          } else {
            console.warn(`[DI]   -> NO match for ${f.key}: "${mapping[f.key]}"`);
          }
        }
      }
    }
  }

  // Show mapping step, hide upload step
  document.getElementById("di-step-upload").style.display = "none";
  document.getElementById("di-step-mapping").style.display = "block";
  document.getElementById("di-step-preview").style.display = "none";
}

/** Escape HTML for safe attribute/text insertion. */
function _escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** Go back to the upload step. */
function diResetUpload() {
  diParsedData = null;
  diCsvContent = "";
  diEntries = [];
  document.getElementById("di-step-upload").style.display = "block";
  document.getElementById("di-step-mapping").style.display = "none";
  document.getElementById("di-step-preview").style.display = "none";
  const status = document.getElementById("di-upload-status");
  if (status) { status.style.display = "none"; status.innerHTML = ""; }
  const fi = document.getElementById("di-file-input");
  if (fi) fi.value = "";
}

/** Gather current mapping from the select dropdowns. */
function _diGatherMapping() {
  const mapping = {};
  document.querySelectorAll("#di-mapping-fields select[data-map-key]").forEach(sel => {
    const val = sel.value.trim();
    if (val) mapping[sel.dataset.mapKey] = val;
  });
  return mapping;
}

/** Save the current mapping to the backend so it persists for next time. */
async function _diSaveMapping(mapping) {
  if (!diParsedData) return;
  const companyId = document.getElementById("di-company").value;
  if (!companyId) return;
  try {
    await fetch(`${API}/api/delivery-import/mapping`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ company_id: companyId, platform: diParsedData.platform, mapping }),
    });
  } catch (e) {
    console.warn("Could not save mapping:", e);
  }
}

/** Explicit save button handler — saves mapping and shows confirmation. */
async function diSaveMapping() {
  const mapping = _diGatherMapping();
  await _diSaveMapping(mapping);
  const btn = document.getElementById("di-save-mapping-btn");
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = "Saved!";
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
  }
}

/** Generate journal entries from parsed data + mapping, and show preview. */
async function diGeneratePreview() {
  if (!diParsedData) return;

  const mapping = _diGatherMapping();

  if (!mapping.bank || !mapping.income) {
    alert("Please select at least the Bank Account and Income Account.");
    return;
  }

  const prefix = document.getElementById("di-prefix").value.trim() || "IMPORT";
  const companyId = document.getElementById("di-company").value;

  // Save mapping for next time
  await _diSaveMapping(mapping);

  // Disable button while generating
  const btn = document.getElementById("di-generate-btn");
  btn.disabled = true;
  btn.textContent = "Generating...";

  try {
    const resp = await fetch(`${API}/api/delivery-import/csv`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ parsed: diParsedData, mapping, prefix, company_id: companyId }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to generate CSV");
    }
    const data = await resp.json();
    diCsvContent = data.csv_content;
    diEntries = data.entries;

    // Show preview
    _diShowPreviewStep(data);
    // Refresh history after generating
    diLoadHistory();
  } catch (err) {
    alert("Error: " + err.message);
    console.error("diGeneratePreview error:", err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate Journal Entries";
  }
}

/** Display the preview table and enable download. */
function _diShowPreviewStep(data) {
  const platform = diParsedData.platform === "ubereats" ? "Uber Eats" : "DoorDash";
  document.getElementById("di-preview-info").textContent =
    `${data.payout_count} payout(s) → ${data.entry_count} journal entry line(s) — ${platform}`;

  const tbody = document.getElementById("di-preview-body");
  tbody.innerHTML = "";

  let lastJournal = "";
  for (const e of data.entries) {
    const isNewJournal = e.journal_no !== lastJournal;
    lastJournal = e.journal_no;
    const row = document.createElement("tr");
    if (isNewJournal) row.style.borderTop = "2px solid var(--color-border)";
    row.innerHTML = `
      <td style="font-weight:${isNewJournal ? '600' : '400'};">${isNewJournal ? e.journal_no : ""}</td>
      <td>${isNewJournal ? e.journal_date : ""}</td>
      <td>${e.account}</td>
      <td style="text-align:right;${e.debit ? 'color:var(--color-danger,#dc2626);' : ''}">${e.debit ? "$" + Number(e.debit).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) : ""}</td>
      <td style="text-align:right;${e.credit ? 'color:var(--color-success,#16a34a);' : ''}">${e.credit ? "$" + Number(e.credit).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) : ""}</td>
      <td style="font-size:var(--text-xs);color:var(--color-text-muted);">${e.description || ""}</td>
    `;
    tbody.appendChild(row);
  }

  document.getElementById("di-step-upload").style.display = "none";
  document.getElementById("di-step-mapping").style.display = "none";
  document.getElementById("di-step-preview").style.display = "block";
}

/** Go back to the mapping step from preview. */
function diBackToMapping() {
  document.getElementById("di-step-upload").style.display = "none";
  document.getElementById("di-step-mapping").style.display = "block";
  document.getElementById("di-step-preview").style.display = "none";
}

/** Download the generated CSV. */
function diDownloadCSV() {
  if (!diCsvContent) { alert("No CSV data available."); return; }
  _diTriggerCsvDownload(diCsvContent, diParsedData.platform, diParsedData.statement_period);
}

function _diTriggerCsvDownload(csvContent, platform, period) {
  const platLabel = platform === "ubereats" ? "UberEats" : "DoorDash";
  const periodLabel = (period || "Statement").replace(/\s+/g, "_");
  const filename = `${platLabel}_JournalEntries_${periodLabel}.csv`;

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Export journal entries directly into QuickBooks via API. */
async function diExportToQBO() {
  if (!diParsedData) return;

  const companyId = document.getElementById("di-company").value;
  if (!companyId) { alert("Please select a company."); return; }

  // Gather mapping and save it
  const mapping = _diGatherMapping();
  await _diSaveMapping(mapping);
  const prefix = document.getElementById("di-prefix").value.trim() || "IMPORT";

  const btn = document.getElementById("di-export-qbo-btn");
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:6px;"></span>Exporting...';

  const statusEl = document.getElementById("di-export-status");
  statusEl.style.display = "none";

  try {
    const resp = await fetch(`${API}/api/delivery-import/export-qbo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ company_id: companyId, parsed: diParsedData, mapping, prefix }),
    });
    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.detail || "Export failed");
    }

    // Show result
    if (data.status === "exported") {
      statusEl.style.display = "block";
      statusEl.style.background = "var(--color-success-bg, #f0fdf4)";
      statusEl.style.color = "var(--color-success, #16a34a)";
      statusEl.innerHTML = `<strong>Successfully exported ${data.posted_count} journal entries</strong> into QuickBooks.`;
    } else if (data.status === "partial") {
      statusEl.style.display = "block";
      statusEl.style.background = "var(--color-warning-bg, #fffbeb)";
      statusEl.style.color = "var(--color-warning, #d97706)";
      statusEl.innerHTML = `<strong>Partially exported:</strong> ${data.posted_count} of ${data.total_count} journal entries posted.`
        + (data.errors ? "<br>Errors: " + data.errors.join("; ") : "");
    } else {
      statusEl.style.display = "block";
      statusEl.style.background = "var(--color-danger-bg, #fef2f2)";
      statusEl.style.color = "var(--color-danger, #dc2626)";
      statusEl.innerHTML = `<strong>Export failed.</strong>`
        + (data.errors ? "<br>" + data.errors.join("<br>") : "");
    }

    // Refresh history
    diLoadHistory();
  } catch (err) {
    statusEl.style.display = "block";
    statusEl.style.background = "var(--color-danger-bg, #fef2f2)";
    statusEl.style.color = "var(--color-danger, #dc2626)";
    statusEl.innerHTML = `<strong>Error:</strong> ${err.message}`;
    console.error("diExportToQBO error:", err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-right:4px;vertical-align:middle;"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>Export into QuickBooks';
  }
}

/* ---- Import History ---- */

async function diLoadHistory() {
  const loadingEl = document.getElementById("di-history-loading");
  const emptyEl = document.getElementById("di-history-empty");
  const tableEl = document.getElementById("di-history-table");
  const tbody = document.getElementById("di-history-body");
  if (!loadingEl) return;

  loadingEl.style.display = "block";
  emptyEl.style.display = "none";
  tableEl.style.display = "none";

  try {
    const data = await apiGet("/api/delivery-import/history");
    const history = data.history || [];

    if (history.length === 0) {
      emptyEl.style.display = "block";
      return;
    }

    // Build company name lookup
    const companyMap = {};
    allCompanies.forEach(c => { companyMap[c.id] = c.name; });

    tbody.innerHTML = "";
    for (const h of history) {
      const date = h.created_at ? new Date(h.created_at + "Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
      const platform = h.platform === "ubereats" ? "Uber Eats" : h.platform === "doordash" ? "DoorDash" : h.platform;
      const companyName = companyMap[h.company_id] || h.company_id;

      let statusBadge = "";
      if (h.status === "exported") {
        statusBadge = '<span class="badge badge-success" style="font-size:var(--text-xs);">Exported to QBO</span>';
      } else if (h.status === "partial") {
        statusBadge = '<span class="badge" style="font-size:var(--text-xs);background:var(--color-warning-bg,#fffbeb);color:var(--color-warning,#d97706);">Partial</span>';
      } else if (h.status === "failed") {
        statusBadge = '<span class="badge" style="font-size:var(--text-xs);background:var(--color-danger-bg,#fef2f2);color:var(--color-danger,#dc2626);">Failed</span>';
      } else {
        statusBadge = '<span class="badge" style="font-size:var(--text-xs);background:var(--color-info-bg,#eff6ff);color:var(--color-info,#2563eb);">CSV Downloaded</span>';
      }

      const jeCount = (h.qbo_je_ids || []).length;
      const jeInfo = jeCount > 0 ? ` <span style="font-size:var(--text-xs);color:var(--color-text-muted);">(${jeCount} JEs)</span>` : "";

      const row = document.createElement("tr");
      row.innerHTML = `
        <td style="white-space:nowrap;font-size:var(--text-xs);">${date}</td>
        <td><strong>${platform}</strong></td>
        <td style="font-size:var(--text-sm);">${h.store_name || companyName}</td>
        <td style="font-size:var(--text-sm);">${h.statement_period || ""}</td>
        <td style="text-align:center;">${h.payout_count}</td>
        <td style="text-align:center;">${h.entry_count}</td>
        <td>${statusBadge}${jeInfo}</td>
        <td>
          <button class="btn btn-ghost btn-sm" onclick="diViewHistoryPreview('${h.id}','${_escHtml(platform)}','${_escHtml(h.store_name || '')}','${_escHtml(h.statement_period || '')}')" title="View Preview" style="padding:4px 8px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </td>
      `;
      tbody.appendChild(row);
    }

    tableEl.style.display = "table";
  } catch (err) {
    console.error("diLoadHistory error:", err);
    emptyEl.textContent = "Could not load import history.";
    emptyEl.style.display = "block";
  } finally {
    loadingEl.style.display = "none";
  }
}

/** View a past import's journal entries in a preview modal. */
async function diViewHistoryPreview(historyId, platform, storeName, period) {
  try {
    const data = await apiGet(`/api/delivery-import/history/${historyId}/csv`);
    if (!data.csv_content) { alert("No data available for this import."); return; }

    // Parse CSV into entry rows
    const lines = data.csv_content.split("\n").filter(l => l.trim());
    if (lines.length < 2) { alert("No journal entries found."); return; }

    // Parse header to find column indices
    const header = _diParseCSVLine(lines[0]);
    const idx = {};
    header.forEach((h, i) => { idx[h.trim().toLowerCase().replace(/\s+/g, "_")] = i; });
    const colJNo = idx["journal_no"] ?? idx["*journalno"] ?? idx["journal_number"] ?? 0;
    const colDate = idx["journal_date"] ?? idx["*journaldate"] ?? idx["date"] ?? 1;
    const colAcct = idx["account"] ?? idx["account_name"] ?? idx["*accountname"] ?? 2;
    const colDebit = idx["debit"] ?? idx["*debit"] ?? 3;
    const colCredit = idx["credit"] ?? idx["*credit"] ?? 4;
    const colDesc = idx["description"] ?? idx["memo"] ?? idx["*description"] ?? 5;

    const entries = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = _diParseCSVLine(lines[i]);
      if (cols.length < 3) continue;
      entries.push({
        journal_no: (cols[colJNo] || "").trim(),
        journal_date: (cols[colDate] || "").trim(),
        account: (cols[colAcct] || "").trim(),
        debit: (cols[colDebit] || "").trim(),
        credit: (cols[colCredit] || "").trim(),
        description: (cols[colDesc] || "").trim(),
      });
    }

    // Set info text
    const info = document.getElementById("di-history-preview-info");
    info.textContent = `${platform} — ${storeName}${period ? " — " + period : ""} — ${entries.length} line(s)`;

    // Build preview table
    const tbody = document.getElementById("di-history-preview-body");
    tbody.innerHTML = "";
    let lastJournal = "";
    for (const e of entries) {
      const isNew = e.journal_no && e.journal_no !== lastJournal;
      if (e.journal_no) lastJournal = e.journal_no;
      const row = document.createElement("tr");
      if (isNew) row.style.borderTop = "2px solid var(--color-border)";
      const debitVal = parseFloat(e.debit) || 0;
      const creditVal = parseFloat(e.credit) || 0;
      row.innerHTML = `
        <td style="font-weight:${isNew ? '600' : '400'};">${isNew ? e.journal_no : ""}</td>
        <td>${isNew ? e.journal_date : ""}</td>
        <td>${_escHtml(e.account)}</td>
        <td style="text-align:right;${debitVal ? 'color:var(--color-danger,#dc2626);' : ''}">${debitVal ? "$" + debitVal.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) : ""}</td>
        <td style="text-align:right;${creditVal ? 'color:var(--color-success,#16a34a);' : ''}">${creditVal ? "$" + creditVal.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) : ""}</td>
        <td style="font-size:var(--text-xs);color:var(--color-text-muted);">${_escHtml(e.description)}</td>
      `;
      tbody.appendChild(row);
    }

    // Show modal
    const modal = document.getElementById("di-history-preview-modal");
    modal.style.display = "flex";
    modal.classList.add("active");
  } catch (err) {
    alert("Could not load preview: " + err.message);
    console.error("diViewHistoryPreview error:", err);
  }
}

/** Parse a single CSV line respecting quoted fields. */
function _diParseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current); current = ""; }
      else { current += ch; }
    }
  }
  result.push(current);
  return result;
}

/** Close the history preview modal. */
function diCloseHistoryPreview() {
  const modal = document.getElementById("di-history-preview-modal");
  modal.style.display = "none";
  modal.classList.remove("active");
  modal.classList.remove("open");
}

// =====================================================================
//  RECEIPTS — OCR + Transaction Matching
// =====================================================================

let rcptInitialized = false;
let rcptCurrentId = null;

function rcptInit() {
  const companySel = document.getElementById("rcpt-company");
  if (companySel) {
    const prior = companySel.value;
    companySel.innerHTML =
      `<option value="">Any company</option>` +
      allCompanies
        .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
        .join("");
    if (prior) companySel.value = prior;
    companySel.onchange = loadReceipts;
  }

  if (!rcptInitialized) {
    const dz = document.getElementById("rcpt-dropzone");
    const input = document.getElementById("rcpt-file-input");
    if (dz && input) {
      dz.onclick = () => input.click();
      dz.ondragover = (e) => { e.preventDefault(); dz.style.background = "rgba(99,102,241,0.08)"; };
      dz.ondragleave = () => { dz.style.background = ""; };
      dz.ondrop = (e) => {
        e.preventDefault();
        dz.style.background = "";
        rcptHandleFiles(e.dataTransfer.files);
      };
      input.onchange = () => rcptHandleFiles(input.files);
    }
    rcptInitialized = true;
  }
  loadReceipts();
}

function rcptStatus(msg, kind) {
  const el = document.getElementById("rcpt-upload-status");
  if (!el) return;
  const colors = {
    info: "background:#eff6ff; color:#1e40af; border:1px solid #bfdbfe;",
    ok: "background:#ecfdf5; color:#065f46; border:1px solid #a7f3d0;",
    err: "background:#fef2f2; color:#991b1b; border:1px solid #fecaca;",
  };
  el.style.display = "block";
  el.style.cssText += colors[kind || "info"];
  el.textContent = msg;
}

async function rcptHandleFiles(files) {
  if (!files || !files.length) return;
  const companyId = document.getElementById("rcpt-company").value || "";
  const list = Array.from(files);
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    rcptStatus(`Uploading ${i + 1}/${list.length}: ${f.name}…`, "info");
    try {
      const fd = new FormData();
      fd.append("file", f);
      const url = `${API}/api/receipts/upload${companyId ? `?company_id=${encodeURIComponent(companyId)}` : ""}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
        body: fd,
      });
      if (!resp.ok) {
        const detail = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${detail.slice(0, 200)}`);
      }
      const data = await resp.json();
      rcptStatus(`Processed ${f.name} — ${data.receipt?.merchant || "(no merchant)"}, $${data.receipt?.total ?? "?"}`, "ok");
    } catch (e) {
      rcptStatus(`Failed: ${e.message}`, "err");
    }
  }
  loadReceipts();
}

function rcptStatusChip(r) {
  if (r.ocr_status === "processing") return `<span class="badge" style="background:#e5e7eb;color:#374151;">Processing</span>`;
  if (r.ocr_status === "failed") return `<span class="badge" style="background:#fee2e2;color:#991b1b;">Failed</span>`;
  if (r.ocr_status === "done") return `<span class="badge" style="background:#dbeafe;color:#1e40af;">Processed</span>`;
  return `<span class="badge" style="background:#e5e7eb;color:#374151;">${escapeHtml(r.ocr_status || "pending")}</span>`;
}

function rcptMatchChip(r) {
  if (r.matched_transaction_id) {
    const src = (r.matched_source || "").toUpperCase();
    const conf = r.matched_confidence != null ? ` · ${Math.round(r.matched_confidence * 100)}%` : "";
    return `<span class="badge" style="background:#d1fae5;color:#065f46;">Matched (${escapeHtml(src)}${conf})</span>`;
  }
  if (r.ocr_status === "done") {
    return `<span class="badge" style="background:#fef3c7;color:#92400e;">Unmatched</span>`;
  }
  return `<span class="text-muted" style="font-size:var(--text-xs);">—</span>`;
}

async function loadReceipts() {
  const body = document.getElementById("rcpt-list-body");
  if (!body) return;
  const companyId = document.getElementById("rcpt-company")?.value || "";
  const status = document.getElementById("rcpt-filter-status")?.value || "";
  const matched = document.getElementById("rcpt-filter-matched")?.value || "";
  const qs = new URLSearchParams();
  if (companyId) qs.set("company_id", companyId);
  if (status) qs.set("status", status);
  if (matched) qs.set("matched", matched);
  try {
    const resp = await fetch(`${API}/api/receipts?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const rows = data.receipts || [];
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:24px; color:var(--color-text-muted);">No receipts match these filters.</td></tr>`;
      return;
    }
    body.innerHTML = rows
      .map(
        (r) => `
        <tr>
          <td>${escapeHtml(r.receipt_date || "—")}</td>
          <td>${escapeHtml(r.merchant || r.original_filename || "—")}</td>
          <td style="text-align:right;">${r.total != null ? "$" + Number(r.total).toFixed(2) : "—"}</td>
          <td>${rcptStatusChip(r)}</td>
          <td>${rcptMatchChip(r)}</td>
          <td style="text-align:right;">
            <button class="btn btn-secondary btn-sm" onclick="reviewReceipt('${r.id}')">Review</button>
          </td>
        </tr>`,
      )
      .join("");
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:24px; color:var(--color-danger);">Failed to load receipts: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function reviewReceipt(id) {
  rcptCurrentId = id;
  const modal = document.getElementById("rcpt-modal");
  modal.classList.add("active");
  modal.style.display = "flex";
  const preview = document.getElementById("rcpt-preview");
  const extracted = document.getElementById("rcpt-extracted");
  const cands = document.getElementById("rcpt-candidates");
  preview.innerHTML = `<span style="color:var(--color-text-muted); font-size:var(--text-sm);">Loading…</span>`;
  extracted.innerHTML = "";
  cands.innerHTML = "";
  try {
    const resp = await fetch(`${API}/api/receipts/${id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { receipt } = await resp.json();
    if (receipt.signed_url) {
      if ((receipt.mime_type || "").startsWith("image/")) {
        preview.innerHTML = `<img src="${receipt.signed_url}" style="max-width:100%; max-height:100%; object-fit:contain;" alt="receipt">`;
      } else {
        preview.innerHTML = `<iframe src="${receipt.signed_url}" style="width:100%; height:100%; border:0;"></iframe>`;
      }
    } else {
      preview.innerHTML = `<span style="color:var(--color-text-muted);">No preview available</span>`;
    }
    const li = (receipt.line_items || [])
      .map((x) => `<li>${escapeHtml(x.description || "")} — $${Number(x.amount || 0).toFixed(2)}</li>`)
      .join("");
    extracted.innerHTML = `
      <div><strong>${escapeHtml(receipt.merchant || "—")}</strong></div>
      <div style="color:var(--color-text-muted);">${escapeHtml(receipt.receipt_date || "")}</div>
      <div style="margin-top:6px;">Subtotal: $${receipt.subtotal ?? "—"} · Tax: $${receipt.tax ?? "—"} · Tip: $${receipt.tip ?? "—"}</div>
      <div style="font-size:var(--text-lg); font-weight:700; margin-top:4px;">Total: $${receipt.total ?? "—"}</div>
      ${receipt.ocr_error ? `<div style="color:var(--color-danger); margin-top:6px;">OCR error: ${escapeHtml(receipt.ocr_error)}</div>` : ""}
      ${li ? `<ul style="margin-top:8px; padding-left:18px;">${li}</ul>` : ""}
    `;

    const mResp = await fetch(`${API}/api/receipts/${id}/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ date_window_days: 3, top_n: 5 }),
    });
    const mData = mResp.ok ? await mResp.json() : { candidates: [] };
    if (!mData.candidates || !mData.candidates.length) {
      cands.innerHTML = `<div class="text-muted" style="font-size:var(--text-sm);">No candidate transactions found within ±3 days. Try syncing QuickBooks or widening the window.</div>`;
    } else {
      cands.innerHTML = mData.candidates
        .map((c) => {
          const confirmed = receipt.matched_transaction_id === c.id && receipt.matched_source === c.source;
          return `
          <div style="border:1px solid var(--color-border); border-radius:var(--radius-md); padding:10px 12px; display:flex; justify-content:space-between; align-items:center; gap:10px; ${confirmed ? "background:#ecfdf5;" : ""}">
            <div style="flex:1;">
              <div style="font-weight:600;">${escapeHtml(c.merchant || "(no merchant)")}</div>
              <div style="font-size:var(--text-xs); color:var(--color-text-muted);">${escapeHtml(c.date || "")} · $${Number(c.amount || 0).toFixed(2)} · <span style="text-transform:uppercase;">${escapeHtml(c.source)}</span></div>
              <div style="height:4px; background:#e5e7eb; border-radius:2px; margin-top:4px; overflow:hidden;">
                <div style="width:${Math.round((c.score || 0) * 100)}%; height:100%; background:#2563eb;"></div>
              </div>
            </div>
            <button class="btn ${confirmed ? "btn-secondary" : "btn-primary"} btn-sm" onclick="confirmReceiptMatch('${c.id}','${c.source}',${c.score || 0})">${confirmed ? "Matched" : "Confirm"}</button>
          </div>`;
        })
        .join("");
    }
  } catch (e) {
    preview.innerHTML = `<span style="color:var(--color-danger);">Failed to load: ${escapeHtml(e.message)}</span>`;
  }
}

async function confirmReceiptMatch(transactionId, source, confidence) {
  if (!rcptCurrentId) return;
  try {
    const resp = await fetch(`${API}/api/receipts/${rcptCurrentId}/confirm-match`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ transaction_id: transactionId, source, confidence }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await reviewReceipt(rcptCurrentId);
    loadReceipts();
  } catch (e) {
    alert("Failed to confirm match: " + e.message);
  }
}

async function reprocessReceiptFromModal() {
  if (!rcptCurrentId) return;
  try {
    const resp = await fetch(`${API}/api/receipts/${rcptCurrentId}/reprocess`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await reviewReceipt(rcptCurrentId);
    loadReceipts();
  } catch (e) {
    alert("Re-OCR failed: " + e.message);
  }
}

async function deleteReceiptFromModal() {
  if (!rcptCurrentId) return;
  if (!confirm("Delete this receipt permanently?")) return;
  try {
    const resp = await fetch(`${API}/api/receipts/${rcptCurrentId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    closeReceiptModal();
    loadReceipts();
  } catch (e) {
    alert("Delete failed: " + e.message);
  }
}

function closeReceiptModal() {
  const modal = document.getElementById("rcpt-modal");
  modal.classList.remove("active");
  modal.style.display = "none";
  rcptCurrentId = null;
}


// =====================================================================
//  ADD COMPANY — Source Chooser + Manual Flow + Plaid Link
// =====================================================================

let _pendingPlaidCompany = null; // { id, name } — holds the company awaiting bank link

function chooseAddSource(src) {
  const chooser   = document.getElementById("add-company-chooser");
  const qbo       = document.getElementById("qbo-wizard-card");
  const manual    = document.getElementById("manual-company-form-card");
  const plaidLink = document.getElementById("plaid-link-card");
  if (!chooser || !qbo || !manual) return;

  chooser.style.display = "none";
  plaidLink.style.display = "none";
  if (src === "qbo") {
    manual.style.display = "none";
    qbo.style.display = "block";
  } else if (src === "manual") {
    qbo.style.display = "none";
    manual.style.display = "block";
    const errEl = document.getElementById("mc-form-error");
    if (errEl) errEl.style.display = "none";
  }
}

function resetAddCompany() {
  const chooser   = document.getElementById("add-company-chooser");
  const qbo       = document.getElementById("qbo-wizard-card");
  const manual    = document.getElementById("manual-company-form-card");
  const plaidLink = document.getElementById("plaid-link-card");
  if (chooser)   chooser.style.display   = "block";
  if (qbo)       qbo.style.display       = "none";
  if (manual)    manual.style.display    = "none";
  if (plaidLink) plaidLink.style.display = "none";
  // Reset QBO wizard back to step 1
  if (typeof setWizardStep === "function") setWizardStep(1);
  _pendingPlaidCompany = null;
  // Clear manual form fields
  ["mc-name", "mc-legal", "mc-ein", "mc-industry"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
}

async function createManualCompany() {
  const btn = document.getElementById("mc-submit-btn");
  const errEl = document.getElementById("mc-form-error");
  if (errEl) errEl.style.display = "none";

  const name = (document.getElementById("mc-name").value || "").trim();
  if (!name) {
    if (errEl) { errEl.textContent = "Company name is required."; errEl.style.display = "block"; }
    return;
  }

  const body = {
    name,
    legal_name: (document.getElementById("mc-legal").value || "").trim() || null,
    ein: (document.getElementById("mc-ein").value || "").trim() || null,
    industry: (document.getElementById("mc-industry").value || "").trim() || null,
    fiscal_year_start: parseInt(document.getElementById("mc-fy-start").value || "1", 10),
    base_currency: document.getElementById("mc-currency").value || "USD",
  };

  if (btn) { btn.disabled = true; btn.textContent = "Creating..."; }
  try {
    const resp = await apiPost("/api/companies/manual", body);
    const newCompany = resp.company;
    if (!newCompany || !newCompany.id) throw new Error("Server did not return the new company");
    showToast(`${newCompany.name} created`, "success");
    await loadCompanyList();
    renderCompaniesTable();
    // Transition to Plaid link card
    document.getElementById("manual-company-form-card").style.display = "none";
    document.getElementById("add-company-chooser").style.display = "none";
    document.getElementById("plaid-link-company-name").textContent = newCompany.name;
    document.getElementById("plaid-link-card").style.display = "block";
    _pendingPlaidCompany = { id: newCompany.id, name: newCompany.name };
  } catch (e) {
    if (errEl) {
      errEl.textContent = e.message || "Failed to create company";
      errEl.style.display = "block";
    } else {
      alert("Failed: " + (e.message || "Unknown error"));
    }
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg> Create Company'; }
  }
}

async function openPlaidLinkForPending() {
  if (!_pendingPlaidCompany) return;
  await connectPlaidBank(_pendingPlaidCompany.id, _pendingPlaidCompany.name);
}

async function connectPlaidBank(companyId, companyName) {
  if (typeof Plaid === "undefined" || !Plaid.create) {
    alert("Plaid Link is still loading — try again in a moment.");
    return;
  }
  const statusEl = document.getElementById("plaid-link-status");
  const openBtn  = document.getElementById("plaid-open-btn");
  if (openBtn)  { openBtn.disabled = true; openBtn.textContent = "Opening Plaid..."; }
  if (statusEl) { statusEl.style.display = "none"; }

  let linkToken;
  try {
    const resp = await apiPost("/api/plaid/link-token", { company_id: companyId });
    linkToken = resp.link_token;
    if (!linkToken) throw new Error("No link token returned");
  } catch (e) {
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.style.color = "var(--color-error)";
      statusEl.textContent = "Could not create Plaid link token: " + (e.message || "unknown error");
    }
    if (openBtn) { openBtn.disabled = false; openBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/></svg> Connect Bank with Plaid';}
    return;
  }

  const handler = Plaid.create({
    token: linkToken,
    onSuccess: async (public_token, metadata) => {
      try {
        const r = await apiPost("/api/plaid/exchange-token", {
          public_token,
          company_id: companyId,
          institution_id:   metadata && metadata.institution ? metadata.institution.institution_id   : null,
          institution_name: metadata && metadata.institution ? metadata.institution.name              : null,
        });
        const accountCount = (r.accounts || []).length;
        showToast(`${companyName}: ${accountCount} account${accountCount === 1 ? "" : "s"} linked. Syncing transactions...`, "success");
        await loadCompanyList();
        renderCompaniesTable();
        resetAddCompany();
      } catch (e) {
        alert("Exchange failed: " + (e.message || "unknown error"));
      }
    },
    onExit: (err, metadata) => {
      if (openBtn) { openBtn.disabled = false; openBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/></svg> Connect Bank with Plaid'; }
      if (err && statusEl) {
        statusEl.style.display = "block";
        statusEl.style.color = "var(--color-error)";
        statusEl.textContent = "Plaid Link closed: " + (err.display_message || err.error_message || err.error_code || "unknown error");
      }
    },
  });
  handler.open();
}

async function syncPlaidCompany(companyId, companyName) {
  try {
    showToast(`Syncing ${companyName || "company"}...`, "info");
    const res = await apiPost(`/api/plaid/sync/${companyId}`, {});
    const t = res.totals || {};
    showToast(`${companyName || "Company"} synced — added ${t.added || 0}, modified ${t.modified || 0}`, "success");
    await loadCompanyList();
    renderCompaniesTable();
  } catch (e) {
    showToast("Sync failed: " + (e.message || "unknown error"), "error");
  }
}


// =====================================================================
//  PLAID TRANSACTIONS MODAL
// =====================================================================

let _plaidTxState = { company_id: null, company_name: "", limit: 100, offset: 0, last_count: 0 };

async function showPlaidTransactions(companyId, companyName) {
  _plaidTxState = { company_id: companyId, company_name: companyName, limit: 100, offset: 0, last_count: 0 };
  const modal = document.getElementById("plaid-tx-modal");
  const title = document.getElementById("plaid-tx-title");
  if (title) title.textContent = `Transactions — ${companyName || ""}`;
  if (modal) {
    modal.classList.add("active");
    modal.style.display = "flex";
  }
  await _loadPlaidTransactions();
}

function closePlaidTxModal() {
  const modal = document.getElementById("plaid-tx-modal");
  if (modal) {
    modal.classList.remove("active");
    modal.style.display = "none";
  }
}

async function plaidTxPage(delta) {
  const next = _plaidTxState.offset + (delta * _plaidTxState.limit);
  if (next < 0) return;
  if (delta > 0 && _plaidTxState.last_count < _plaidTxState.limit) return; // no more pages
  _plaidTxState.offset = next;
  await _loadPlaidTransactions();
}

async function plaidSyncFromModal() {
  if (!_plaidTxState.company_id) return;
  await syncPlaidCompany(_plaidTxState.company_id, _plaidTxState.company_name);
  await _loadPlaidTransactions();
}

async function _loadPlaidTransactions() {
  const body = document.getElementById("plaid-tx-body");
  const summary = document.getElementById("plaid-tx-summary");
  const pag = document.getElementById("plaid-tx-pagination");
  if (!body) return;
  body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--color-text-muted);">Loading...</td></tr>';

  try {
    const qs = new URLSearchParams({
      limit: String(_plaidTxState.limit),
      offset: String(_plaidTxState.offset),
    }).toString();
    const resp = await apiGet(`/api/plaid/transactions/${_plaidTxState.company_id}?${qs}`);
    const txs = resp.transactions || [];
    _plaidTxState.last_count = txs.length;

    if (!txs.length) {
      body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--color-text-muted);">No transactions yet. Click "Sync Now" to pull from Plaid.</td></tr>';
    } else {
      body.innerHTML = txs.map((t) => {
        const amount = Number(t.amount || 0);
        // Plaid: positive = outflow (spend). Display with sign.
        const displayAmt = amount;
        const color = displayAmt > 0 ? "var(--color-text-primary)" : "var(--color-success)";
        const cat = (t.category && t.category.name) || (t.plaid_pfc ? t.plaid_pfc.replace(/_/g, " ").toLowerCase() : "—");
        const acct = t.account ? (t.account.name + (t.account.mask ? ` ···${t.account.mask}` : "")) : "—";
        const merch = t.merchant_name || t.description || "—";
        return `<tr>
          <td style="font-size:var(--text-xs);">${t.date || ""}</td>
          <td style="font-size:var(--text-xs);">${_escapeHtml(acct)}</td>
          <td>${_escapeHtml(merch)}</td>
          <td style="font-size:var(--text-xs);">${_escapeHtml(cat)}${t.is_transfer ? ' <span class="badge badge-neutral" style="font-size:10px;">transfer</span>' : ""}</td>
          <td style="text-align:right;color:${color};font-variant-numeric:tabular-nums;">${displayAmt.toFixed(2)}</td>
        </tr>`;
      }).join("");
    }
    if (summary) summary.textContent = `Showing ${txs.length} transaction${txs.length === 1 ? "" : "s"} starting at offset ${_plaidTxState.offset}.`;
    if (pag) pag.textContent = `Page ${(Math.floor(_plaidTxState.offset / _plaidTxState.limit) + 1)}`;

    const prevBtn = document.getElementById("plaid-tx-prev");
    const nextBtn = document.getElementById("plaid-tx-next");
    if (prevBtn) prevBtn.disabled = _plaidTxState.offset <= 0;
    if (nextBtn) nextBtn.disabled = txs.length < _plaidTxState.limit;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--color-error);">Failed to load: ${_escapeHtml(e.message || "unknown error")}</td></tr>`;
  }
}

function _escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
