/* ============================================
   Consolidated Report — Application Logic
   ============================================ */

// --- API Config ---
// IMPORTANT: Change this URL to your Railway backend URL after deploying.
// Example: "https://your-app-name.up.railway.app"
// For local development, use: "http://localhost:8000"
const API = "https://overflowing-ambition-production-4b7e.up.railway.app";
// Next.js Financials app — used for routes that hit Supabase directly
// (loan-statement extraction, vendor loan CoA mapping). Override with
// window.FIN_API at runtime, otherwise default to localhost dev.
// Next.js Financials app URL. Override via window.FIN_API. Otherwise auto-pick
// based on host: localhost → local Next.js dev, prod legacy → deployed hub.
const FIN_API = (() => {
  if (typeof window !== "undefined" && window.FIN_API) return window.FIN_API;
  if (typeof window !== "undefined") {
    const h = window.location.hostname;
    if (h === "localhost" || h === "127.0.0.1") return "http://localhost:3000";
    return "https://hub.consolidatedreport.app";
  }
  return "http://localhost:3000";
})();
// Supabase project — used in parallel to Railway login so we can call
// FIN_API routes (loan-statement extraction, vendor mapping) with a JWT.
const SUPABASE_URL = (typeof window !== "undefined" && window.SUPABASE_URL) || "https://aemqlnwbnvwynnxirrmg.supabase.co";
const SUPABASE_ANON_KEY = (typeof window !== "undefined" && window.SUPABASE_ANON_KEY) || "sb_publishable_lB85Z64texzZYJkUkPvMxw_wBE23m9I";
let authToken = null;
let supabaseAccessToken = null;
let supabaseRefreshToken = null;
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

// --- Supabase session bridge ---
// Acquires a Supabase access token using the same email/password the user
// supplied to Railway. Required for FIN_API calls (Next.js routes that read
// Supabase via RLS). Failure is non-fatal: legacy Railway flows keep working.
async function _supabaseSignIn(email, password) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) return false;
    const data = await r.json();
    supabaseAccessToken = data.access_token || null;
    supabaseRefreshToken = data.refresh_token || null;
    return !!supabaseAccessToken;
  } catch {
    return false;
  }
}

async function _supabaseRefresh() {
  if (!supabaseRefreshToken) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: supabaseRefreshToken }),
    });
    if (!r.ok) return false;
    const data = await r.json();
    supabaseAccessToken = data.access_token || null;
    supabaseRefreshToken = data.refresh_token || supabaseRefreshToken;
    return !!supabaseAccessToken;
  } catch {
    return false;
  }
}

// Fetch wrapper for FIN_API calls — adds Bearer header, retries once on 401
// after refreshing the Supabase token.
async function finFetch(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${FIN_API}${path}`;
  const doFetch = () => {
    const headers = Object.assign({}, opts.headers || {});
    if (supabaseAccessToken) headers["Authorization"] = `Bearer ${supabaseAccessToken}`;
    return fetch(url, Object.assign({}, opts, { headers }));
  };
  let resp = await doFetch();
  if (resp.status === 401 && supabaseRefreshToken) {
    const ok = await _supabaseRefresh();
    if (ok) resp = await doFetch();
  }
  return resp;
}

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
    // Parallel Supabase session — non-fatal if it fails (Railway flows keep
    // working; only FIN_API routes need it).
    _supabaseSignIn(email, password);
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
    _supabaseSignIn(email, password);
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
  supabaseAccessToken = null;
  supabaseRefreshToken = null;
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
  // Gate Business-only features (period comparison, intercompany journals, etc.)
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
    const raw = await res.text().catch(() => "");
    let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch {}
    window.__lastApiError = { path, status: res.status, raw, data, reqBody: body, ts: new Date().toISOString() };
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
    // Railway sometimes returns plaid_items: [] for manual+Plaid companies
    // even when Supabase has the items. That makes the company switcher
    // and Companies page display "No bank linked" and downstream UIs gate
    // off bank features. For manual companies, treat Supabase as the source
    // of truth for plaid_items / accounts_count.
    if (supabaseAccessToken) {
      try { await _enrichManualPlaidItems(); }
      catch (e) { console.warn("plaid_items enrichment failed", e); }
    }
    // Hydrate sidebar selection from localStorage BEFORE populating the
    // multi-selects, so the report/dashboard pickers default to the company
    // the user had selected on their last visit (not "All Companies").
    _loadPersistedSelection();
    populateCompanySelectors();
    if (typeof renderCompanySwitcher === "function") renderCompanySwitcher();
  } catch {
    allCompanies = [];
  }
}

// Pull plaid_items + accounts for every manual company from Supabase and
// overlay onto allCompanies[i].plaid_items. Done in two parallel calls so
// it's one round trip per table regardless of company count.
async function _enrichManualPlaidItems() {
  const manuals = (allCompanies || []).filter((c) => (c.source || "qbo") === "manual");
  if (!manuals.length) return;
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  const ids = manuals.map((c) => c.id).join(",");
  const [items, accts] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/plaid_items?company_id=in.(${ids})&select=id,company_id,institution_name,institution_id,status,last_synced_at`, { headers })
      .then((r) => r.ok ? r.json() : []),
    fetch(`${SUPABASE_URL}/rest/v1/accounts?company_id=in.(${ids})&select=id,company_id,plaid_item_id,mask`, { headers })
      .then((r) => r.ok ? r.json() : []),
  ]);
  const acctCountByItem = new Map();
  const maskByItem = new Map();
  for (const a of accts) {
    if (!a.plaid_item_id) continue;
    acctCountByItem.set(a.plaid_item_id, (acctCountByItem.get(a.plaid_item_id) || 0) + 1);
    if (!maskByItem.has(a.plaid_item_id) && a.mask) maskByItem.set(a.plaid_item_id, a.mask);
  }
  const itemsByCompany = new Map();
  for (const it of items) {
    const arr = itemsByCompany.get(it.company_id) || [];
    arr.push({
      id: it.id,
      institution_id: it.institution_id,
      institution_name: it.institution_name,
      status: it.status,
      last_synced_at: it.last_synced_at,
      accounts_count: acctCountByItem.get(it.id) || 0,
      mask_preview: maskByItem.get(it.id) || null,
    });
    itemsByCompany.set(it.company_id, arr);
  }
  for (const c of manuals) {
    const supaItems = itemsByCompany.get(c.id);
    if (supaItems && supaItems.length) c.plaid_items = supaItems;
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
  _syncCompanyMultiSelect();

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

// Default the report/dashboard company multi-selects to whichever company
// the sidebar has selected. If sidebar is on "All Companies" (selectedCompanyId
// === null), check every box ("All Companies"). Called on initial population
// and again whenever the sidebar selection changes.
function _syncCompanyMultiSelect() {
  ["pl", "bs", "cf", "dash"].forEach((prefix) => {
    const optionsDiv = document.getElementById(`${prefix}-company-options`);
    if (!optionsDiv) return;
    let html = '<div class="multi-opt-divider"></div>';
    for (const c of allCompanies) {
      const dotClass = c.status === "connected" ? "connected" : "disconnected";
      const isChecked = selectedCompanyId ? (selectedCompanyId === c.id) : true;
      html += `<label class="multi-opt"><input type="checkbox" value="${c.id}" onchange="handleCompanyCheck('${prefix}')"${isChecked ? " checked" : ""}> <span><i class="status-dot ${dotClass}"></i>${c.name}</span></label>`;
    }
    optionsDiv.innerHTML = html;
    updateMultiSelectLabel(prefix);
  });
  // Method dropdown is only meaningful for QBO companies — sync state now
  // that the company list is loaded and the selected company is known.
  _syncMethodDropdownState();
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
    users: "User Management",
    "knowledge-base": "AI Knowledge Base",
    "delivery-import": "UberEats / DoorDash Import",
    receipts: "Receipts — OCR & Matching",
  };
  // Block non-admin from users page
  if (page === "users" && currentUser && currentUser.role !== "admin") {
    page = "dashboard";
  }
  const allTitles = Object.assign({}, titles, {
    transactions: "Transactions",
    coa: "Chart of Accounts",
    rules: "Categorization Rules",
    "manual-journal": "Journal Entries",
    "bank-accounts": "Bank Accounts",
    customers: "Customers",
    vendors: "Vendors",
    invoices: "Invoices",
    bills: "Bills",
    "ar-aging": "AR Aging",
    "ap-aging": "AP Aging",
    "credit-memos": "Credit Memos",
    recurring: "Recurring Invoices",
  });
  document.getElementById("page-title").textContent = allTitles[page] || "Dashboard";
  location.hash = page;
  if (page === "companies") loadCompanies();
  if (page === "intercompany") loadICHistory();
  if (page === "users") loadUsers();
  if (page === "knowledge-base") loadKnowledgeBase();
  if (page === "delivery-import") diInit();
  if (page === "receipts") rcptInit();
  // Per-company pages
  if (page === "transactions") txInit();
  if (page === "coa") coaInit();
  if (page === "rules") rulesInit();
  if (page === "manual-journal") journalInit();
  if (page === "bank-accounts") baInit();
  if (page === "dashboard") dashInit();
  if (page === "customers") customersInit();
  if (page === "vendors") vendorsInit();
  if (page === "invoices") invoicesInit();
  if (page === "bills") billsInit();
  if (page === "ar-aging") arAgingInit();
  if (page === "ap-aging") apAgingInit();
  if (page === "credit-memos") openCreditMemoModal();
  if (page === "recurring") openRecurringModal();
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

// Emit a rich empty-state cell (drop into <tr><td colspan=N>…</td></tr>).
// opts: { title, body, cta: { label, onclick } }
function emptyStateCell(colspan, opts) {
  const t = (opts && opts.title) || "Nothing here yet";
  const b = (opts && opts.body)  || "";
  const cta = opts && opts.cta;
  const ctaHtml = cta ? `<div style="margin-top:14px;"><button class="btn btn-primary btn-sm" onclick="${cta.onclick}">${cta.label}</button></div>` : "";
  return `<tr><td colspan="${colspan}" style="text-align:center;padding:40px 16px;color:var(--color-text-muted);">`
       + `<div style="font-size:var(--text-base);font-weight:600;color:var(--color-text);margin-bottom:6px;">${t}</div>`
       + (b ? `<div style="font-size:var(--text-sm);max-width:420px;margin:0 auto;">${b}</div>` : "")
       + ctaHtml
       + `</td></tr>`;
}

function applyDateMacro(prefix) {
  if (document.getElementById(`${prefix}-date-macro`).value) {
    const s = document.getElementById(`${prefix}-start-date`);
    const e = document.getElementById(`${prefix}-end-date`);
    if (s) s.value = "";
    if (e) e.value = "";
  }
  _autoRunReport(prefix);
}

// Debounce report reruns when filters change. Only fires if the report
// has already been run at least once for this page in this session (no
// accidental fetches on first mount). The explicit "Run Report" button
// still works as the source of truth.
const _autoRunState = { pl: false, bs: false, cf: false, timers: {} };
function _autoRunReport(prefix) {
  if (!_autoRunState[prefix]) return;
  clearTimeout(_autoRunState.timers[prefix]);
  _autoRunState.timers[prefix] = setTimeout(() => {
    if (prefix === "pl") loadPL();
    else if (prefix === "bs") loadBS();
    else if (prefix === "cf") loadCF();
  }, 250);
}
function _markReportRun(prefix) { _autoRunState[prefix] = true; }

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
  _markReportRun("pl");
  const ld = document.getElementById("pl-loading");
  const wr = document.getElementById("pl-table-wrapper");
  ld.innerHTML = '<div class="loading-spinner" style="margin:0 auto;"></div><p class="mt-4">Loading Profit & Loss...</p>';
  ld.classList.remove("hidden"); wr.classList.add("hidden");

  try {
    const sel = getSelectedCompanies("pl");
    const viewEl = document.getElementById("pl-view-mode");
    const byCompany = viewEl ? viewEl.value === "by_company" : false;
    const summarize = (document.getElementById("pl-summarize")?.value || "") || null;
    const startVal = document.getElementById("pl-start-date").value || null;
    const endVal = document.getElementById("pl-end-date").value || null;
    // Source-based routing: QBO → Railway; Plaid/Manual → Supabase direct.
    // byCompany on a manual company is degenerate (single company), but the
    // user might land here from a saved view — still route to Supabase so
    // they see real numbers instead of Railway's empty response.
    const __useRailway = _shouldUseRailway();
    const useSupa = !__useRailway;
    let data;
    if (useSupa) {
      const cid = (sel.company_id && sel.company_id !== "all") ? sel.company_id : selectedCompanyId;
      data = await _supaProfitLoss(cid, startVal, endVal, summarize);
    } else {
      data = await apiPost("/api/reports/profit-loss", {
        start_date: startVal,
        end_date: endVal,
        date_macro: document.getElementById("pl-date-macro").value || null,
        accounting_method: document.getElementById("pl-method").value,
        compare_prior_year: document.getElementById("pl-compare").value === "prior_year",
        compare_prior_month: document.getElementById("pl-compare").value === "prior_month",
        company_id: sel.company_id,
        company_ids: sel.company_ids,
        by_company: byCompany,
        summarize_column_by: summarize,
      });
    }
    currentReportData.pl = data;
    if (useSupa) {
      _renderSupaPLReport(data, "pl-table-wrapper");
    } else if (byCompany && data.company_breakdowns) {
      renderByCompanyReport(data, "pl-table-wrapper");
    } else {
      renderQBOReport(data, "pl-table-wrapper");
    }
    ld.classList.add("hidden"); wr.classList.remove("hidden");
  } catch (e) { ld.innerHTML = `<p style="color:var(--color-error);">Error: ${e.message}</p>`; }
}

async function loadBS() {
  _markReportRun("bs");
  const ld = document.getElementById("bs-loading");
  const wr = document.getElementById("bs-table-wrapper");
  ld.innerHTML = '<div class="loading-spinner" style="margin:0 auto;"></div><p class="mt-4">Loading Balance Sheet...</p>';
  ld.classList.remove("hidden"); wr.classList.add("hidden");

  try {
    const sel = getSelectedCompanies("bs");
    const viewEl = document.getElementById("bs-view-mode");
    const byCompany = viewEl ? viewEl.value === "by_company" : false;
    const summarize = (document.getElementById("bs-summarize")?.value || "") || null;
    const endVal = document.getElementById("bs-end-date").value || null;
    // When user picks By Month/Quarter/Year, QBO needs a start_date to know
    // where to begin the first column. Default to start of same calendar year
    // as the end date. User can still override by entering bs-start-date
    // (if that input exists on the page).
    let startVal = document.getElementById("bs-start-date")?.value || null;
    if (summarize && endVal && !startVal) {
      startVal = endVal.slice(0, 4) + "-01-01";
    }
    // Non-QBO companies (manual + Plaid) live in Supabase only — Railway's
    // /api/reports/balance-sheet returns nothing for them. Use a direct
    // Supabase build instead. Single-company AND multi-company by-company
    // are both handled here. Periods + prior-year compare are still
    // Railway-only.
    const company = _getSelectedCompany();
    // Determine the manual+Plaid candidate ids for this run.
    const candidateIds = (() => {
      if (sel.company_ids && sel.company_ids.length) return sel.company_ids;
      if (sel.company_id && sel.company_id !== "all") return [sel.company_id];
      if (selectedCompanyId) return [selectedCompanyId];
      return (allCompanies || []).filter((c) => (c.source || "qbo") !== "qbo").map((c) => c.id);
    })();
    const manualPlaidIds = candidateIds.filter((id) => {
      const c = (allCompanies || []).find((co) => co.id === id);
      return c && (c.source || "qbo") !== "qbo";
    });
    const useSupa = manualPlaidIds.length > 0 && supabaseAccessToken;
    let data;
    if (useSupa && byCompany) {
      // Use ALL selected companies (mixed sources). The aggregator pulls
      // QBO ones via Railway and manual+Plaid via Supabase.
      data = await _supaBalanceSheetByCompany(candidateIds, endVal);
    } else if (useSupa && candidateIds.length > 1) {
      // Consolidated across multiple companies — same mixed-source handling
      data = await _supaBalanceSheetConsolidated(candidateIds, endVal);
    } else if (useSupa) {
      // Single-company path
      data = await _supaBalanceSheet(manualPlaidIds[0], endVal);
    } else {
      data = await apiPost("/api/reports/balance-sheet", {
        start_date: startVal,
        end_date: endVal,
        date_macro: document.getElementById("bs-date-macro").value || null,
        accounting_method: document.getElementById("bs-method").value,
        compare_prior_year: document.getElementById("bs-compare").value === "prior_year",
        company_id: sel.company_id,
        company_ids: sel.company_ids,
        by_company: byCompany,
        summarize_column_by: summarize,
      });
    }
    currentReportData.bs = data;
    if (useSupa && byCompany) {
      _renderSupaBSByCompany(data, "bs-table-wrapper");
    } else if (useSupa) {
      _renderSupaBSReport(data, "bs-table-wrapper");
    } else if (byCompany && data.company_breakdowns) {
      renderByCompanyReport(data, "bs-table-wrapper");
    } else {
      renderQBOReport(data, "bs-table-wrapper");
    }
    ld.classList.add("hidden"); wr.classList.remove("hidden");
  } catch (e) { ld.innerHTML = `<p style="color:var(--color-error);">Error: ${e.message}</p>`; }
}

// Build a basic Balance Sheet directly from Supabase for non-QBO companies.
// No double-entry GL exists for these (journal_entries is empty), so balances
// are derived: bank/loan accounts via accounts.current_balance, A/P from
// open bills, A/R from open invoices, equity is a single derived plug.
// Period activity (P&L / CF) is intentionally not folded in here — that
// would need a Supabase-side P&L which lives in a separate function.
async function _supaBalanceSheet(companyId, endDate) {
  if (!supabaseAccessToken) throw new Error("Supabase session required.");
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  const asOf = endDate || new Date().toISOString().slice(0, 10);

  // NOTE: A GL-based Balance Sheet exists at _supaBalanceSheetFromGL but it
  // requires opening-balance journal entries to be accurate (otherwise bank
  // accounts compute from cash-leg activity only and net negative). Until
  // opening balances are backfilled, this hybrid path remains the default
  // for every company. Switching companies onto the GL BS is a per-company
  // call once their opening balances are entered.

  const [coa, accounts, openBills, openInvoices, txnsBs] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/chart_of_accounts?company_id=eq.${companyId}&is_active=eq.true&select=id,code,name,type,subtype,qbo_account_type&order=code`, { headers }).then((r) => r.ok ? r.json() : []),
    fetch(`${SUPABASE_URL}/rest/v1/accounts?company_id=eq.${companyId}&select=id,name,type,subtype,current_balance,coa_account_id`, { headers }).then((r) => r.ok ? r.json() : []),
    fetch(`${SUPABASE_URL}/rest/v1/bills?company_id=eq.${companyId}&status=in.(open,partially_paid,overdue)&date=lte.${asOf}&select=balance`, { headers }).then((r) => r.ok ? r.json() : []),
    fetch(`${SUPABASE_URL}/rest/v1/invoices?company_id=eq.${companyId}&status=in.(sent,partially_paid,overdue)&date=lte.${asOf}&select=balance`, { headers }).then((r) => r.ok ? r.json() : []),
    // For BS asset/liability/equity COAs that aren't bank-linked, the balance
    // lives in transactions categorized to them (e.g. Loan from Farm Noodle
    // gets its balance from JE/bank-txn rows hitting that liability COA).
    // Pull amount + the COA type so we can roll up in JS without a server JOIN.
    fetch(`${SUPABASE_URL}/rest/v1/transactions?company_id=eq.${companyId}&date=lte.${asOf}&parent_transaction_id=is.null&category_id=not.is.null&select=amount,category:categories(coa_account_id)&limit=20000`, { headers }).then((r) => r.ok ? r.json() : []),
  ]);

  // Per-CoA derived balance: sum of linked bank accounts' current_balance.
  // Bank accounts without a coa_account_id link show up as their own
  // standalone rows below (depository → Asset, loan → Liability).
  const bankByCoa = new Map();
  const bankLinkedCoas = new Set();
  const unlinkedBankRows = [];
  for (const a of accounts) {
    const bal = parseFloat(a.current_balance || 0);
    if (a.coa_account_id) {
      bankByCoa.set(a.coa_account_id, (bankByCoa.get(a.coa_account_id) || 0) + bal);
      bankLinkedCoas.add(a.coa_account_id);
    } else if (Math.abs(bal) > 0.005) {
      const isLiability = a.type === "loan";
      unlinkedBankRows.push({
        id: a.id, code: "—", name: a.name,
        type: isLiability ? "liability" : "asset",
        balance: bal,
      });
    }
  }

  // Roll transactions categorized to non-bank-linked asset/liability/equity
  // CoAs into the bankByCoa map. Sign rule:
  //   asset      contribution =  amount   (debit-positive)
  //   liability  contribution = -amount   (credit-positive)
  //   equity     contribution = -amount   (credit-positive)
  // Skip any CoA that already has a bank-account linked to it — those get
  // their balance from accounts.current_balance and would double-count.
  // PL CoAs (income/expense) are not balance-sheet — handled by the
  // Retained Earnings plug at the end.
  const coaTypeById = new Map(coa.map((c) => [c.id, c.type]));
  for (const t of (txnsBs || [])) {
    const coaId = t.category?.coa_account_id;
    if (!coaId) continue;
    if (bankLinkedCoas.has(coaId)) continue;
    const coaType = coaTypeById.get(coaId);
    if (coaType !== "asset" && coaType !== "liability" && coaType !== "equity") continue;
    const amt = parseFloat(t.amount || 0);
    const contribution = coaType === "asset" ? amt : -amt;
    bankByCoa.set(coaId, (bankByCoa.get(coaId) || 0) + contribution);
  }

  const totalAP = openBills.reduce((s, b) => s + parseFloat(b.balance || 0), 0);
  const totalAR = openInvoices.reduce((s, i) => s + parseFloat(i.balance || 0), 0);

  let apAssigned = false;
  let arAssigned = false;
  const accountsWithBalance = coa.map((c) => {
    let balance = bankByCoa.get(c.id) || 0;
    const nameLc = (c.name || "").toLowerCase();
    const isAP = c.type === "liability" && /payable/.test(nameLc) && !apAssigned;
    const isAR = c.type === "asset" && /receivable/.test(nameLc) && !arAssigned;
    if (isAP) { balance += totalAP; apAssigned = true; }
    if (isAR) { balance += totalAR; arAssigned = true; }
    return { id: c.id, code: c.code, name: c.name, type: c.type, subtype: c.subtype, qbo_account_type: c.qbo_account_type || null, balance };
  });

  // If no Payable/Receivable accounts existed in the CoA, fold the totals
  // into synthetic rows so they still show up.
  if (!apAssigned && totalAP > 0) {
    accountsWithBalance.push({ id: "_synth_ap", code: "—", name: "Accounts Payable (open bills)", type: "liability", qbo_account_type: "Accounts Payable", balance: totalAP });
  }
  if (!arAssigned && totalAR > 0) {
    accountsWithBalance.push({ id: "_synth_ar", code: "—", name: "Accounts Receivable (open invoices)", type: "asset", qbo_account_type: "Accounts Receivable", balance: totalAR });
  }
  // Fold standalone bank rows (no CoA link) into the same list so they
  // appear under Assets / Liabilities.
  accountsWithBalance.push(...unlinkedBankRows);

  // Sub-group order within each top-level type. Mirrors how QBO orders
  // its Balance Sheet (current assets first, fixed assets next, etc).
  // Rows without qbo_account_type fall into a flat "untyped" tail.
  const QBO_SUBGROUP_ORDER = {
    asset: ["Bank", "Accounts Receivable", "Other Current Asset", "Fixed Asset", "Other Asset"],
    liability: ["Accounts Payable", "Credit Card", "Other Current Liability", "Long Term Liability", "Other Liability"],
    equity: ["Equity"],
  };

  const buildGroup = (label, type) => {
    const all = accountsWithBalance.filter((a) => a.type === type && Math.abs(a.balance) > 0.005);
    all.sort((a, b) => (a.code || "").localeCompare(b.code || ""));
    const total = all.reduce((s, a) => s + a.balance, 0);
    const subOrder = QBO_SUBGROUP_ORDER[type] || [];
    const seen = new Set();
    const subgroups = [];
    for (const subtype of subOrder) {
      const sub = all.filter((a) => a.qbo_account_type === subtype);
      if (sub.length) {
        subgroups.push({ label: subtype, rows: sub, total: sub.reduce((s, a) => s + a.balance, 0) });
        sub.forEach((a) => seen.add(a.id));
      }
    }
    const unrecognized = all.filter((a) => a.qbo_account_type && !seen.has(a.id));
    if (unrecognized.length) {
      const otherLabel = "Other " + (type === "asset" ? "Assets" : type === "liability" ? "Liabilities" : "Equity");
      subgroups.push({ label: otherLabel, rows: unrecognized, total: unrecognized.reduce((s, a) => s + a.balance, 0) });
      unrecognized.forEach((a) => seen.add(a.id));
    }
    const untyped = all.filter((a) => !seen.has(a.id));
    return { label, type, rows: all, total, subgroups, untyped };
  };

  const assets = buildGroup("Assets", "asset");
  const liabilities = buildGroup("Liabilities", "liability");
  const equityFromCoa = buildGroup("Equity", "equity");
  // Plug equity so the sheet balances. Without journal data we can't
  // compute retained earnings / current-year net income separately.
  const derivedEquity = assets.total - liabilities.total - equityFromCoa.total;
  if (Math.abs(derivedEquity) > 0.005) {
    equityFromCoa.rows.push({ id: "_plug", code: "—", name: "Retained Earnings (derived)", type: "equity", balance: derivedEquity });
    equityFromCoa.total += derivedEquity;
  }

  return {
    asOf,
    companyId,
    groups: [assets, liabilities, equityFromCoa],
    totalAssets: assets.total,
    totalLiabilities: liabilities.total,
    totalEquity: equityFromCoa.total,
    notice: "Derived from Supabase — no double-entry GL data, so balances reflect bank/loan accounts, open A/P, open A/R, and a derived equity plug.",
  };
}

// Fetch a QBO company's Balance Sheet via Railway and flatten the nested
// QBO Rows.Row tree into [{type, name, balance}]. Used to mix a QBO company
// into the Supabase by-company / consolidated views. Times out fast (6s)
// because Railway has been unreliable for some QBO companies and we don't
// want one slow QBO call to hang the whole report — on failure returns []
// and the company shows as empty in its column.
async function _railwayBSFlatRows(qboCompanyId, endDate, accountingMethod) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(`${API}/api/reports/balance-sheet`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ end_date: endDate, accounting_method: accountingMethod || "Cash", company_id: qboCompanyId }),
      signal: ctrl.signal,
    });
    if (!r.ok) return [];
    const data = await r.json();
    const flat = [];
    const walk = (rows, parentType) => {
      const list = (rows && (rows.Row || rows.row)) || [];
      for (const row of list) {
        // Detect type from the Header label of a group row
        let nextType = parentType;
        const headerName = (row.Header?.ColData?.[0]?.value || row.group || "").toLowerCase();
        if (headerName.includes("asset")) nextType = "asset";
        else if (headerName.includes("liabilit")) nextType = "liability";
        else if (headerName.includes("equity")) nextType = "equity";
        // Leaf row (account)
        if (row.ColData && row.ColData.length >= 2 && (parentType || nextType)) {
          const name = row.ColData[0]?.value || "";
          const bal = parseFloat(row.ColData[1]?.value || "0") || 0;
          if (name) flat.push({ name, code: null, type: nextType || parentType, balance: bal });
        }
        // Recurse into nested rows
        if (row.Rows) walk(row.Rows, nextType);
      }
    };
    walk(data.current?.Rows || data.current?.rows || {}, null);
    return flat;
  } catch (e) {
    console.warn(`[BS] Railway BS fetch failed for ${qboCompanyId}: ${e?.message || e}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Convert a flat list of {type, name, balance} rows (from Railway) into a
// _supaBalanceSheet-shaped response so the merger downstream can treat
// QBO companies the same as Supabase ones.
function _railwayBSFlatToGroupedShape(flatRows, asOf) {
  const groups = ["asset", "liability", "equity"].map((type) => {
    const rows = flatRows
      .filter((r) => r.type === type && Math.abs(r.balance) > 0.005)
      .map((r) => ({ id: "_qbo:" + type + ":" + r.name, code: null, name: r.name, type, qbo_account_type: null, balance: r.balance }));
    rows.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const total = rows.reduce((s, r) => s + r.balance, 0);
    return { label: type === "asset" ? "Assets" : type === "liability" ? "Liabilities" : "Equity", type, rows, total, subgroups: [], untyped: rows };
  });
  return { asOf, groups, totalAssets: groups[0].total, totalLiabilities: groups[1].total, totalEquity: groups[2].total };
}

// Multi-company Balance Sheet: runs each company's BS in parallel
// (Supabase for manual+Plaid, Railway for QBO) and merges into one
// table with one column per company plus a Total. Rows are matched
// across companies by (type, code, name).
async function _supaBalanceSheetByCompany(companyIds, endDate) {
  if (!supabaseAccessToken) throw new Error("Supabase session required.");
  const asOf = endDate || new Date().toISOString().slice(0, 10);
  const ids = companyIds.filter(Boolean);
  if (!ids.length) return { asOf, companies: [], rowsByGroup: {}, totals: {} };

  // Run each company's BS in parallel, dispatching by source.
  const perCompany = await Promise.all(ids.map(async (id) => {
    const co = (allCompanies || []).find((c) => c.id === id);
    const isQbo = co && (co.source || "qbo") === "qbo";
    if (isQbo) {
      const flat = await _railwayBSFlatRows(id, asOf, "Cash");
      return { id, name: co?.name || id, data: _railwayBSFlatToGroupedShape(flat, asOf), source: "qbo" };
    }
    const data = await _supaBalanceSheet(id, asOf);
    return { id, name: co?.name || id, data, source: "manual" };
  }));

  // Match rows across companies by NORMALIZED NAME within type. QBO returns
  // accounts without our internal codes (codes are Plaid-side conventions),
  // so a (type, code, name) key fragments the same account into two rows.
  // Prefer whichever side has a real code/qbo_account_type when filling the
  // merged record.
  const norm = (s) => (s || "").toLowerCase().trim().replace(/\s+/g, " ");
  const rowMap = new Map();
  const groupTypes = ["asset", "liability", "equity"];
  const totalsByCompany = {};
  for (const pc of perCompany) {
    totalsByCompany[pc.id] = { asset: 0, liability: 0, equity: 0 };
    for (const g of (pc.data.groups || [])) {
      for (const r of (g.rows || [])) {
        const key = `${g.type}|${norm(r.name)}`;
        if (!rowMap.has(key)) {
          rowMap.set(key, {
            code: r.code || null,
            name: r.name,
            type: g.type,
            qbo_account_type: r.qbo_account_type || null,
            byCo: {},
            byCoCoaId: {},
          });
        }
        const slot = rowMap.get(key);
        // Prefer whichever side carries the code / sub-class.
        if (!slot.code && r.code) slot.code = r.code;
        if (!slot.qbo_account_type && r.qbo_account_type) slot.qbo_account_type = r.qbo_account_type;
        slot.byCo[pc.id] = (slot.byCo[pc.id] || 0) + (parseFloat(r.balance) || 0);
        // Track this company's CoA id for the row so a cell click can
        // drill into the right company's register.
        if (r.id && !String(r.id).startsWith("_") && !String(r.id).startsWith("_qbo:")) {
          slot.byCoCoaId[pc.id] = r.id;
        }
        totalsByCompany[pc.id][g.type] = (totalsByCompany[pc.id][g.type] || 0) + (parseFloat(r.balance) || 0);
      }
    }
  }

  // Compute Total column on each row + per-type group totals across all companies.
  const allRows = Array.from(rowMap.values()).map((r) => ({
    ...r,
    total: Object.values(r.byCo).reduce((s, v) => s + v, 0),
  }));

  const QBO_SUBGROUP_ORDER = {
    asset: ["Bank", "Accounts Receivable", "Other Current Asset", "Fixed Asset", "Other Asset"],
    liability: ["Accounts Payable", "Credit Card", "Other Current Liability", "Long Term Liability", "Other Liability"],
    equity: ["Equity"],
  };

  const groups = groupTypes.map((type) => {
    const rows = allRows.filter((r) => r.type === type && Math.abs(r.total) > 0.005);
    rows.sort((a, b) => (a.code || "").localeCompare(b.code || ""));
    const total = rows.reduce((s, r) => s + r.total, 0);
    // Subgroup by qbo_account_type
    const subOrder = QBO_SUBGROUP_ORDER[type] || [];
    const seen = new Set();
    const subgroups = [];
    for (const subtype of subOrder) {
      const sub = rows.filter((r) => r.qbo_account_type === subtype);
      if (sub.length) {
        subgroups.push({ label: subtype, rows: sub, total: sub.reduce((s, r) => s + r.total, 0) });
        sub.forEach((r) => seen.add(r));
      }
    }
    const unrecognized = rows.filter((r) => r.qbo_account_type && !seen.has(r));
    if (unrecognized.length) {
      const otherLabel = "Other " + (type === "asset" ? "Assets" : type === "liability" ? "Liabilities" : "Equity");
      subgroups.push({ label: otherLabel, rows: unrecognized, total: unrecognized.reduce((s, r) => s + r.total, 0) });
      unrecognized.forEach((r) => seen.add(r));
    }
    const untyped = rows.filter((r) => !seen.has(r));
    return { label: type === "asset" ? "Assets" : type === "liability" ? "Liabilities" : "Equity", type, rows, total, subgroups, untyped };
  });

  return {
    asOf,
    companies: perCompany.map((pc) => ({ id: pc.id, name: pc.name })),
    groups,
    totalsByCompany,
    notice: "By Company · derived from Supabase — bank/loan accounts, open A/P, open A/R, derived equity per company.",
  };
}

// Consolidated mode: sums multiple manual+Plaid companies' Balance Sheets
// into one column. Reuses _supaBalanceSheetByCompany under the hood for
// the row-matching logic, then collapses each row's per-company values
// into a single `balance` so the existing _renderSupaBSReport renderer
// can display it unchanged. Adds a derived Retained Earnings plug to
// balance the consolidated sheet (same way the single-company path does).
async function _supaBalanceSheetConsolidated(companyIds, endDate) {
  const multi = await _supaBalanceSheetByCompany(companyIds, endDate);
  const flatten = (arr) => (arr || []).map((r) => ({
    id: "_consol:" + r.type + ":" + (r.code || r.name),
    code: r.code,
    name: r.name,
    type: r.type,
    qbo_account_type: r.qbo_account_type || null,
    balance: r.total,
  }));
  const groups = multi.groups.map((g) => ({
    label: g.label,
    type: g.type,
    rows: flatten(g.rows),
    total: g.total,
    subgroups: (g.subgroups || []).map((sg) => ({
      label: sg.label,
      rows: flatten(sg.rows),
      total: sg.total,
    })),
    untyped: flatten(g.untyped),
  }));
  const totalAssets = groups.find((g) => g.type === "asset")?.total || 0;
  const totalLiabilities = groups.find((g) => g.type === "liability")?.total || 0;
  let totalEquity = groups.find((g) => g.type === "equity")?.total || 0;
  const eq = groups.find((g) => g.type === "equity");
  const plug = totalAssets - totalLiabilities - totalEquity;
  if (Math.abs(plug) > 0.005 && eq) {
    const plugRow = { id: "_plug", code: "—", name: "Retained Earnings (derived)", type: "equity", qbo_account_type: null, balance: plug };
    eq.rows.push(plugRow);
    eq.untyped = (eq.untyped || []).concat([plugRow]);
    eq.total += plug;
    totalEquity += plug;
  }
  const coNames = (multi.companies || []).map((c) => c.name).join(" + ");
  return {
    asOf: multi.asOf,
    companyId: "consolidated",
    groups,
    totalAssets,
    totalLiabilities,
    totalEquity,
    notice: `Consolidated across ${multi.companies.length} companies (${coNames}) — derived from Supabase. Bank/loan balances + open A/P + open A/R + a derived equity plug.`,
  };
}

// Renderer for the multi-company BS. Mirrors _renderSupaBSReport's
// structure but adds one column per company plus a Total column.
function _renderSupaBSByCompany(data, wrapperId) {
  const wrap = document.getElementById(wrapperId);
  const fmt = (n) => (n < 0 ? `(${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const cos = data.companies || [];
  const colCount = 2 + cos.length; // Account + per-company + Total

  let html = `<div style="padding:var(--space-3) var(--space-4);background:var(--color-bg-muted);border-radius:var(--radius-md);margin-bottom:var(--space-3);font-size:var(--text-xs);color:var(--color-text-secondary);">${_escapeHtml(data.notice || "")}</div>`;
  html += `<div style="margin-bottom:var(--space-2);font-weight:600;">Balance Sheet · By Company — As of ${data.asOf}</div>`;
  html += `<table class="qbo-report-table by-company-table" style="width:100%;border-collapse:collapse;">`;
  html += `<thead><tr><th style="text-align:left;padding:var(--space-2);">Account</th>`;
  for (const co of cos) {
    html += `<th style="text-align:right;padding:var(--space-2);" title="${_escapeHtml(co.name)}">${_escapeHtml(co.name.replace(/^Food Terminal /, "FT ").replace(/^FT Barrett /, "FTB "))}</th>`;
  }
  html += `<th style="text-align:right;padding:var(--space-2);font-weight:700;">Total</th>`;
  html += `</tr></thead><tbody>`;

  const renderRow = (r, indentExtra) => {
    const label = r.code ? `${r.code} ${r.name}` : r.name;
    const labelEsc = _escapeHtml(label).replace(/'/g, "\\'").replace(/"/g, "&quot;");
    let h = `<tr><td style="padding:2px var(--space-2);padding-left:calc(var(--space-5) + ${indentExtra || 0}px);">${_escapeHtml(label)}</td>`;
    for (const co of cos) {
      const v = r.byCo?.[co.id] || 0;
      const coaId = r.byCoCoaId?.[co.id];
      const drillable = !!coaId && Math.abs(v) > 0.005;
      const cellAttrs = drillable
        ? ` class="bs-cell-clickable" onclick="setSelectedCompany('${co.id}'); drillDownAccount('${labelEsc}','${coaId}')" title="View ${_escapeHtml(co.name).replace(/"/g, '&quot;')} register"`
        : "";
      h += `<td${cellAttrs} style="text-align:right;padding:2px var(--space-2);font-variant-numeric:tabular-nums;">${Math.abs(v) > 0.005 ? fmt(v) : "—"}</td>`;
    }
    h += `<td style="text-align:right;padding:2px var(--space-2);font-variant-numeric:tabular-nums;font-weight:600;">${fmt(r.total)}</td>`;
    h += `</tr>`;
    return h;
  };
  const subTotalRow = (label, sumByCo, total, indent) => {
    let h = `<tr><td style="padding:2px var(--space-2);padding-left:calc(var(--space-4) + ${indent || 0}px);font-style:italic;color:var(--color-text-secondary);">Total ${_escapeHtml(label)}</td>`;
    for (const co of cos) {
      const v = sumByCo[co.id] || 0;
      h += `<td style="text-align:right;padding:2px var(--space-2);font-variant-numeric:tabular-nums;font-style:italic;color:var(--color-text-secondary);">${Math.abs(v) > 0.005 ? fmt(v) : "—"}</td>`;
    }
    h += `<td style="text-align:right;padding:2px var(--space-2);font-variant-numeric:tabular-nums;font-style:italic;color:var(--color-text-secondary);">${fmt(total)}</td></tr>`;
    return h;
  };
  const groupTotalRow = (label, sumByCo, total) => {
    let h = `<tr><td style="padding:var(--space-1) var(--space-2);font-weight:600;border-top:1px dashed var(--color-border);">Total ${_escapeHtml(label)}</td>`;
    for (const co of cos) {
      const v = sumByCo[co.id] || 0;
      h += `<td style="text-align:right;padding:var(--space-1) var(--space-2);font-weight:600;font-variant-numeric:tabular-nums;border-top:1px dashed var(--color-border);">${fmt(v)}</td>`;
    }
    h += `<td style="text-align:right;padding:var(--space-1) var(--space-2);font-weight:600;font-variant-numeric:tabular-nums;border-top:1px dashed var(--color-border);">${fmt(total)}</td></tr>`;
    return h;
  };

  for (const g of data.groups) {
    html += `<tr><td colspan="${colCount}" style="font-weight:600;padding:var(--space-3) var(--space-2) var(--space-1);border-top:1px solid var(--color-border);">${_escapeHtml(g.label)}</td></tr>`;
    if (!g.rows.length) {
      html += `<tr><td colspan="${colCount}" style="padding:0 var(--space-2);color:var(--color-text-muted);">(none)</td></tr>`;
    } else if (g.subgroups && g.subgroups.length) {
      for (const sg of g.subgroups) {
        html += `<tr><td colspan="${colCount}" style="font-weight:500;padding:var(--space-2) var(--space-2) 2px;padding-left:var(--space-4);color:var(--color-text-secondary);font-size:var(--text-sm);">${_escapeHtml(sg.label)}</td></tr>`;
        for (const r of sg.rows) html += renderRow(r, 8);
        const sgByCo = {};
        for (const co of cos) sgByCo[co.id] = sg.rows.reduce((s, r) => s + (r.byCo?.[co.id] || 0), 0);
        html += subTotalRow(sg.label, sgByCo, sg.total, 0);
      }
      for (const r of (g.untyped || [])) html += renderRow(r, 0);
    } else {
      for (const r of g.rows) html += renderRow(r, 0);
    }
    const gByCo = {};
    for (const co of cos) gByCo[co.id] = data.totalsByCompany?.[co.id]?.[g.type] || 0;
    html += groupTotalRow(g.label, gByCo, g.total);
  }
  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

// GL-based Balance Sheet: every COA's balance = sum of journal_lines as of
// the asOf date. Asset/expense are debit-balance (debit−credit); liability,
// equity, income are credit-balance (credit−debit). Income/expense roll up
// into a single Retained Earnings (current-year) row under Equity.
async function _supaBalanceSheetFromGL(companyId, asOf) {
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };

  const [coa, jeRows] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/chart_of_accounts?company_id=eq.${companyId}&is_active=eq.true&select=id,code,name,type,subtype&order=code`, { headers }).then((r) => r.ok ? r.json() : []),
    fetch(`${SUPABASE_URL}/rest/v1/journal_entries?company_id=eq.${companyId}&date=lte.${asOf}&select=date,journal_lines(coa_account_id,debit,credit)&limit=20000`, { headers }).then((r) => r.ok ? r.json() : []),
  ]);

  const coaById = new Map(coa.map((c) => [c.id, c]));
  // raw[coaId] = signed natural-balance amount (debit-positive types: dr-cr;
  // credit-positive types: cr-dr).
  const raw = new Map();
  for (const je of jeRows) {
    for (const jl of (je.journal_lines || [])) {
      const c = coaById.get(jl.coa_account_id);
      if (!c) continue;
      const dr = parseFloat(jl.debit || 0);
      const cr = parseFloat(jl.credit || 0);
      const debitPositive = (c.type === "asset" || c.type === "expense");
      const delta = debitPositive ? (dr - cr) : (cr - dr);
      raw.set(c.id, (raw.get(c.id) || 0) + delta);
    }
  }

  // Roll income+expense into a single current-year Retained Earnings line.
  let netIncomeYTD = 0;
  for (const c of coa) {
    if (c.type === "income" || c.type === "expense") {
      const v = raw.get(c.id) || 0;
      // Income contributes positively, expense negatively to net income
      netIncomeYTD += (c.type === "income" ? v : -v);
    }
  }

  const accountsWithBalance = coa
    .filter((c) => c.type === "asset" || c.type === "liability" || c.type === "equity")
    .map((c) => ({ id: c.id, code: c.code, name: c.name, type: c.type, subtype: c.subtype, balance: raw.get(c.id) || 0 }));

  const buildGroup = (label, type) => {
    const rows = accountsWithBalance.filter((a) => a.type === type && Math.abs(a.balance) > 0.005);
    rows.sort((a, b) => (a.code || "").localeCompare(b.code || ""));
    const total = rows.reduce((s, a) => s + a.balance, 0);
    return { label, type, rows, total };
  };

  const assets = buildGroup("Assets", "asset");
  const liabilities = buildGroup("Liabilities", "liability");
  const equity = buildGroup("Equity", "equity");

  if (Math.abs(netIncomeYTD) > 0.005) {
    equity.rows.push({ id: "_ytd_ni", code: "—", name: "Net Income (current period)", type: "equity", balance: netIncomeYTD });
    equity.total += netIncomeYTD;
  }

  // Final balance check — should be 0 in a clean GL.
  const imbalance = assets.total - liabilities.total - equity.total;
  if (Math.abs(imbalance) > 0.005) {
    equity.rows.push({ id: "_plug", code: "—", name: "Balance Sheet Imbalance (data check)", type: "equity", balance: imbalance });
    equity.total += imbalance;
  }

  return {
    asOf,
    companyId,
    groups: [assets, liabilities, equity],
    totalAssets: assets.total,
    totalLiabilities: liabilities.total,
    totalEquity: equity.total,
    notice: "Derived from the General Ledger. Single source of truth.",
  };
}

function _renderSupaBSReport(data, wrapperId) {
  const wrap = document.getElementById(wrapperId);
  const fmt = (n) => (n < 0 ? `(${Math.abs(n).toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})})` : n.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2}));
  let html = `<div style="padding:var(--space-3) var(--space-4);background:var(--color-bg-muted);border-radius:var(--radius-md);margin-bottom:var(--space-3);font-size:var(--text-xs);color:var(--color-text-secondary);">${_escapeHtml(data.notice || "")}</div>`;
  html += `<div style="margin-bottom:var(--space-2);font-weight:600;">Balance Sheet — As of ${data.asOf}</div>`;
  html += `<table class="qbo-report-table" style="width:100%;border-collapse:collapse;">`;
  html += `<thead><tr><th style="text-align:left;padding:var(--space-2);">Account</th><th style="text-align:right;padding:var(--space-2);">Balance</th></tr></thead><tbody>`;
  const renderRow = (r, indentExtra) => {
    const drillable = r.id && !String(r.id).startsWith("_");
    const labelEsc = _escapeHtml((r.code ? r.code + " " : "") + r.name).replace(/'/g, "\\'").replace(/"/g, "&quot;");
    // Hover background makes it obvious which rows are clickable.
    const trAttrs = drillable
      ? `class="bs-row-clickable" onclick="drillDownAccount('${labelEsc}','${r.id}')" title="View transactions"`
      : "";
    const label = r.code ? `${r.code} ${r.name}` : r.name;
    return `<tr ${trAttrs}><td style="padding:2px var(--space-2);padding-left:calc(var(--space-5) + ${indentExtra || 0}px);">${_escapeHtml(label)}</td><td style="text-align:right;padding:2px var(--space-2);font-variant-numeric:tabular-nums;">${fmt(r.balance)}</td></tr>`;
  };
  for (const g of data.groups) {
    html += `<tr><td colspan="2" style="font-weight:600;padding:var(--space-3) var(--space-2) var(--space-1);border-top:1px solid var(--color-border);">${_escapeHtml(g.label)}</td></tr>`;
    if (!g.rows.length) {
      html += `<tr><td style="padding:0 var(--space-2);color:var(--color-text-muted);">(none)</td><td></td></tr>`;
    } else if (g.subgroups && g.subgroups.length) {
      // Render each QBO sub-classification as its own indented section
      // followed by a subtotal. Untyped rows render flat after the subgroups.
      for (const sg of g.subgroups) {
        html += `<tr><td colspan="2" style="font-weight:500;padding:var(--space-2) var(--space-2) 2px;padding-left:var(--space-4);color:var(--color-text-secondary);font-size:var(--text-sm);">${_escapeHtml(sg.label)}</td></tr>`;
        for (const r of sg.rows) html += renderRow(r, 8);
        html += `<tr><td style="padding:2px var(--space-2);padding-left:var(--space-4);font-style:italic;color:var(--color-text-secondary);">Total ${_escapeHtml(sg.label)}</td><td style="text-align:right;padding:2px var(--space-2);font-variant-numeric:tabular-nums;font-style:italic;color:var(--color-text-secondary);">${fmt(sg.total)}</td></tr>`;
      }
      for (const r of (g.untyped || [])) html += renderRow(r, 0);
    } else {
      for (const r of g.rows) html += renderRow(r, 0);
    }
    html += `<tr><td style="padding:var(--space-1) var(--space-2);font-weight:600;border-top:1px dashed var(--color-border);">Total ${_escapeHtml(g.label)}</td><td style="text-align:right;padding:var(--space-1) var(--space-2);font-weight:600;font-variant-numeric:tabular-nums;border-top:1px dashed var(--color-border);">${fmt(g.total)}</td></tr>`;
  }
  const liabPlusEquity = data.totalLiabilities + data.totalEquity;
  html += `<tr><td style="padding:var(--space-3) var(--space-2);font-weight:700;border-top:2px solid var(--color-border);">Total Liabilities + Equity</td><td style="text-align:right;padding:var(--space-3) var(--space-2);font-weight:700;font-variant-numeric:tabular-nums;border-top:2px solid var(--color-border);">${fmt(liabPlusEquity)}</td></tr>`;
  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

// Cash-basis P&L from Supabase. Routes to the GL-based builder when the
// company has any journal_entries (proper double-entry data); otherwise
// falls back to the legacy transactions × categories × COA path that has
// served manual+Plaid companies prior to the GL backfill.
async function _supaProfitLoss(companyId, startDate, endDate, summarizeBy) {
  if (!supabaseAccessToken) throw new Error("Supabase session required.");
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  // Detect whether this company has GL data — if yes, use it.
  try {
    const probe = await fetch(
      `${SUPABASE_URL}/rest/v1/journal_entries?company_id=eq.${companyId}&select=id&limit=1`,
      { headers }
    );
    if (probe.ok) {
      const rows = await probe.json();
      if (Array.isArray(rows) && rows.length > 0) {
        return _supaProfitLossFromGL(companyId, startDate, endDate, summarizeBy);
      }
    }
  } catch { /* fall through to legacy path */ }
  return _supaProfitLossFromTxns(companyId, startDate, endDate, summarizeBy);
}

// Legacy P&L: reads transactions × categories × chart_of_accounts. Kept
// for companies that don't have a general ledger populated yet.
async function _supaProfitLossFromTxns(companyId, startDate, endDate, summarizeBy) {
  if (!supabaseAccessToken) throw new Error("Supabase session required.");
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  const start = startDate || `${new Date().getFullYear()}-01-01`;
  const end = endDate || new Date().toISOString().slice(0, 10);

  const [coa, categories, txns] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/chart_of_accounts?company_id=eq.${companyId}&is_active=eq.true&type=in.(income,expense)&select=id,code,name,type,subtype&order=code`, { headers }).then((r) => r.ok ? r.json() : []),
    // transactions.category_id → categories.id → categories.coa_account_id → chart_of_accounts.id
    fetch(`${SUPABASE_URL}/rest/v1/categories?company_id=eq.${companyId}&select=id,coa_account_id`, { headers }).then((r) => r.ok ? r.json() : []),
    // Pull only the txns we need: in-period, not transfers, not split parents
    // Pull date too — needed when summarizing by month/quarter/year.
    fetch(`${SUPABASE_URL}/rest/v1/transactions?company_id=eq.${companyId}&date=gte.${start}&date=lte.${end}&is_transfer=eq.false&parent_transaction_id=is.null&select=date,amount,category_id&limit=10000`, { headers }).then((r) => r.ok ? r.json() : []),
  ]);

  // Build the category → CoA bridge
  const catToCoa = new Map();
  for (const c of categories) {
    if (c.coa_account_id) catToCoa.set(c.id, c.coa_account_id);
  }

  // Decide summary axis. The select sends "Month" / "Quarter" / "Year" with
  // an initial cap, so normalise once up front — the comparisons below were
  // all lowercase and silently fell through to the single-column path.
  const sb = (summarizeBy || "").toLowerCase();
  const colKey = (date) => {
    if (!date) return "Total";
    if (sb === "month") return date.slice(0, 7);          // "2026-04"
    if (sb === "quarter") {
      const m = parseInt(date.slice(5, 7), 10);
      return `${date.slice(0, 4)}-Q${Math.ceil(m / 3)}`;
    }
    if (sb === "year") return date.slice(0, 4);
    return "Total";
  };
  const colLabel = (key) => {
    if (key === "Total") return "Total";
    if (sb === "month") {
      const [y, m] = key.split("-");
      return new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1).toLocaleString("en-US", { month: "short", year: "numeric" });
    }
    return key;
  };

  // byCoaCol: coaId -> Map<colKey, sum>
  const byCoaCol = new Map();
  const colKeysSet = new Set();
  for (const t of txns) {
    if (!t.category_id) continue;
    const coaId = catToCoa.get(t.category_id);
    if (!coaId) continue;
    const k = colKey(t.date);
    colKeysSet.add(k);
    let m = byCoaCol.get(coaId);
    if (!m) { m = new Map(); byCoaCol.set(coaId, m); }
    m.set(k, (m.get(k) || 0) + parseFloat(t.amount || 0));
  }

  // Build the column list. For "Total" mode there's just one column.
  // For summarized modes, build the full sequence between start and end so
  // months with zero activity still appear (matches QBO behavior).
  let columns = [];
  if (!sb) {
    columns = [{ key: "Total", label: "Total" }];
  } else {
    const keys = Array.from(colKeysSet);
    keys.sort();
    columns = keys.map((k) => ({ key: k, label: colLabel(k) }));
    if (!columns.length) columns = [{ key: colKey(start), label: colLabel(colKey(start)) }];
  }

  const buildRow = (c) => {
    const m = byCoaCol.get(c.id) || new Map();
    const byColumn = {};
    let total = 0;
    for (const col of columns) {
      const v = m.get(col.key) || 0;
      // Income: flip sign so revenue reads positive.
      const display = c.type === "income" ? -v : v;
      byColumn[col.key] = display;
      total += display;
    }
    return { id: c.id, code: c.code, name: c.name, type: c.type, byColumn, balance: total };
  };

  const incomeRows = coa.filter((c) => c.type === "income").map(buildRow).filter((r) => columns.some((col) => Math.abs(r.byColumn[col.key]) > 0.005));
  const expenseRows = coa.filter((c) => c.type === "expense").map(buildRow).filter((r) => columns.some((col) => Math.abs(r.byColumn[col.key]) > 0.005));
  incomeRows.sort((a, b) => (a.code || "").localeCompare(b.code || ""));
  expenseRows.sort((a, b) => (a.code || "").localeCompare(b.code || ""));

  const colTotals = (rows) => {
    const out = { total: 0 };
    for (const col of columns) {
      out[col.key] = rows.reduce((s, r) => s + (r.byColumn[col.key] || 0), 0);
      out.total += out[col.key];
    }
    return out;
  };
  const incomeTotals = colTotals(incomeRows);
  const expenseTotals = colTotals(expenseRows);
  const netByColumn = {};
  for (const col of columns) {
    netByColumn[col.key] = (incomeTotals[col.key] || 0) - (expenseTotals[col.key] || 0);
  }

  return {
    start, end,
    columns,
    groups: [
      { label: "Income",  rows: incomeRows,  totals: incomeTotals,  total: incomeTotals.total },
      { label: "Expense", rows: expenseRows, totals: expenseTotals, total: expenseTotals.total },
    ],
    totalIncome: incomeTotals.total,
    totalExpense: expenseTotals.total,
    netIncome: incomeTotals.total - expenseTotals.total,
    netByColumn,
    notice: "Cash basis · derived from categorized transactions in Supabase (legacy path — no GL data for this company yet). No prior-period compare yet.",
  };
}

// GL-based P&L: reads journal_lines × journal_entries × chart_of_accounts.
// Income COAs naturally hold credit balances (revenue = credits − debits);
// expense COAs are debit balances (expense = debits − credits). Same shape
// as _supaProfitLossFromTxns so the renderer doesn't need to change.
async function _supaProfitLossFromGL(companyId, startDate, endDate, summarizeBy) {
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  const start = startDate || `${new Date().getFullYear()}-01-01`;
  const end = endDate || new Date().toISOString().slice(0, 10);

  const [coa, jeRows] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/chart_of_accounts?company_id=eq.${companyId}&is_active=eq.true&type=in.(income,expense)&select=id,code,name,type,subtype&order=code`, { headers }).then((r) => r.ok ? r.json() : []),
    // Pull every JE in range with its lines inlined via PostgREST embed
    fetch(`${SUPABASE_URL}/rest/v1/journal_entries?company_id=eq.${companyId}&date=gte.${start}&date=lte.${end}&select=date,journal_lines(coa_account_id,debit,credit)&limit=10000`, { headers }).then((r) => r.ok ? r.json() : []),
  ]);

  const sb = (summarizeBy || "").toLowerCase();
  const colKey = (date) => {
    if (!date) return "Total";
    if (sb === "month") return date.slice(0, 7);
    if (sb === "quarter") {
      const m = parseInt(date.slice(5, 7), 10);
      return `${date.slice(0, 4)}-Q${Math.ceil(m / 3)}`;
    }
    if (sb === "year") return date.slice(0, 4);
    return "Total";
  };
  const colLabel = (key) => {
    if (key === "Total") return "Total";
    if (sb === "month") {
      const [y, m] = key.split("-");
      return new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1).toLocaleString("en-US", { month: "short", year: "numeric" });
    }
    return key;
  };

  const coaTypeById = new Map(coa.map((c) => [c.id, c.type]));
  // byCoaCol: coaId -> Map<colKey, signed P&L amount>
  const byCoaCol = new Map();
  const colKeysSet = new Set();
  for (const je of jeRows) {
    const k = colKey(je.date);
    for (const jl of (je.journal_lines || [])) {
      const t = coaTypeById.get(jl.coa_account_id);
      if (t !== "income" && t !== "expense") continue;
      const dr = parseFloat(jl.debit || 0);
      const cr = parseFloat(jl.credit || 0);
      // Income: revenue is credit-balance, so the natural P&L value is cr-dr.
      // Expense: dr-cr. We store the "raw" value (income negative, expense positive)
      // mirroring the legacy path so buildRow's sign-flip logic stays consistent.
      const raw = t === "income" ? -(cr - dr) : (dr - cr);
      colKeysSet.add(k);
      let m = byCoaCol.get(jl.coa_account_id);
      if (!m) { m = new Map(); byCoaCol.set(jl.coa_account_id, m); }
      m.set(k, (m.get(k) || 0) + raw);
    }
  }

  let columns = [];
  if (!sb) {
    columns = [{ key: "Total", label: "Total" }];
  } else {
    const keys = Array.from(colKeysSet); keys.sort();
    columns = keys.map((k) => ({ key: k, label: colLabel(k) }));
    if (!columns.length) columns = [{ key: colKey(start), label: colLabel(colKey(start)) }];
  }

  const buildRow = (c) => {
    const m = byCoaCol.get(c.id) || new Map();
    const byColumn = {};
    let total = 0;
    for (const col of columns) {
      const v = m.get(col.key) || 0;
      const display = c.type === "income" ? -v : v;
      byColumn[col.key] = display;
      total += display;
    }
    return { id: c.id, code: c.code, name: c.name, type: c.type, byColumn, balance: total };
  };

  const incomeRows = coa.filter((c) => c.type === "income").map(buildRow).filter((r) => columns.some((col) => Math.abs(r.byColumn[col.key]) > 0.005));
  const expenseRows = coa.filter((c) => c.type === "expense").map(buildRow).filter((r) => columns.some((col) => Math.abs(r.byColumn[col.key]) > 0.005));
  incomeRows.sort((a, b) => (a.code || "").localeCompare(b.code || ""));
  expenseRows.sort((a, b) => (a.code || "").localeCompare(b.code || ""));

  const colTotals = (rows) => {
    const out = { total: 0 };
    for (const col of columns) {
      out[col.key] = rows.reduce((s, r) => s + (r.byColumn[col.key] || 0), 0);
      out.total += out[col.key];
    }
    return out;
  };
  const incomeTotals = colTotals(incomeRows);
  const expenseTotals = colTotals(expenseRows);
  const netByColumn = {};
  for (const col of columns) {
    netByColumn[col.key] = (incomeTotals[col.key] || 0) - (expenseTotals[col.key] || 0);
  }

  return {
    start, end,
    columns,
    groups: [
      { label: "Income",  rows: incomeRows,  totals: incomeTotals,  total: incomeTotals.total },
      { label: "Expense", rows: expenseRows, totals: expenseTotals, total: expenseTotals.total },
    ],
    totalIncome: incomeTotals.total,
    totalExpense: expenseTotals.total,
    netIncome: incomeTotals.total - expenseTotals.total,
    netByColumn,
    notice: "Cash basis · derived from the General Ledger. Single source of truth.",
  };
}

function _renderSupaPLReport(data, wrapperId) {
  const wrap = document.getElementById(wrapperId);
  const fmt = (n) => (n < 0 ? `(${Math.abs(n).toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})})` : n.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2}));
  const cols = data.columns || [{ key: "Total", label: "Total" }];
  const showCols = cols.length > 1;
  let html = `<div style="padding:var(--space-3) var(--space-4);background:var(--color-bg-muted);border-radius:var(--radius-md);margin-bottom:var(--space-3);font-size:var(--text-xs);color:var(--color-text-secondary);">${_escapeHtml(data.notice || "")}</div>`;
  html += `<div style="margin-bottom:var(--space-2);font-weight:600;">Profit &amp; Loss — ${data.start} to ${data.end}</div>`;
  html += `<table class="qbo-report-table" style="width:100%;border-collapse:collapse;">`;
  // Header row: Account + each column + Total (when multiple cols)
  html += `<thead><tr><th style="text-align:left;padding:var(--space-2);">Account</th>`;
  for (const col of cols) {
    html += `<th style="text-align:right;padding:var(--space-2);">${_escapeHtml(col.label)}</th>`;
  }
  if (showCols) html += `<th style="text-align:right;padding:var(--space-2);">Total</th>`;
  html += `</tr></thead><tbody>`;
  const colspan = 1 + cols.length + (showCols ? 1 : 0);
  for (const g of data.groups) {
    html += `<tr><td colspan="${colspan}" style="font-weight:600;padding:var(--space-3) var(--space-2) var(--space-1);border-top:1px solid var(--color-border);">${_escapeHtml(g.label)}</td></tr>`;
    if (!g.rows.length) {
      html += `<tr><td style="padding:0 var(--space-2);color:var(--color-text-muted);">(none)</td>${'<td></td>'.repeat(colspan - 1)}</tr>`;
    } else {
      for (const r of g.rows) {
        const labelEsc = _escapeHtml((r.code ? r.code + " " : "") + r.name).replace(/'/g, "\\'");
        html += `<tr style="cursor:pointer;" onclick="drillDownAccount('${labelEsc}','${r.id}')" title="View transactions">`;
        html += `<td style="padding:2px var(--space-2);padding-left:var(--space-5);">${_escapeHtml(r.code || "—")} ${_escapeHtml(r.name)}</td>`;
        for (const col of cols) {
          const v = (r.byColumn && r.byColumn[col.key] !== undefined) ? r.byColumn[col.key] : (cols.length === 1 ? r.balance : 0);
          html += `<td style="text-align:right;padding:2px var(--space-2);font-variant-numeric:tabular-nums;">${fmt(v)}</td>`;
        }
        if (showCols) html += `<td style="text-align:right;padding:2px var(--space-2);font-variant-numeric:tabular-nums;font-weight:600;">${fmt(r.balance)}</td>`;
        html += `</tr>`;
      }
    }
    // Group totals row
    html += `<tr><td style="padding:var(--space-1) var(--space-2);font-weight:600;border-top:1px dashed var(--color-border);">Total ${_escapeHtml(g.label)}</td>`;
    for (const col of cols) {
      const v = g.totals ? (g.totals[col.key] || 0) : g.total;
      html += `<td style="text-align:right;padding:var(--space-1) var(--space-2);font-weight:600;font-variant-numeric:tabular-nums;border-top:1px dashed var(--color-border);">${fmt(v)}</td>`;
    }
    if (showCols) html += `<td style="text-align:right;padding:var(--space-1) var(--space-2);font-weight:600;font-variant-numeric:tabular-nums;border-top:1px dashed var(--color-border);">${fmt(g.total)}</td>`;
    html += `</tr>`;
  }
  // Net Income row (per column when multi)
  html += `<tr><td style="padding:var(--space-3) var(--space-2);font-weight:700;border-top:2px solid var(--color-border);">Net Income</td>`;
  for (const col of cols) {
    const v = data.netByColumn ? (data.netByColumn[col.key] || 0) : data.netIncome;
    html += `<td style="text-align:right;padding:var(--space-3) var(--space-2);font-weight:700;font-variant-numeric:tabular-nums;border-top:2px solid var(--color-border);">${fmt(v)}</td>`;
  }
  if (showCols) html += `<td style="text-align:right;padding:var(--space-3) var(--space-2);font-weight:700;font-variant-numeric:tabular-nums;border-top:2px solid var(--color-border);">${fmt(data.netIncome)}</td>`;
  html += `</tr></tbody></table>`;
  wrap.innerHTML = html;
}

// Cash Flow: per-bank-account net cash movement over the period. We don't
// derive Operating/Investing/Financing categorization (would need
// per-category metadata) — this is a simple net-cash view.
async function _supaCashFlow(companyId, startDate, endDate) {
  if (!supabaseAccessToken) throw new Error("Supabase session required.");
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  const start = startDate || `${new Date().getFullYear()}-01-01`;
  const end = endDate || new Date().toISOString().slice(0, 10);

  const [accounts, txns] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/accounts?company_id=eq.${companyId}&type=in.(depository,loan)&select=id,name,type,subtype,current_balance&order=name`, { headers }).then((r) => r.ok ? r.json() : []),
    fetch(`${SUPABASE_URL}/rest/v1/transactions?company_id=eq.${companyId}&date=gte.${start}&date=lte.${end}&is_transfer=eq.false&parent_transaction_id=is.null&select=account_id,amount&limit=20000`, { headers }).then((r) => r.ok ? r.json() : []),
  ]);

  const byAcct = new Map();
  for (const t of txns) {
    const k = t.account_id;
    if (!k) continue;
    const v = byAcct.get(k) || { inflows: 0, outflows: 0 };
    const amt = parseFloat(t.amount || 0);
    if (amt < 0) v.inflows += -amt;       // negative = money in
    else v.outflows += amt;                // positive = money out
    byAcct.set(k, v);
  }

  const rows = [];
  for (const a of accounts) {
    const m = byAcct.get(a.id) || { inflows: 0, outflows: 0 };
    const net = m.inflows - m.outflows;
    if (Math.abs(net) < 0.005 && Math.abs(m.inflows) < 0.005 && Math.abs(m.outflows) < 0.005) continue;
    rows.push({ id: a.id, name: a.name, type: a.type, inflows: m.inflows, outflows: m.outflows, net });
  }
  const totalNet = rows.reduce((s, r) => s + r.net, 0);
  const totalInflows = rows.reduce((s, r) => s + r.inflows, 0);
  const totalOutflows = rows.reduce((s, r) => s + r.outflows, 0);

  return {
    start, end,
    accounts: rows,
    totalInflows,
    totalOutflows,
    totalNet,
    notice: "Net cash movement per bank account · derived from transactions in Supabase. No Operating/Investing/Financing split or compare yet.",
  };
}

function _renderSupaCFReport(data, wrapperId) {
  const wrap = document.getElementById(wrapperId);
  const fmt = (n) => (n < 0 ? `(${Math.abs(n).toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})})` : n.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2}));
  let html = `<div style="padding:var(--space-3) var(--space-4);background:var(--color-bg-muted);border-radius:var(--radius-md);margin-bottom:var(--space-3);font-size:var(--text-xs);color:var(--color-text-secondary);">${_escapeHtml(data.notice || "")}</div>`;
  html += `<div style="margin-bottom:var(--space-2);font-weight:600;">Cash Flow — ${data.start} to ${data.end}</div>`;
  html += `<table class="qbo-report-table" style="width:100%;border-collapse:collapse;">`;
  html += `<thead><tr><th style="text-align:left;padding:var(--space-2);">Account</th><th style="text-align:right;padding:var(--space-2);">Inflows</th><th style="text-align:right;padding:var(--space-2);">Outflows</th><th style="text-align:right;padding:var(--space-2);">Net</th></tr></thead><tbody>`;
  if (!data.accounts.length) {
    html += `<tr><td colspan="4" style="padding:var(--space-4);text-align:center;color:var(--color-text-muted);">No transactions in this period.</td></tr>`;
  } else {
    for (const r of data.accounts) {
      html += `<tr><td style="padding:2px var(--space-2);">${_escapeHtml(r.name)}</td>`
        + `<td style="text-align:right;padding:2px var(--space-2);font-variant-numeric:tabular-nums;">${fmt(r.inflows)}</td>`
        + `<td style="text-align:right;padding:2px var(--space-2);font-variant-numeric:tabular-nums;">${fmt(r.outflows)}</td>`
        + `<td style="text-align:right;padding:2px var(--space-2);font-variant-numeric:tabular-nums;">${fmt(r.net)}</td></tr>`;
    }
  }
  html += `<tr><td style="padding:var(--space-3) var(--space-2);font-weight:700;border-top:2px solid var(--color-border);">Net Change in Cash</td>`
    + `<td style="text-align:right;padding:var(--space-3) var(--space-2);font-weight:700;font-variant-numeric:tabular-nums;border-top:2px solid var(--color-border);">${fmt(data.totalInflows)}</td>`
    + `<td style="text-align:right;padding:var(--space-3) var(--space-2);font-weight:700;font-variant-numeric:tabular-nums;border-top:2px solid var(--color-border);">${fmt(data.totalOutflows)}</td>`
    + `<td style="text-align:right;padding:var(--space-3) var(--space-2);font-weight:700;font-variant-numeric:tabular-nums;border-top:2px solid var(--color-border);">${fmt(data.totalNet)}</td></tr>`;
  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

async function loadCF() {
  _markReportRun("cf");
  const ld = document.getElementById("cf-loading");
  const wr = document.getElementById("cf-table-wrapper");
  ld.innerHTML = '<div class="loading-spinner" style="margin:0 auto;"></div><p class="mt-4">Loading Cash Flow...</p>';
  ld.classList.remove("hidden"); wr.classList.add("hidden");

  try {
    const sel = getSelectedCompanies("cf");
    const viewEl = document.getElementById("cf-view-mode");
    const byCompany = viewEl ? viewEl.value === "by_company" : false;
    const summarize = (document.getElementById("cf-summarize")?.value || "") || null;
    const startVal = document.getElementById("cf-start-date").value || null;
    const endVal = document.getElementById("cf-end-date").value || null;
    const __useRailway = _shouldUseRailway();
    const useSupa = !__useRailway && !byCompany;
    let data;
    if (useSupa) {
      const cid = (sel.company_id && sel.company_id !== "all") ? sel.company_id : selectedCompanyId;
      data = await _supaCashFlow(cid, startVal, endVal);
    } else {
      data = await apiPost("/api/reports/cash-flow", {
        start_date: startVal,
        end_date: endVal,
        date_macro: document.getElementById("cf-date-macro").value || null,
        compare_prior_year: document.getElementById("cf-compare").value === "prior_year",
        company_id: sel.company_id,
        company_ids: sel.company_ids,
        by_company: byCompany,
        summarize_column_by: summarize,
      });
    }
    currentReportData.cf = data;
    if (useSupa) {
      _renderSupaCFReport(data, "cf-table-wrapper");
    } else if (byCompany && data.company_breakdowns) {
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

  // Detect column-summarized response: Columns.Column has more than 2 entries
  const colDefs = current.Columns?.Column || current.columns?.Column || [];
  const periodCols = colDefs.slice(1); // first is Account
  const isMultiCol = periodCols.length > 1;

  if (isMultiCol) {
    let html = top + '<table class="data-table"><thead><tr><th>Account</th>';
    for (const c of periodCols) html += `<th class="num">${c.ColTitle || c.col_title || ""}</th>`;
    html += "</tr></thead><tbody>";
    html += renderRowsMulti((current.Rows || current.rows || {}).Row || [], 0, periodCols.length);
    html += "</tbody></table>";
    wrapper.innerHTML = html;
    return;
  }

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

// Render rows for a multi-column summarized report (by month/quarter/year).
// Each ColData: [name, val_1, val_2, ..., val_N]. nPeriod = N.
function renderRowsMulti(arr, depth, nPeriod) {
  const fmt = (s) => {
    const n = parseFloat(s) || 0;
    if (n === 0) return "$0.00";
    return (n < 0 ? "\u2212" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  let h = "";
  for (const r of arr) {
    if (r.type === "Section" || r.group) {
      if (r.Header?.ColData) {
        h += `<tr class="section-header"><td colspan="${nPeriod + 1}">${r.Header.ColData[0]?.value || ""}</td></tr>`;
      }
      if (r.Rows?.Row) h += renderRowsMulti(r.Rows.Row, depth + 1, nPeriod);
      if (r.Summary?.ColData) {
        const cd = r.Summary.ColData;
        const name = cd[0]?.value || "Total";
        let row = `<tr class="total-row"><td>${name}</td>`;
        for (let i = 1; i <= nPeriod; i++) {
          row += `<td class="num">${fmt(cd[i]?.value)}</td>`;
        }
        h += row + "</tr>";
      }
    } else if (r.ColData) {
      const cd = r.ColData;
      const name = cd[0]?.value || "";
      const cls = depth > 0 ? `indent-${Math.min(depth, 2)}` : "";
      let row = `<tr class="${cls}"><td>${name}</td>`;
      for (let i = 1; i <= nPeriod; i++) {
        row += `<td class="num">${fmt(cd[i]?.value)}</td>`;
      }
      h += row + "</tr>";
    }
  }
  return h;
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

async function drillDownAccount(accountName, coaId) {
  const ctx = _getActiveReportContext();
  const modal = document.getElementById("txn-detail-modal");
  const loading = document.getElementById("txn-detail-loading");
  const table = document.getElementById("txn-detail-table");

  const _ttl = `Transaction Detail: ${accountName}`;
  document.getElementById("txn-detail-title").textContent = _ttl;
  document.getElementById("txn-detail-title").title = _ttl;
  document.getElementById("txn-detail-badge").textContent = `Account: ${accountName}`;
  const dm = ctx.date_macro || "";
  const sd = ctx.start_date || "";
  const ed = ctx.end_date || "";
  document.getElementById("txn-detail-date-range").textContent = dm ? dm : (sd && ed ? `${sd} to ${ed}` : "");

  loading.classList.remove("hidden");
  table.innerHTML = "";
  modal.classList.add("active");

  try {
    let data;
    if (_shouldUseRailway()) {
      data = await apiPost("/api/reports/transaction-detail", {
        account_name: accountName,
        company_id: ctx.company_id || "all",
        company_ids: ctx.company_ids || null,
        start_date: ctx.start_date || null,
        end_date: ctx.end_date || null,
        date_macro: ctx.date_macro || null,
        accounting_method: ctx.accounting_method || "Accrual",
      });
    } else {
      // Supabase drill: filter the register query to the active report's
      // date range. coaId is required to find the matching transactions.
      data = await _supaAccountRegister(coaId, accountName, ctx.start_date, ctx.end_date);
    }
    currentTxnDetail = Object.assign({}, data, { account_name: accountName, drill_coa_id: coaId });
    loading.classList.add("hidden");
    renderTransactionDetail(currentTxnDetail);
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
  const hasEditable = txns.some(t => t.editable && t.id);

  let html = '<table class="data-table txn-detail-table"><thead><tr>';
  for (const col of activeCols) {
    html += `<th${col.numeric ? ' class="num"' : ''}>${col.label}</th>`;
  }
  if (hasEditable) html += '<th style="width:110px;">Actions</th>';
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
    if (hasEditable) {
      if (txn.editable && txn.id) {
        html += `<td style="white-space:nowrap;">`
             +  `<button class="btn btn-sm btn-ghost" onclick="drillEditTxn('${txn.id}')" title="Change category">Edit</button> `
             +  `<button class="btn btn-sm btn-ghost" onclick="drillDeleteTxn('${txn.id}')" title="Delete transaction" style="color:var(--color-error);">Delete</button>`
             +  `</td>`;
      } else {
        html += '<td></td>';
      }
    }
    html += '</tr>';
  }

  // Footer totals
  let summaryColspan = activeCols.filter(c => !c.numeric).length;
  html += '<tr class="total-row"><td colspan="' + summaryColspan + '" style="text-align:right;font-weight:600;">Total (' + txns.length + ' transactions)</td>';
  for (const col of activeCols) {
    if (!col.numeric) continue;
    if (col.key === "Debit") html += `<td class="num">${fmt(totalDebit)}</td>`;
    else if (col.key === "Credit") html += `<td class="num">${fmt(totalCredit)}</td>`;
    else if (col.key === "Amount") html += `<td class="num">${fmt(totalAmount)}</td>`;
    else html += '<td></td>';
  }
  if (hasEditable) html += '<td></td>';
  html += '</tr>';

  html += '</tbody></table>';
  el.innerHTML = html;
}

async function _refreshDrillModal() {
  if (currentTxnDetail?.vendor_id) {
    await openVendorTransactions(currentTxnDetail.vendor_id, currentTxnDetail.vendor_name);
    return;
  }
  if (currentTxnDetail?.register_account_name && currentTxnDetail?.register_company_id) {
    await openAccountRegister("", currentTxnDetail.register_account_name);
    return;
  }
  if (currentTxnDetail?.account_name) {
    const ctx = _getActiveReportContext();
    if (_shouldUseRailway()) {
      const data = await apiPost("/api/reports/transaction-detail", {
        account_name: currentTxnDetail.account_name,
        company_id: ctx.company_id || "all",
        company_ids: ctx.company_ids || null,
        start_date: ctx.start_date || null,
        end_date: ctx.end_date || null,
        date_macro: ctx.date_macro || null,
        accounting_method: ctx.accounting_method || "Accrual",
      });
      currentTxnDetail = data;
      renderTransactionDetail(data);
    } else {
      // No CoA id from a P&L/BS drill — render whatever we already had.
      // Account-register flow uses register_account_name and runs its own
      // path above, so this branch is mainly defensive.
      renderTransactionDetail(currentTxnDetail);
    }
  }
}

async function drillDeleteTxn(txnId) {
  if (!confirm("Delete this transaction? This cannot be undone.")) return;
  try {
    if (_shouldUseRailway()) {
      await apiDelete(`/api/transactions/${txnId}`);
    } else {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/transactions?id=eq.${encodeURIComponent(txnId)}`, {
        method: "DELETE",
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` },
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    showToast("Deleted.", "success");
    await _refreshDrillModal();
  } catch (e) {
    showToast("Delete failed: " + (e.message || e), "error");
  }
}

async function drillEditTxn(txnId) {
  if (typeof openCategoryPicker === "function") {
    openCategoryPicker(txnId, async (catId) => {
      try {
        if (_shouldUseRailway()) await apiPatch(`/api/transactions/${txnId}`, { category_id: catId });
        else await _supaTxnPatch(txnId, { category_id: catId });
        showToast("Category updated.", "success");
        await _refreshDrillModal();
      } catch (e) { showToast("Update failed: " + (e.message || e), "error"); }
    });
  } else {
    showToast("Open the Transactions page to edit this row.", "info");
  }
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
    el.innerHTML = '<p class="text-muted" style="padding:var(--space-4);font-size:var(--text-sm);">No companies yet. Click "Add Company" above to add your first one.</p>';
    return;
  }
  let html = '<table class="data-table"><thead><tr><th>Company</th><th>Source</th><th>Status</th><th>Last Synced</th><th>Actions</th></tr></thead><tbody>';
  for (const c of allCompanies) {
    const isManual = (c.source || "qbo") === "manual";
    const srcBadge = isManual
      ? `<span class="source-badge manual">Manual + Plaid</span>`
      : `<span class="source-badge qbo">QuickBooks</span>`;
    const safeName = c.name.replace(/'/g, "\\'");

    // Build main cell (name + sub-line for manual bank status)
    let mainCell = `<strong>${_escapeHtml(c.name)}</strong>`;
    if (isManual) {
      const items = c.plaid_items || [];
      if (items.length === 0) {
        mainCell += `<div style="font-size:var(--text-xs);color:var(--color-error);margin-top:2px;">⚠ No bank linked — reports will be empty</div>`;
      } else {
        const totalAccts = items.reduce((s, it) => s + (it.accounts_count || 0), 0);
        const bankNames = items.map((it) => it.institution_name || "Bank").join(", ");
        const lastSync = items.map((it) => it.last_synced_at).filter(Boolean).sort().reverse()[0];
        const syncedAgo = lastSync ? _timeAgo(new Date(lastSync)) : "never";
        mainCell += `<div style="font-size:var(--text-xs);color:var(--color-text-secondary);margin-top:2px;">🏦 ${_escapeHtml(bankNames)} · ${totalAccts} account${totalAccts === 1 ? "" : "s"} · synced ${syncedAgo}</div>`;
      }
    } else if (c.legal_name) {
      mainCell += `<div style="font-size:var(--text-xs);color:var(--color-text-secondary);margin-top:2px;">${_escapeHtml(c.legal_name)}</div>`;
    }

    // Status
    let statusBadge, statusLabel;
    if (isManual) {
      if (!c.plaid_items || c.plaid_items.length === 0) {
        statusBadge = "badge-warning"; statusLabel = "No bank";
      } else if (c.plaid_items.some((it) => it.status && it.status !== "good")) {
        statusBadge = "badge-warning"; statusLabel = "Needs attention";
      } else {
        statusBadge = "badge-success"; statusLabel = "Active";
      }
    } else {
      statusBadge = c.status === "connected" ? "badge-success" : c.status === "syncing" ? "badge-warning" : "badge-neutral";
      statusLabel = c.status === "connected" ? "Connected" : c.status === "syncing" ? "Syncing" : "Disconnected";
    }
    const synced = c.last_synced ? new Date(c.last_synced + "Z").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";

    // Actions — contextual
    let actionBtns = "";
    if (isManual) {
      const hasBank = (c.plaid_items || []).length > 0;
      if (!hasBank) {
        actionBtns = `
          <button class="btn btn-sm btn-primary" onclick="connectPlaidBank('${c.id}','${safeName}')">Connect Bank →</button>
          <button class="btn btn-sm btn-ghost" style="color:var(--color-error);" onclick="removeCompany('${c.id}','${safeName}')">&times;</button>`;
      } else {
        actionBtns = `
          <button class="btn btn-sm btn-secondary" onclick="setSelectedCompany('${c.id}');navigateTo('transactions');">View</button>
          <button class="btn btn-sm btn-secondary" onclick="syncPlaidCompany('${c.id}','${safeName}')">Sync</button>
          <button class="btn btn-sm btn-ghost" style="color:var(--color-error);" onclick="removeCompany('${c.id}','${safeName}')">&times;</button>`;
      }
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
      <td>${mainCell}</td>
      <td>${srcBadge}</td>
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

function _timeAgo(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
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

// When entry type = loan_advance, auto-prefill the standard A/R + A/P pattern:
//   Source (lender):  Dr Accounts Receivable      / Cr <leave for user>
//   Dest   (borrower): Dr <leave for user>        / Cr Accounts Payable
// User can still edit the account names; we only seed the structure.
function onIcTypeChange() {
  const t = document.getElementById("ic-type").value;
  if (t !== "loan_advance") return;
  // Only auto-fill if both sides are empty (don't blow away existing edits)
  const srcEmpty = document.querySelectorAll("#ic-source-lines tr").length === 0;
  const dstEmpty = document.querySelectorAll("#ic-dest-lines tr").length === 0;
  if (srcEmpty) {
    addICLine("source", { posting_type: "Debit",  account_name: "Accounts Receivable" });
    addICLine("source", { posting_type: "Credit", account_name: "" });
  }
  if (dstEmpty) {
    addICLine("dest",   { posting_type: "Debit",  account_name: "" });
    addICLine("dest",   { posting_type: "Credit", account_name: "Accounts Payable" });
  }
}

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
      // Detect manual vs QBO via the cached companies list — manual companies
      // pull their CoA from Supabase, QBO companies use the synced cache.
      const co = (allCompanies || []).find((c) => c.id === companyId);
      if (co && co.source === "manual") {
        const r = await apiGet(`/api/coa/${companyId}`);
        // Normalize to the {name, account_type, classification} shape that
        // buildAccountOptions expects.
        accounts = (r.accounts || []).map((a) => ({
          name: a.name,
          fully_qualified_name: a.name,
          account_type: a.type ? a.type.charAt(0).toUpperCase() + a.type.slice(1) : "Other",
          classification: a.type ? a.type.charAt(0).toUpperCase() + a.type.slice(1) : "Other",
        }));
      } else {
        accounts = await apiGet(`/api/companies/${companyId}/accounts`);
      }
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
        : (companyNames.length ? companyNames.map((n) => `<span class="badge badge-neutral" style="margin:1px;font-size:var(--text-xxs, 0.625rem);">${n}</span>`).join(" ") : '<span class="text-muted" style="font-size:var(--text-xs);">None</span>');
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
    <div style="background:var(--color-bg-muted);padding:10px 14px;border-radius:12px 12px 12px 4px;font-size:var(--text-sm);line-height:1.5;max-width:85%;color:var(--color-text-primary);">
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
  div.innerHTML = `<div style="background:${bg};color:${color};padding:10px 14px;border-radius:${radius};font-size:var(--text-sm);line-height:1.5;max-width:85%;word-wrap:break-word;">${html}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function showChatTyping() {
  const msgs = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.id = "chat-typing";
  div.className = "chat-msg assistant";
  div.innerHTML = `<div style="background:var(--color-bg-muted);padding:10px 14px;border-radius:12px 12px 12px 4px;font-size:var(--text-sm);color:var(--color-text-secondary);">
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
        <div style="font-weight:600;font-size:var(--text-xs);color:var(--color-accent);margin-bottom:6px;">&#9998; Journal Entry Ready</div>
        <div style="font-size:var(--text-xs);margin-bottom:4px;"><strong>Type:</strong> ${escapeHtml(je.entry_type || '')}</div>
        <div style="font-size:var(--text-xs);margin-bottom:4px;"><strong>Amount:</strong> $${(je.amount || 0).toLocaleString()}</div>
        <div style="font-size:var(--text-xs);margin-bottom:4px;"><strong>Date:</strong> ${escapeHtml(je.date || '')}</div>
        <div style="font-size:var(--text-xs);margin-bottom:8px;"><strong>Description:</strong> ${escapeHtml(je.description || '')}</div>
        <button onclick='executeChatJE(${escapeHtml(JSON.stringify(json.trim()))})' style="padding:6px 14px;background:#1a56db;color:white;border:none;border-radius:6px;font-size:var(--text-xs);font-weight:600;cursor:pointer;">Create This Entry</button>
      </div>`;
    } catch (e) {
      return `<pre style="font-size:var(--text-xs);overflow-x:auto;">${escapeHtml(json)}</pre>`;
    }
  });

  // Handle ```action:show_report blocks
  html = html.replace(/```action:show_report\n([\s\S]*?)```/g, (match, json) => {
    try {
      const rpt = JSON.parse(json.trim());
      const label = { "profit-loss": "P&L", "balance-sheet": "Balance Sheet", "cash-flow": "Cash Flow" }[rpt.report_type] || rpt.report_type;
      return `<div style="margin:8px 0;">
        <button onclick='executeChatReport(${escapeHtml(JSON.stringify(json.trim()))})' style="padding:8px 16px;background:var(--color-accent);color:white;border:none;border-radius:6px;font-size:var(--text-xs);font-weight:600;cursor:pointer;">&#128202; Open ${escapeHtml(label)} Report</button>
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
        <button onclick="navigateTo('${escapeHtml(nav.page)}')" style="padding:8px 16px;background:var(--color-accent);color:white;border:none;border-radius:6px;font-size:var(--text-xs);font-weight:600;cursor:pointer;">&#8594; Go to ${escapeHtml(nav.page)}</button>
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
    appendChatMsg("assistant", `<div style="color:var(--color-success);font-weight:600;">&#10003; Journal entry created successfully! (ID: ${data.id.slice(0,8)}...)</div><div style="margin-top:4px;"><button onclick="navigateTo('intercompany')" style="padding:6px 14px;background:var(--color-accent);color:white;border:none;border-radius:6px;font-size:var(--text-xs);cursor:pointer;">View in Journal Entries</button></div>`);
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

function openAddCompany() {
  // Show the chooser; hide everything else
  const chooser   = document.getElementById("add-company-chooser");
  const qbo       = document.getElementById("qbo-wizard-card");
  const manual    = document.getElementById("manual-company-form-card");
  const plaidLink = document.getElementById("plaid-link-card");
  const addBtn    = document.getElementById("companies-add-btn");
  if (chooser)   chooser.style.display   = "block";
  if (qbo)       qbo.style.display       = "none";
  if (manual)    manual.style.display    = "none";
  if (plaidLink) plaidLink.style.display = "none";
  if (addBtn)    addBtn.style.display    = "none";
  chooser?.scrollIntoView({ behavior: "smooth", block: "start" });
}

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
  const addBtn    = document.getElementById("companies-add-btn");
  if (chooser)   chooser.style.display   = "none";
  if (qbo)       qbo.style.display       = "none";
  if (manual)    manual.style.display    = "none";
  if (plaidLink) plaidLink.style.display = "none";
  if (addBtn)    addBtn.style.display    = "inline-flex";
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

// =====================================================================
//  M3: QBO AR/AP Import
// =====================================================================

let _qboArApPlan = null;

function openQboArApImportModal() {
  const srcSel = document.getElementById("qbo-arap-src");
  const destSel = document.getElementById("qbo-arap-dest");
  const qboCos = (allCompanies || []).filter((c) => (c.source || "qbo") === "qbo");
  const manualCos = (allCompanies || []).filter((c) => c.source === "manual");
  if (!qboCos.length) { showToast("No QuickBooks companies connected.", "error"); return; }
  if (!manualCos.length) { showToast("No manual companies. Create one first.", "error"); return; }
  srcSel.innerHTML = '<option value="">Select...</option>' +
    qboCos.map((c) => `<option value="${c.id}">${_escapeHtml(c.name)}</option>`).join("");
  destSel.innerHTML = '<option value="">Select...</option>' +
    manualCos.map((c) => `<option value="${c.id}">${_escapeHtml(c.name)}</option>`).join("");
  const end = document.getElementById("qbo-arap-end");
  if (end && !end.value) end.value = new Date().toISOString().slice(0, 10);
  _qboArApPlan = null;
  _qboArApResetUi();
  const modal = document.getElementById("qbo-arap-modal");
  modal.classList.add("active"); modal.style.display = "flex";
}
function closeQboArApImportModal() {
  const m = document.getElementById("qbo-arap-modal");
  m.classList.remove("active"); m.style.display = "none"; _qboArApPlan = null;
}
function _qboArApResetUi() {
  document.getElementById("qbo-arap-error").style.display = "none";
  document.getElementById("qbo-arap-preview").style.display = "none";
  document.getElementById("qbo-arap-result").style.display = "none";
  document.getElementById("qbo-arap-progress").style.display = "none";
  document.getElementById("qbo-arap-preview-btn").style.display = "inline-flex";
  document.getElementById("qbo-arap-preview-btn").disabled = false;
  document.getElementById("qbo-arap-confirm-btn").style.display = "none";
  document.getElementById("qbo-arap-back-btn").style.display = "none";
  ["qbo-arap-src","qbo-arap-dest","qbo-arap-start","qbo-arap-end"].forEach((id) => { const el = document.getElementById(id); if (el) el.disabled = false; });
}
function qboArApBackToForm() { _qboArApPlan = null; _qboArApResetUi(); }

function _qboArApCollect() {
  const errEl = document.getElementById("qbo-arap-error");
  errEl.style.display = "none";
  const src = document.getElementById("qbo-arap-src").value;
  const dest = document.getElementById("qbo-arap-dest").value;
  const start = document.getElementById("qbo-arap-start").value;
  const end = document.getElementById("qbo-arap-end").value;
  if (!src || !dest || !start || !end) { errEl.textContent = "All fields required."; errEl.style.display = "block"; return null; }
  if (src === dest) { errEl.textContent = "Source and destination must differ."; errEl.style.display = "block"; return null; }
  return { source_qbo_company_id: src, dest_manual_company_id: dest, start_date: start, end_date: end };
}

async function runQboArApPreview() {
  const form = _qboArApCollect(); if (!form) return;
  const progEl = document.getElementById("qbo-arap-progress");
  const progText = document.getElementById("qbo-arap-progress-text");
  const previewEl = document.getElementById("qbo-arap-preview");
  const errEl = document.getElementById("qbo-arap-error");
  const btn = document.getElementById("qbo-arap-preview-btn");
  progText.textContent = "Previewing... counting entities in QBO.";
  progEl.style.display = "block"; btn.disabled = true; previewEl.style.display = "none";
  try {
    const r = await apiPost("/api/import/qbo-ar-ap", { ...form, preview: true });
    progEl.style.display = "none";
    const c = r.counts;
    const newList = (r.new_coas || []).slice(0, 12);
    const newHtml = newList.length
      ? `<div style="margin-top:6px;font-size:var(--text-xs);">New CoA accounts: ${newList.map((u) => `<code>${_escapeHtml(u.coa_code || "")}</code> ${_escapeHtml(u.qbo_name)}`).join(" · ")}${r.new_coas.length > newList.length ? ` +${r.new_coas.length - newList.length} more` : ""}</div>`
      : "";
    previewEl.innerHTML = `
      <strong>Ready to import</strong>
      <div style="margin-top:6px;">
        <div><strong>${_escapeHtml(r.source_company)}</strong> → <strong>${_escapeHtml(r.dest_company)}</strong></div>
        <div><strong>${c.customers}</strong> customers · <strong>${c.vendors}</strong> vendors</div>
        <div><strong>${c.invoices}</strong> invoices · <strong>${c.bills}</strong> bills (${r.start_date} → ${r.end_date})</div>
        <div><strong>${c.new_coa}</strong> new CoA accounts will be created</div>
      </div>${newHtml}`;
    previewEl.style.display = "block";
    _qboArApPlan = form;
    ["qbo-arap-src","qbo-arap-dest","qbo-arap-start","qbo-arap-end"].forEach((id) => document.getElementById(id).disabled = true);
    btn.style.display = "none";
    document.getElementById("qbo-arap-confirm-btn").style.display = "inline-flex";
    document.getElementById("qbo-arap-back-btn").style.display = "inline-flex";
  } catch (e) {
    progEl.style.display = "none"; btn.disabled = false;
    errEl.textContent = "Preview failed: " + (e.message || "unknown");
    errEl.style.display = "block";
  }
}

async function runQboArApConfirm() {
  if (!_qboArApPlan) return;
  const progEl = document.getElementById("qbo-arap-progress");
  const progText = document.getElementById("qbo-arap-progress-text");
  const previewEl = document.getElementById("qbo-arap-preview");
  const resultEl = document.getElementById("qbo-arap-result");
  const errEl = document.getElementById("qbo-arap-error");
  const confirmBtn = document.getElementById("qbo-arap-confirm-btn");
  const backBtn = document.getElementById("qbo-arap-back-btn");
  progText.textContent = "Importing — this can take 1–3 minutes.";
  progEl.style.display = "block"; confirmBtn.disabled = true; backBtn.disabled = true;
  try {
    const r = await apiPost("/api/import/qbo-ar-ap", { ..._qboArApPlan, preview: false });
    progEl.style.display = "none"; confirmBtn.style.display = "none"; backBtn.style.display = "none"; previewEl.style.display = "none";
    resultEl.innerHTML = `
      <div>Imported:</div>
      <ul style="margin:4px 0 0 16px;font-size:var(--text-sm);">
        <li><strong>${r.customers}</strong> customers</li>
        <li><strong>${r.vendors}</strong> vendors</li>
        <li><strong>${r.invoices}</strong> invoices${r.skipped_invoices ? ` (${r.skipped_invoices} skipped — missing customer)` : ""}</li>
        <li><strong>${r.bills}</strong> bills${r.skipped_bills ? ` (${r.skipped_bills} skipped — missing vendor)` : ""}</li>
      </ul>
      <div style="margin-top:10px;">
        <button class="btn btn-sm btn-primary" onclick="setSelectedCompany('${_qboArApPlan.dest_manual_company_id}');navigateTo('invoices');closeQboArApImportModal();" type="button">Open Invoices</button>
      </div>`;
    resultEl.style.display = "block";
    showToast(`Imported ${r.invoices} invoices + ${r.bills} bills`, "success");
  } catch (e) {
    progEl.style.display = "none"; confirmBtn.disabled = false; backBtn.disabled = false;
    errEl.textContent = "Import failed: " + (e.message || "unknown");
    errEl.style.display = "block";
  }
}


// =====================================================================
//  M4: Match Transaction to Invoice/Bill
// =====================================================================

let _matchContext = { kind: "invoice", txId: null, txAmount: 0, txMerchant: "" };

async function txApplyToInvoice(txId) { await _openMatchModal(txId, "invoice"); }
async function txApplyToBill(txId) { await _openMatchModal(txId, "bill"); }

async function _openMatchModal(txId, kind) {
  // Read amount + merchant from the cached txn record. Reading from DOM cells
  // (td[5] etc) was producing NaN for outflows, since spent + received live in
  // separate columns and only one is populated per row.
  const tx = (_txState.txs || []).find((t) => t.id === txId);
  const amount = tx ? Math.abs(parseFloat(tx.amount) || 0) : 0;
  const merchant = tx ? (tx.merchant_name || tx.description || "") : "";
  _matchContext = { kind, txId, txAmount: amount, txMerchant: merchant };
  document.getElementById("match-modal-title").textContent = `Apply to ${kind === "invoice" ? "Invoice" : "Bill"}`;
  document.getElementById("match-tx-context").innerHTML = `
    <strong>${_escapeHtml(merchant || "(unknown)")}</strong> · ${formatCurrency(amount)}<br>
    Looking for ${kind === "invoice" ? "open invoices" : "open bills"} with matching amount and date.
  `;
  const list = document.getElementById("match-candidates");
  list.innerHTML = '<div style="color:var(--color-text-muted);padding:12px;text-align:center;">Loading suggestions...</div>';
  const modal = document.getElementById("match-modal");
  modal.classList.add("active"); modal.style.display = "flex";
  // Pre-flight: refuse to render candidates if this txn already has a payment.
  // Otherwise the user clicks Apply and only then sees the "already matched"
  // server error — confusing and looks broken.
  if (supabaseAccessToken && selectedCompanyId) {
    try {
      const dupeRes = await fetch(
        `${SUPABASE_URL}/rest/v1/payments?matched_transaction_id=eq.${txId}&select=id,kind,date,amount&limit=1`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` } }
      );
      if (dupeRes.ok) {
        const dupes = await dupeRes.json();
        if (Array.isArray(dupes) && dupes.length > 0) {
          list.innerHTML = `<div style="padding:12px;text-align:center;color:var(--color-text-muted);">This transaction is already matched to a ${kind}. Unmatch the existing payment from the bill/invoice first, then re-open this dialog.</div>`;
          return;
        }
      }
    } catch { /* non-fatal — fall through to candidates */ }
  }
  try {
    let candidates = null;
    try {
      const r = await apiGet(`/api/payments/match-suggestions/${txId}?kind=${kind}&top_n=10`);
      candidates = r.candidates || [];
    } catch { /* fall through to Supabase */ }
    // Railway's match-suggestions endpoint 404s for manual+Plaid companies.
    // Same shape as the auto-match Supabase fallback (_supaMatchSuggestions):
    // pull open bills/invoices, rank by amount + date proximity.
    if ((!candidates || !candidates.length) && supabaseAccessToken) {
      candidates = await _supaMatchCandidatesFor(txId, kind, amount);
    }
    if (!candidates || !candidates.length) {
      list.innerHTML = `<div style="color:var(--color-text-muted);padding:12px;text-align:center;">No matching open ${kind}s within the amount tolerance.</div>`;
      return;
    }
    list.innerHTML = candidates.map((c) => `
      <div style="border:1px solid var(--color-border);border-radius:var(--radius-md);padding:10px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <strong>${_escapeHtml(c.number || "—")}</strong> · ${c.date}
          <div style="font-size:var(--text-xs);color:var(--color-text-secondary);">
            ${_escapeHtml(c.party?.display_name || "")} · Balance ${parseFloat(c.balance || 0).toFixed(2)} of ${parseFloat(c.total || 0).toFixed(2)}
            · Score ${c.score}
          </div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="_applyMatch('${c.id}', ${c.balance})" type="button">Apply</button>
      </div>
    `).join("");
  } catch (e) {
    list.innerHTML = `<div style="color:var(--color-error);padding:12px;text-align:center;">${_escapeHtml(e.message)}</div>`;
  }
}

function closeMatchModal() {
  const m = document.getElementById("match-modal");
  m.classList.remove("active"); m.style.display = "none";
}

async function _applyMatch(targetId, maxAmount) {
  const errEl = document.getElementById("match-error");
  errEl.style.display = "none";
  const ctx = _matchContext;
  const amt = Math.min(ctx.txAmount, parseFloat(maxAmount) || ctx.txAmount);
  try {
    let railwayWorked = false;
    try {
      const body = {
        plaid_txn_id: ctx.txId,
        amount: amt,
        payment_method: "ach",
        memo: `Auto-matched from transaction: ${ctx.txMerchant}`.slice(0, 200),
      };
      if (ctx.kind === "invoice") body.invoice_id = targetId; else body.bill_id = targetId;
      await apiPost("/api/payments/apply-match", body);
      railwayWorked = true;
    } catch { /* fall through to Supabase */ }
    if (!railwayWorked) {
      // Same shape as txApplyMatchHint's fallback: build the m record and
      // delegate to _supaApplyMatch (inserts payment + payment_application,
      // updates parent balance/status).
      await _supaApplyMatch(ctx.txId, {
        kind: ctx.kind,
        id: targetId,
        balance: parseFloat(maxAmount) || amt,
      });
    }
    showToast(`Applied ${amt.toFixed(2)} to ${ctx.kind}`, "success");
    closeMatchModal();
    await txReload();
  } catch (e) {
    errEl.textContent = "Failed: " + (e.message || "unknown");
    errEl.style.display = "block";
  }
}

// Match candidates from Supabase for the manual match modal. Returns
// the same shape Railway's /api/payments/match-suggestions/<id> uses:
// [{ id, number, date, party: { display_name }, balance, total, score }, ...]
async function _supaMatchCandidatesFor(txId, kind, amount) {
  if (!supabaseAccessToken || !selectedCompanyId) return null;
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  const tx = (_txState.txs || []).find((t) => t.id === txId);
  const txDate = tx?.date;
  const isInvoice = kind === "invoice";
  const url = isInvoice
    ? `${SUPABASE_URL}/rest/v1/invoices?company_id=eq.${selectedCompanyId}&status=in.(open,partially_paid,overdue,sent,draft)&select=id,number,date,due_date,total,balance,party:customers(display_name)`
    : `${SUPABASE_URL}/rest/v1/bills?company_id=eq.${selectedCompanyId}&status=in.(open,partially_paid,overdue)&select=id,number,date,due_date,total,balance,party:vendors(display_name)`;
  const r = await fetch(url, { headers });
  if (!r.ok) return null;
  const rows = await r.json();
  const dayDiff = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
  const amt = Math.abs(parseFloat(amount) || 0);
  const out = [];
  for (const d of rows) {
    const balance = parseFloat(d.balance ?? d.total ?? 0);
    const dRef = d.due_date || d.date;
    const dd = txDate ? dayDiff(txDate, dRef) : 0;
    // Looser than auto-match (the user is manually choosing): allow any
    // amount, score by amount-fit + date-fit so the closest one is on top.
    const amtScore = Math.max(0, 100 - Math.abs(balance - amt));
    const dateScore = Math.max(0, 100 - dd * 5);
    const score = Math.round((amtScore + dateScore) / 2);
    out.push({
      id: d.id,
      number: d.number,
      date: dRef,
      party: d.party,
      total: parseFloat(d.total || 0),
      balance,
      score,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 10);
}


// =====================================================================
//  M5: Print + Email + Credit Memos + Recurring
// =====================================================================

function docPrint() {
  const { kind, data } = _docDetailState;
  if (!data) return;
  const doc = kind === "invoice" ? data.invoice : data.bill;
  const party = kind === "invoice" ? data.customer : data.vendor;
  const lines = data.lines || [];
  const title = kind === "invoice" ? "INVOICE" : "BILL";
  const host = document.getElementById("doc-print-host");
  host.innerHTML = `
    <div style="max-width:720px;margin:0 auto;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #222;padding-bottom:12px;">
        <div>
          <h1 style="margin:0;font-size:28px;">${title}</h1>
          <div>#${_escapeHtml(doc.number || "")}</div>
        </div>
        <div style="text-align:right;">
          <div><strong>Date:</strong> ${doc.date}</div>
          ${doc.due_date ? `<div><strong>Due:</strong> ${doc.due_date}</div>` : ""}
        </div>
      </div>
      <div style="margin:20px 0;">
        <div style="font-size:var(--text-xs);color:#666;text-transform:uppercase;">${kind === "invoice" ? "Bill To" : "From"}</div>
        <div><strong>${_escapeHtml(party?.display_name || "")}</strong></div>
        ${party?.company_name ? `<div>${_escapeHtml(party.company_name)}</div>` : ""}
        ${party?.email ? `<div>${_escapeHtml(party.email)}</div>` : ""}
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <thead><tr style="border-bottom:1px solid #222;">
          <th style="text-align:left;padding:6px 4px;">Description</th>
          <th style="text-align:right;padding:6px 4px;">Qty</th>
          <th style="text-align:right;padding:6px 4px;">Unit</th>
          <th style="text-align:right;padding:6px 4px;">Amount</th>
        </tr></thead>
        <tbody>
          ${lines.map((l) => `<tr style="border-bottom:1px solid #eee;">
            <td style="padding:6px 4px;">${_escapeHtml(l.description || "")}</td>
            <td style="text-align:right;padding:6px 4px;">${parseFloat(l.quantity || 0).toFixed(2)}</td>
            <td style="text-align:right;padding:6px 4px;">${parseFloat(l.unit_price || 0).toFixed(2)}</td>
            <td style="text-align:right;padding:6px 4px;">${formatCurrency(l.amount)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <div style="text-align:right;margin-bottom:8px;">Subtotal: <strong>${parseFloat(doc.subtotal || 0).toFixed(2)}</strong></div>
      <div style="text-align:right;margin-bottom:8px;">Tax: <strong>${parseFloat(doc.tax_total || 0).toFixed(2)}</strong></div>
      <div style="text-align:right;font-size:var(--text-lg);border-top:2px solid #222;padding-top:8px;">
        <strong>Total: ${parseFloat(doc.total || 0).toFixed(2)}</strong>
      </div>
      <div style="text-align:right;font-size:var(--text-sm);color:#c33;margin-top:4px;">Balance: ${parseFloat(doc.balance || 0).toFixed(2)}</div>
      ${doc.memo ? `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #eee;font-size:var(--text-sm);"><strong>Memo:</strong> ${_escapeHtml(doc.memo)}</div>` : ""}
    </div>
  `;
  window.print();
}

// --- Email invoice ---
let _emailInvoiceId = null;

function openEmailInvoice() {
  const data = _docDetailState.data;
  const inv = data.invoice;
  const cust = data.customer || {};
  _emailInvoiceId = inv.id;
  const company = _getSelectedCompany();
  document.getElementById("email-invoice-to").value = cust.email || "";
  document.getElementById("email-invoice-subject").value = `Invoice ${inv.number || ""} from ${company?.name || ""}`.trim();
  document.getElementById("email-invoice-body").value =
    `<p>Hi ${cust.display_name || ""},</p>\n` +
    `<p>Please find your invoice details below:</p>\n` +
    `<p><strong>${inv.number}</strong> — total $${parseFloat(inv.total || 0).toFixed(2)} — due ${inv.due_date || "on receipt"}.</p>\n` +
    `<p>Balance owing: $${parseFloat(inv.balance || 0).toFixed(2)}.</p>\n` +
    `<p>Thank you!</p>`;
  document.getElementById("email-invoice-error").style.display = "none";
  const m = document.getElementById("email-invoice-modal");
  m.classList.add("active"); m.style.display = "flex";
}
function closeEmailInvoice() {
  const m = document.getElementById("email-invoice-modal");
  m.classList.remove("active"); m.style.display = "none"; _emailInvoiceId = null;
}

async function emailInvoiceSend() {
  const errEl = document.getElementById("email-invoice-error");
  errEl.style.display = "none";
  const to = document.getElementById("email-invoice-to").value.trim();
  if (!to) { errEl.textContent = "Recipient email required."; errEl.style.display = "block"; return; }
  const btn = document.getElementById("email-invoice-send-btn");
  btn.disabled = true; btn.textContent = "Sending...";
  try {
    await apiPost(`/api/invoices/${_emailInvoiceId}/email`, {
      to_email: to,
      subject: document.getElementById("email-invoice-subject").value,
      body_html: document.getElementById("email-invoice-body").value,
    });
    showToast("Email sent", "success");
    closeEmailInvoice();
  } catch (e) {
    errEl.textContent = "Failed: " + (e.message || "unknown");
    errEl.style.display = "block";
  } finally {
    btn.disabled = false; btn.textContent = "Send Email";
  }
}


// --- Credit Memos (simple modal-based UI) ---

let _cmCustomers = [], _cmCoa = [];

async function openCreditMemoModal() {
  const company = _getSelectedCompany();
  if (!company || company.source !== "manual") { showToast("Pick a manual company first.", "error"); return; }
  if (!_contactsState.coa.length) await _contactsLoadCoa();
  _cmCoa = _contactsState.coa;
  try {
    const [cr, lr] = await Promise.all([
      apiGet(`/api/customers/${selectedCompanyId}`),
      apiGet(`/api/credit-memos/${selectedCompanyId}`),
    ]);
    _cmCustomers = cr.customers || [];
    const rows = lr.credit_memos || [];
    const list = document.getElementById("credit-memo-list");
    if (!rows.length) {
      list.innerHTML = '<div style="text-align:center;padding:16px;color:var(--color-text-muted);font-size:var(--text-sm);">No credit memos yet.</div>';
    } else {
      list.innerHTML = `<table class="data-table" style="width:100%;font-size:var(--text-sm);">
        <thead><tr><th>Date</th><th>#</th><th>Customer</th><th>Status</th><th style="text-align:right;">Total</th><th style="text-align:right;">Balance</th><th></th></tr></thead>
        <tbody>${rows.map((c) => `<tr>
          <td>${c.date}</td><td>${_escapeHtml(c.number || "—")}</td>
          <td>${_escapeHtml(c.customer?.display_name || "")}</td>
          <td>${_statusBadge(c.status || "open")}</td>
          <td style="text-align:right;">${parseFloat(c.total || 0).toFixed(2)}</td>
          <td style="text-align:right;">${parseFloat(c.balance || 0).toFixed(2)}</td>
          <td><button class="btn btn-sm btn-ghost" style="color:var(--color-error);" onclick="creditMemoDelete('${c.id}')">×</button></td>
        </tr>`).join("")}</tbody></table>`;
    }
    const m = document.getElementById("credit-memo-modal");
    m.classList.add("active"); m.style.display = "flex";
  } catch (e) { showToast("Load failed: " + e.message, "error"); }
}
function closeCreditMemoModal() {
  const m = document.getElementById("credit-memo-modal");
  m.classList.remove("active"); m.style.display = "none";
  creditMemoCancelForm();
}
function creditMemoNewForm() {
  document.getElementById("credit-memo-new-form").style.display = "block";
  const custSel = document.getElementById("cm-customer");
  custSel.innerHTML = '<option value="">— select —</option>' +
    _cmCustomers.map((c) => `<option value="${c.id}">${_escapeHtml(c.display_name)}</option>`).join("");
  const acctSel = document.getElementById("cm-account");
  acctSel.innerHTML = '<option value="">— select —</option>' +
    _cmCoa.filter((a) => a.is_active).map((a) => `<option value="${a.id}">${_escapeHtml(a.code)} ${_escapeHtml(a.name)} (${a.type})</option>`).join("");
  document.getElementById("cm-date").value = new Date().toISOString().slice(0, 10);
  document.getElementById("cm-amount").value = "";
  document.getElementById("cm-memo").value = "";
  document.getElementById("cm-error").style.display = "none";
}
function creditMemoCancelForm() {
  document.getElementById("credit-memo-new-form").style.display = "none";
}
async function creditMemoSave() {
  const errEl = document.getElementById("cm-error");
  errEl.style.display = "none";
  const customer_id = document.getElementById("cm-customer").value;
  const date = document.getElementById("cm-date").value;
  const amount = parseFloat(document.getElementById("cm-amount").value || "0");
  const coa_account_id = document.getElementById("cm-account").value;
  if (!customer_id || !date || !amount || !coa_account_id) {
    errEl.textContent = "All fields required."; errEl.style.display = "block"; return;
  }
  try {
    await apiPost(`/api/credit-memos/${selectedCompanyId}`, {
      customer_id, date,
      memo: document.getElementById("cm-memo").value.trim() || null,
      lines: [{ description: document.getElementById("cm-memo").value || "Credit",
                quantity: 1, unit_price: amount, tax_rate: 0, coa_account_id }],
    });
    creditMemoCancelForm();
    await openCreditMemoModal();
  } catch (e) { errEl.textContent = "Failed: " + e.message; errEl.style.display = "block"; }
}
async function creditMemoDelete(id) {
  if (!confirm("Delete this credit memo? Any applied amounts will be restored to invoices.")) return;
  try { await apiDelete(`/api/credit-memos/${id}`); await openCreditMemoModal(); }
  catch (e) { showToast("Failed: " + e.message, "error"); }
}


// --- Recurring Invoices ---

let _recCustomers = [], _recCoa = [];

async function openRecurringModal() {
  const company = _getSelectedCompany();
  if (!company || company.source !== "manual") { showToast("Pick a manual company first.", "error"); return; }
  if (!_contactsState.coa.length) await _contactsLoadCoa();
  _recCoa = _contactsState.coa;
  try {
    const [cr, lr] = await Promise.all([
      apiGet(`/api/customers/${selectedCompanyId}`),
      apiGet(`/api/recurring-invoices/${selectedCompanyId}`),
    ]);
    _recCustomers = cr.customers || [];
    const rows = lr.recurring_invoices || [];
    const list = document.getElementById("recurring-list");
    if (!rows.length) {
      list.innerHTML = '<div style="text-align:center;padding:16px;color:var(--color-text-muted);font-size:var(--text-sm);">No recurring invoices yet.</div>';
    } else {
      list.innerHTML = `<table class="data-table" style="width:100%;font-size:var(--text-sm);">
        <thead><tr><th>Name</th><th>Customer</th><th>Frequency</th><th>Next Run</th><th style="text-align:center;">Active</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><strong>${_escapeHtml(r.name)}</strong></td>
          <td>${_escapeHtml(r.customer?.display_name || "")}</td>
          <td style="text-transform:capitalize;">${r.frequency}</td>
          <td>${r.next_run_date}</td>
          <td style="text-align:center;">${r.is_active ? "✓" : "✗"}</td>
          <td><button class="btn btn-sm btn-ghost" style="color:var(--color-error);" onclick="recurringDelete('${r.id}')">×</button></td>
        </tr>`).join("")}</tbody></table>`;
    }
    const m = document.getElementById("recurring-modal");
    m.classList.add("active"); m.style.display = "flex";
  } catch (e) { showToast("Load failed: " + e.message, "error"); }
}
function closeRecurringModal() {
  const m = document.getElementById("recurring-modal");
  m.classList.remove("active"); m.style.display = "none";
  recurringCancelForm();
}
function recurringNewForm() {
  document.getElementById("recurring-new-form").style.display = "block";
  const custSel = document.getElementById("rec-customer");
  custSel.innerHTML = '<option value="">— select —</option>' +
    _recCustomers.map((c) => `<option value="${c.id}">${_escapeHtml(c.display_name)}</option>`).join("");
  const acctSel = document.getElementById("rec-account");
  acctSel.innerHTML = '<option value="">— select —</option>' +
    _recCoa.filter((a) => a.is_active && a.type === "income").map((a) => `<option value="${a.id}">${_escapeHtml(a.code)} ${_escapeHtml(a.name)}</option>`).join("");
  document.getElementById("rec-start").value = new Date().toISOString().slice(0, 10);
  document.getElementById("rec-name").value = "";
  document.getElementById("rec-description").value = "";
  document.getElementById("rec-amount").value = "";
  document.getElementById("rec-due-days").value = "30";
  document.getElementById("rec-error").style.display = "none";
}
function recurringCancelForm() { document.getElementById("recurring-new-form").style.display = "none"; }

async function recurringSave() {
  const errEl = document.getElementById("rec-error");
  errEl.style.display = "none";
  const name = document.getElementById("rec-name").value.trim();
  const customer_id = document.getElementById("rec-customer").value;
  const frequency = document.getElementById("rec-frequency").value;
  const start_date = document.getElementById("rec-start").value;
  const end_date = document.getElementById("rec-end").value || null;
  const description = document.getElementById("rec-description").value.trim();
  const amount = parseFloat(document.getElementById("rec-amount").value || "0");
  const coa_account_id = document.getElementById("rec-account").value;
  const due_days_offset = parseInt(document.getElementById("rec-due-days").value || "30", 10);
  if (!name || !customer_id || !start_date || !amount || !coa_account_id) {
    errEl.textContent = "All fields required."; errEl.style.display = "block"; return;
  }
  try {
    await apiPost(`/api/recurring-invoices/${selectedCompanyId}`, {
      customer_id, name, frequency, start_date, end_date,
      template_json: {
        due_days_offset,
        memo: description,
        lines: [{ description, quantity: 1, unit_price: amount, tax_rate: 0, coa_account_id }],
      },
    });
    recurringCancelForm();
    await openRecurringModal();
  } catch (e) { errEl.textContent = "Failed: " + e.message; errEl.style.display = "block"; }
}
async function recurringDelete(id) {
  if (!confirm("Delete this recurring invoice schedule?")) return;
  try { await apiDelete(`/api/recurring-invoices/${id}`); await openRecurringModal(); }
  catch (e) { showToast("Failed: " + e.message, "error"); }
}
async function recurringRunNow() {
  if (!confirm("Materialize all due recurring invoices now?")) return;
  try {
    const r = await apiPost("/api/recurring-invoices/process", {});
    showToast(`Processed ${r.processed}, created ${(r.created || []).length}`, "success");
    await openRecurringModal();
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}


// Pending exchange data, held between Plaid Link onSuccess and the user's import-date choice
let _pendingExchange = null; // { company_id, company_name, public_token, institution_id, institution_name }

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
    onSuccess: (public_token, metadata) => {
      // Stash and prompt the user for an import start date before calling exchange.
      _pendingExchange = {
        company_id: companyId,
        company_name: companyName,
        public_token,
        institution_id:   metadata && metadata.institution ? metadata.institution.institution_id   : null,
        institution_name: metadata && metadata.institution ? metadata.institution.name              : null,
      };
      _openPlaidImportDateModal(companyId, _pendingExchange.institution_name || companyName);
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


// --- Import-date modal ---

function _openPlaidImportDateModal(companyId, instName) {
  const modal = document.getElementById("plaid-import-date-modal");
  const nameEl = document.getElementById("plaid-import-inst-name");
  const errEl  = document.getElementById("plaid-import-error");
  if (errEl) errEl.style.display = "none";
  if (nameEl) nameEl.textContent = instName || "Your bank";

  // Resolve the company for fiscal year start / preview dates.
  const company = allCompanies.find((c) => c.id === companyId) || {};
  const fyStartMonth = parseInt(company.fiscal_year_start || 1, 10);
  const today = new Date();
  const year = today.getFullYear();
  // Current fiscal year start: if current month >= fyStart, use this year; else prior year.
  const fyStart = new Date(
    today.getMonth() + 1 >= fyStartMonth ? year : year - 1,
    fyStartMonth - 1,
    1,
  );
  const priorYearStart = new Date(year - 1, today.getMonth(), today.getDate());

  const fmt = (d) => d.toISOString().slice(0, 10);
  const fyPreview = document.getElementById("plaid-import-fy-preview");
  const pyPreview = document.getElementById("plaid-import-py-preview");
  if (fyPreview) fyPreview.textContent = `From ${fmt(fyStart)}`;
  if (pyPreview) pyPreview.textContent = `From ${fmt(priorYearStart)}`;

  // Store computed dates on the modal for the confirm handler.
  modal.dataset.fyStart = fmt(fyStart);
  modal.dataset.priorYearStart = fmt(priorYearStart);
  modal.dataset.companyId = companyId;

  // Reset to default choice
  const defaultRadio = modal.querySelector('input[name="plaid-import-choice"][value="everything"]');
  if (defaultRadio) defaultRadio.checked = true;
  const customInput = document.getElementById("plaid-import-custom-date");
  if (customInput) customInput.value = fmt(priorYearStart);

  modal.classList.add("active");
  modal.style.display = "flex";
}

function _closePlaidImportDateModal() {
  const modal = document.getElementById("plaid-import-date-modal");
  if (modal) {
    modal.classList.remove("active");
    modal.style.display = "none";
  }
}

function cancelPlaidImport() {
  _pendingExchange = null;
  _closePlaidImportDateModal();
  const openBtn = document.getElementById("plaid-open-btn");
  if (openBtn) { openBtn.disabled = false; openBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/></svg> Connect Bank with Plaid'; }
  showToast("Bank linked but import canceled. Connect again to pull transactions.", "info");
}

async function confirmPlaidImport() {
  if (!_pendingExchange) return;
  const modal = document.getElementById("plaid-import-date-modal");
  const errEl = document.getElementById("plaid-import-error");
  const confirmBtn = document.getElementById("plaid-import-confirm-btn");

  const choice = (modal.querySelector('input[name="plaid-import-choice"]:checked') || {}).value;
  let importStartDate = null;
  if (choice === "fy") {
    importStartDate = modal.dataset.fyStart;
  } else if (choice === "prior-year") {
    importStartDate = modal.dataset.priorYearStart;
  } else if (choice === "custom") {
    const customInput = document.getElementById("plaid-import-custom-date");
    importStartDate = customInput ? customInput.value : null;
    if (!importStartDate) {
      if (errEl) { errEl.textContent = "Pick a valid date."; errEl.style.display = "block"; }
      return;
    }
    // Cap at today and 730 days ago (Plaid's limit for /transactions/get is typically 24 months)
    const today = new Date().toISOString().slice(0, 10);
    if (importStartDate > today) {
      if (errEl) { errEl.textContent = "Start date can't be in the future."; errEl.style.display = "block"; }
      return;
    }
  }
  // choice === "everything" → importStartDate stays null (default 730-day window)

  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "Starting import..."; }

  try {
    const body = {
      public_token: _pendingExchange.public_token,
      company_id:   _pendingExchange.company_id,
      institution_id:   _pendingExchange.institution_id,
      institution_name: _pendingExchange.institution_name,
    };
    if (importStartDate) body.import_start_date = importStartDate;
    const r = await apiPost("/api/plaid/exchange-token", body);
    const accountCount = (r.accounts || []).length;
    const sinceLabel = importStartDate ? ` since ${importStartDate}` : "";
    showToast(
      `${_pendingExchange.company_name}: ${accountCount} account${accountCount === 1 ? "" : "s"} linked. Importing transactions${sinceLabel}...`,
      "success",
    );
    _pendingExchange = null;
    _closePlaidImportDateModal();
    await loadCompanyList();
    renderCompaniesTable();
    resetAddCompany();
  } catch (e) {
    if (errEl) {
      errEl.textContent = "Exchange failed: " + (e.message || "unknown error");
      errEl.style.display = "block";
    }
  } finally {
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Start Import'; }
  }
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
          <td style="font-size:var(--text-xs);">${_escapeHtml(cat)}${t.is_transfer ? ' <span class="badge badge-neutral" style="font-size:var(--text-xxs, 0.625rem);">transfer</span>' : ""}</td>
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

// ---------- Shared formatters & helpers ----------

const _CURRENCY_FMT = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD",
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/** Format a number as USD. Accepts strings or numbers. Returns "—" for null/undefined/NaN. */
function formatCurrency(n) {
  if (n === null || n === undefined || n === "") return "—";
  const x = typeof n === "number" ? n : parseFloat(n);
  if (!isFinite(x)) return "—";
  return _CURRENCY_FMT.format(x);
}

/** Format a number without the currency symbol (for tight columns). */
function formatNumber(n) {
  if (n === null || n === undefined || n === "") return "—";
  const x = typeof n === "number" ? n : parseFloat(n);
  if (!isFinite(x)) return "—";
  return x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Pull a human-readable merchant out of a transaction. Falls back to parsing
 *  ACH/NACHA descriptors like "ORIG CO NAME:TX ROADHOUSE … TRACE#:… IND NAME:…".
 *  Accepts a transaction object or a raw string. */
function prettifyMerchant(tx) {
  if (tx == null) return "—";
  if (typeof tx === "object") {
    const name = (tx.merchant_name || "").trim();
    if (name) return _truncate(name, 80);
    const raw = (tx.description || "").trim();
    if (!raw) return "—";
    return _truncate(_titleCaseMerchant(_extractMerchantFromDescriptor(raw)), 80);
  }
  const raw = String(tx).trim();
  if (!raw) return "—";
  return _truncate(_titleCaseMerchant(_extractMerchantFromDescriptor(raw)), 80);
}

function _extractMerchantFromDescriptor(raw) {
  let m = raw.match(/ORIG CO NAME:\s*([^]*?)(?=\s+(?:INT |DESC |CO ENTRY|SEC:|TRACE#:|EED:|IND ID:|IND NAME:|TRN:|ORIG ID:)|$)/i);
  if (m && m[1].trim()) return m[1].trim();
  m = raw.match(/IND NAME:\s*([^]*?)(?=\s+TRN:|$)/i);
  if (m && m[1].trim()) return m[1].trim();
  return raw
    .replace(/\bORIG ID:\S+/gi, "")
    .replace(/\bDESC DATE:\S*/gi, "")
    .replace(/\bCO ENTRY DESCR:\S*/gi, "")
    .replace(/\bSEC:\S+/gi, "")
    .replace(/\bTRACE#:\S+/gi, "")
    .replace(/\bEED:\S+/gi, "")
    .replace(/\bIND ID:\S*/gi, "")
    .replace(/\bTRN:\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function _titleCaseMerchant(s) {
  if (!s) return s;
  return s.split(/\s+/).map((w) => {
    if (w.length <= 3) return w; // keep TX, LLC, ACH, etc.
    if (/^[A-Z]+$/.test(w))  return w.charAt(0) + w.slice(1).toLowerCase();
    return w;
  }).join(" ");
}

function _truncate(s, n) {
  if (!s) return "—";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Format an ISO date (YYYY-MM-DD) as a friendlier label. */
function formatDate(iso, style = "short") {
  if (!iso) return "—";
  try {
    const d = new Date(iso.slice(0, 10) + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    if (style === "full")  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    if (style === "long")  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    if (style === "mdy")   return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); // default: Apr 23
  } catch (e) { return iso; }
}

/** Translate an API error into user-friendly text. */
function friendlyError(e) {
  if (!e) return "Something went wrong.";
  const msg = String(e.message || e);
  if (/401/.test(msg)) return "You need to sign in again.";
  if (/403/.test(msg)) return "You don't have access to that.";
  if (/404/.test(msg)) return "Not found.";
  if (/429/.test(msg)) return "Too many requests — wait a moment and try again.";
  if (/503/.test(msg)) return "Service is temporarily unavailable. Try again in a minute.";
  if (/Network error|Failed to fetch/i.test(msg)) return "Can't reach the server. Check your connection.";
  // Default: trim verbose prefixes
  return msg.replace(/^API Error:\s*/, "").replace(/^HTTP \d+\s*/, "") || "Something went wrong.";
}

// ---------- Unified status badge palette ----------

const _STATUS_MAP = {
  // green — done / good
  paid:   { label: "Paid",          tone: "success" },
  good:   { label: "Good",          tone: "success" },
  active: { label: "Active",        tone: "success" },
  connected: { label: "Connected",  tone: "success" },
  applied:   { label: "Applied",    tone: "success" },
  // amber — in progress / needs attention
  partially_paid:    { label: "Partially paid",    tone: "warning" },
  partially_applied: { label: "Partially applied", tone: "warning" },
  overdue:           { label: "Overdue",           tone: "warning" },
  syncing:           { label: "Syncing",           tone: "warning" },
  login_required:    { label: "Login required",    tone: "warning" },
  pending_expiration:{ label: "Re-auth soon",      tone: "warning" },
  // red — error / attention-needed
  error:         { label: "Error",         tone: "error" },
  auth_expired:  { label: "Re-auth needed", tone: "error" },
  disconnected: { label: "Disconnected",   tone: "error" },
  // neutral — default/open
  draft:   { label: "Draft",   tone: "neutral" },
  sent:    { label: "Sent",    tone: "neutral" },
  open:    { label: "Open",    tone: "neutral" },
  void:    { label: "Void",    tone: "neutral" },
};

const _TONE_CLASS = {
  success: "badge-success", warning: "badge-warning",
  error:   "badge-error",   neutral: "badge-neutral",
};

function statusBadge(status, fallbackLabel) {
  if (!status) return "";
  const entry = _STATUS_MAP[status] || { label: fallbackLabel || status, tone: "neutral" };
  const cls = _TONE_CLASS[entry.tone] || "badge-neutral";
  return `<span class="badge ${cls}" style="text-transform:none;">${_escapeHtml(entry.label)}</span>`;
}


// =====================================================================
//  COMPANY SWITCHER (sidebar)
// =====================================================================

let selectedCompanyId = null; // null = "All Companies"

function _getSelectedCompany() {
  if (!selectedCompanyId) return null;
  return (allCompanies || []).find((c) => c.id === selectedCompanyId) || null;
}

// True when we should route writes through Railway (QBO companies). Railway
// is opt-in: only companies with source explicitly "qbo" use it. Manual +
// Plaid companies (and anything with a missing/unknown source) go to
// Supabase. Previous behavior defaulted unknown sources to "qbo", which
// silently routed manual+Plaid companies to Railway whenever the company
// hadn't loaded yet — surfacing as empty P&L / failed bill matches / etc.
function _shouldUseRailway() {
  const company = _getSelectedCompany();
  if (company) return company.source === "qbo";
  // No company resolved yet (fresh tab, race on first paint). Prefer Supabase
  // when we have a session; only fall back to Railway if we genuinely have
  // nothing else.
  return !supabaseAccessToken;
}

// Method dropdowns (Cash/Accrual) are only meaningful for QBO companies —
// the Supabase report builders are cash-basis only. For manual+Plaid we
// force the visible value to "Cash" and disable the control so the user
// isn't tricked into thinking changing it does anything. Called after
// company selection changes and on initial company load.
function _syncMethodDropdownState() {
  const isRailway = _shouldUseRailway();
  ["pl-method", "bs-method"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (isRailway) {
      el.disabled = false;
      el.title = "";
    } else {
      el.value = "Cash";
      el.disabled = true;
      el.title = "Cash basis only on manual + Plaid companies";
    }
  });
}

function _loadPersistedSelection() {
  try {
    const saved = localStorage.getItem("v2_selected_company_id");
    if (saved && saved !== "null") selectedCompanyId = saved;
  } catch (e) { /* ignore */ }
}

function _persistSelection() {
  try { localStorage.setItem("v2_selected_company_id", selectedCompanyId || "null"); }
  catch (e) { /* ignore */ }
}

function renderCompanySwitcher() {
  const nameEl = document.getElementById("company-switcher-name");
  const subEl = document.getElementById("company-switcher-sub");
  const menuEl = document.getElementById("company-switcher-menu");
  if (!menuEl) return;

  const current = _getSelectedCompany();
  if (current) {
    nameEl.textContent = current.name;
    const isManual = (current.source || "qbo") === "manual";
    subEl.textContent = isManual ? "Manual + Plaid" : "QuickBooks";
  } else {
    nameEl.textContent = "All Companies";
    subEl.textContent = "Consolidated view";
  }

  const items = [
    `<div class="company-switcher-option ${!selectedCompanyId ? "active" : ""}" onclick="setSelectedCompany(null)">
       <div class="company-switcher-option-name">All Companies</div>
       <div class="company-switcher-option-sub">Consolidated view</div>
     </div>`,
    ...(allCompanies || []).map((c) => {
      const isManual = (c.source || "qbo") === "manual";
      const sub = isManual
        ? (c.plaid_items && c.plaid_items.length
            ? `${c.plaid_items[0].institution_name || "Bank"} · ${c.plaid_items.reduce((a, it) => a + (it.accounts_count || 0), 0)} accounts`
            : "Manual + Plaid · No bank linked")
        : "QuickBooks";
      return `<div class="company-switcher-option ${selectedCompanyId === c.id ? "active" : ""}" onclick="setSelectedCompany('${c.id}')">
        <div class="company-switcher-option-name">${_escapeHtml(c.name)}</div>
        <div class="company-switcher-option-sub">${_escapeHtml(sub)}</div>
      </div>`;
    }),
  ];
  menuEl.innerHTML = items.join("");

  // Toggle per-company nav visibility
  const hidden = !current || current.source !== "manual";
  ["sidebar-section-company", "sidebar-section-sales", "sidebar-section-expenses"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", hidden);
  });
}

function toggleCompanySwitcher() {
  const menu = document.getElementById("company-switcher-menu");
  if (!menu) return;
  menu.classList.toggle("open");
}

function setSelectedCompany(id) {
  selectedCompanyId = id;
  _persistSelection();
  document.getElementById("company-switcher-menu").classList.remove("open");
  renderCompanySwitcher();
  // Re-sync report/dashboard company multi-selects to follow the new sidebar pick.
  _syncCompanyMultiSelect();
  _syncMethodDropdownState();
  // If on a per-company page and switched to All, go to dashboard
  const currentPage = (location.hash || "#dashboard").slice(1);
  const perCompanyPages = ["transactions", "coa", "rules", "manual-journal", "bank-accounts"];
  if (!id && perCompanyPages.includes(currentPage)) {
    navigateTo("dashboard");
    return;
  }
  // Re-init current page with new company context
  if (perCompanyPages.includes(currentPage)) {
    navigateTo(currentPage);
  } else if (currentPage === "dashboard") {
    dashInit();
  } else if (currentPage === "profit-loss") {
    loadPL();
  } else if (currentPage === "balance-sheet") {
    loadBS();
  } else if (currentPage === "cash-flow") {
    loadCF();
  }
}

// Close switcher on outside click
document.addEventListener("click", (e) => {
  const sw = document.getElementById("sidebar-company-switcher");
  if (sw && !sw.contains(e.target)) {
    document.getElementById("company-switcher-menu")?.classList.remove("open");
  }
});

// Global keyboard shortcuts:
//  - Esc: close the top-most open modal (and any popover)
//  - /:   focus the primary search input on the current page (if any)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    _closeTxPopover?.();
    // Close the top-most open modal overlay by reverse DOM order
    const openModals = Array.from(document.querySelectorAll(".modal-overlay.active"));
    if (openModals.length) {
      const top = openModals[openModals.length - 1];
      top.classList.remove("active");
      top.style.display = "none";
    }
  } else if (e.key === "/" && !/input|textarea|select/i.test((e.target.tagName || ""))) {
    const page = (location.hash || "").slice(1);
    const id = ({
      transactions: "tx-filter-search",
      customers: "customers-search",
      vendors: "vendors-search",
      coa: "coa-filter-search",
    })[page];
    if (id) {
      const el = document.getElementById(id);
      if (el) { e.preventDefault(); el.focus(); }
    }
  }
});


// =====================================================================
//  TRANSACTIONS PAGE
// =====================================================================

let _txState = {
  limit: 50, offset: 0, has_more: false,
  categories: [], accounts: [], items: [],
  sort_col: "date", sort_dir: "desc",
};
let _txDebounceTimer = null;

async function txInit() {
  const body = document.getElementById("tx-body");
  if (!selectedCompanyId) {
    if (body) body.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--color-text-muted);">
      <div style="margin-bottom:12px;">Select a company from the sidebar switcher to see its transactions.</div>
      <button class="btn btn-primary btn-sm" onclick="navigateTo('companies')" type="button">Go to Companies</button>
    </td></tr>`;
    return;
  }
  const company = _getSelectedCompany();
  if (!company || company.source !== "manual") {
    if (body) body.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--color-text-muted);">
      Transactions are only available for <strong>Manual + Plaid</strong> companies.
      QBO companies keep their transactions in QuickBooks.
    </td></tr>`;
    return;
  }
  document.getElementById("tx-page-title").textContent = `Transactions — ${company.name}`;
  _txState.offset = 0;
  _txRenderSortArrows();
  await Promise.all([_txLoadCategories(), _txLoadAccounts()]);
  await txReload();
}

async function _txLoadCategories() {
  try {
    // Source-based routing: QBO → Railway; Plaid/Manual → Supabase direct.
    const __useRailway = _shouldUseRailway();
    if (!__useRailway) {
      // Pull categories joined to chart_of_accounts so we can show the CoA
      // code/name (which is what users want to see in the picker, not the
      // raw category name).
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/categories?company_id=eq.${selectedCompanyId}&select=id,name,coa:chart_of_accounts(code,name,type)&order=name`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` } },
      );
      if (r.ok) {
        const rows = await r.json();
        _txState.categories = rows.map((c) => ({
          id: c.id,
          name: c.coa?.name || c.name,
          code: c.coa?.code || "",
          type: c.coa?.type || null,
        }));
      } else {
        _txState.categories = [];
      }
    } else {
      const resp = await apiGet(`/api/categories/${selectedCompanyId}`);
      _txState.categories = resp.categories || [];
    }
    const sel = document.getElementById("tx-filter-category");
    if (sel) {
      sel.innerHTML = `<option value="">All categories</option>` +
        _txState.categories.map((c) => `<option value="${c.id}">${_escapeHtml(c.code ? c.code + " " : "")}${_escapeHtml(c.name)}</option>`).join("");
    }
  } catch (e) { console.warn("Categories load failed", e); }
}

async function _txLoadAccounts() {
  try {
    const resp = await apiGet(`/api/plaid/accounts/${selectedCompanyId}`);
    _txState.accounts = resp.accounts || [];
    _txState.items = resp.items || [];
    if (!_txState.items.length && supabaseAccessToken) {
      const [items, accts] = await Promise.all([
        _supaFetch("plaid_items", { select: "id,institution_name,status,last_synced_at,created_at", order: "created_at.desc" }),
        _supaFetch("accounts",    { select: "id,name,mask,type,subtype,plaid_item_id,current_balance,available_balance,coa_account_id" }),
      ]);
      if (items) _txState.items = items;
      if (accts) _txState.accounts = accts;
    }
    _txRenderBankFilter();
    _txRenderAccountFilter();
    _txRenderBanksSummary();
  } catch (e) { console.warn("Accounts load failed", e); }
}

function _txRenderBanksSummary() {
  const panel = document.getElementById("tx-banks-summary");
  if (!panel) return;
  const items = _txState.items || [];
  const accts = _txState.accounts || [];
  if (!items.length && !accts.length) {
    panel.style.display = "none";
    return;
  }
  const totalAccounts = accts.length;
  const totalBalance = accts.reduce((s, a) => s + (parseFloat(a.current_balance) || 0), 0);

  // Financials-style grouped chip layout ----------------------------------
  const activeBankId = document.getElementById("tx-filter-bank")?.value || "";
  const activeAcctId = document.getElementById("tx-filter-account")?.value || "";
  const allActive = !activeBankId && !activeAcctId;

  // Group Plaid items by primary account type → label.
  // Only two visible groups: BANK (depository + QBO imports) and CREDIT CARD.
  // Loans and investments are intentionally hidden — user doesn't want them.
  const typeToGroup = (t) => {
    const s = (t || "").toLowerCase();
    if (s === "depository") return { label: "BANK",        order: 1 };
    if (s === "credit")     return { label: "CREDIT CARD", order: 2 };
    return null;   // hide loans, investments, anything else
  };
  const groups = {};   // label → { order, rows: [{ chip_html }] }
  const addRow = (label, order, html) => {
    if (!groups[label]) groups[label] = { order, rows: [] };
    groups[label].rows.push(html);
  };

  const statusDot = (status) => {
    const ok = status === "good" || !status;
    const warn = status === "login_required" || status === "pending_expiration";
    const color = ok ? "#10b981" : (warn ? "#f59e0b" : "#ef4444");
    return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;"></span>`;
  };

  const syncIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>`;

  const chip = ({ id, label, sub, status, lastSync, onClick, onSync, active, bgVariant }) => {
    const selected = active;
    const bg = selected ? "var(--color-accent)" : (bgVariant || "var(--color-surface)");
    const fg = selected ? "white" : "var(--color-text-primary)";
    const border = selected ? "var(--color-accent)" : "var(--color-border)";
    return `<button type="button" onclick="${onClick}" title="${_escapeHtml(label)}"
        style="display:inline-flex;align-items:center;gap:8px;padding:6px 10px 6px 12px;
               background:${bg};color:${fg};border:1px solid ${border};
               border-radius:999px;font-size:var(--text-xs);cursor:pointer;font-family:inherit;white-space:nowrap;">
      ${selected ? "" : statusDot(status)}
      <strong>${_escapeHtml(label)}</strong>
      <span style="opacity:0.8;">${_escapeHtml(sub)}</span>
      ${lastSync ? `<span style="opacity:0.65;">· synced ${_timeAgo(new Date(lastSync))}</span>` : ""}
      ${onSync ? `<span onclick="event.stopPropagation();${onSync}" title="Sync now" style="display:inline-flex;align-items:center;padding:2px;opacity:0.65;cursor:pointer;">${syncIcon}</span>` : ""}
    </button>`;
  };

  // Per-item chips (skip groups that typeToGroup returns null for)
  for (const it of items) {
    const accs = accts.filter((a) => a.plaid_item_id === it.id);
    // Show this bank if ANY of its accounts is a visible type (depository
    // or credit), regardless of how many loan/investment accounts it also
    // has. With mixed-type items (e.g. First Internet Bank: 1 checking + 1
    // loan) a count-based primary picker would tie 1-1 and could pick
    // "loan", hiding the whole bank. Prefer depository, fall back to credit.
    const hasDepository = accs.some((a) => (a.type || "").toLowerCase() === "depository");
    const hasCredit     = accs.some((a) => (a.type || "").toLowerCase() === "credit");
    if (!hasDepository && !hasCredit) continue;   // pure loan / investment item — hide
    const g = typeToGroup(hasDepository ? "depository" : "credit");
    const sub = `${accs.length} acct${accs.length === 1 ? "" : "s"}`;
    addRow(g.label, g.order, chip({
      id: it.id,
      label: it.institution_name || "Bank",
      sub,
      status: it.status,
      lastSync: it.last_synced_at,
      onClick: `txChipSelectBank('${it.id}')`,
      onSync: `syncPlaidCompany('${selectedCompanyId}','${(_getSelectedCompany()?.name || "").replace(/'/g, "\\'")}')`,
      active: activeBankId === it.id,
    }));
  }

  // QBO Import placeholders → merge into the BANK group (per user preference).
  const placeholders = accts.filter((a) => !a.plaid_item_id);
  for (const p of placeholders) {
    const safeName = (p.name || "").replace(/'/g, "\\'");
    addRow("BANK", 1,
      `<span style="display:inline-flex;align-items:center;gap:4px;
                    background:${activeAcctId === p.id ? "var(--color-accent)" : "oklch(0.95 0.04 250)"};
                    color:${activeAcctId === p.id ? "white" : "#0f1d3d"};
                    border:1px solid ${activeAcctId === p.id ? "var(--color-accent)" : "oklch(0.85 0.08 250)"};
                    border-radius:999px;font-size:var(--text-xs);padding-left:10px;">
        <button type="button" onclick="txChipSelectAccount('${p.id}')" title="Filter to this import"
            style="display:inline-flex;align-items:center;gap:6px;padding:6px 4px 6px 0;background:transparent;color:inherit;border:none;cursor:pointer;font-family:inherit;font-size:inherit;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          <strong>${_escapeHtml(p.name)}</strong>
        </button>
        <button title="Delete this QBO import" onclick="txDeleteQboImport('${p.id}','${safeName}')"
            style="background:transparent;border:none;color:${activeAcctId === p.id ? "white" : "var(--color-error)"};font-size:var(--text-base);cursor:pointer;padding:0 8px 0 4px;line-height:1;" type="button">&times;</button>
      </span>`);
  }

  const allChip = `<button type="button" onclick="txChipSelectAll()" title="Show all accounts"
      style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;
             background:${allActive ? "var(--color-text)" : "var(--color-surface)"};
             color:${allActive ? "var(--color-text-inverse, white)" : "var(--color-text-primary)"};
             border:1px solid ${allActive ? "var(--color-text)" : "var(--color-border)"};
             border-radius:999px;font-size:var(--text-xs);cursor:pointer;font-family:inherit;font-weight:600;">
      All banks
    </button>`;

  // Render: Financials-style layout — per-group label on left, chips middle, action right
  const sortedGroups = Object.entries(groups).sort((a, b) => a[1].order - b[1].order);
  const groupRows = sortedGroups.map(([label, g], idx) => `
    <div style="display:flex;gap:12px;align-items:flex-start;padding:8px 0;${idx ? "border-top:1px solid var(--color-border);" : ""}">
      <div style="font-size:var(--text-xxs, 0.625rem);font-weight:700;letter-spacing:0.08em;color:var(--color-text-secondary);min-width:60px;padding-top:8px;">${label}</div>
      <div style="flex:1;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
        ${idx === 0 ? allChip : ""}
        ${g.rows.join("")}
      </div>
      ${idx === 0 ? `<div style="flex-shrink:0;">
        <button class="btn btn-sm btn-secondary" onclick="navigateTo('bank-accounts')" type="button" title="Manage bank connections">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M12 5v14M5 12h14"/></svg>
          Connect bank
        </button>
      </div>` : ""}
    </div>`).join("");

  panel.innerHTML = `
    <div style="padding:0;">
      ${groupRows || `<div style="padding:12px;color:var(--color-text-muted);font-size:var(--text-sm);">No bank connected yet. <a href="#bank-accounts" onclick="navigateTo('bank-accounts');return false;">Connect one →</a></div>`}
      <div style="border-top:1px solid var(--color-border);padding:6px 0 0;font-size:var(--text-xs);color:var(--color-text-secondary);display:flex;justify-content:space-between;">
        <span>${totalAccounts} account${totalAccounts === 1 ? "" : "s"} · total balance <strong style="color:var(--color-text-primary);">${formatCurrency(totalBalance)}</strong></span>
      </div>
    </div>`;
  panel.style.display = "block";
}

function _txRenderBankFilter() {
  const sel = document.getElementById("tx-filter-bank");
  if (!sel) return;
  sel.innerHTML = `<option value="">All banks</option>` +
    _txState.items.map((it) => `<option value="${it.id}">${_escapeHtml(it.institution_name || "Bank")}</option>`).join("");
}

function _txRenderAccountFilter() {
  const sel = document.getElementById("tx-filter-account");
  if (!sel) return;
  const bankId = document.getElementById("tx-filter-bank")?.value || "";
  const scoped = bankId
    ? _txState.accounts.filter((a) => a.plaid_item_id === bankId)
    : _txState.accounts;
  sel.innerHTML = `<option value="">All accounts</option>` +
    scoped.map((a) => `<option value="${a.id}">${_escapeHtml(a.name)}${a.mask ? " ···" + a.mask : ""}</option>`).join("");
}

function txChipSelectAll() {
  document.getElementById("tx-filter-bank").value = "";
  document.getElementById("tx-filter-account").value = "";
  _txRenderAccountFilter();
  _txState.offset = 0;
  txReload();
  _txRenderBanksSummary();
}

function txChipSelectBank(bankId) {
  document.getElementById("tx-filter-bank").value = bankId;
  document.getElementById("tx-filter-account").value = "";
  _txRenderAccountFilter();
  _txState.offset = 0;
  txReload();
  _txRenderBanksSummary();
}

function txChipSelectAccount(accountId) {
  document.getElementById("tx-filter-bank").value = "";
  // Rebuild the account dropdown FIRST (it wipes any pre-set value), then
  // assign the account id we want selected. Otherwise the rebuild clobbers it
  // and the backend gets account_id="" → returns all transactions.
  _txRenderAccountFilter();
  document.getElementById("tx-filter-account").value = accountId;
  _txState.offset = 0;
  txReload();
  _txRenderBanksSummary();
}

async function txDeleteQboImport(placeholderId, label) {
  const msg = `Delete "${label}"?\n\nThis removes the placeholder account AND every QBO-imported transaction attached to it from this company.\n\nAuto-created CoA accounts stay — remove them individually from the Chart of Accounts page if needed.\n\nType DELETE to confirm.`;
  const answer = prompt(msg);
  if (answer !== "DELETE") {
    if (answer !== null) showToast("Canceled — didn't match.", "info");
    return;
  }
  try {
    await apiDelete(`/api/accounts/${placeholderId}`);
    showToast(`${label} removed`, "success");
    // Refresh everything on the Transactions page
    await _txLoadAccounts();
    await txReload();
    if (typeof loadCompanyList === "function") await loadCompanyList();
  } catch (e) { showToast("Failed: " + (e.message || "unknown"), "error"); }
}

function txSetSort(col) {
  if (_txState.sort_col === col) {
    _txState.sort_dir = _txState.sort_dir === "asc" ? "desc" : "asc";
  } else {
    _txState.sort_col = col;
    _txState.sort_dir = col === "date" || col === "amount" || col === "spent" || col === "received" ? "desc" : "asc";
  }
  _txState.offset = 0;
  _txRenderSortArrows();
  // "spent" and "received" are pseudo-columns derived from `amount`. Sort
  // client-side over the loaded page so we don't need backend support
  // for a computed column.
  if (col === "spent" || col === "received") {
    _txRender(_txSortClientSide(_txState.txs || []));
  } else {
    txReload();
  }
}

function _txSortClientSide(txs) {
  const col = _txState.sort_col;
  const dir = _txState.sort_dir;
  if (col !== "spent" && col !== "received") return txs;
  // Plaid convention: positive amount = spent (outflow), negative = received.
  // For "Spent" sort, spend rows come first (largest spend on top when desc).
  // For "Received" sort, receive rows come first (largest receive on top when desc).
  const want = col === "spent" ? "spent" : "received";
  const dirMul = dir === "desc" ? -1 : 1;
  const arr = [...txs];
  arr.sort((a, b) => {
    const aVal = Number(a.amount || 0);
    const bVal = Number(b.amount || 0);
    const aIs = want === "spent" ? aVal > 0 : aVal < 0;
    const bIs = want === "spent" ? bVal > 0 : bVal < 0;
    // Rows of the wanted side always come before the other side.
    if (aIs && !bIs) return -1;
    if (!aIs && bIs) return 1;
    if (!aIs && !bIs) return 0;
    // Both on the wanted side — compare by magnitude of that side.
    const aMag = want === "spent" ? aVal : -aVal;
    const bMag = want === "spent" ? bVal : -bVal;
    return (aMag - bMag) * dirMul;
  });
  return arr;
}

function _txRenderSortArrows() {
  document.querySelectorAll(".tx-sort-th").forEach((th) => {
    const col = th.dataset.sort;
    const arrow = th.querySelector(".tx-sort-arrow");
    if (!arrow) return;
    if (col === _txState.sort_col) {
      arrow.textContent = _txState.sort_dir === "asc" ? " ▲" : " ▼";
      arrow.style.opacity = "1";
    } else {
      arrow.textContent = " ⇅";
      arrow.style.opacity = "0.35";
    }
  });
}

function txBankChanged() {
  // Rebuild account options to match the selected bank and reset account picker
  const acctSel = document.getElementById("tx-filter-account");
  if (acctSel) acctSel.value = "";
  _txRenderAccountFilter();
  txReload();
  _txRenderBanksSummary();
}

function txDebouncedReload() {
  clearTimeout(_txDebounceTimer);
  _txDebounceTimer = setTimeout(txReload, 350);
}

function txResetFilters() {
  ["tx-filter-search", "tx-filter-date-from", "tx-filter-date-to"].forEach((id) => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  ["tx-filter-bank", "tx-filter-account", "tx-filter-category"].forEach((id) => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  ["tx-filter-uncat", "tx-filter-transfers"].forEach((id) => {
    const el = document.getElementById(id); if (el) el.checked = false;
  });
  _txRenderAccountFilter();
  _txState.offset = 0;
  txReload();
}

async function txReload() {
  if (!selectedCompanyId) return;
  const body = document.getElementById("tx-body");
  body.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--color-text-muted);">Loading...</td></tr>';

  const params = new URLSearchParams({
    limit: String(_txState.limit),
    offset: String(_txState.offset),
    sort: `${_txState.sort_col}.${_txState.sort_dir}`,
  });
  const search = document.getElementById("tx-filter-search").value.trim();
  if (search) params.set("search", search);
  const dateFrom = document.getElementById("tx-filter-date-from").value;
  if (dateFrom) params.set("date_from", dateFrom);
  const dateTo = document.getElementById("tx-filter-date-to").value;
  if (dateTo) params.set("date_to", dateTo);
  const bank = document.getElementById("tx-filter-bank").value;
  if (bank) params.set("plaid_item_id", bank);
  const acct = document.getElementById("tx-filter-account").value;
  if (acct) params.set("account_id", acct);
  const cat = document.getElementById("tx-filter-category").value;
  if (cat) params.set("category_id", cat);
  if (document.getElementById("tx-filter-uncat").checked) params.set("uncategorized_only", "true");
  if (document.getElementById("tx-filter-transfers").checked) params.set("transfers_only", "true");

  try {
    let txs = [];
    let hasMore = false;
    // Manual+Plaid companies live in Supabase. QBO companies live in
    // Railway. _shouldUseRailway() picks the right backend, with a safe
    // Supabase fallback when the company list isn't loaded but a Supabase
    // session exists.
    //
    // Edge case: QBO Import placeholder accounts. The QBO→Manual import
    // writes its data into Supabase journal_entries / journal_lines (GL),
    // not into the transactions table. Detect the chip and project the
    // posted lines on this placeholder's cash COA into transaction-shaped
    // rows for the table renderer. Read-only — no match/categorize/edit.
    const acctRow = (_txState.accounts || []).find((a) => a.id === acct);
    const isQboImportFilter = !!(acct && acctRow && !acctRow.plaid_item_id && (acctRow.name || "").startsWith("QBO Import · "));
    if (isQboImportFilter) {
      const fb = await _txFetchFromJournalEntriesAsTxns(acctRow, params);
      txs = (fb && fb.rows) || [];
      hasMore = !!(fb && fb.has_more);
    } else if (_shouldUseRailway()) {
      const resp = await apiGet(`/api/transactions/${selectedCompanyId}?${params.toString()}`);
      txs = resp.transactions || [];
      hasMore = !!resp.has_more;
      // Defensive: if Railway returns empty for what's actually a Supabase
      // company (stale source flag, etc.), fall through to Supabase.
      if (!txs.length && supabaseAccessToken) {
        const fb = await _txFetchFromSupabase(params);
        if (fb && fb.rows && fb.rows.length) { txs = fb.rows; hasMore = !!fb.has_more; }
      }
    } else if (supabaseAccessToken) {
      const fb = await _txFetchFromSupabase(params);
      txs = (fb && fb.rows) || [];
      hasMore = !!(fb && fb.has_more);
    }
    _txState.has_more = hasMore;
    _txState.txs = txs;
    // Match hints + applied-match lookups don't apply to GL-derived JE rows
    // (they have synthetic je:<id> ids that aren't in payments / payment_apps).
    if (isQboImportFilter) {
      _txMatchMap = null;
      _txAppliedMap = null;
    } else {
      // Fetch match hints + already-applied matches in parallel. Hints surface
      // an inline Match button for Plaid-categorized rows lining up with an
      // open bill/invoice; applied matches show what each txn is *already*
      // linked to so the user doesn't have to dig into the bill detail page.
      await Promise.all([_txLoadMatchHints(txs), _txLoadAppliedMatches(txs)]);
    }
    _txRender(txs);
    document.getElementById("tx-summary").textContent = `${txs.length} shown`;
    const pageNum = Math.floor(_txState.offset / _txState.limit) + 1;
    document.getElementById("tx-pagination-info").textContent = `Page ${pageNum}`;
    document.getElementById("tx-prev").disabled = _txState.offset <= 0;
    document.getElementById("tx-next").disabled = !_txState.has_more;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--color-error);">Load failed: ${_escapeHtml(e.message || "unknown")}</td></tr>`;
  }
}

// Generic Supabase REST fetcher for fallback queries when Railway's
// endpoints return empty for manual+plaid companies whose data lives
// only in Supabase.
async function _supaFetch(table, query) {
  if (!supabaseAccessToken || !selectedCompanyId) return null;
  const sp = new URLSearchParams();
  sp.append("company_id", `eq.${selectedCompanyId}`);
  sp.append("select", query.select || "*");
  if (query.order) sp.append("order", query.order);
  if (query.limit) sp.append("limit", String(query.limit));
  for (const f of (query.filters || [])) sp.append(f.k, f.v);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${sp.toString()}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` },
    });
    if (!r.ok) {
      console.warn(`[supa] ${table} ${r.status}`, (await r.text()).slice(0, 200));
      return null;
    }
    return await r.json();
  } catch (e) { console.warn(`[supa] ${table} fetch failed`, e); return null; }
}

// PATCH a single row in `table` filtered by `id`. Throws on non-2xx so
// callers can show toast errors. Used by the dual-path writers in
// transactions/accounts when the active company is manual+Plaid.
async function _supaPatchRow(table, id, patch) {
  if (!supabaseAccessToken) throw new Error("Not signed in to Supabase.");
  const headers = {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${supabaseAccessToken}`,
    Prefer: "return=minimal",
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers, body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// =====================================================================
//  GL auto-emission (writes journal_entries + journal_lines on each event)
// =====================================================================
//
// When a company has any journal_entries rows, we treat it as "on the
// GL" and auto-emit a balanced JE for every bill / payment / categorized
// transaction event. Companies without GL data are no-ops here (legacy
// path remains untouched). Backfill JEs use source='backfill'; live
// emissions use source='auto' so the two are distinguishable and a
// rollback by source value is cheap.
//
// Idempotency: each auto-emitted JE has memo = `auto:<kind>:<source_id>`.
// On re-emit (e.g. txn re-categorized, bill updated), we DELETE prior
// auto JEs with the same memo before inserting.

const _glCompanyEnabledCache = new Map();
const _apCoaCache = new Map();
const _arCoaCache = new Map();

async function _glCompanyEnabled(companyId) {
  if (!companyId) return false;
  if (_glCompanyEnabledCache.has(companyId)) return _glCompanyEnabledCache.get(companyId);
  if (!supabaseAccessToken) return false;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/journal_entries?company_id=eq.${companyId}&select=id&limit=1`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` } }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    const enabled = Array.isArray(rows) && rows.length > 0;
    _glCompanyEnabledCache.set(companyId, enabled);
    return enabled;
  } catch { return false; }
}

async function _glLookupClearingCoa(companyId, kind /* 'ap' | 'ar' */) {
  const cache = kind === "ar" ? _arCoaCache : _apCoaCache;
  if (cache.has(companyId)) return cache.get(companyId);
  const filter = kind === "ar"
    ? `type=eq.asset&name=ilike.*receivable*`
    : `type=eq.liability&name=ilike.*payable*`;
  // Pull all candidates and prefer subtype='operating' — companies often
  // have multiple A/P-named rows (a default unsubtyped one + the canonical
  // operating one). Without this, the lookup picks whichever sorts first
  // by code, which for FT Barrett is the unsubtyped duplicate (code 2000)
  // while the backfill historically used the subtyped row (code 2901).
  // Falls back to "loans payable" exclusion + first match.
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/chart_of_accounts?company_id=eq.${companyId}&is_active=eq.true&${filter}&select=id,code,name,subtype&order=code`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` } }
  );
  let id = null;
  if (r.ok) {
    const rows = await r.json();
    // Filter out "Loans Payable" / "Accounts/Notes Receivable" sub-types we
    // don't want to land bill-payments on.
    const candidates = rows.filter((c) => {
      const n = (c.name || "").toLowerCase();
      if (kind === "ap") return /payable/.test(n) && !/loan/.test(n);
      return /receivable/.test(n) && !/note/.test(n);
    });
    const operating = candidates.find((c) => c.subtype === "operating");
    id = (operating || candidates[0])?.id || null;
  }
  cache.set(companyId, id);
  return id;
}

// Insert (or replace) a JE keyed by memo `auto:<kind>:<sourceId>`.
// `lines` is an array of {coa_account_id, debit, credit, description}.
// No-op if the company is not on the GL.
async function _glEmit(kind, sourceId, dateISO, lines, options) {
  const companyId = (options && options.company_id) || selectedCompanyId;
  if (!companyId) return;
  if (!await _glCompanyEnabled(companyId)) return;
  if (!Array.isArray(lines) || lines.length === 0) return;
  // Drop zero-amount lines, validate balance.
  const cleanLines = lines.filter((l) => (parseFloat(l.debit) || 0) > 0.005 || (parseFloat(l.credit) || 0) > 0.005);
  if (!cleanLines.length) return;
  const totalDr = cleanLines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0);
  const totalCr = cleanLines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  if (Math.abs(totalDr - totalCr) > 0.01) {
    console.warn("[GL] Refusing unbalanced JE", { kind, sourceId, totalDr, totalCr });
    return;
  }
  const memo = `auto:${kind}:${sourceId}`;
  const headers = {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${supabaseAccessToken}`,
  };
  // Idempotency: drop any prior auto JE with the same memo.
  await fetch(
    `${SUPABASE_URL}/rest/v1/journal_entries?company_id=eq.${companyId}&memo=eq.${encodeURIComponent(memo)}&source=eq.auto`,
    { method: "DELETE", headers }
  ).catch(() => {});
  const jeRes = await fetch(`${SUPABASE_URL}/rest/v1/journal_entries`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify({ company_id: companyId, date: dateISO, memo, source: "auto" }),
  });
  if (!jeRes.ok) {
    console.warn("[GL] JE insert failed", kind, sourceId, jeRes.status);
    return;
  }
  const [je] = await jeRes.json();
  const linesPayload = cleanLines.map((l) => ({
    journal_entry_id: je.id,
    coa_account_id: l.coa_account_id,
    debit: parseFloat(l.debit) || 0,
    credit: parseFloat(l.credit) || 0,
    description: l.description || null,
  }));
  const linesRes = await fetch(`${SUPABASE_URL}/rest/v1/journal_lines`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(linesPayload),
  });
  if (!linesRes.ok) {
    console.warn("[GL] Lines insert failed; rolling back JE", kind, sourceId);
    await fetch(`${SUPABASE_URL}/rest/v1/journal_entries?id=eq.${je.id}`, { method: "DELETE", headers }).catch(() => {});
  }
}

async function _glEmitDelete(kind, sourceId, options) {
  const companyId = (options && options.company_id) || selectedCompanyId;
  if (!companyId) return;
  if (!await _glCompanyEnabled(companyId)) return;
  const memo = `auto:${kind}:${sourceId}`;
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  await fetch(
    `${SUPABASE_URL}/rest/v1/journal_entries?company_id=eq.${companyId}&memo=eq.${encodeURIComponent(memo)}&source=eq.auto`,
    { method: "DELETE", headers }
  ).catch(() => {});
}

// Translate the Railway PATCH /api/transactions/{id} body shape into the
// Supabase column shape, then apply it.
async function _supaTxnPatch(txId, body) {
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, "category_id")) {
    patch.category_id = body.category_id;
    patch.categorized_by = "user";
  }
  if (body.clear_category) {
    patch.category_id = null;
    patch.categorized_by = "user";
  }
  if (body.clear_vendor) {
    patch.vendor_id = null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "is_transfer")) {
    patch.is_transfer = !!body.is_transfer;
  }
  if (Object.prototype.hasOwnProperty.call(body, "vendor_id")) {
    patch.vendor_id = body.vendor_id;
  }
  if (Object.prototype.hasOwnProperty.call(body, "notes")) {
    patch.notes = body.notes;
  }
  if (!Object.keys(patch).length) return;
  await _supaPatchRow("transactions", txId, patch);

  // GL auto-emission: if this patch changed the category, sync the JE.
  // No-op for companies not on the GL.
  const changedCategory =
    Object.prototype.hasOwnProperty.call(patch, "category_id") ||
    body.clear_category;
  if (changedCategory) {
    try { await _glSyncTxnCategorize(txId); }
    catch (e) { console.warn("[GL] txn categorize emit failed", e); }
  }
}

// Look up the txn's date / amount / account-cash-coa / category-coa, then
// emit (or delete) the auto JE for it. Called after a categorize patch.
async function _glSyncTxnCategorize(txId) {
  if (!selectedCompanyId) return;
  if (!await _glCompanyEnabled(selectedCompanyId)) return;
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  const txArr = await fetch(
    `${SUPABASE_URL}/rest/v1/transactions?id=eq.${txId}&select=date,amount,account_id,category_id&limit=1`,
    { headers }
  ).then((r) => r.ok ? r.json() : []);
  const tx = txArr[0];
  if (!tx) return;
  if (!tx.category_id) {
    // Category cleared — drop any existing auto JE for this txn.
    await _glEmitDelete("txn", txId);
    return;
  }
  const [acctArr, catArr] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/accounts?id=eq.${tx.account_id}&select=coa_account_id&limit=1`, { headers }).then((r) => r.ok ? r.json() : []),
    fetch(`${SUPABASE_URL}/rest/v1/categories?id=eq.${tx.category_id}&select=coa_account_id&limit=1`, { headers }).then((r) => r.ok ? r.json() : []),
  ]);
  const cashCoa = acctArr[0]?.coa_account_id;
  const eventCoa = catArr[0]?.coa_account_id;
  if (!cashCoa || !eventCoa) {
    // Missing COA mapping — refuse to emit a partial JE.
    await _glEmitDelete("txn", txId);
    return;
  }
  const amt = parseFloat(tx.amount);
  const abs = Math.abs(amt);
  // Universal rule: amount > 0 = outflow on bank → Dr event, Cr cash.
  //                 amount < 0 = inflow on bank  → Cr event, Dr cash.
  const lines = amt > 0
    ? [
        { coa_account_id: eventCoa, debit: abs, credit: 0, description: "Categorize" },
        { coa_account_id: cashCoa,  debit: 0,   credit: abs, description: "Cash leg" },
      ]
    : [
        { coa_account_id: eventCoa, debit: 0,   credit: abs, description: "Categorize" },
        { coa_account_id: cashCoa,  debit: abs, credit: 0,   description: "Cash leg" },
      ];
  await _glEmit("txn", txId, tx.date, lines);
}

// Pull transactions directly from Supabase. Returns { rows, has_more }.
// Used as the primary path for manual+Plaid companies and as a fallback
// when Railway returns an empty page for a misclassified company.
async function _txFetchFromSupabase(params) {
  if (!supabaseAccessToken || !selectedCompanyId) return { rows: [], has_more: false };
  const sp = new URLSearchParams();
  sp.append("company_id", `eq.${selectedCompanyId}`);
  sp.append("select", "*,account:accounts(name,mask),vendor:vendors(display_name),category:categories(name)");
  // Honor sort + paging from the caller's params so manual+Plaid companies
  // get real pagination (Range header + count=exact for has_more).
  const limit = parseInt(params.get("limit") || "50", 10);
  const offset = parseInt(params.get("offset") || "0", 10);
  const sort = params.get("sort") || "date.desc";
  // sort is "<col>.<dir>" (e.g. "date.desc"); pass through as PostgREST order.
  sp.append("order", sort);
  // Hide QBO-imported journal entries by default — those are double-entry
  // rows that duplicate real bank activity. Only apply this hide when the
  // user has NOT picked a specific bank/account chip; if they explicitly
  // click the QBO Import chip, they want to see those rows.
  const bankSelected = params.get("plaid_item_id");
  const acctSelected = params.get("account_id");
  if (!bankSelected && !acctSelected) {
    sp.append("plaid_txn_id", "not.like.qbo:*");
  }

  // Pass through bank/account chip selections. plaid_item_id lives on the
  // accounts table, so resolve to a set of account_ids client-side from the
  // cached _txState.accounts list and filter with PostgREST's in.() syntax.
  if (acctSelected) sp.append("account_id", `eq.${acctSelected}`);
  if (bankSelected) {
    const ids = (_txState.accounts || [])
      .filter((a) => a.plaid_item_id === bankSelected)
      .map((a) => a.id);
    if (ids.length) {
      sp.append("account_id", `in.(${ids.join(",")})`);
    } else {
      // Bank selected but we have no accounts for it cached — return nothing
      // rather than fall back to "all transactions for the company".
      sp.append("account_id", "eq.00000000-0000-0000-0000-000000000000");
    }
  }

  const search = params.get("search");
  if (search) {
    const s = search.replace(/[(),*]/g, "");
    sp.append("or", `(merchant_name.ilike.*${s}*,description.ilike.*${s}*,name.ilike.*${s}*)`);
  }
  const dateFrom = params.get("date_from");
  if (dateFrom) sp.append("date", `gte.${dateFrom}`);
  const dateTo = params.get("date_to");
  if (dateTo) sp.append("date", `lte.${dateTo}`);
  // Header filter chips that the original code set on `params` but the
  // Supabase fetcher was ignoring — that's why "Uncategorized only" and
  // "Transfers only" were showing categorized/non-transfer rows through.
  const cat = params.get("category_id");
  if (cat) sp.append("category_id", `eq.${cat}`);
  if (params.get("uncategorized_only") === "true") {
    sp.append("category_id", "is.null");
    sp.append("is_transfer", "eq.false");
  }
  if (params.get("transfers_only") === "true") {
    sp.append("is_transfer", "eq.true");
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/transactions?${sp.toString()}`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${supabaseAccessToken}`,
        // count=exact + Range tells PostgREST to return total count in the
        // Content-Range header so we can compute has_more without an extra
        // round-trip.
        Prefer: "count=exact",
        Range: `${offset}-${offset + limit - 1}`,
      },
    });
    if (!r.ok) {
      console.warn("[supa] transactions", r.status, (await r.text()).slice(0, 200));
      return { rows: [], has_more: false };
    }
    const rows = await r.json();
    let hasMore = false;
    const cr = r.headers.get("content-range") || "";
    // Content-Range looks like "0-49/250" or "0-49/*"
    const m = /\/(\d+|\*)/.exec(cr);
    if (m && m[1] !== "*") {
      const total = parseInt(m[1], 10);
      hasMore = (offset + rows.length) < total;
    } else {
      // Conservative fallback: if a full page came back, assume more.
      hasMore = rows.length >= limit;
    }
    return { rows, has_more: hasMore };
  } catch (e) {
    console.warn("[supa] transactions fetch failed", e);
    return { rows: [], has_more: false };
  }
}

// QBO Import data lives in journal_entries / journal_lines (GL), not in the
// transactions table. Fetch the lines posted to this placeholder's cash COA
// and project them into transaction-shaped rows the table renderer accepts.
// Read-only: rows carry is_journal_row so the renderer suppresses the inline
// edit / match / actions UI (those operate on the transactions table by id).
async function _txFetchFromJournalEntriesAsTxns(acctRow, params) {
  if (!supabaseAccessToken || !selectedCompanyId) return { rows: [], has_more: false };
  const cashCoa = acctRow && acctRow.coa_account_id;
  if (!cashCoa) return { rows: [], has_more: false };

  const limit = parseInt(params.get("limit") || "50", 10);
  const offset = parseInt(params.get("offset") || "0", 10);
  const dateFrom = params.get("date_from");
  const dateTo = params.get("date_to");

  // Embed the parent journal_entries row so we can filter on company_id +
  // optional date range and read date/memo for each line.
  const sp = new URLSearchParams();
  sp.append("coa_account_id", `eq.${cashCoa}`);
  sp.append("select", "id,debit,credit,description,journal_entry:journal_entries!inner(id,date,memo,company_id)");
  sp.append("journal_entry.company_id", `eq.${selectedCompanyId}`);
  if (dateFrom) sp.append("journal_entry.date", `gte.${dateFrom}`);
  if (dateTo) sp.append("journal_entry.date", `lte.${dateTo}`);
  sp.append("order", "journal_entry(date).desc");

  let lines = [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/journal_lines?${sp.toString()}`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${supabaseAccessToken}`,
        Prefer: "count=exact",
        Range: `${offset}-${offset + limit - 1}`,
      },
    });
    if (!r.ok) {
      console.warn("[je-as-tx]", r.status, (await r.text()).slice(0, 200));
      return { rows: [], has_more: false };
    }
    lines = await r.json();
    var contentRange = r.headers.get("content-range") || "";
  } catch (e) {
    console.warn("[je-as-tx] fetch failed", e);
    return { rows: [], has_more: false };
  }

  // Cheap client-side search across description + memo (PostgREST OR-filter
  // on embed targets is awkward, and we already paged by Range above).
  const search = (params.get("search") || "").trim().toLowerCase();
  if (search) {
    lines = lines.filter((l) =>
      (l.description || "").toLowerCase().includes(search) ||
      (l.journal_entry && (l.journal_entry.memo || "").toLowerCase().includes(search))
    );
  }

  let hasMore = false;
  const m = /\/(\d+|\*)/.exec(contentRange || "");
  if (m && m[1] !== "*") {
    hasMore = (offset + lines.length) < parseInt(m[1], 10);
  } else {
    hasMore = lines.length >= limit;
  }

  // Bank/asset COA: debit = inflow (Received), credit = outflow (Spent).
  // Renderer convention: amount > 0 = Spent, amount < 0 = Received → so
  // amount = credit - debit.
  const rows = lines.map((l) => {
    const debit = parseFloat(l.debit) || 0;
    const credit = parseFloat(l.credit) || 0;
    const memo = (l.journal_entry && l.journal_entry.memo) || "";
    return {
      id: `je:${l.id}`,
      date: (l.journal_entry && l.journal_entry.date) || null,
      amount: credit - debit,
      description: l.description || memo || "(journal entry)",
      merchant_name: null,
      account: { name: acctRow.name, mask: null },
      vendor: null,
      category: null,
      category_id: null,
      vendor_id: null,
      is_transfer: false,
      pending: false,
      categorized_by: null,
      is_journal_row: true,
    };
  });

  return { rows, has_more: hasMore };
}

function _txRender(txs) {
  const body = document.getElementById("tx-body");
  if (!txs.length) {
    body.innerHTML = emptyStateCell(10, {title: "No transactions match these filters", body: "Try widening the date range, clearing search, or removing the category filter."});
    return;
  }
  body.innerHTML = txs.map((t) => {
    const amount = Number(t.amount || 0);
    // Plaid convention: positive amount = outflow (Spent). Negative = inflow (Received).
    const spent = amount > 0 ? amount : 0;
    const received = amount < 0 ? -amount : 0;
    const acct = t.account ? `${_escapeHtml(t.account.name)}${t.account.mask ? " ···" + t.account.mask : ""}` : "—";

    // Read-only row for GL-derived QBO Import entries: no checkbox, no
    // editable cells, no actions menu — those all operate on a real txn id
    // and would 404 / inject invalid UUIDs into payments queries.
    if (t.is_journal_row) {
      const jeMerch = t.description || "—";
      const jeBadge = '<span class="badge badge-neutral" style="font-size:var(--text-xxs, 0.625rem);margin-left:6px;">journal</span>';
      return `<tr data-tx-id="${t.id}" data-is-journal="1">
        <td></td>
        <td style="font-size:var(--text-xs);white-space:nowrap;">${formatDate(t.date, "long")}</td>
        <td><div style="font-weight:500;">${_escapeHtml(jeMerch)}${jeBadge}</div></td>
        <td style="font-size:var(--text-xs);">${acct}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums;color:var(--color-text);">${spent > 0 ? formatNumber(spent) : ""}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums;color:var(--color-success);">${received > 0 ? formatNumber(received) : ""}</td>
        <td><span style="color:var(--color-text-muted);">—</span></td>
        <td><span style="color:var(--color-text-muted);font-size:var(--text-xs);">—</span></td>
        <td></td>
      </tr>`;
    }

    const catName = t.category ? t.category.name : (t.is_transfer ? "Transfer" : "Uncategorized");
    const catClass = t.category ? "" : (t.is_transfer ? "color:var(--color-text-secondary);font-style:italic;" : "color:var(--color-error);");
    const vendorName = t.vendor ? t.vendor.display_name : "";
    const vendorCell = vendorName ? _escapeHtml(vendorName) : '<span style="color:var(--color-text-muted);">—</span>';
    const merch = t.merchant_name || t.description || "—";
    const descLine = t.merchant_name && t.description && t.merchant_name !== t.description
      ? `<div style="font-size:var(--text-xs);color:var(--color-text-secondary);">${_escapeHtml(t.description)}</div>` : "";
    const isSplit = !!t.split_parent_id;
    const pencil = `<span class="inline-edit-pencil" aria-hidden="true">✎</span>`;

    // Three-state match column: already-applied beats suggested-hint beats
    // plain category. Applied is the truth from payment_applications;
    // hint is just a suggestion from _supaMatchSuggestions.
    const applied = _txAppliedMap ? _txAppliedMap[t.id] : null;
    const matchHint = !applied && _txMatchMap ? _txMatchMap[t.id] : null;
    let matchHtml;
    if (applied) {
      const kindLabel = applied.kind === "invoice" ? "Invoice" : "Bill";
      const numLabel = applied.number ? _escapeHtml(applied.number) : "—";
      matchHtml = `<div style="font-size:var(--text-xs);line-height:1.3;">`
        + `<div style="font-weight:600;color:var(--color-success);">✓ ${kindLabel} ${numLabel}${applied.date ? " — " + formatDate(applied.date) : ""}</div>`
        + `${applied.party ? `<div style="color:var(--color-text-secondary);">${_escapeHtml(applied.party)}</div>` : ""}`
        + `<div style="margin-top:3px;"><button class="btn btn-sm btn-ghost" style="padding:2px 8px;" onclick="viewMatchedDoc('${applied.kind}','${applied.target_id}')" title="Open the linked ${kindLabel.toLowerCase()}">View</button></div>`
        + `</div>`;
    } else if (matchHint) {
      matchHtml = `<div style="font-size:var(--text-xs);color:var(--color-success);line-height:1.3;">`
        + `<div style="font-weight:600;">${matchHint.kind === "invoice" ? "Invoice" : "Bill"} ${_escapeHtml(matchHint.number || "")}${matchHint.date ? " — " + formatDate(matchHint.date) : ""}</div>`
        + `${matchHint.party ? `<div>${_escapeHtml(matchHint.party)}</div>` : ""}`
        + `<div style="margin-top:3px;"><button class="btn btn-sm btn-primary" style="padding:2px 10px;" onclick="txApplyMatchHint('${t.id}')">Match</button> `
        + `<button class="btn btn-sm btn-ghost" style="padding:2px 8px;" onclick="_txBeginInlineEdit(event, '${t.id}', 'category')" title="Categorize instead">Categorize</button></div>`
        + `</div>`;
    } else {
      matchHtml = `<span class="tx-editable-content" style="${catClass}">${_escapeHtml(catName)}${isSplit ? ' <span class="badge badge-neutral" style="font-size:var(--text-xxs, 0.625rem);">split</span>' : ""}</span>${pencil}`;
    }

    return `<tr data-tx-id="${t.id}" data-is-transfer="${t.is_transfer ? "1" : "0"}" data-has-category="${t.category_id ? "1" : "0"}" data-has-vendor="${t.vendor_id ? "1" : "0"}">
      <td><input type="checkbox" class="tx-row-check" value="${t.id}" onchange="txUpdateBulkBar()"></td>
      <td style="font-size:var(--text-xs);white-space:nowrap;">${formatDate(t.date, "long")}${t.pending ? ' <span class="badge badge-warning" style="font-size:var(--text-xxs, 0.625rem);">pending</span>' : ""}</td>
      <td><div style="font-weight:500;">${_escapeHtml(merch)}</div>${descLine}</td>
      <td style="font-size:var(--text-xs);">${acct}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;color:var(--color-text);">${spent > 0 ? formatNumber(spent) : ""}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;color:var(--color-success);">${received > 0 ? formatNumber(received) : ""}</td>
      <td class="tx-editable" onclick="_txBeginInlineEdit(event, '${t.id}', 'vendor')" title="Click to set vendor">
        <span class="tx-editable-content" style="font-size:var(--text-xs);">${vendorCell}</span>${pencil}
      </td>
      <td class="tx-editable" ${(!matchHint && !applied) ? `onclick="_txBeginInlineEdit(event, '${t.id}', 'category')"` : ""} title="${applied ? "Already matched — click View to open the linked document" : matchHint ? "Suggested match — click Match to apply" : "Click to set category"}">${matchHtml}</td>
      <td style="text-align:right;">
        <button class="btn btn-sm btn-ghost" onclick="txActionsMenu('${t.id}', event)" title="More">⋯</button>
      </td>
    </tr>`;
  }).join("");
}

// ---- Auto-match (QBO bank feed style) ----
// _txMatchMap: txnId -> { kind, id, number, date, party, balance, score }
let _txMatchMap = null;
// _txAppliedMap: txnId -> { kind, target_id, number, date, party } where the
// txn is already linked to a bill/invoice via payment_applications.
let _txAppliedMap = null;

// Fetch the bill/invoice each transaction is already matched to via the
// payments + payment_applications tables. Lets the Transactions list show
// "✓ Bill 302706398-2026-03" inline instead of just the underlying category.
async function _txLoadAppliedMatches(txs) {
  if (!supabaseAccessToken || !selectedCompanyId || !txs || !txs.length) {
    _txAppliedMap = null;
    return;
  }
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  const txIds = txs.map((t) => t.id);
  try {
    const payRes = await fetch(
      `${SUPABASE_URL}/rest/v1/payments?company_id=eq.${selectedCompanyId}&matched_transaction_id=in.(${txIds.join(",")})&select=id,kind,matched_transaction_id`,
      { headers }
    );
    const pays = payRes.ok ? await payRes.json() : [];
    if (!pays.length) { _txAppliedMap = {}; return; }
    const payIds = pays.map((p) => p.id);
    const appRes = await fetch(
      `${SUPABASE_URL}/rest/v1/payment_applications?payment_id=in.(${payIds.join(",")})&select=payment_id,bill_id,invoice_id,amount`,
      { headers }
    );
    const apps = appRes.ok ? await appRes.json() : [];
    const billIds = [...new Set(apps.map((a) => a.bill_id).filter(Boolean))];
    const invIds = [...new Set(apps.map((a) => a.invoice_id).filter(Boolean))];
    const [bills, invs] = await Promise.all([
      billIds.length ? fetch(`${SUPABASE_URL}/rest/v1/bills?id=in.(${billIds.join(",")})&select=id,number,date,due_date,vendor:vendors(display_name)`, { headers }).then((r) => r.ok ? r.json() : []) : Promise.resolve([]),
      invIds.length ? fetch(`${SUPABASE_URL}/rest/v1/invoices?id=in.(${invIds.join(",")})&select=id,number,date,due_date,customer:customers(display_name)`, { headers }).then((r) => r.ok ? r.json() : []) : Promise.resolve([]),
    ]);
    const billsById = new Map(bills.map((b) => [b.id, b]));
    const invsById = new Map(invs.map((i) => [i.id, i]));
    // payment_id -> first application (most matches are one-to-one)
    const appByPayment = new Map();
    for (const a of apps) if (!appByPayment.has(a.payment_id)) appByPayment.set(a.payment_id, a);
    const out = {};
    for (const p of pays) {
      const a = appByPayment.get(p.id);
      if (!a) continue;
      if (a.bill_id) {
        const b = billsById.get(a.bill_id);
        if (!b) continue;
        out[p.matched_transaction_id] = {
          kind: "bill",
          target_id: b.id,
          number: b.number,
          date: b.date,
          party: b.vendor?.display_name || "",
        };
      } else if (a.invoice_id) {
        const inv = invsById.get(a.invoice_id);
        if (!inv) continue;
        out[p.matched_transaction_id] = {
          kind: "invoice",
          target_id: inv.id,
          number: inv.number,
          date: inv.date,
          party: inv.customer?.display_name || "",
        };
      }
    }
    _txAppliedMap = out;
  } catch (e) {
    console.warn("[supa] applied-match fetch failed", e);
    _txAppliedMap = null;
  }
}

// Open the bill/invoice page filtered to the linked document so the user can
// review or unmatch it.
function viewMatchedDoc(kind, targetId) {
  if (!targetId) return;
  if (kind === "invoice") {
    location.hash = `#invoices?id=${targetId}`;
  } else {
    location.hash = `#bills?id=${targetId}`;
  }
}

async function _txLoadMatchHints(txs) {
  if (!selectedCompanyId || !txs || !txs.length) { _txMatchMap = null; return; }
  // Plaid-auto-categorized, uncategorized, or QBO-imported A/P|A/R rows are
  // all match candidates — QBO bill payments arrive with category_id already
  // set to A/P, but they're exactly the rows users want to link to bills.
  const candidates = txs.filter((t) => !t.is_transfer && (t.categorized_by === "plaid" || t.categorized_by === "qbo_import" || !t.category_id));
  if (!candidates.length) { _txMatchMap = null; return; }
  let railwayWorked = false;
  try {
    const r = await apiPost("/api/payments/match-suggestions/batch", {
      company_id: selectedCompanyId,
      transaction_ids: candidates.map((t) => t.id),
    });
    _txMatchMap = r.matches || {};
    if (Object.keys(_txMatchMap).length) railwayWorked = true;
  } catch (e) {
    _txMatchMap = null;
  }
  if (!railwayWorked && supabaseAccessToken) {
    _txMatchMap = await _supaMatchSuggestions(candidates) || _txMatchMap;
  }
}

// Supabase-side match-hint scanner. For each candidate transaction, find an
// open bill (outflow / positive amount) or invoice (inflow / negative
// amount) whose total matches the txn amount within ±0.01 and whose date
// is within ±7 days. Returns the same { txId → { kind, id, number, date,
// party, balance, score } } shape Railway returns.
async function _supaMatchSuggestions(candidates) {
  if (!supabaseAccessToken || !selectedCompanyId || !candidates.length) return null;
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  // Fetch open bills + invoices once for the company
  const [bills, invs] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/bills?company_id=eq.${selectedCompanyId}&status=in.(open,partially_paid,overdue)&select=id,number,date,due_date,total,balance,vendor:vendors(display_name)`, { headers }).then((r) => r.ok ? r.json() : []),
    fetch(`${SUPABASE_URL}/rest/v1/invoices?company_id=eq.${selectedCompanyId}&status=in.(open,partially_paid,overdue,sent)&select=id,number,date,due_date,total,balance,customer:customers(display_name)`, { headers }).then((r) => r.ok ? r.json() : []),
  ]);

  const dayDiff = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
  const out = {};
  for (const t of candidates) {
    const amt = Math.abs(parseFloat(t.amount));
    const isOutflow = parseFloat(t.amount) > 0;
    const pool = isOutflow ? bills : invs;
    let best = null;
    let bestScore = -1;
    for (const d of pool) {
      const balance = parseFloat(d.balance ?? d.total ?? 0);
      if (Math.abs(balance - amt) > 0.01) continue;
      // Take the smaller of (date, due_date) — a payment can land near
      // either the bill date or the due date. Window widened to 30 days
      // to cover monthly recurring bills paid mid-cycle.
      const candidates = [d.date, d.due_date].filter(Boolean);
      let dd = Infinity;
      for (const ref of candidates) {
        const x = dayDiff(t.date, ref);
        if (x < dd) dd = x;
      }
      if (dd > 30) continue;
      const score = Math.round(100 - dd * 3);
      if (score > bestScore) { bestScore = score; best = d; }
    }
    if (best) {
      out[t.id] = {
        kind: isOutflow ? "bill" : "invoice",
        id: best.id,
        number: best.number,
        date: best.due_date || best.date,
        party: isOutflow ? best.vendor?.display_name : best.customer?.display_name,
        balance: parseFloat(best.balance ?? best.total ?? 0),
        score: bestScore,
      };
    }
  }
  return out;
}

async function txApplyMatchHint(txId) {
  if (!_txMatchMap || !_txMatchMap[txId]) { showToast("No match available.", "error"); return; }
  const m = _txMatchMap[txId];
  try {
    let railwayWorked = false;
    try {
      const body = m.kind === "invoice"
        ? { plaid_txn_id: txId, invoice_id: m.id }
        : { plaid_txn_id: txId, bill_id: m.id };
      await apiPost("/api/payments/apply-match", body);
      railwayWorked = true;
    } catch { /* fall through */ }
    if (!railwayWorked) await _supaApplyMatch(txId, m);
    showToast(`Matched to ${m.kind} ${m.number || ""}.`, "success");
    await txReload();
  } catch (e) {
    showToast("Match failed: " + (e.message || e), "error");
  }
}

// Supabase-side apply-match: create a payment row + payment_application
// linking the transaction to the bill/invoice + update the parent's
// balance/status. Two REST calls (insert payment, insert application)
// + one PATCH to bump the bill/invoice. Returns when all complete.
async function _supaApplyMatch(txId, m) {
  // Find the transaction in our cached state for date / amount / account
  const tx = (_txState.txs || []).find((t) => t.id === txId);
  if (!tx) throw new Error("transaction not in current view; reload and retry");
  const amount = Math.abs(parseFloat(tx.amount));
  const headers = {
    "Content-Type": "application/json",
    Prefer: "return=representation",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${supabaseAccessToken}`,
  };
  // 0. Idempotency: refuse if this txn already has a payment. Without this
  //    guard, re-clicking Match (or matching from a different view after the
  //    txn was hidden post-categorize) silently double-pays — one bank txn
  //    can clear two bills.
  const dupeRes = await fetch(
    `${SUPABASE_URL}/rest/v1/payments?matched_transaction_id=eq.${tx.id}&select=id&limit=1`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` } }
  );
  if (dupeRes.ok) {
    const dupes = await dupeRes.json();
    if (Array.isArray(dupes) && dupes.length > 0) {
      throw new Error("transaction is already matched; unmatch it first");
    }
  }
  // 1. Insert payment
  const payRes = await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      company_id: selectedCompanyId,
      date: tx.date,
      amount,
      kind: m.kind === "invoice" ? "invoice_payment" : "bill_payment",
      bank_account_id: tx.account_id,
      matched_transaction_id: tx.id,
      memo: tx.merchant_name || tx.description?.slice(0, 80) || null,
    }),
  });
  if (!payRes.ok) throw new Error(`payment insert: ${payRes.status} ${(await payRes.text()).slice(0, 150)}`);
  const [payment] = await payRes.json();

  // 2. Insert payment_application
  const appRes = await fetch(`${SUPABASE_URL}/rest/v1/payment_applications`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      payment_id: payment.id,
      [m.kind === "invoice" ? "invoice_id" : "bill_id"]: m.id,
      amount,
    }),
  });
  if (!appRes.ok) throw new Error(`application insert: ${appRes.status} ${(await appRes.text()).slice(0, 150)}`);

  // 3. Update bill/invoice balance and status
  const newBalance = Math.max(0, parseFloat(m.balance) - amount);
  const newStatus = newBalance < 0.01 ? "paid" : "partially_paid";
  const table = m.kind === "invoice" ? "invoices" : "bills";
  const updRes = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${m.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ balance: newBalance, status: newStatus }),
  });
  if (!updRes.ok) throw new Error(`${table} update: ${updRes.status} ${(await updRes.text()).slice(0, 150)}`);

  // 4. Categorize the bank transaction so it shows as a Bill/Invoice
  //    Payment in the register instead of "Uncategorized." Matches QBO's
  //    behavior: a matched bank txn rolls up to A/P (bill payment) or
  //    A/R (invoice payment), not to the bill's expense lines (those
  //    are already booked via the bill itself).
  try {
    const isPayable = m.kind !== "invoice";
    const coaQuery = isPayable
      ? `${SUPABASE_URL}/rest/v1/chart_of_accounts?company_id=eq.${selectedCompanyId}&type=eq.liability&name=ilike.*payable*&select=id,name&limit=1`
      : `${SUPABASE_URL}/rest/v1/chart_of_accounts?company_id=eq.${selectedCompanyId}&type=eq.asset&name=ilike.*receivable*&select=id,name&limit=1`;
    const coaRows = await fetch(coaQuery, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` } })
      .then((r) => r.ok ? r.json() : []);
    const coaId = coaRows[0]?.id;
    if (coaId) {
      const catRows = await fetch(`${SUPABASE_URL}/rest/v1/categories?company_id=eq.${selectedCompanyId}&coa_account_id=eq.${coaId}&select=id&limit=1`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` } })
        .then((r) => r.ok ? r.json() : []);
      const catId = catRows[0]?.id;
      if (catId) {
        await _supaPatchRow("transactions", txId, {
          category_id: catId,
          vendor_id: tx.vendor_id || (m.party ? null : null),
          categorized_by: "user",
        });
      }
    }
  } catch (e) {
    // Non-fatal — the match itself succeeded; categorization just falls back
    // to whatever the txn had before. User can re-categorize manually.
    console.warn("[match] post-categorize failed", e);
  }

  // 5. GL emit: book the payment as Dr A/P (or A/R), Cr cash (bank-account
  //    coa). No-op when the company isn't on the GL. The categorize step
  //    above wrote category_id via _supaPatchRow (not _supaTxnPatch), so it
  //    does NOT trigger the txn-categorize JE — avoiding double-counting.
  try {
    const apOrAr = m.kind === "invoice" ? "ar" : "ap";
    const clearingCoa = await _glLookupClearingCoa(selectedCompanyId, apOrAr);
    const acctArr = await fetch(
      `${SUPABASE_URL}/rest/v1/accounts?id=eq.${tx.account_id}&select=coa_account_id&limit=1`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` } }
    ).then((r) => r.ok ? r.json() : []);
    const cashCoa = acctArr[0]?.coa_account_id;
    if (clearingCoa && cashCoa) {
      const lines = m.kind === "invoice"
        ? [
            { coa_account_id: cashCoa,    debit: amount, credit: 0,      description: "Customer payment" },
            { coa_account_id: clearingCoa, debit: 0,      credit: amount, description: "Clear A/R" },
          ]
        : [
            { coa_account_id: clearingCoa, debit: amount, credit: 0,      description: "Clear A/P" },
            { coa_account_id: cashCoa,    debit: 0,      credit: amount, description: "Cash out" },
          ];
      await _glEmit("payment", payment.id, tx.date, lines);
    }
  } catch (e) {
    console.warn("[GL] payment emit failed", e);
  }
}


// ---- Inline custom combobox (Transactions Category/Vendor cells) ----
// Matches the Financials component pattern: click a cell → floating
// popover anchored below the cell with a search input and a scrollable
// list. Type to filter. If no match, a "Create '<text>'" row appears
// at the bottom with an auto-detected type badge (for category) or a
// plain create for vendor.

const _TX_CAT_TYPE_COLORS = {
  asset:     "background:#dbeafe;color:#1e40af;",
  liability: "background:#ffedd5;color:#9a3412;",
  equity:    "background:#ede9fe;color:#5b21b6;",
  income:    "background:#d1fae5;color:#065f46;",
  expense:   "background:#ffe4e6;color:#9f1239;",
};

function _txDetectCoaType(name) {
  const n = (name || "").toLowerCase();
  if (/revenue|income|sales|fees earned/.test(n)) return "income";
  if (/payable|loan|credit card|liability|accrued/.test(n)) return "liability";
  if (/equity|retained|owner|drawings/.test(n)) return "equity";
  if (/receivable|cash|bank|asset|deposit|checking|savings/.test(n)) return "asset";
  return "expense";
}

function _txNextCoaCode(type, categories) {
  const prefixes = { asset: 1000, liability: 2000, equity: 3000, income: 4000, expense: 5000 };
  const base = prefixes[type] || 5000;
  let max = base;
  for (const c of categories) {
    if (c.type !== type || !c.code) continue;
    const n = parseInt(c.code, 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return String(max + 10);
}

async function _txEnsureVendorsLoaded() {
  if (_txState._vendorsLoaded) return;
  try {
    const r = await apiGet(`/api/vendors/${selectedCompanyId}`);
    _txState.vendors = r.vendors || [];
    _txState._vendorsLoaded = true;
  } catch (e) { _txState.vendors = []; }
}

function _closeTxCombo() {
  const el = document.getElementById("tx-combo");
  if (el) el.remove();
  document.removeEventListener("mousedown", _txComboOutsideClick, true);
  document.removeEventListener("keydown", _txComboKeydown, true);
}

let _txComboCtx = null; // { txId, kind, cellEl, filtered, focusIdx, search, showCreate }

function _txComboOutsideClick(e) {
  const el = document.getElementById("tx-combo");
  if (!el) return;
  if (!el.contains(e.target) && !(_txComboCtx?.cellEl?.contains(e.target))) _closeTxCombo();
}

function _txComboKeydown(e) {
  if (!_txComboCtx) return;
  if (e.key === "Escape") { e.preventDefault(); _closeTxCombo(); return; }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    const total = _txComboCtx.filtered.length + (_txComboCtx.showCreate ? 1 : 0);
    _txComboCtx.focusIdx = Math.min(_txComboCtx.focusIdx + 1, total - 1);
    _txComboRenderList();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    _txComboCtx.focusIdx = Math.max(_txComboCtx.focusIdx - 1, 0);
    _txComboRenderList();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const i = _txComboCtx.focusIdx;
    if (i < 0) return;
    if (i < _txComboCtx.filtered.length) {
      _txComboCommit(_txComboCtx.filtered[i].id);
    } else if (_txComboCtx.showCreate) {
      _txComboCreateAndCommit();
    }
  }
}

function _txComboItemsFor(kind) {
  if (kind === "category") {
    return (_txState.categories || []).map((c) => ({
      id: c.id, label: c.name, code: c.code || "", type: c.type,
    }));
  }
  return (_txState.vendors || []).map((v) => ({
    id: v.id, label: v.display_name, code: "", type: "",
  }));
}

function _txComboRenderList() {
  const listEl = document.getElementById("tx-combo-list");
  if (!listEl || !_txComboCtx) return;
  const { kind, filtered, focusIdx, search, showCreate, selectedId } = _txComboCtx;
  let html = "";
  filtered.forEach((it, i) => {
    const isActive = i === focusIdx;
    const isSel = it.id === selectedId;
    html += `<button type="button" class="tx-combo-item${isActive ? " is-active" : ""}${isSel ? " is-selected" : ""}" data-idx="${i}">`
         +  `<span class="tx-combo-check">${isSel ? "✓" : ""}</span>`
         +  `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_escapeHtml(it.label)}</span>`
         +  (it.code ? `<span class="tx-combo-code">${_escapeHtml(it.code)}</span>` : "")
         +  `</button>`;
  });
  if (showCreate) {
    const i = filtered.length;
    const isActive = i === focusIdx;
    const detected = kind === "category" ? _txDetectCoaType(search) : "";
    const badgeStyle = detected ? _TX_CAT_TYPE_COLORS[detected] : "";
    const badgeHtml = detected ? `<span class="tx-combo-type-badge" style="${badgeStyle}">${detected}</span>` : "";
    html += `<button type="button" class="tx-combo-create${isActive ? " is-active" : ""}" data-idx="${i}" data-create="1">`
         +  `<span>+ Create "${_escapeHtml(search)}"</span>`
         +  badgeHtml
         +  `</button>`;
  }
  if (!filtered.length && !showCreate) {
    html += `<div class="tx-combo-empty">No matches</div>`;
  }
  listEl.innerHTML = html;
  listEl.querySelectorAll(".tx-combo-item").forEach((btn) => {
    btn.onclick = () => _txComboCommit(filtered[parseInt(btn.dataset.idx, 10)].id);
  });
  const createBtn = listEl.querySelector(".tx-combo-create");
  if (createBtn) createBtn.onclick = _txComboCreateAndCommit;
}

function _txComboFilter(text) {
  if (!_txComboCtx) return;
  _txComboCtx.search = text;
  _txComboCtx.focusIdx = -1;
  const q = text.trim().toLowerCase();
  const items = _txComboItemsFor(_txComboCtx.kind);
  _txComboCtx.filtered = q
    ? items.filter((it) => it.label.toLowerCase().includes(q) || (it.code || "").toLowerCase().includes(q))
    : items;
  _txComboCtx.showCreate = !!q && !items.some((it) => it.label.toLowerCase() === q);
  _txComboRenderList();
}

async function _txComboCommit(id) {
  const { txId, kind } = _txComboCtx;
  _closeTxCombo();
  // Capture the merchant before reload swaps the row out from under us.
  const txBefore = (_txState.txs || []).find((t) => t.id === txId);
  const patch = kind === "category" ? { category_id: id } : { vendor_id: id };
  try {
    if (_shouldUseRailway()) await apiPatch(`/api/transactions/${txId}`, patch);
    else await _supaTxnPatch(txId, patch);
    await txReload();
    if (kind === "category" && id) await _maybePromptSaveAsRule(txBefore, id);
  } catch (e) { showToast("Update failed: " + (e.message || e), "error"); }
}

// After a manual category change, offer to save it as a rule that
// auto-applies to other transactions with the same merchant. Only fires
// when the merchant name is set (otherwise there's nothing useful to
// match on). On manual+Plaid companies the rule is written directly to
// Supabase; on QBO companies it goes through Railway.
async function _maybePromptSaveAsRule(txBefore, newCategoryId) {
  const merchant = (txBefore && (txBefore.merchant_name || "")).trim();
  if (!merchant) return;
  const cat = (_txState.categories || []).find((c) => c.id === newCategoryId);
  const catLabel = cat ? cat.name : "this category";
  const ok = confirm(
    `Save as a rule?\n\n` +
    `Whenever a transaction's merchant matches "${merchant}", set the category to "${catLabel}". ` +
    `Existing transactions are not changed; future ones (and a manual re-run of rules) will pick this up.`
  );
  if (!ok) return;
  const body = {
    name: `${merchant} → ${catLabel}`,
    priority: 100,
    match: { merchant },
    action: { set_category_id: newCategoryId },
    enabled: true,
  };
  try {
    if (_shouldUseRailway()) {
      await apiPost(`/api/rules/${selectedCompanyId}`, body);
    } else {
      const headers = { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rules`, { method: "POST", headers, body: JSON.stringify({ ...body, company_id: selectedCompanyId }) });
      if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    showToast(`Rule saved: "${merchant}" → ${catLabel}`, "success");
  } catch (e) {
    showToast("Save rule failed: " + (e.message || e), "error");
  }
}

async function _txComboCreateAndCommit() {
  if (!_txComboCtx) return;
  const { kind, search, txId } = _txComboCtx;
  const text = (search || "").trim();
  if (!text) return;

  const listEl = document.getElementById("tx-combo-list");
  if (listEl) listEl.innerHTML = `<div class="tx-combo-empty">Creating “${_escapeHtml(text)}”…</div>`;

  const useSupa = !_shouldUseRailway();
  const supaHeaders = useSupa ? { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}`, Prefer: "return=representation" } : null;
  try {
    if (kind === "category") {
      const type = _txDetectCoaType(text);
      const code = _txNextCoaCode(type, _txState.categories || []);
      if (useSupa) {
        // The coa_insert_mirror trigger creates the matching categories row.
        const r = await fetch(`${SUPABASE_URL}/rest/v1/chart_of_accounts`, {
          method: "POST", headers: supaHeaders,
          body: JSON.stringify({ company_id: selectedCompanyId, name: text, code, type, is_active: true }),
        });
        if (!r.ok) throw new Error(`Supabase coa ${r.status}: ${(await r.text()).slice(0, 200)}`);
        if (typeof _txLoadCategories === "function") await _txLoadCategories();
      } else {
        await apiPost(`/api/coa/${selectedCompanyId}`, { name: text, code, type, is_active: true });
        const r = await apiGet(`/api/transactions/categories/${selectedCompanyId}`).catch(() => null);
        if (r && r.categories) {
          _txState.categories = r.categories;
        } else {
          try {
            const resp = await apiGet(`/api/coa/${selectedCompanyId}`);
            _coaState.accounts = resp.accounts || [];
            if (typeof _txLoadCategories === "function") await _txLoadCategories();
          } catch {}
        }
      }
      const newCat = (_txState.categories || []).find((c) => (c.name || "").toLowerCase() === text.toLowerCase());
      if (newCat) {
        await _txComboCommit(newCat.id);
        showToast(`Created category "${text}".`, "success");
      } else {
        showToast(`Created "${text}" but couldn't auto-select. Refresh and retry.`, "info");
        _closeTxCombo();
      }
    } else {
      let newId = null;
      if (useSupa) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/vendors`, {
          method: "POST", headers: supaHeaders,
          body: JSON.stringify({ company_id: selectedCompanyId, display_name: text }),
        });
        if (!r.ok) throw new Error(`Supabase vendors ${r.status}: ${(await r.text()).slice(0, 200)}`);
        newId = (await r.json())[0]?.id;
        // Refresh local cache
        const r2 = await fetch(`${SUPABASE_URL}/rest/v1/vendors?company_id=eq.${selectedCompanyId}&is_active=eq.true&select=id,display_name&order=display_name`, {
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` },
        });
        if (r2.ok) { _txState.vendors = await r2.json(); _txState._vendorsLoaded = true; }
      } else {
        const r = await apiPost(`/api/vendors/${selectedCompanyId}`, { display_name: text });
        newId = r.vendor?.id || r.id;
        const resp = await apiGet(`/api/vendors/${selectedCompanyId}`);
        _txState.vendors = resp.vendors || [];
        _txState._vendorsLoaded = true;
      }
      if (newId) {
        await _txComboCommit(newId);
        showToast(`Created vendor "${text}".`, "success");
      } else {
        _closeTxCombo();
      }
    }
  } catch (e) {
    showToast("Create failed: " + (e.message || e), "error");
    _closeTxCombo();
  }
}

async function _txBeginInlineEdit(event, txId, kind) {
  event.stopPropagation();
  _closeTxCombo();
  const cellEl = event.currentTarget;
  if (kind === "vendor") await _txEnsureVendorsLoaded();

  const row = document.querySelector(`tr[data-tx-id="${txId}"]`);
  const selectedId = kind === "category"
    ? (row?.dataset.hasCategory === "1" ? _txCurrentId(txId, "category_id") : null)
    : (row?.dataset.hasVendor === "1"   ? _txCurrentId(txId, "vendor_id")   : null);

  const items = _txComboItemsFor(kind);
  _txComboCtx = {
    txId, kind, cellEl, selectedId,
    filtered: items, focusIdx: -1, search: "", showCreate: false,
  };

  const pop = document.createElement("div");
  pop.className = "tx-combo";
  pop.id = "tx-combo";
  pop.innerHTML = `
    <div class="tx-combo-search">
      <input type="text" id="tx-combo-input" placeholder="${kind === "category" ? "Search or create category…" : "Search or create vendor…"}">
    </div>
    <div class="tx-combo-list" id="tx-combo-list"></div>
  `;
  document.body.appendChild(pop);

  // Position below the cell
  const r = cellEl.getBoundingClientRect();
  pop.style.visibility = "hidden";
  pop.style.top = "0"; pop.style.left = "0";
  const popH = pop.offsetHeight, popW = pop.offsetWidth;
  const preferBelow = window.innerHeight - r.bottom > popH + 8;
  pop.style.top = (preferBelow ? r.bottom + 4 : Math.max(8, r.top - popH - 4)) + "px";
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - popW - 8)) + "px";
  pop.style.visibility = "visible";

  const input = document.getElementById("tx-combo-input");
  input.addEventListener("input", (e) => _txComboFilter(e.target.value));
  input.focus();
  _txComboRenderList();

  setTimeout(() => {
    document.addEventListener("mousedown", _txComboOutsideClick, true);
    document.addEventListener("keydown", _txComboKeydown, true);
  }, 0);
}

function _txCurrentId(txId, field) {
  const t = (_txState.txs || []).find((x) => x.id === txId);
  return t ? (t[field] || null) : null;
}

// Vendor picker — reuses the category picker modal with different data.
// When opened from a transaction, pre-fills search with the merchant name and
// offers a "Create '<merchant>'" action at the top for one-click auto-create.
let _vendorPickerState = { txId: null, vendors: [], merchantName: "" };

async function openVendorPicker(txId) {
  const picker = document.getElementById("category-picker-modal");
  try {
    const r = await apiGet(`/api/vendors/${selectedCompanyId}`);
    // Pull merchant_name from the row so we can suggest it as the new vendor name
    const row = document.querySelector(`tr[data-tx-id="${txId}"]`);
    const merchant = row ? (row.querySelectorAll("td")[2].querySelector("div")?.textContent?.trim() || "") : "";
    _vendorPickerState = { txId, vendors: r.vendors || [], merchantName: merchant };
  } catch (e) {
    showToast(friendlyError(e), "error");
    return;
  }
  const search = document.getElementById("cat-picker-search");
  search.value = _vendorPickerState.merchantName || "";
  search.placeholder = "Search or create vendor...";
  picker.querySelector(".modal-header h3").textContent = "Pick or create a vendor";
  _renderVendorPickerList();
  search.oninput = _renderVendorPickerList;
  picker.classList.add("active"); picker.style.display = "flex";
  // Focus the search so user can immediately type/accept
  setTimeout(() => search.focus(), 50);
}

function _renderVendorPickerList() {
  const q = (document.getElementById("cat-picker-search").value || "").trim();
  const qLower = q.toLowerCase();
  const rows = (_vendorPickerState.vendors || []).filter((v) => !qLower || (v.display_name || "").toLowerCase().includes(qLower));
  const exactMatch = rows.find((v) => (v.display_name || "").toLowerCase() === qLower);
  const body = document.getElementById("cat-picker-list");

  // Build the "Create new vendor" affordance at top
  let createBlock = "";
  if (q && !exactMatch) {
    const safe = q.replace(/'/g, "\\'");
    createBlock = `<div style="padding:10px 12px;margin-bottom:4px;border-radius:6px;border:1px dashed var(--color-accent);background:oklch(from var(--color-accent) l c h / 0.08);cursor:pointer;"
        onmouseover="this.style.background='oklch(from var(--color-accent) l c h / 0.15)'"
        onmouseout="this.style.background='oklch(from var(--color-accent) l c h / 0.08)'"
        onclick="vendorPickerCreateAndApply('${safe}')">
      <span style="color:var(--color-accent);font-weight:600;">+ Create "${_escapeHtml(q)}"</span>
      <span style="font-size:var(--text-xs);color:var(--color-text-secondary);margin-left:8px;">new vendor</span>
    </div>`;
  }

  if (!rows.length) {
    body.innerHTML = (createBlock || "") +
      (q ? "" : '<div style="padding:12px;color:var(--color-text-muted);text-align:center;font-size:var(--text-sm);">Type a vendor name to create one.</div>');
    _overrideVendorClearBtn();
    return;
  }

  body.innerHTML = createBlock + rows.map((v) => `<div style="padding:8px 12px;border-radius:6px;cursor:pointer;" onmouseover="this.style.background='var(--color-bg-muted)'" onmouseout="this.style.background='transparent'" onclick="vendorPickerSelect('${v.id}')">
    <strong>${_escapeHtml(v.display_name)}</strong>
    ${v.email ? `<span style="color:var(--color-text-secondary);font-size:var(--text-xs);margin-left:8px;">${_escapeHtml(v.email)}</span>` : ""}
  </div>`).join("");
  _overrideVendorClearBtn();
}

function _overrideVendorClearBtn() {
  const clearBtn = Array.from(document.querySelectorAll("#category-picker-modal button"))
    .find((b) => /clear/i.test(b.textContent));
  if (clearBtn) clearBtn.onclick = vendorPickerClear;
}

async function vendorPickerSelect(vendorId) {
  const txId = _vendorPickerState.txId;
  if (!txId) return;
  try {
    if (_shouldUseRailway()) await apiPatch(`/api/transactions/${txId}`, { vendor_id: vendorId });
    else await _supaTxnPatch(txId, { vendor_id: vendorId });
    closeCategoryPicker();
    _resetCategoryPickerDefaults();
    await txReload();
  } catch (e) { showToast(friendlyError(e), "error"); }
}

async function vendorPickerCreateAndApply(displayName) {
  const txId = _vendorPickerState.txId;
  if (!txId || !displayName.trim()) return;
  try {
    const __useRailway = _shouldUseRailway();
    let newVendorId = null;
    if (!__useRailway) {
      const headers = { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}`, Prefer: "return=representation" };
      const cr = await fetch(`${SUPABASE_URL}/rest/v1/vendors`, {
        method: "POST", headers,
        body: JSON.stringify({ company_id: selectedCompanyId, display_name: displayName.trim() }),
      });
      if (!cr.ok) throw new Error(`Supabase vendors ${cr.status}: ${(await cr.text()).slice(0, 200)}`);
      newVendorId = (await cr.json())[0]?.id;
      if (!newVendorId) throw new Error("Vendor not created");
      const tr = await fetch(`${SUPABASE_URL}/rest/v1/transactions?id=eq.${txId}`, {
        method: "PATCH", headers, body: JSON.stringify({ vendor_id: newVendorId }),
      });
      if (!tr.ok) throw new Error(`Supabase tx update ${tr.status}: ${(await tr.text()).slice(0, 200)}`);
    } else {
      const r = await apiPost(`/api/vendors/${selectedCompanyId}`, {
        display_name: displayName.trim(),
      });
      newVendorId = r.vendor?.id;
      if (!newVendorId) throw new Error("Vendor not created");
      await apiPatch(`/api/transactions/${txId}`, { vendor_id: newVendorId });
    }
    showToast(`Created vendor "${displayName}" and linked`, "success");
    closeCategoryPicker();
    _resetCategoryPickerDefaults();
    _contactsState.rows = [];
    await txReload();
  } catch (e) { showToast(friendlyError(e), "error"); }
}

async function vendorPickerClear() {
  const txId = _vendorPickerState.txId;
  if (!txId) return;
  try {
    if (_shouldUseRailway()) await apiPatch(`/api/transactions/${txId}`, { clear_vendor: true });
    else await _supaTxnPatch(txId, { clear_vendor: true });
    closeCategoryPicker();
    _resetCategoryPickerDefaults();
    await txReload();
  } catch (e) { showToast(friendlyError(e), "error"); }
}

// Reset the picker back to category mode so the next category click works
function _resetCategoryPickerDefaults() {
  const picker = document.getElementById("category-picker-modal");
  picker.querySelector(".modal-header h3").textContent = "Pick a category";
  const search = document.getElementById("cat-picker-search");
  search.placeholder = "Search categories...";
  search.oninput = renderCategoryPickerList;
  const clearBtn = Array.from(picker.querySelectorAll("button")).find((b) => /clear/i.test(b.textContent));
  if (clearBtn) clearBtn.onclick = categoryPickerClear;
}

function txPage(delta) {
  const next = _txState.offset + delta * _txState.limit;
  if (next < 0) return;
  if (delta > 0 && !_txState.has_more) return;
  _txState.offset = next;
  txReload();
}

function txToggleAll(checked) {
  document.querySelectorAll(".tx-row-check").forEach((el) => { el.checked = checked; });
  txUpdateBulkBar();
}

function _txSelectedIds() {
  return Array.from(document.querySelectorAll(".tx-row-check:checked")).map((el) => el.value);
}

function txUpdateBulkBar() {
  const ids = _txSelectedIds();
  const bar = document.getElementById("tx-bulk-bar");
  const count = document.getElementById("tx-bulk-count");
  if (!bar) return;
  if (ids.length === 0) {
    bar.style.display = "none";
  } else {
    bar.style.display = "flex";
    count.textContent = `${ids.length} selected`;
  }
}

function txBulkClear() {
  document.querySelectorAll(".tx-row-check").forEach((el) => { el.checked = false; });
  const selAll = document.getElementById("tx-select-all");
  if (selAll) selAll.checked = false;
  txUpdateBulkBar();
}

async function txBulkCategorize() {
  const ids = _txSelectedIds();
  if (!ids.length) return;
  // Open category picker in bulk mode
  const picker = document.getElementById("category-picker-modal");
  document.getElementById("cat-picker-search").value = "";
  _bulkCategorizeIds = ids;
  picker.querySelector(".modal-header h3").textContent = `Set category for ${ids.length} transactions`;
  const search = document.getElementById("cat-picker-search");
  search.oninput = renderCategoryPickerList;
  // Override the per-row picker selectors to use the bulk handler
  _bulkCategorizeMode = true;
  renderCategoryPickerList();
  picker.classList.add("active");
  picker.style.display = "flex";
}

let _bulkCategorizeMode = false;
let _bulkCategorizeIds = [];

async function _bulkCategorizeApply(categoryId) {
  const ids = _bulkCategorizeIds || [];
  if (!ids.length) return;
  const useRailway = _shouldUseRailway();
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      if (useRailway) await apiPatch(`/api/transactions/${id}`, { category_id: categoryId });
      else await _supaTxnPatch(id, { category_id: categoryId });
      ok++;
    } catch (e) { fail++; }
  }
  _bulkCategorizeMode = false; _bulkCategorizeIds = [];
  closeCategoryPicker();
  showToast(`Categorized ${ok}${fail ? `, ${fail} failed` : ""}`, ok ? "success" : "error");
  txBulkClear();
  await txReload();
}

async function txBulkMarkTransfer() {
  const ids = _txSelectedIds();
  if (!ids.length) return;
  if (!confirm(`Mark ${ids.length} transaction(s) as transfer? They'll drop out of P&L.`)) return;
  const useRailway = _shouldUseRailway();
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      if (useRailway) await apiPatch(`/api/transactions/${id}`, { is_transfer: true });
      else await _supaTxnPatch(id, { is_transfer: true });
      ok++;
    } catch (e) { fail++; }
  }
  showToast(`Marked ${ok} as transfer${fail ? `, ${fail} failed` : ""}`, ok ? "success" : "error");
  txBulkClear();
  await txReload();
}

async function txBulkClearCategory() {
  const ids = _txSelectedIds();
  if (!ids.length) return;
  if (!confirm(`Clear category on ${ids.length} transaction(s)?`)) return;
  const useRailway = _shouldUseRailway();
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      if (useRailway) await apiPatch(`/api/transactions/${id}`, { clear_category: true });
      else await _supaTxnPatch(id, { clear_category: true });
      ok++;
    } catch (e) { fail++; }
  }
  showToast(`Cleared ${ok}${fail ? `, ${fail} failed` : ""}`, ok ? "success" : "error");
  txBulkClear();
  await txReload();
}

async function txSync() {
  if (!selectedCompanyId) return;
  const company = _getSelectedCompany();
  try {
    showToast(`Syncing ${company.name}...`, "info");
    const res = await apiPost(`/api/plaid/sync/${selectedCompanyId}`, {});
    const t = res.totals || {};
    showToast(`Synced: +${t.added || 0} new, ${t.modified || 0} updated, ${t.removed || 0} removed`, "success");
    await txReload();
  } catch (e) {
    showToast("Sync failed: " + (e.message || "unknown"), "error");
  }
}

async function txRecategorize() {
  if (!selectedCompanyId) return;
  if (!confirm("Re-run categorization rules on all uncategorized transactions?")) return;
  try {
    const res = _shouldUseRailway()
      ? await apiPost(`/api/rules/${selectedCompanyId}/recategorize`, {})
      : await _supaRulesRecategorize("uncategorized");
    showToast(`Categorized: ${res.rule || 0} by rule · ${res.plaid || 0} by Plaid · ${res.skipped || 0} still uncategorized`, "success");
    await txReload();
  } catch (e) {
    showToast("Failed: " + (e.message || "unknown"), "error");
  }
}

function txExportCsv() {
  // Build CSV from current visible rows (simplest approach — rely on current filtered view)
  const rows = Array.from(document.querySelectorAll("#tx-body tr[data-tx-id]"));
  if (!rows.length) { showToast("Nothing to export", "info"); return; }
  const header = ["Date", "Merchant", "Description", "Account", "Category", "Amount"];
  const csvRows = [header.join(",")];
  rows.forEach((r) => {
    const cells = r.querySelectorAll("td");
    // cells: [0]=checkbox, [1]=date, [2]=merchant/desc, [3]=account, [4]=category, [5]=amount
    const merchant = cells[2].querySelector("div")?.textContent?.trim() || "";
    const desc = cells[2].querySelectorAll("div")[1]?.textContent?.trim() || "";
    const rowVals = [
      cells[1].textContent.trim(),
      merchant, desc,
      cells[3].textContent.trim(),
      cells[4].textContent.trim().replace(/\s+/g, " "),
      cells[5].textContent.trim(),
    ].map((v) => `"${v.replace(/"/g, '""')}"`);
    csvRows.push(rowVals.join(","));
  });
  const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "transactions.csv"; a.click();
  URL.revokeObjectURL(url);
}

// --- Transaction actions popover ---

function txActionsMenu(txId, event) {
  event.stopPropagation();
  _openTxPopover(txId, event.currentTarget);
}

function _openTxPopover(txId, anchorEl) {
  // Close any existing popover first
  _closeTxPopover();

  const row = document.querySelector(`tr[data-tx-id="${txId}"]`);
  const isTransfer   = row?.dataset.isTransfer === "1";
  const hasCategory  = row?.dataset.hasCategory === "1";
  const hasVendor    = row?.dataset.hasVendor === "1";

  const run = (fn) => () => { _closeTxPopover(); fn(); };

  const items = [
    { label: "Split transaction",                onClick: run(() => openSplitModal(txId)) },
    { label: isTransfer ? "Unmark transfer" : "Mark as transfer",
      onClick: run(() => _txMarkTransfer(txId, !isTransfer)) },
    hasCategory ? { label: "Clear category",     onClick: run(() => _txClearCategory(txId)) } : null,
    { label: "Set vendor…",                      onClick: run(() => openVendorPicker(txId)) },
    hasVendor ? { label: "Clear vendor",         onClick: run(() => _txClearVendor(txId)) } : null,
    { label: "Create rule from merchant",        onClick: run(() => _txCreateRuleFrom(txId)) },
    null,   // divider
    { label: "Apply to invoice…",                onClick: run(() => txApplyToInvoice(txId)) },
    { label: "Apply to bill…",                   onClick: run(() => txApplyToBill(txId)) },
  ];

  const pop = document.createElement("div");
  pop.className = "tx-popover";
  pop.id = "tx-actions-popover";
  pop.innerHTML = items.map((it) => {
    if (it === null) return '<hr>';
    if (!it) return "";
    return `<button type="button">${_escapeHtml(it.label)}</button>`;
  }).join("");
  document.body.appendChild(pop);

  // Wire onClick for each visible button (in the same order we filtered)
  const visibleItems = items.filter((x) => x);
  const buttons = pop.querySelectorAll("button");
  let bIdx = 0;
  for (const it of visibleItems) {
    if (it === null) continue;
    buttons[bIdx++].onclick = it.onClick;
  }

  // Position below the anchor, flipped if too close to viewport bottom
  const rect = anchorEl.getBoundingClientRect();
  pop.style.visibility = "hidden";
  pop.style.top = "0px"; pop.style.left = "0px";
  pop.style.display = "block";
  const popH = pop.offsetHeight;
  const popW = pop.offsetWidth;
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow > popH + 8 ? rect.bottom + 4 : rect.top - popH - 4;
  const left = Math.min(rect.right - popW, window.innerWidth - popW - 8);
  pop.style.top = Math.max(8, top) + "px";
  pop.style.left = Math.max(8, left) + "px";
  pop.style.visibility = "visible";

  // Dismiss handlers
  setTimeout(() => {
    document.addEventListener("click", _txPopoverOutsideClick, { once: false });
    document.addEventListener("keydown", _txPopoverKeydown, { once: false });
  }, 0);
}

function _txPopoverOutsideClick(e) {
  const pop = document.getElementById("tx-actions-popover");
  if (!pop) return;
  if (!pop.contains(e.target)) _closeTxPopover();
}

function _txPopoverKeydown(e) {
  if (e.key === "Escape") _closeTxPopover();
}

function _closeTxPopover() {
  const pop = document.getElementById("tx-actions-popover");
  if (pop) pop.remove();
  document.removeEventListener("click", _txPopoverOutsideClick);
  document.removeEventListener("keydown", _txPopoverKeydown);
}

// Generic row-action popover. Usage:
//   <button onclick="rowActionsMenu(event, [{label:'Edit', onClick:'edit(id)'}, null, {label:'Delete', onClick:'del(id)', danger:true}])">⋯</button>
// items: array of {label, onClick:string, danger?} — null entries render as dividers.
function rowActionsMenu(event, items) {
  event.stopPropagation();
  _closeTxPopover();
  const pop = document.createElement("div");
  pop.className = "tx-popover";
  pop.id = "tx-actions-popover";
  pop.innerHTML = items.map((it) => {
    if (it === null) return '<hr>';
    if (!it) return "";
    const style = it.danger ? ' style="color:var(--color-error);"' : '';
    return `<button type="button" onclick="_closeTxPopover();${it.onClick}"${style}>${_escapeHtml(it.label)}</button>`;
  }).join("");
  document.body.appendChild(pop);

  const anchor = event.currentTarget;
  const rect = anchor.getBoundingClientRect();
  pop.style.visibility = "hidden";
  pop.style.top = "0px"; pop.style.left = "0px";
  pop.style.display = "block";
  const popH = pop.offsetHeight, popW = pop.offsetWidth;
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow > popH + 8 ? rect.bottom + 4 : rect.top - popH - 4;
  const left = Math.min(rect.right - popW, window.innerWidth - popW - 8);
  pop.style.top = Math.max(8, top) + "px";
  pop.style.left = Math.max(8, left) + "px";
  pop.style.visibility = "visible";
  setTimeout(() => {
    document.addEventListener("click", _txPopoverOutsideClick, { once: false });
    document.addEventListener("keydown", _txPopoverKeydown, { once: false });
  }, 0);
}

async function _txMarkTransfer(txId, mark) {
  try {
    if (_shouldUseRailway()) await apiPatch(`/api/transactions/${txId}`, { is_transfer: mark });
    else await _supaTxnPatch(txId, { is_transfer: mark });
    showToast(mark ? "Marked as transfer" : "Unmarked transfer", "success");
    await txReload();
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}

async function _txClearCategory(txId) {
  try {
    if (_shouldUseRailway()) await apiPatch(`/api/transactions/${txId}`, { clear_category: true });
    else await _supaTxnPatch(txId, { clear_category: true });
    showToast("Category cleared", "success");
    await txReload();
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}

async function _txClearVendor(txId) {
  try {
    if (_shouldUseRailway()) await apiPatch(`/api/transactions/${txId}`, { clear_vendor: true });
    else await _supaTxnPatch(txId, { clear_vendor: true });
    showToast("Vendor cleared", "success");
    await txReload();
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}

async function _txCreateRuleFrom(txId) {
  const row = document.querySelector(`tr[data-tx-id="${txId}"]`);
  if (!row) return;
  const merchant = row.querySelectorAll("td")[2].querySelector("div")?.textContent?.trim() || "";
  await rulesInit();
  openRuleEditModal(null);
  document.getElementById("rule-name").value = `${merchant} rule`;
  document.getElementById("rule-merchant").value = merchant;
  rulePreview();
}


// =====================================================================
//  CATEGORY PICKER MODAL (used by Transactions inline categorize)
// =====================================================================

let _catPickerState = { txId: null, current: "" };

function openCategoryPicker(txId, currentName) {
  _catPickerState = { txId, current: currentName };
  document.getElementById("cat-picker-search").value = "";
  renderCategoryPickerList();
  document.getElementById("category-picker-modal").classList.add("active");
  document.getElementById("category-picker-modal").style.display = "flex";
}

function closeCategoryPicker() {
  document.getElementById("category-picker-modal").classList.remove("active");
  document.getElementById("category-picker-modal").style.display = "none";
  _catPickerState = { txId: null, current: "" };
  _vendorPickerState = { txId: null, vendors: [] };
  if (typeof _resetCategoryPickerDefaults === "function") _resetCategoryPickerDefaults();
}

function renderCategoryPickerList() {
  const q = (document.getElementById("cat-picker-search").value || "").toLowerCase();
  const groups = { income: [], expense: [], asset: [], liability: [], equity: [] };
  (_txState.categories || []).forEach((c) => {
    if (q && !(c.name.toLowerCase().includes(q) || (c.code || "").includes(q))) return;
    if (groups[c.type]) groups[c.type].push(c);
  });
  const html = Object.entries(groups)
    .filter(([, arr]) => arr.length)
    .map(([type, arr]) => `
      <div style="font-size:var(--text-xs);text-transform:uppercase;color:var(--color-text-secondary);margin:8px 4px 4px;">${type}</div>
      ${arr.map((c) => `<div class="cat-picker-row" style="padding:8px 12px;border-radius:6px;cursor:pointer;display:flex;justify-content:space-between;" onmouseover="this.style.background='var(--color-bg-muted)'" onmouseout="this.style.background='transparent'" onclick="categoryPickerSelect('${c.id}')">
        <span>${_escapeHtml(c.name)}</span>
        <span style="font-size:var(--text-xs);color:var(--color-text-secondary);">${_escapeHtml(c.code || "")}</span>
      </div>`).join("")}
    `).join("");
  document.getElementById("cat-picker-list").innerHTML = html || '<div style="padding:12px;color:var(--color-text-muted);text-align:center;">No matches</div>';
}

async function categoryPickerSelect(categoryId) {
  // Bulk mode takes precedence
  if (_bulkCategorizeMode) return _bulkCategorizeApply(categoryId);
  const txId = _catPickerState.txId;
  if (!txId) return;
  const txBefore = (_txState.txs || []).find((t) => t.id === txId);
  try {
    if (_shouldUseRailway()) await apiPatch(`/api/transactions/${txId}`, { category_id: categoryId });
    else await _supaTxnPatch(txId, { category_id: categoryId });
    closeCategoryPicker();
    await txReload();
    if (categoryId) await _maybePromptSaveAsRule(txBefore, categoryId);
  } catch (e) { showToast(friendlyError(e), "error"); }
}

async function categoryPickerClear() {
  if (_bulkCategorizeMode) return _bulkCategorizeApply(null); // won't pass validation but keep flow clean
  const txId = _catPickerState.txId;
  if (!txId) return;
  try {
    if (_shouldUseRailway()) await apiPatch(`/api/transactions/${txId}`, { clear_category: true });
    else await _supaTxnPatch(txId, { clear_category: true });
    closeCategoryPicker();
    await txReload();
  } catch (e) { showToast(friendlyError(e), "error"); }
}


// =====================================================================
//  SPLIT TRANSACTION MODAL
// =====================================================================

let _splitState = { txId: null, parentAmount: 0, lines: [] };

async function openSplitModal(txId) {
  const row = document.querySelector(`tr[data-tx-id="${txId}"]`);
  const amount = row ? parseFloat(row.querySelectorAll("td")[5].textContent.trim()) : 0;
  const merchant = row ? (row.querySelectorAll("td")[2].querySelector("div")?.textContent?.trim() || "") : "";
  const date = row ? row.querySelectorAll("td")[1].textContent.trim() : "";
  _splitState = {
    txId, parentAmount: amount,
    lines: [
      { category_id: "", amount: (amount / 2).toFixed(2), notes: "" },
      { category_id: "", amount: (amount / 2).toFixed(2), notes: "" },
    ],
  };
  document.getElementById("split-parent-info").innerHTML = `
    <div><strong>${_escapeHtml(merchant)}</strong> · ${date}</div>
    <div style="font-size:var(--text-xs);color:var(--color-text-secondary);">Total to split: <strong>${amount.toFixed(2)}</strong></div>
  `;
  _renderSplitLines();
  document.getElementById("split-modal").classList.add("active");
  document.getElementById("split-modal").style.display = "flex";
}

function closeSplitModal() {
  document.getElementById("split-modal").classList.remove("active");
  document.getElementById("split-modal").style.display = "none";
}

function splitAddLine() {
  _splitState.lines.push({ category_id: "", amount: 0, notes: "" });
  _renderSplitLines();
}

function _renderSplitLines() {
  const container = document.getElementById("split-lines");
  const categories = _txState.categories || [];
  container.innerHTML = _splitState.lines.map((l, i) => `
    <div style="display:grid;grid-template-columns:2fr 2fr 120px auto;gap:8px;align-items:end;">
      <div>
        <label class="form-label" style="font-size:var(--text-xs);">Category</label>
        <select class="form-select form-select-sm" onchange="_splitUpdate(${i}, 'category_id', this.value)">
          <option value="">— select —</option>
          ${categories.map((c) => `<option value="${c.id}" ${l.category_id === c.id ? "selected" : ""}>${_escapeHtml(c.code ? c.code + " " : "")}${_escapeHtml(c.name)}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="form-label" style="font-size:var(--text-xs);">Notes</label>
        <input class="form-input form-input-sm" type="text" value="${_escapeHtml(l.notes || "")}" oninput="_splitUpdate(${i}, 'notes', this.value)">
      </div>
      <div>
        <label class="form-label" style="font-size:var(--text-xs);">Amount</label>
        <input class="form-input form-input-sm" type="number" step="0.01" value="${l.amount}" oninput="_splitUpdate(${i}, 'amount', this.value)">
      </div>
      <button class="btn btn-ghost btn-sm" onclick="_splitRemove(${i})" type="button" ${_splitState.lines.length <= 2 ? "disabled" : ""}>&times;</button>
    </div>`).join("");
  _updateSplitBalance();
}

function _splitUpdate(i, field, value) {
  _splitState.lines[i][field] = field === "amount" ? parseFloat(value) || 0 : value;
  _updateSplitBalance();
}

function _splitRemove(i) {
  if (_splitState.lines.length <= 2) return;
  _splitState.lines.splice(i, 1);
  _renderSplitLines();
}

function _updateSplitBalance() {
  const total = _splitState.lines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
  const parent = _splitState.parentAmount;
  const diff = total - parent;
  const el = document.getElementById("split-balance");
  const ok = Math.abs(diff) < 0.005;
  el.innerHTML = `Total: <strong>${total.toFixed(2)}</strong> / ${parent.toFixed(2)} ${ok ? '<span style="color:var(--color-success);">✓ balanced</span>' : `<span style="color:var(--color-error);">off by ${diff.toFixed(2)}</span>`}`;
  document.getElementById("split-save-btn").disabled = !ok;
}

async function splitSave() {
  if (!_splitState.txId) return;
  const errEl = document.getElementById("split-error");
  errEl.style.display = "none";
  if (_splitState.lines.some((l) => !l.category_id)) {
    errEl.textContent = "Each line needs a category."; errEl.style.display = "block"; return;
  }
  try {
    await apiPost(`/api/transactions/${_splitState.txId}/split`, {
      splits: _splitState.lines.map((l) => ({
        category_id: l.category_id,
        amount: parseFloat(l.amount),
        notes: l.notes || null,
      })),
    });
    closeSplitModal();
    showToast("Transaction split", "success");
    await txReload();
  } catch (e) { errEl.textContent = "Failed: " + (e.message || "unknown"); errEl.style.display = "block"; }
}


// =====================================================================
//  CHART OF ACCOUNTS PAGE
// =====================================================================

let _coaState = { accounts: [] };
let _coaDebounceTimer = null;

async function coaInit() {
  const body = document.getElementById("coa-body");
  if (!selectedCompanyId) {
    body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--color-text-muted);">Pick a company.</td></tr>';
    return;
  }
  const company = _getSelectedCompany();
  if (!company || company.source !== "manual") {
    body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--color-text-muted);">Chart of Accounts is only available for manual + Plaid companies.</td></tr>';
    return;
  }
  document.getElementById("coa-page-title").textContent = `Chart of Accounts — ${company.name}`;
  await coaReload();
}

function coaDebouncedReload() {
  clearTimeout(_coaDebounceTimer);
  _coaDebounceTimer = setTimeout(coaReload, 300);
}

async function coaReload() {
  if (!selectedCompanyId) return;
  const body = document.getElementById("coa-body");
  body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--color-text-muted);">Loading...</td></tr>';
  try {
    let accounts = [];
    try {
      const resp = await apiGet(`/api/coa/${selectedCompanyId}`);
      accounts = resp.accounts || [];
    } catch { /* fall through to Supabase */ }
    // Same pattern as 55fd369: Railway returns empty/404 for manual+Plaid
    // companies whose CoA lives only in Supabase. Pull it directly.
    if (!accounts.length && supabaseAccessToken) {
      const rows = await _supaFetch("chart_of_accounts", {
        select: "id,code,name,type,subtype,parent_id,is_active",
        order: "code",
      });
      if (rows && rows.length) accounts = rows;
    }
    _coaState.accounts = accounts;
    _coaRender();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--color-error);">Load failed: ${_escapeHtml(e.message)}</td></tr>`;
  }
}

function _coaRender() {
  const body = document.getElementById("coa-body");
  const typeFilter = document.getElementById("coa-filter-type").value;
  const search = (document.getElementById("coa-filter-search").value || "").toLowerCase();
  const rows = _coaState.accounts.filter((a) => {
    if (!a.is_active) return false;
    if (typeFilter) {
      if (typeFilter.startsWith("sub:")) {
        if ((a.subtype || "") !== typeFilter.slice(4)) return false;
      } else {
        if (a.type !== typeFilter) return false;
        // Plain type filters exclude subtyped rows so "Expense" doesn't
        // also show Cost of Goods Sold / Other Expense entries.
        if (typeFilter === "expense" && ["cogs", "other_expense"].includes(a.subtype)) return false;
        if (typeFilter === "income"  && a.subtype === "other_income") return false;
      }
    }
    if (search && !(a.name.toLowerCase().includes(search) || a.code.includes(search))) return false;
    return true;
  });
  if (!rows.length) { body.innerHTML = emptyStateCell(5, {title: "No accounts match this filter", body: "Try clearing the search or switching the type filter back to All."}); return; }
  const typeColor = { asset: "#10b981", liability: "#ef4444", equity: "#8b5cf6", income: "#3b82f6", expense: "#f59e0b" };
  body.innerHTML = rows.map((a) => `<tr>
    <td style="font-family:monospace;font-size:var(--text-sm);">${_escapeHtml(a.code)}</td>
    <td><strong>${_escapeHtml(a.name)}</strong></td>
    <td><span class="badge" style="background:${typeColor[a.type] || "#888"}22;color:${typeColor[a.type] || "#888"};">${a.type}</span></td>
    <td style="text-align:right;font-variant-numeric:tabular-nums;">${a.ytd_activity != null ? formatCurrency(a.ytd_activity) : '<span style="color:var(--color-text-muted);">—</span>'}</td>
    <td style="text-align:right;white-space:nowrap;">
      <button class="btn btn-sm btn-ghost" onclick="openAccountRegister('${a.id}','${a.name.replace(/'/g, "\\'")}')" title="View and edit all transactions for this account">Register</button>
      <button class="btn btn-sm btn-ghost" onclick='rowActionsMenu(event, [{label:"Edit", onClick:"openCoaEditModal(&#39;${a.id}&#39;)"}, {label:"Merge into…", onClick:"coaMergeOpen(&#39;${a.id}&#39;)"}, null, {label:"Archive", onClick:"coaArchive(&#39;${a.id}&#39;)", danger:true}])' title="More">⋯</button>
    </td>
  </tr>`).join("");
}

async function openAccountRegister(coaId, accountName) {
  const modal = document.getElementById("txn-detail-modal");
  const loading = document.getElementById("txn-detail-loading");
  const table = document.getElementById("txn-detail-table");
  const _ttl2 = `Register — ${accountName}`;
  document.getElementById("txn-detail-title").textContent = _ttl2;
  document.getElementById("txn-detail-title").title = _ttl2;
  document.getElementById("txn-detail-badge").textContent = `Account: ${accountName}`;
  document.getElementById("txn-detail-date-range").textContent = "All activity";
  loading.classList.remove("hidden");
  table.innerHTML = "";
  modal.classList.add("active");
  try {
    // Resolve coaId once — _refreshDrillModal calls back with empty coaId
    // and only the accountName, so fall back to the cached register id.
    const resolvedCoaId = coaId || (currentTxnDetail && currentTxnDetail.register_coa_id) || "";
    let data;
    if (_shouldUseRailway()) {
      data = await apiPost("/api/reports/transaction-detail", {
        account_name: accountName,
        company_id: selectedCompanyId,
        start_date: null, end_date: null, date_macro: null,
        accounting_method: "Accrual",
      });
    } else {
      data = await _supaAccountRegister(resolvedCoaId, accountName);
    }
    // Tag as register mode so _refreshDrillModal re-uses this path on edit/delete.
    currentTxnDetail = Object.assign({}, data, {
      register_account_name: accountName,
      register_company_id: selectedCompanyId,
      register_coa_id: resolvedCoaId,
    });
    loading.classList.add("hidden");
    renderTransactionDetail(currentTxnDetail);
  } catch (e) {
    loading.innerHTML = `<p style="color:var(--color-error);padding:var(--space-4);">Error loading register: ${e.message}</p>`;
  }
}

// Supabase-side equivalent of QBO's /api/reports/transaction-detail for the
// account-register flow. Returns transactions hitting the given CoA either
// as the categorized side (transactions.category_id ↦ categories.coa_account_id)
// or the bank/cash side (accounts.coa_account_id), shaped for renderTransactionDetail.
// Optional startDate/endDate constrain to a P&L/BS period; omit for full register.
async function _supaAccountRegister(coaId, accountName, startDate, endDate) {
  if (!supabaseAccessToken || !selectedCompanyId) {
    throw new Error("Sign in required.");
  }
  if (!coaId) {
    return { account_name: accountName, transactions: [] };
  }
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  const base = `${SUPABASE_URL}/rest/v1`;

  // 1. Find the mirror category (categories.coa_account_id = coaId) for the
  //    P&L side, and bank accounts whose coa_account_id = coaId for the cash
  //    side. Both lookups are scoped to the current company.
  const [catRows, acctRows] = await Promise.all([
    fetch(`${base}/categories?company_id=eq.${selectedCompanyId}&coa_account_id=eq.${coaId}&select=id`, { headers })
      .then((r) => r.ok ? r.json() : []),
    fetch(`${base}/accounts?company_id=eq.${selectedCompanyId}&coa_account_id=eq.${coaId}&select=id,name,mask`, { headers })
      .then((r) => r.ok ? r.json() : []),
  ]);
  const categoryIds = (catRows || []).map((c) => c.id);
  const bankAccountIds = (acctRows || []).map((a) => a.id);

  if (!categoryIds.length && !bankAccountIds.length) {
    return { account_name: accountName, transactions: [] };
  }

  const sel = "id,date,amount,description,merchant_name,is_transfer,split_parent_id,categorized_by,plaid_txn_id,account:accounts(name,mask),vendor:vendors(display_name),category:categories(name,coa_account_id)";
  const dateClause = `${startDate ? `&date=gte.${startDate}` : ""}${endDate ? `&date=lte.${endDate}` : ""}`;
  const queries = [];
  if (categoryIds.length) {
    queries.push(`${base}/transactions?company_id=eq.${selectedCompanyId}&category_id=in.(${categoryIds.join(",")})${dateClause}&order=date.desc&limit=500&select=${encodeURIComponent(sel)}`);
  }
  if (bankAccountIds.length) {
    queries.push(`${base}/transactions?company_id=eq.${selectedCompanyId}&account_id=in.(${bankAccountIds.join(",")})${dateClause}&order=date.desc&limit=500&select=${encodeURIComponent(sel)}`);
  }

  const results = await Promise.all(queries.map((u) => fetch(u, { headers }).then((r) => r.ok ? r.json() : [])));
  const seen = new Set();
  const merged = [];
  for (const arr of results) {
    for (const t of (arr || [])) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      merged.push(t);
    }
  }
  merged.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  // Shape into the columns renderTransactionDetail expects.
  const transactions = merged.map((t) => {
    const amt = Number(t.amount || 0);
    // Plaid: positive = outflow (debit on bank). Mirror QBO's debit/credit
    // pair so the totals row balances against the Net column.
    const debit = amt > 0 ? amt : 0;
    const credit = amt < 0 ? -amt : 0;
    const acctLabel = t.account ? `${t.account.name}${t.account.mask ? " ···" + t.account.mask : ""}` : "";
    const vendor = t.vendor ? t.vendor.display_name : "";
    const merchant = t.merchant_name || vendor || t.description || "";
    const memo = (t.description && t.description !== merchant) ? t.description : "";
    return {
      id: t.id,
      editable: true,
      Date: t.date || "",
      "Transaction Type": t.is_transfer ? "Transfer" : "Bank Txn",
      Num: "",
      Name: vendor || merchant,
      "Memo/Description": memo,
      Account: acctLabel,
      Debit: debit ? debit.toFixed(2) : "",
      Credit: credit ? credit.toFixed(2) : "",
      Amount: amt.toFixed(2),
      Balance: "",
    };
  });

  return { account_name: accountName, transactions };
}

let _coaEditId = null;
function openCoaEditModal(id) {
  _coaEditId = id;
  const acc = id ? _coaState.accounts.find((a) => a.id === id) : null;
  document.getElementById("coa-edit-title").textContent = id ? "Edit Account" : "New Account";
  document.getElementById("coa-code").value = acc ? acc.code : "";
  document.getElementById("coa-name").value = acc ? acc.name : "";
  document.getElementById("coa-type").value = acc ? acc.type : "expense";
  document.getElementById("coa-active").checked = acc ? !!acc.is_active : true;
  // Parent dropdown (filtered on open)
  const parentSel = document.getElementById("coa-parent");
  parentSel.innerHTML = '<option value="">(no parent)</option>' +
    _coaState.accounts.filter((p) => p.is_active && p.id !== id).map((p) => `<option value="${p.id}" ${acc && acc.parent_id === p.id ? "selected" : ""}>${_escapeHtml(p.code)} ${_escapeHtml(p.name)}</option>`).join("");
  document.getElementById("coa-error").style.display = "none";
  document.getElementById("coa-edit-modal").classList.add("active");
  document.getElementById("coa-edit-modal").style.display = "flex";
}
function closeCoaEditModal() {
  document.getElementById("coa-edit-modal").classList.remove("active");
  document.getElementById("coa-edit-modal").style.display = "none";
}

async function coaSave() {
  const errEl = document.getElementById("coa-error");
  errEl.style.display = "none";
  const code = document.getElementById("coa-code").value.trim();
  const name = document.getElementById("coa-name").value.trim();
  const type = document.getElementById("coa-type").value;
  const parent_id = document.getElementById("coa-parent").value || null;
  const is_active = document.getElementById("coa-active").checked;
  if (!code || !name) { errEl.textContent = "Code and name are required."; errEl.style.display = "block"; return; }
  try {
    const __useRailway = _shouldUseRailway();
    if (!__useRailway) {
      const headers = { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
      if (_coaEditId) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/chart_of_accounts?id=eq.${_coaEditId}`, {
          method: "PATCH", headers, body: JSON.stringify({ code, name, type, parent_id, is_active }),
        });
        if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
      } else {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/chart_of_accounts`, {
          method: "POST", headers, body: JSON.stringify({ company_id: selectedCompanyId, code, name, type, parent_id, is_active }),
        });
        if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
      }
    } else {
      if (_coaEditId) {
        await apiPatch(`/api/coa/${_coaEditId}`, { code, name, type, parent_id, is_active });
      } else {
        await apiPost(`/api/coa/${selectedCompanyId}`, { code, name, type, parent_id });
      }
    }
    closeCoaEditModal();
    await coaReload();
  } catch (e) { errEl.textContent = "Failed: " + (e.message || "unknown"); errEl.style.display = "block"; }
}

async function coaArchive(id) {
  if (!confirm("Archive this account? Inactive accounts stop showing in pickers and reports.")) return;
  try {
    const __useRailway = _shouldUseRailway();
    if (!__useRailway) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/chart_of_accounts?id=eq.${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` },
        body: JSON.stringify({ is_active: false }),
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } else {
      await apiPatch(`/api/coa/${id}`, { is_active: false });
    }
    showToast("Archived", "success");
    await coaReload();
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}


// =====================================================================
//  CoA MERGE
// =====================================================================
// Opens a small modal that lets the user pick a target CoA to merge the
// source row into. The actual repointing of every FK reference happens
// server-side via the merge_coa_accounts() RPC; the UI just collects the
// (source, target) pair and shows the resulting per-table counts.

let _coaMergeSrc = null;

function coaMergeOpen(srcId) {
  const src = _coaState.accounts.find((a) => a.id === srcId);
  if (!src) return;
  _coaMergeSrc = src;
  // Filter target candidates: active CoAs, same type, not the source.
  const targets = _coaState.accounts
    .filter((a) => a.is_active && a.type === src.type && a.id !== srcId)
    .sort((a, b) => (a.code || "").localeCompare(b.code || ""));
  const typeColor = { asset: "#10b981", liability: "#ef4444", equity: "#8b5cf6", income: "#3b82f6", expense: "#f59e0b" };
  // Build an ad-hoc modal so we don't conflict with the existing
  // coa-edit-modal markup.
  coaMergeClose();
  const overlay = document.createElement("div");
  overlay.id = "coa-merge-modal";
  overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;";
  overlay.innerHTML = `
    <div style="background:var(--color-bg);border-radius:var(--radius-lg);box-shadow:0 12px 40px rgba(0,0,0,0.18);max-width:520px;width:90%;">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--color-border);">
        <h3 style="margin:0;font-size:var(--text-lg);">Merge account</h3>
        <button onclick="coaMergeClose()" type="button" style="background:none;border:none;font-size:24px;cursor:pointer;line-height:1;color:var(--color-text-secondary);">&times;</button>
      </div>
      <div style="padding:var(--space-4);">
        <div style="font-size:var(--text-sm);color:var(--color-text-secondary);margin-bottom:8px;">Source (will be deleted)</div>
        <div style="background:var(--color-bg-muted);padding:10px 12px;border-radius:var(--radius-md);margin-bottom:16px;">
          <code>${_escapeHtml(src.code || "—")}</code> <strong>${_escapeHtml(src.name)}</strong>
          <span class="badge" style="margin-left:8px;background:${typeColor[src.type] || "#888"}22;color:${typeColor[src.type] || "#888"};">${src.type}</span>
        </div>
        <div style="font-size:var(--text-sm);color:var(--color-text-secondary);margin-bottom:8px;">Target — every reference to source will repoint here</div>
        <select id="coa-merge-target" style="width:100%;padding:8px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg);">
          <option value="">— Select target ${_escapeHtml(src.type)} account —</option>
          ${targets.map((t) => `<option value="${t.id}">${_escapeHtml(t.code || "—")} ${_escapeHtml(t.name)}</option>`).join("")}
        </select>
        ${targets.length === 0 ? '<div style="margin-top:8px;color:var(--color-text-muted);font-size:var(--text-sm);">No other active accounts of this type to merge into.</div>' : ""}
        <div id="coa-merge-error" style="display:none;color:var(--color-error);font-size:var(--text-sm);margin-top:10px;"></div>
        <div style="font-size:var(--text-xs);color:var(--color-text-secondary);margin-top:14px;line-height:1.4;">
          This repoints every reference (transactions, bills, journal entries, etc) from the source to the target, then deletes the source row. Reversing it requires re-creating the source manually.
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;padding:var(--space-3) var(--space-4);border-top:1px solid var(--color-border);">
        <button class="btn btn-secondary" onclick="coaMergeClose()" type="button">Cancel</button>
        <button class="btn btn-primary" onclick="coaMergeConfirm()" type="button" ${targets.length === 0 ? "disabled" : ""}>Merge</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

function coaMergeClose() {
  const overlay = document.getElementById("coa-merge-modal");
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  _coaMergeSrc = null;
}

async function coaMergeConfirm() {
  if (!_coaMergeSrc) return;
  const targetId = document.getElementById("coa-merge-target")?.value;
  const errEl = document.getElementById("coa-merge-error");
  const overlay = document.getElementById("coa-merge-modal");
  const mergeBtn = overlay?.querySelector(".btn-primary");
  if (!targetId) {
    if (errEl) { errEl.textContent = "Pick a target account."; errEl.style.display = "block"; }
    return;
  }
  if (!supabaseAccessToken) {
    if (errEl) { errEl.textContent = "Sign in required."; errEl.style.display = "block"; }
    return;
  }
  // Visible busy state — without this, the merge silently does ~700ms of
  // work and looks frozen.
  if (mergeBtn) { mergeBtn.disabled = true; mergeBtn.textContent = "Merging…"; }
  if (errEl) { errEl.style.display = "none"; }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/merge_coa_accounts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${supabaseAccessToken}`,
      },
      body: JSON.stringify({ p_source_id: _coaMergeSrc.id, p_target_id: targetId }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = body?.message || body?.hint || `RPC ${r.status}`;
      throw new Error(msg);
    }
    const counts = body?.updates || {};
    const total = Object.values(counts).reduce((s, n) => s + (Number(n) || 0), 0);
    showToast(`Merged ${body.source_name} into ${body.target_name} — ${total} reference${total === 1 ? "" : "s"} updated.`, "success");
    // Invalidate caches that may have pointed at the deleted CoA.
    if (typeof _apCoaCache !== "undefined") _apCoaCache.clear?.();
    if (typeof _arCoaCache !== "undefined") _arCoaCache.clear?.();
    coaMergeClose();
    await coaReload();
  } catch (e) {
    if (mergeBtn) { mergeBtn.disabled = false; mergeBtn.textContent = "Merge"; }
    if (errEl) { errEl.textContent = "Merge failed: " + (e.message || e); errEl.style.display = "block"; }
  }
}

// =====================================================================
//  RULES PAGE
// =====================================================================

let _rulesState = { rules: [] };

async function rulesInit() {
  const body = document.getElementById("rules-body");
  if (!selectedCompanyId) { body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--color-text-muted);">Pick a company.</td></tr>'; return; }
  const company = _getSelectedCompany();
  if (!company || company.source !== "manual") { body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--color-text-muted);">Rules apply to manual + Plaid companies only.</td></tr>'; return; }
  document.getElementById("rules-page-title").textContent = `Categorization Rules — ${company.name}`;

  // Preload accounts + categories + vendors for dropdowns in the rule form
  if (!_txState.categories.length) await _txLoadCategories();
  if (!_txState.accounts.length) await _txLoadAccounts();
  try {
    const r = await apiGet(`/api/vendors/${selectedCompanyId}`);
    _rulesState.vendors = r.vendors || [];
  } catch (e) { _rulesState.vendors = []; }
  await rulesReload();
}

async function rulesReload() {
  try {
    const __useRailway = _shouldUseRailway();
    if (!__useRailway) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rules?company_id=eq.${selectedCompanyId}&order=priority.asc,created_at.desc`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` },
      });
      if (!r.ok) throw new Error(`Supabase rules ${r.status}`);
      _rulesState.rules = await r.json();
    } else {
      const resp = await apiGet(`/api/rules/${selectedCompanyId}`);
      _rulesState.rules = resp.rules || [];
    }
    _rulesRender();
  } catch (e) {
    document.getElementById("rules-body").innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--color-error);">Load failed: ${_escapeHtml(e.message)}</td></tr>`;
  }
}

function _rulesRender() {
  const body = document.getElementById("rules-body");
  const rules = _rulesState.rules;
  if (!rules.length) { body.innerHTML = emptyStateCell(6, {title: "No categorization rules yet", body: "Rules auto-categorize recurring transactions by merchant, description, or amount.", cta: {label: "+ New Rule", onclick: "openRuleEdit(null)"}}); return; }
  body.innerHTML = rules.map((r) => {
    const parts = [];
    if (r.match?.merchant) parts.push(`merchant contains <em>"${_escapeHtml(r.match.merchant)}"</em>`);
    if (r.match?.description_regex) parts.push(`description ~ <em>/${_escapeHtml(r.match.description_regex)}/</em>`);
    if (r.match?.min !== undefined || r.match?.max !== undefined) {
      const lo = r.match.min ?? "-∞", hi = r.match.max ?? "∞";
      parts.push(`amount in [${lo}, ${hi}]`);
    }
    const action = [];
    if (r.action?.set_category_id) {
      const cat = _txState.categories.find((c) => c.id === r.action.set_category_id);
      action.push(cat ? `→ ${_escapeHtml(cat.name)}` : "→ (unknown)");
    }
    if (r.action?.set_vendor_id) {
      const vend = (_rulesState.vendors || []).find((v) => v.id === r.action.set_vendor_id);
      action.push(vend ? `vendor: ${_escapeHtml(vend.display_name)}` : "vendor: (unknown)");
    }
    if (r.action?.mark_transfer) action.push("mark transfer");
    return `<tr>
      <td><strong>${_escapeHtml(r.name)}</strong></td>
      <td style="font-size:var(--text-xs);">${parts.join(" · ") || "<em>no filters</em>"}</td>
      <td style="font-size:var(--text-xs);">${action.join(" · ") || "—"}</td>
      <td style="text-align:center;">${r.priority}</td>
      <td style="text-align:center;">
        <input type="checkbox" ${r.enabled ? "checked" : ""} onchange="rulesToggleEnabled('${r.id}', this.checked)">
      </td>
      <td style="text-align:right;">
        <button class="btn btn-sm btn-ghost" onclick="openRuleEditModal('${r.id}')">Edit</button>
        <button class="btn btn-sm btn-ghost" style="color:var(--color-error);" onclick="rulesDelete('${r.id}')">Delete</button>
      </td>
    </tr>`;
  }).join("");
}

async function rulesToggleEnabled(id, enabled) {
  const rule = _rulesState.rules.find((x) => x.id === id);
  if (!rule) return;
  try {
    const __useRailway = _shouldUseRailway();
    if (!__useRailway) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rules?id=eq.${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` },
        body: JSON.stringify({ enabled }),
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
    } else {
      await apiPatch(`/api/rules/${id}`, {
        name: rule.name, priority: rule.priority, match: rule.match, action: rule.action, enabled,
      });
    }
    rule.enabled = enabled;
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}

async function rulesDelete(id) {
  if (!confirm("Delete this rule?")) return;
  try {
    const __useRailway = _shouldUseRailway();
    if (!__useRailway) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rules?id=eq.${id}`, {
        method: "DELETE",
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` },
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
    } else {
      await apiDelete(`/api/rules/${id}`);
    }
    await rulesReload();
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}

async function rulesRecategorize() {
  const scope = prompt(
    "Re-run rules on which transactions?\n\n" +
    "Type one of:\n" +
    "  uncategorized  \u2014 only rows with no category yet (default)\n" +
    "  non_user       \u2014 also override Plaid / QBO-imported rows (lets new\n" +
    "                   rules re-classify existing activity)\n" +
    "  all            \u2014 also re-run against rows previously set by a rule",
    "non_user"
  );
  if (!scope) return;
  const validScopes = ["uncategorized", "non_user", "all"];
  const sc = scope.trim();
  if (!validScopes.includes(sc)) {
    showToast("Scope must be one of: " + validScopes.join(", "), "error");
    return;
  }
  try {
    let res;
    if (_shouldUseRailway()) {
      res = await apiPost(`/api/rules/${selectedCompanyId}/recategorize?scope=${sc}`, {});
    } else {
      res = await _supaRulesRecategorize(sc);
    }
    showToast(
      `Categorized: ${res.rule || 0} by rule · ${res.plaid || 0} by Plaid · ${res.skipped || 0} skipped`,
      "success",
    );
    if (typeof txReload === "function") await txReload();
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}

// Build a function that decides whether a transaction matches a rule's
// `match` object. Used by both preview and recategorize on the Supabase
// path. Mirrors the Railway-side rules engine's semantics for the keys
// that show up in the UI: merchant (substring), description_regex,
// min/max amount, direction (in/out by sign), and account_id.
function _ruleMatcher(match) {
  const m = match || {};
  const merchantNeedle = m.merchant ? String(m.merchant).toLowerCase() : null;
  let descRe = null;
  if (m.description_regex) {
    try { descRe = new RegExp(m.description_regex, "i"); } catch { descRe = null; }
  }
  const min = (m.min !== undefined && m.min !== null && m.min !== "") ? parseFloat(m.min) : null;
  const max = (m.max !== undefined && m.max !== null && m.max !== "") ? parseFloat(m.max) : null;
  const dir = (m.direction === "in" || m.direction === "out") ? m.direction : null;
  const acctId = m.account_id || null;
  return (t) => {
    if (acctId && t.account_id !== acctId) return false;
    const amt = Number(t.amount || 0);
    if (min !== null && amt < min) return false;
    if (max !== null && amt > max) return false;
    // Plaid convention: amount > 0 = outflow ("out"), amount < 0 = inflow ("in").
    if (dir === "in" && amt >= 0) return false;
    if (dir === "out" && amt <= 0) return false;
    if (merchantNeedle) {
      const hay = ((t.merchant_name || "") + " " + (t.description || "")).toLowerCase();
      if (!hay.includes(merchantNeedle)) return false;
    }
    if (descRe) {
      if (!descRe.test(t.description || "")) return false;
    }
    return true;
  };
}

// Apply a scope filter to a list of transactions. Mirrors Railway's
// recategorize endpoint scopes so the prompt behavior is consistent.
function _applyScopeFilter(rows, scope) {
  return rows.filter((t) => {
    if (t.is_transfer) return false;
    if (scope === "uncategorized") return !t.category_id;
    if (scope === "non_user") return t.categorized_by !== "user";
    if (scope === "plaid_only") return t.categorized_by === "plaid";
    if (scope === "all") return true;
    return false;
  });
}

// Fetch every transaction for the active company. Pages through Supabase
// in batches of 1000 so we don't truncate at PostgREST's default limit.
async function _supaFetchAllTxns() {
  if (!supabaseAccessToken || !selectedCompanyId) return [];
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}`, Prefer: "count=exact" };
  const sel = "id,date,amount,description,merchant_name,is_transfer,category_id,vendor_id,account_id,categorized_by,plaid_txn_id";
  const pageSize = 1000;
  let offset = 0;
  const all = [];
  while (true) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/transactions?company_id=eq.${selectedCompanyId}&select=${encodeURIComponent(sel)}&order=date.desc`,
      { headers: { ...headers, Range: `${offset}-${offset + pageSize - 1}` } },
    );
    if (!r.ok) {
      console.warn("[supa] tx fetch all", r.status, (await r.text()).slice(0, 200));
      break;
    }
    const rows = await r.json();
    all.push(...rows);
    const cr = r.headers.get("content-range") || "";
    const m = /\/(\d+|\*)/.exec(cr);
    const total = m && m[1] !== "*" ? parseInt(m[1], 10) : null;
    if (rows.length < pageSize || (total !== null && offset + rows.length >= total)) break;
    offset += pageSize;
  }
  return all;
}

// Supabase-side equivalent of Railway's POST /api/rules/preview. Counts
// how many uncategorized transactions match the given match object.
async function _supaRulePreview(match, scope) {
  const matcher = _ruleMatcher(match);
  const all = await _supaFetchAllTxns();
  const sc = scope || "uncategorized";
  const scoped = _applyScopeFilter(all, sc);
  const matches = scoped.filter(matcher).length;
  return { matches, scanned: scoped.length };
}

// Supabase-side equivalent of Railway's recategorize endpoint. Walks the
// scope, finds the first enabled rule (by priority asc) that matches each
// row, and PATCHes the row. Returns { rule, plaid, skipped } so the
// existing toast format keeps working.
async function _supaRulesRecategorize(scope) {
  // Pull the latest rules (don't trust the in-memory list — the Rules page
  // may not have been visited this session).
  const rulesResp = await fetch(
    `${SUPABASE_URL}/rest/v1/rules?company_id=eq.${selectedCompanyId}&enabled=eq.true&order=priority.asc,created_at.desc`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` } },
  );
  if (!rulesResp.ok) throw new Error(`Supabase rules ${rulesResp.status}`);
  const rules = (await rulesResp.json()).map((r) => ({ ...r, _matcher: _ruleMatcher(r.match) }));
  const txs = _applyScopeFilter(await _supaFetchAllTxns(), scope);

  let ruleHits = 0, skipped = 0;
  for (const t of txs) {
    const hit = rules.find((r) => r._matcher(t));
    if (!hit) { skipped++; continue; }
    const patch = {};
    if (hit.action?.set_category_id) patch.category_id = hit.action.set_category_id;
    if (hit.action?.set_vendor_id) patch.vendor_id = hit.action.set_vendor_id;
    if (hit.action?.mark_transfer) patch.is_transfer = true;
    if (!Object.keys(patch).length) { skipped++; continue; }
    patch.categorized_by = "rule";
    try {
      await _supaPatchRow("transactions", t.id, patch);
      ruleHits++;
    } catch (e) {
      console.warn("[supa] recategorize patch failed", t.id, e);
      skipped++;
    }
  }
  return { rule: ruleHits, plaid: 0, skipped };
}

let _ruleEditId = null;
function openRuleEditModal(id) {
  _ruleEditId = id;
  const r = id ? _rulesState.rules.find((x) => x.id === id) : null;
  document.getElementById("rule-edit-title").textContent = id ? "Edit Rule" : "New Rule";
  document.getElementById("rule-name").value = r ? r.name : "";
  document.getElementById("rule-merchant").value = r?.match?.merchant || "";
  document.getElementById("rule-desc-regex").value = r?.match?.description_regex || "";
  document.getElementById("rule-amt-min").value = r?.match?.min ?? "";
  document.getElementById("rule-amt-max").value = r?.match?.max ?? "";
  const dirSel = document.getElementById("rule-direction");
  if (dirSel) dirSel.value = r?.match?.direction || "";
  document.getElementById("rule-priority").value = r?.priority ?? 100;
  document.getElementById("rule-mark-transfer").checked = !!r?.action?.mark_transfer;
  document.getElementById("rule-enabled").checked = r ? !!r.enabled : true;

  // Account dropdown
  const accSel = document.getElementById("rule-account");
  accSel.innerHTML = '<option value="">Any account</option>' +
    (_txState.accounts || []).map((a) => `<option value="${a.id}" ${r?.match?.account_id === a.id ? "selected" : ""}>${_escapeHtml(a.name)}${a.mask ? " ···" + a.mask : ""}</option>`).join("");

  // Category combobox (type-to-filter via native datalist)
  _ruleRenderComboOptions("category");
  _ruleSetComboValue("category", r?.action?.set_category_id || "");

  // Vendor combobox (type-to-filter + quick "create new" when no match)
  _ruleRenderComboOptions("vendor");
  _ruleSetComboValue("vendor", r?.action?.set_vendor_id || "");

  document.getElementById("rule-error").style.display = "none";
  document.getElementById("rule-preview-count").textContent = "";
  document.getElementById("rule-edit-modal").classList.add("active");
  document.getElementById("rule-edit-modal").style.display = "flex";
}

// ---- Rule editor comboboxes (type-to-filter via native datalist) ----
// Both the category and vendor pickers are <input list="..."> elements
// backed by a hidden <input> that stores the resolved id. Labels include
// the code/name for categories and display_name for vendors. On input
// change we resolve back to an id; if nothing matches, vendor mode
// offers a quick-create, category mode clears.

function _ruleComboSource(kind) {
  if (kind === "category") {
    const cats = _txState.categories || [];
    return cats.map((c) => ({
      id: c.id,
      label: (c.code ? c.code + " " : "") + c.name,
    }));
  }
  const vs = _rulesState.vendors || [];
  return vs.map((v) => ({ id: v.id, label: v.display_name }));
}

function _ruleRenderComboOptions(kind) {
  const dl = document.getElementById(kind === "category" ? "rule-category-options" : "rule-vendor-options");
  if (!dl) return;
  const src = _ruleComboSource(kind);
  dl.innerHTML = src.map((o) => `<option value="${_escapeHtml(o.label)}"></option>`).join("");
}

function _ruleSetComboValue(kind, id) {
  const input = document.getElementById(kind === "category" ? "rule-set-category-input" : "rule-set-vendor-input");
  const hidden = document.getElementById(kind === "category" ? "rule-set-category" : "rule-set-vendor");
  if (!input || !hidden) return;
  const src = _ruleComboSource(kind);
  const match = src.find((o) => o.id === id);
  input.value = match ? match.label : "";
  hidden.value = id || "";
}

async function _ruleComboChanged(kind) {
  const input = document.getElementById(kind === "category" ? "rule-set-category-input" : "rule-set-vendor-input");
  const hidden = document.getElementById(kind === "category" ? "rule-set-category" : "rule-set-vendor");
  const text = (input.value || "").trim();
  if (!text) { hidden.value = ""; return; }
  const src = _ruleComboSource(kind);
  // Exact match (case-insensitive)
  const exact = src.find((o) => o.label.toLowerCase() === text.toLowerCase());
  if (exact) { hidden.value = exact.id; return; }
  // No exact match yet — user may still be typing. Leave hidden blank and
  // react only when the user tabs away or presses Enter. We detect "commit"
  // by binding once below.
  hidden.value = "";
  // Lazy-attach a commit handler. Using blur for UX.
  if (!input.dataset.commitBound) {
    input.dataset.commitBound = "1";
    input.addEventListener("blur", () => _ruleComboCommit(kind));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); _ruleComboCommit(kind); }
    });
  }
}

async function _ruleComboCommit(kind) {
  const input = document.getElementById(kind === "category" ? "rule-set-category-input" : "rule-set-vendor-input");
  const hidden = document.getElementById(kind === "category" ? "rule-set-category" : "rule-set-vendor");
  const text = (input.value || "").trim();
  if (!text) { hidden.value = ""; return; }
  const src = _ruleComboSource(kind);
  const exact = src.find((o) => o.label.toLowerCase() === text.toLowerCase());
  if (exact) { hidden.value = exact.id; return; }
  if (kind === "vendor") {
    if (confirm(`Vendor "${text}" doesn't exist yet. Create it now?`)) {
      try {
        const __useRailway = _shouldUseRailway();
        let newId = null;
        if (!__useRailway) {
          const headers = { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}`, Prefer: "return=representation" };
          const cr = await fetch(`${SUPABASE_URL}/rest/v1/vendors`, {
            method: "POST", headers,
            body: JSON.stringify({ company_id: selectedCompanyId, display_name: text }),
          });
          if (!cr.ok) throw new Error(`Supabase vendors ${cr.status}: ${(await cr.text()).slice(0, 200)}`);
          newId = (await cr.json())[0]?.id;
          // Refresh list from Supabase
          const lr = await fetch(`${SUPABASE_URL}/rest/v1/vendors?company_id=eq.${selectedCompanyId}&is_active=eq.true&select=id,display_name&order=display_name`, {
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` },
          });
          if (lr.ok) _rulesState.vendors = await lr.json();
        } else {
          const r = await apiPost(`/api/vendors/${selectedCompanyId}`, { display_name: text });
          newId = r.vendor?.id || r.id;
          const resp = await apiGet(`/api/vendors/${selectedCompanyId}`);
          _rulesState.vendors = resp.vendors || [];
        }
        if (newId) {
          _ruleRenderComboOptions("vendor");
          _ruleSetComboValue("vendor", newId);
          showToast(`Created vendor "${text}".`, "success");
          return;
        }
      } catch (e) {
        showToast("Create failed: " + (e.message || e), "error");
      }
    }
    // Revert input
    _ruleSetComboValue("vendor", "");
  } else {
    // Categories: can't quick-create (need type, code). Revert input.
    showToast(`"${text}" is not a category. Use Chart of Accounts to add one.`, "info");
    _ruleSetComboValue("category", "");
  }
}

function closeRuleEditModal() {
  document.getElementById("rule-edit-modal").classList.remove("active");
  document.getElementById("rule-edit-modal").style.display = "none";
  _ruleEditId = null;
}

let _rulePreviewTimer = null;
function rulePreview() {
  clearTimeout(_rulePreviewTimer);
  _rulePreviewTimer = setTimeout(async () => {
    const match = _collectRuleMatch();
    if (!match || Object.keys(match).length === 0) {
      document.getElementById("rule-preview-count").textContent = "";
      return;
    }
    try {
      const res = _shouldUseRailway()
        ? await apiPost("/api/rules/preview", { company_id: selectedCompanyId, match })
        : await _supaRulePreview(match, "uncategorized");
      document.getElementById("rule-preview-count").textContent = `Matches ${res.matches}/${res.scanned} uncategorized`;
    } catch (e) { /* silent */ }
  }, 400);
}

function _collectRuleMatch() {
  const match = {};
  const m = document.getElementById("rule-merchant").value.trim();
  if (m) match.merchant = m;
  const d = document.getElementById("rule-desc-regex").value.trim();
  if (d) match.description_regex = d;
  const lo = document.getElementById("rule-amt-min").value;
  if (lo !== "") match.min = parseFloat(lo);
  const hi = document.getElementById("rule-amt-max").value;
  if (hi !== "") match.max = parseFloat(hi);
  const acct = document.getElementById("rule-account").value;
  if (acct) match.account_id = acct;
  const dir = document.getElementById("rule-direction")?.value;
  if (dir === "in" || dir === "out") match.direction = dir;
  return match;
}

async function ruleSave() {
  const errEl = document.getElementById("rule-error");
  errEl.style.display = "none";
  const name = document.getElementById("rule-name").value.trim();
  if (!name) { errEl.textContent = "Name is required."; errEl.style.display = "block"; return; }
  const match = _collectRuleMatch();
  if (Object.keys(match).length === 0) { errEl.textContent = "At least one match condition required."; errEl.style.display = "block"; return; }
  const action = {};
  const setCat = document.getElementById("rule-set-category").value;
  if (setCat) action.set_category_id = setCat;
  const setVend = document.getElementById("rule-set-vendor")?.value;
  if (setVend) action.set_vendor_id = setVend;
  if (document.getElementById("rule-mark-transfer").checked) action.mark_transfer = true;
  if (!action.set_category_id && !action.set_vendor_id && !action.mark_transfer) {
    errEl.textContent = "Set a category, a vendor, or mark as transfer."; errEl.style.display = "block"; return;
  }
  const body = {
    name, priority: parseInt(document.getElementById("rule-priority").value || "100", 10),
    match, action,
    enabled: document.getElementById("rule-enabled").checked,
  };
  try {
    const __useRailway = _shouldUseRailway();
    if (!__useRailway) {
      const headers = { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
      if (_ruleEditId) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/rules?id=eq.${_ruleEditId}`, { method: "PATCH", headers, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
      } else {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/rules`, { method: "POST", headers, body: JSON.stringify({ ...body, company_id: selectedCompanyId }) });
        if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
      }
    } else {
      if (_ruleEditId) {
        await apiPatch(`/api/rules/${_ruleEditId}`, body);
      } else {
        await apiPost(`/api/rules/${selectedCompanyId}`, body);
      }
    }
    closeRuleEditModal();
    await rulesReload();
    await _rulePromptApplyToPlaid(body);
  } catch (e) { errEl.textContent = "Failed: " + (e.message || "unknown"); errEl.style.display = "block"; }
}

// After save, count Plaid-auto-categorized transactions that match this
// rule and offer to apply the rule to them in one click. QBO-imported and
// user-touched rows are never included — this is purely for overriding
// Plaid's default PFC guess with the user's new rule.
async function _rulePromptApplyToPlaid(body) {
  try {
    const useRailway = _shouldUseRailway();
    const preview = useRailway
      ? await apiPost("/api/rules/preview", { company_id: selectedCompanyId, match: body.match, scope: "plaid_only" })
      : await _supaRulePreview(body.match, "plaid_only");
    const n = preview.matches || 0;
    if (!n) {
      showToast("Rule saved.", "success");
      return;
    }
    const ok = confirm(
      `Rule saved.\n\n` +
      `This rule matches ${n} Plaid-auto-categorized transaction${n === 1 ? "" : "s"}. ` +
      `Apply the rule to those rows now?\n\n` +
      `Only Plaid-auto rows are affected. QBO-imported and manually categorized rows stay as they are.`
    );
    if (!ok) {
      showToast("Rule saved. Existing Plaid-categorized rows left unchanged.", "success");
      return;
    }
    const res = useRailway
      ? await apiPost(`/api/rules/${selectedCompanyId}/recategorize?scope=plaid_only`, {})
      : await _supaRulesRecategorize("plaid_only");
    showToast(`Applied: ${res.rule || 0} row${(res.rule || 0) === 1 ? "" : "s"} re-categorized.`, "success");
    if (typeof txReload === "function") await txReload();
  } catch (e) {
    showToast("Rule saved, but applying it failed: " + (e.message || e), "error");
  }
}


// =====================================================================
//  JOURNAL ENTRIES PAGE
// =====================================================================

let _journalState = { entries: [], editingLines: [] };

async function journalInit() {
  if (!selectedCompanyId) return;
  const company = _getSelectedCompany();
  if (!company || company.source !== "manual") {
    document.getElementById("journal-list").innerHTML = '<div style="text-align:center;padding:24px;color:var(--color-text-muted);">Journal entries are for manual + Plaid companies only.</div>';
    return;
  }
  document.getElementById("journal-page-title").textContent = `Journal Entries — ${company.name}`;
  if (!_txState.categories.length) await _txLoadCategories();
  if (!_coaState.accounts.length) {
    try {
      if (!_shouldUseRailway()) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/chart_of_accounts?company_id=eq.${selectedCompanyId}&is_active=eq.true&select=id,code,name,type,subtype&order=code`, {
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` },
        });
        if (r.ok) _coaState.accounts = await r.json();
      } else {
        const resp = await apiGet(`/api/coa/${selectedCompanyId}`);
        _coaState.accounts = resp.accounts || [];
      }
    } catch (e) {}
  }
  await journalReload();
}

async function journalReload() {
  const list = document.getElementById("journal-list");
  list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--color-text-muted);">Loading...</div>';
  try {
    const __useRailway = _shouldUseRailway();
    if (!__useRailway) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/journal_entries?company_id=eq.${selectedCompanyId}&select=id,date,memo,lines:journal_lines(id,coa_account_id,description,debit,credit)&order=date.desc,created_at.desc`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` },
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
      _journalState.entries = await r.json();
    } else {
      const resp = await apiGet(`/api/journal/${selectedCompanyId}`);
      _journalState.entries = resp.entries || [];
    }
    _journalRender();
  } catch (e) {
    list.innerHTML = `<div style="text-align:center;padding:24px;color:var(--color-error);">Load failed: ${_escapeHtml(e.message)}</div>`;
  }
}

function _journalRender() {
  const list = document.getElementById("journal-list");
  const entries = _journalState.entries;
  if (!entries.length) { list.innerHTML = `<div style="text-align:center;padding:40px 16px;color:var(--color-text-muted);"><div style="font-size:var(--text-base);font-weight:600;color:var(--color-text);margin-bottom:6px;">No journal entries yet</div><div style="font-size:var(--text-sm);max-width:420px;margin:0 auto;">Use journal entries to record opening balances, adjustments, and anything not captured from bank feeds.</div><div style="margin-top:14px;"><button class="btn btn-primary btn-sm" onclick="openJournalEntryEdit(null)">+ New Entry</button></div></div>`; return; }
  list.innerHTML = entries.map((e) => {
    const totalDebit = (e.lines || []).reduce((s, l) => s + parseFloat(l.debit || 0), 0);
    return `<div class="card" style="margin-bottom:12px;padding:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div>
          <strong>${e.date || ""}</strong>
          <span style="margin-left:10px;">${_escapeHtml(e.memo || "")}</span>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <span style="font-size:var(--text-sm);">${totalDebit.toFixed(2)}</span>
          <button class="btn btn-sm btn-ghost" style="color:var(--color-error);" onclick="journalDelete('${e.id}')">&times;</button>
        </div>
      </div>
      <table class="data-table" style="width:100%;font-size:var(--text-sm);">
        <thead><tr><th>Account</th><th>Description</th><th style="text-align:right;">Debit</th><th style="text-align:right;">Credit</th></tr></thead>
        <tbody>${(e.lines || []).map((l) => `<tr>
          <td>${_escapeHtml(l.coa?.code || "")} ${_escapeHtml(l.coa?.name || "")}</td>
          <td>${_escapeHtml(l.description || "")}</td>
          <td style="text-align:right;">${parseFloat(l.debit || 0).toFixed(2)}</td>
          <td style="text-align:right;">${parseFloat(l.credit || 0).toFixed(2)}</td>
        </tr>`).join("")}</tbody>
      </table>
    </div>`;
  }).join("");
}

async function journalDelete(id) {
  if (!confirm("Delete this journal entry?")) return;
  try {
    const __useRailway = _shouldUseRailway();
    if (!__useRailway) {
      // journal_lines has ON DELETE CASCADE on journal_entry_id, so deleting
      // the parent removes the lines too.
      const r = await fetch(`${SUPABASE_URL}/rest/v1/journal_entries?id=eq.${id}`, {
        method: "DELETE",
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` },
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
    } else {
      await apiDelete(`/api/journal/${id}`);
    }
    await journalReload();
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}

function openJournalEditModal() {
  if (!selectedCompanyId) return;
  _journalState.editingLines = [
    { coa_account_id: "", description: "", debit: 0, credit: 0 },
    { coa_account_id: "", description: "", debit: 0, credit: 0 },
  ];
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById("journal-date").value = today;
  document.getElementById("journal-memo").value = "";
  document.getElementById("journal-error").style.display = "none";
  _renderJournalLines();
  document.getElementById("journal-edit-modal").classList.add("active");
  document.getElementById("journal-edit-modal").style.display = "flex";
}
function closeJournalEditModal() {
  document.getElementById("journal-edit-modal").classList.remove("active");
  document.getElementById("journal-edit-modal").style.display = "none";
}

function journalAddLine() {
  _journalState.editingLines.push({ coa_account_id: "", description: "", debit: 0, credit: 0 });
  _renderJournalLines();
}

function _renderJournalLines() {
  const body = document.getElementById("journal-lines-body");
  const coa = _coaState.accounts.filter((a) => a.is_active);
  body.innerHTML = _journalState.editingLines.map((l, i) => `<tr>
    <td>
      <select class="form-select form-select-sm" onchange="_journalLineUpdate(${i}, 'coa_account_id', this.value)">
        <option value="">— pick account —</option>
        ${coa.map((a) => `<option value="${a.id}" ${l.coa_account_id === a.id ? "selected" : ""}>${_escapeHtml(a.code)} ${_escapeHtml(a.name)}</option>`).join("")}
      </select>
    </td>
    <td><input class="form-input form-input-sm" type="text" value="${_escapeHtml(l.description || "")}" oninput="_journalLineUpdate(${i}, 'description', this.value)"></td>
    <td style="text-align:right;"><input class="form-input form-input-sm" type="number" step="0.01" value="${l.debit || ""}" oninput="_journalLineUpdate(${i}, 'debit', this.value)" style="text-align:right;width:100px;"></td>
    <td style="text-align:right;"><input class="form-input form-input-sm" type="number" step="0.01" value="${l.credit || ""}" oninput="_journalLineUpdate(${i}, 'credit', this.value)" style="text-align:right;width:100px;"></td>
    <td><button class="btn btn-ghost btn-sm" onclick="_journalLineRemove(${i})" type="button" ${_journalState.editingLines.length <= 2 ? "disabled" : ""}>&times;</button></td>
  </tr>`).join("");
  _updateJournalBalance();
}

function _journalLineUpdate(i, field, value) {
  if (field === "debit" || field === "credit") _journalState.editingLines[i][field] = parseFloat(value) || 0;
  else _journalState.editingLines[i][field] = value;
  _updateJournalBalance();
}
function _journalLineRemove(i) {
  if (_journalState.editingLines.length <= 2) return;
  _journalState.editingLines.splice(i, 1);
  _renderJournalLines();
}
function _updateJournalBalance() {
  const td = _journalState.editingLines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0);
  const tc = _journalState.editingLines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  const ok = Math.abs(td - tc) < 0.005 && td > 0;
  document.getElementById("journal-balance").innerHTML = `Dr ${td.toFixed(2)} / Cr ${tc.toFixed(2)} ${ok ? '<span style="color:var(--color-success);">✓</span>' : '<span style="color:var(--color-error);">unbalanced</span>'}`;
  document.getElementById("journal-save-btn").disabled = !ok;
}

// =====================================================================
//  JOURNAL ENTRY — CSV Import
// =====================================================================

let _journalImportState = { parsed: null };

function openJournalImportModal() {
  if (!selectedCompanyId) { showToast("Pick a company first.", "error"); return; }
  const company = _getSelectedCompany();
  if (!company || company.source !== "manual") { showToast("Journal import is for manual companies.", "error"); return; }
  document.getElementById("journal-import-text").value = "";
  document.getElementById("journal-import-file").value = "";
  document.getElementById("journal-import-preview").innerHTML = "";
  document.getElementById("journal-import-error").style.display = "none";
  document.getElementById("journal-import-parse-btn").style.display = "inline-flex";
  document.getElementById("journal-import-confirm-btn").style.display = "none";
  document.getElementById("journal-import-back-btn").style.display = "none";
  _journalImportState.parsed = null;

  // Wire file input once per open
  const fileEl = document.getElementById("journal-import-file");
  fileEl.onchange = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => { document.getElementById("journal-import-text").value = ev.target.result; };
    reader.readAsText(f);
  };

  const m = document.getElementById("journal-import-modal");
  m.classList.add("active"); m.style.display = "flex";
}

function closeJournalImportModal() {
  const m = document.getElementById("journal-import-modal");
  m.classList.remove("active"); m.style.display = "none";
  _journalImportState.parsed = null;
}

function journalImportBack() {
  document.getElementById("journal-import-parse-btn").style.display = "inline-flex";
  document.getElementById("journal-import-confirm-btn").style.display = "none";
  document.getElementById("journal-import-back-btn").style.display = "none";
  document.getElementById("journal-import-preview").innerHTML = "";
  _journalImportState.parsed = null;
}

// --- CSV parser (handles quoted fields with commas + escaped quotes) ---
function _parseCsv(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQuote = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuote = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuote = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => (c || "").trim() !== ""));
}

function _normalizeHeader(h) {
  return (h || "").trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

function _parseNum(s) {
  if (s === null || s === undefined || s === "") return 0;
  const cleaned = String(s).replace(/[\$,]/g, "").trim();
  if (!cleaned) return 0;
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}

async function journalImportParse() {
  const errEl = document.getElementById("journal-import-error");
  const previewEl = document.getElementById("journal-import-preview");
  errEl.style.display = "none";
  previewEl.innerHTML = "";

  const text = document.getElementById("journal-import-text").value.trim();
  if (!text) { errEl.textContent = "Paste CSV text or upload a file."; errEl.style.display = "block"; return; }

  const rows = _parseCsv(text);
  if (rows.length < 2) { errEl.textContent = "Need a header row plus at least one data row."; errEl.style.display = "block"; return; }

  const header = rows[0].map(_normalizeHeader);
  const find = (...names) => {
    for (const n of names) { const i = header.indexOf(n); if (i !== -1) return i; }
    return -1;
  };
  const idxDate    = find("date", "transaction_date", "txn_date");
  const idxMemo    = find("memo", "description", "reference", "note");
  const idxAccount = find("account", "account_code", "account_name", "coa", "gl");
  const idxDesc    = find("line_description", "line_memo", "detail");
  const idxDebit   = find("debit", "dr", "debit_amount");
  const idxCredit  = find("credit", "cr", "credit_amount");
  const idxAmount  = find("amount", "value");   // optional: signed amount column

  if (idxDate < 0 || idxAccount < 0) {
    errEl.textContent = `CSV must have at least a Date and Account column. Found: ${header.join(", ")}`;
    errEl.style.display = "block"; return;
  }

  // Load CoA for account resolution
  let coa = [];
  try {
    const r = await apiGet(`/api/coa/${selectedCompanyId}`);
    coa = r.accounts || [];
  } catch (e) { errEl.textContent = "Failed to load CoA: " + friendlyError(e); errEl.style.display = "block"; return; }
  const byCode = new Map(coa.filter((c) => c.is_active).map((c) => [String(c.code).toLowerCase(), c]));
  const byName = new Map(coa.filter((c) => c.is_active).map((c) => [String(c.name).toLowerCase(), c]));

  const resolveAccount = (raw) => {
    const s = String(raw || "").trim();
    if (!s) return null;
    // Try exact code match
    const m1 = byCode.get(s.toLowerCase());
    if (m1) return m1;
    // Try exact name match
    const m2 = byName.get(s.toLowerCase());
    if (m2) return m2;
    // Try "code name" pattern — take first token as code
    const firstToken = s.split(/\s+/)[0];
    const m3 = byCode.get(firstToken.toLowerCase());
    if (m3) return m3;
    // Last resort: case-insensitive "contains" match on name
    const lc = s.toLowerCase();
    const m4 = coa.find((c) => c.is_active && c.name.toLowerCase() === lc);
    if (m4) return m4;
    return null;
  };

  // Parse each data row into a line
  const lines = [];
  const errors = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const dateRaw = (row[idxDate] || "").trim();
    if (!dateRaw) continue;  // skip blank rows
    // Normalize date: accept YYYY-MM-DD, M/D/YYYY, etc. Convert to YYYY-MM-DD.
    let isoDate = dateRaw;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(dateRaw)) {
      const [m, d, y] = dateRaw.split("/");
      const yyyy = y.length === 2 ? (parseInt(y, 10) > 50 ? "19" + y : "20" + y) : y;
      isoDate = `${yyyy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    const memo = (row[idxMemo] || "").trim();
    const acctRaw = (row[idxAccount] || "").trim();
    const acct = resolveAccount(acctRaw);
    if (!acct) {
      errors.push(`Row ${r + 1}: unknown account "${acctRaw}"`);
      continue;
    }
    let debit  = idxDebit  >= 0 ? _parseNum(row[idxDebit])  : 0;
    let credit = idxCredit >= 0 ? _parseNum(row[idxCredit]) : 0;
    if (!debit && !credit && idxAmount >= 0) {
      // Single signed Amount column: positive = debit, negative = credit (common)
      const v = _parseNum(row[idxAmount]);
      if (v > 0) debit = v; else if (v < 0) credit = -v;
    }
    if (debit === 0 && credit === 0) {
      errors.push(`Row ${r + 1}: no debit or credit amount`);
      continue;
    }
    lines.push({
      row: r + 1,
      date: isoDate,
      memo: memo || null,
      coa_account_id: acct.id,
      coa_label: `${acct.code} ${acct.name}`,
      description: (idxDesc >= 0 ? (row[idxDesc] || "").trim() : "") || null,
      debit, credit,
    });
  }

  // Group by date+memo
  const groupKey = (l) => `${l.date}||${l.memo || ""}`;
  const groups = new Map();
  for (const l of lines) {
    const k = groupKey(l);
    if (!groups.has(k)) groups.set(k, { date: l.date, memo: l.memo, lines: [] });
    groups.get(k).lines.push(l);
  }

  // Validate balance per group
  const entries = [];
  for (const g of groups.values()) {
    const td = g.lines.reduce((s, l) => s + l.debit, 0);
    const tc = g.lines.reduce((s, l) => s + l.credit, 0);
    g.total_debit  = td;
    g.total_credit = tc;
    g.balanced = Math.abs(td - tc) < 0.005 && td > 0;
    if (g.lines.length < 2) g.balanced = false;
    entries.push(g);
  }

  _journalImportState.parsed = entries;

  if (!entries.length && !errors.length) {
    errEl.textContent = "No usable rows found.";
    errEl.style.display = "block";
    return;
  }

  // Render preview
  const balanced = entries.filter((e) => e.balanced).length;
  const unbalanced = entries.filter((e) => !e.balanced);

  const errBlock = errors.length
    ? `<div style="padding:10px;background:oklch(0.95 0.08 30);color:var(--color-error);border-radius:6px;font-size:var(--text-xs);margin-bottom:10px;">
         <strong>${errors.length} row error${errors.length === 1 ? "" : "s"}:</strong>
         <ul style="margin:4px 0 0 16px;">${errors.slice(0, 10).map((e) => `<li>${_escapeHtml(e)}</li>`).join("")}${errors.length > 10 ? `<li>… and ${errors.length - 10} more</li>` : ""}</ul>
       </div>`
    : "";

  previewEl.innerHTML = `
    <div style="margin-bottom:10px;font-size:var(--text-sm);">
      <strong>${entries.length}</strong> entries parsed ·
      <span style="color:var(--color-success);">${balanced} balanced</span>
      ${unbalanced.length ? ` · <span style="color:var(--color-error);">${unbalanced.length} unbalanced</span>` : ""}
    </div>
    ${errBlock}
    ${entries.map((e, i) => `
      <div style="border:1px solid ${e.balanced ? "var(--color-border)" : "var(--color-error)"};border-radius:6px;padding:10px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:var(--text-sm);">
          <div><strong>${formatDate(e.date)}</strong>${e.memo ? ` · ${_escapeHtml(e.memo)}` : ""}</div>
          <div>
            ${e.balanced
              ? '<span class="badge badge-success">Balanced</span>'
              : `<span class="badge badge-error">Off by ${formatNumber(Math.abs(e.total_debit - e.total_credit))}</span>`}
          </div>
        </div>
        <table class="data-table" style="width:100%;font-size:var(--text-xs);">
          <thead><tr><th>Account</th><th>Description</th><th style="text-align:right;">Debit</th><th style="text-align:right;">Credit</th></tr></thead>
          <tbody>${e.lines.map((l) => `<tr>
            <td>${_escapeHtml(l.coa_label)}</td>
            <td>${_escapeHtml(l.description || "")}</td>
            <td style="text-align:right;">${l.debit ? formatNumber(l.debit) : ""}</td>
            <td style="text-align:right;">${l.credit ? formatNumber(l.credit) : ""}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
    `).join("")}`;

  document.getElementById("journal-import-parse-btn").style.display = "none";
  document.getElementById("journal-import-confirm-btn").style.display = "inline-flex";
  document.getElementById("journal-import-back-btn").style.display = "inline-flex";

  if (unbalanced.length) {
    // Still let user proceed — but disable confirm
    document.getElementById("journal-import-confirm-btn").disabled = true;
    errEl.innerHTML = `<strong>${unbalanced.length} entr${unbalanced.length === 1 ? "y is" : "ies are"} unbalanced.</strong> Fix them or go back and edit the CSV.`;
    errEl.style.display = "block";
  } else {
    document.getElementById("journal-import-confirm-btn").disabled = false;
  }
}

async function journalImportConfirm() {
  const entries = _journalImportState.parsed;
  if (!entries?.length) return;
  const balanced = entries.filter((e) => e.balanced);
  if (!balanced.length) return;
  const btn = document.getElementById("journal-import-confirm-btn");
  btn.disabled = true; btn.textContent = "Creating...";
  let ok = 0, fail = 0;
  const errEl = document.getElementById("journal-import-error");
  errEl.style.display = "none";
  for (const e of balanced) {
    try {
      await apiPost(`/api/journal/${selectedCompanyId}`, {
        date: e.date,
        memo: e.memo || null,
        lines: e.lines.map((l) => ({
          coa_account_id: l.coa_account_id,
          debit:  l.debit || 0,
          credit: l.credit || 0,
          description: l.description || null,
        })),
      });
      ok++;
    } catch (err) {
      fail++;
      console.warn("JE import failed:", err);
    }
  }
  btn.disabled = false; btn.textContent = "Confirm & Create";
  showToast(`Created ${ok} journal entries${fail ? `, ${fail} failed` : ""}`, ok ? "success" : "error");
  closeJournalImportModal();
  await journalReload();
}


async function journalSave() {
  const errEl = document.getElementById("journal-error");
  errEl.style.display = "none";
  const date = document.getElementById("journal-date").value;
  if (!date) { errEl.textContent = "Date required."; errEl.style.display = "block"; return; }
  const memo = document.getElementById("journal-memo").value.trim();
  const lines = _journalState.editingLines.filter((l) => l.coa_account_id);
  if (lines.some((l) => !l.coa_account_id)) { errEl.textContent = "Every line needs an account."; errEl.style.display = "block"; return; }
  try {
    const __useRailway = _shouldUseRailway();
    if (!__useRailway) {
      const headers = { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}`, Prefer: "return=representation" };
      // Insert journal_entries header
      const er = await fetch(`${SUPABASE_URL}/rest/v1/journal_entries`, {
        method: "POST", headers,
        body: JSON.stringify({ company_id: selectedCompanyId, date, memo: memo || null, source: "manual" }),
      });
      if (!er.ok) throw new Error(`Supabase journal_entries ${er.status}: ${(await er.text()).slice(0, 200)}`);
      const entry = (await er.json())[0];
      // Insert journal_lines
      const linesPayload = lines.map((l) => ({
        journal_entry_id: entry.id,
        coa_account_id: l.coa_account_id,
        description: l.description || null,
        debit: parseFloat(l.debit || 0),
        credit: parseFloat(l.credit || 0),
      }));
      const lr = await fetch(`${SUPABASE_URL}/rest/v1/journal_lines`, {
        method: "POST", headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify(linesPayload),
      });
      if (!lr.ok) {
        await fetch(`${SUPABASE_URL}/rest/v1/journal_entries?id=eq.${entry.id}`, { method: "DELETE", headers }).catch(() => {});
        throw new Error(`Supabase journal_lines ${lr.status}: ${(await lr.text()).slice(0, 200)}`);
      }
    } else {
      await apiPost(`/api/journal/${selectedCompanyId}`, { date, memo: memo || null, lines });
    }
    closeJournalEditModal();
    await journalReload();
  } catch (e) { errEl.textContent = "Failed: " + (e.message || "unknown"); errEl.style.display = "block"; }
}


// =====================================================================
//  BANK ACCOUNTS PAGE
// =====================================================================

let _baState = { items: [], accounts: [] };

async function baInit() {
  const list = document.getElementById("ba-list");
  if (!selectedCompanyId) { list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--color-text-muted);">Pick a company.</div>'; return; }
  const company = _getSelectedCompany();
  if (!company || company.source !== "manual") { list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--color-text-muted);">Bank accounts only apply to manual + Plaid companies.</div>'; return; }
  document.getElementById("ba-page-title").textContent = `Bank Accounts — ${company.name}`;
  if (!_coaState.accounts.length) {
    try {
      // QBO companies fetch via Railway; manual+Plaid have no Railway data,
      // so fall through to Supabase if Railway returns nothing.
      const r = await apiGet(`/api/coa/${selectedCompanyId}`);
      _coaState.accounts = r.accounts || [];
    } catch (e) { /* fall through */ }
    if (!_coaState.accounts.length && supabaseAccessToken) {
      const rows = await _supaFetch("chart_of_accounts", {
        select: "id,code,name,type,subtype,is_active,parent_id",
        filters: [{ k: "is_active", v: "eq.true" }],
        order: "code",
      });
      if (rows) _coaState.accounts = rows;
    }
  }
  await baReload();
}

async function baReload() {
  try {
    const resp = await apiGet(`/api/plaid/accounts/${selectedCompanyId}`);
    _baState.items = resp.items || [];
    _baState.accounts = resp.accounts || [];
    if (!_baState.items.length && supabaseAccessToken) {
      const [items, accts] = await Promise.all([
        _supaFetch("plaid_items", { select: "id,institution_name,status,last_synced_at,created_at", order: "created_at.desc" }),
        _supaFetch("accounts",    { select: "id,name,mask,type,subtype,plaid_item_id,current_balance,available_balance,coa_account_id" }),
      ]);
      if (items) _baState.items = items;
      if (accts) _baState.accounts = accts;
    }
    _baRender();
  } catch (e) {
    document.getElementById("ba-list").innerHTML = `<div style="text-align:center;padding:24px;color:var(--color-error);">Load failed: ${_escapeHtml(e.message)}</div>`;
  }
}

function _baRender() {
  const list = document.getElementById("ba-list");
  if (!_baState.items.length) { list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--color-text-muted);">No banks linked yet. Click <strong>Link Another Bank</strong>.</div>'; return; }
  const coaAssets = _coaState.accounts.filter((a) => a.is_active && (a.type === "asset" || a.type === "liability"));
  list.innerHTML = _baState.items.map((it) => {
    const accts = _baState.accounts.filter((a) => a.plaid_item_id === it.id);
    const lastSync = it.last_synced_at ? new Date(it.last_synced_at).toLocaleString() : "never";
    const safeInst = (it.institution_name || "Bank").replace(/'/g, "\\'");
    return `<div class="card" style="margin-bottom:12px;padding:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;flex-wrap:wrap;">
        <div>
          <strong>${_escapeHtml(it.institution_name || "Bank")}</strong>
          <span class="badge ${it.status === "good" ? "badge-success" : "badge-warning"}" style="margin-left:8px;">${it.status || "unknown"}</span>
          <div style="font-size:var(--text-xs);color:var(--color-text-secondary);">${accts.length} account${accts.length === 1 ? "" : "s"} · last synced: ${lastSync}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-sm btn-secondary" onclick="baSyncItem('${it.id}')" title="Pull latest transactions from Plaid">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
            Sync
          </button>
          <button class="btn btn-sm btn-secondary" onclick="baReconnect('${it.id}','${safeInst}')" title="Re-link if the bank says credentials expired">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            Reconnect
          </button>
          <button class="btn btn-sm" style="background:var(--color-error);color:white;border:none;" onclick="baDeleteBank('${it.id}','${safeInst}', ${accts.length})" title="Disconnect and delete this bank — transactions and accounts are removed">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            Delete Bank
          </button>
        </div>
      </div>
      <table class="data-table" style="width:100%;font-size:var(--text-sm);">
        <thead><tr><th>Account</th><th>Type</th><th style="text-align:right;">Balance</th><th>Maps to CoA</th><th style="width:32px;"></th></tr></thead>
        <tbody>${accts.map((a) => {
          const safeAcctLabel = `${a.name}${a.mask ? " ···" + a.mask : ""}`.replace(/'/g, "\\'");
          return `<tr>
          <td><strong>${_escapeHtml(a.name)}</strong>${a.mask ? ` <span style="color:var(--color-text-secondary);">···${a.mask}</span>` : ""}</td>
          <td style="font-size:var(--text-xs);">${a.type || ""}${a.subtype ? " · " + a.subtype : ""}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;">${parseFloat(a.current_balance || 0).toFixed(2)}</td>
          <td>
            <select class="form-select form-select-sm" onchange="baUpdateCoaMapping('${a.id}', this.value)">
              <option value="">(none)</option>
              ${coaAssets.map((c) => `<option value="${c.id}" ${a.coa_account_id === c.id ? "selected" : ""}>${_escapeHtml(c.code)} ${_escapeHtml(c.name)}</option>`).join("")}
            </select>
          </td>
          <td style="text-align:right;">
            <button class="btn btn-sm btn-ghost" style="color:var(--color-error);" title="Remove this account from this company (deletes its transactions)" onclick="baDeleteAccount('${a.id}','${safeAcctLabel}')">&times;</button>
          </td>
        </tr>`;
        }).join("")}</tbody>
      </table>
    </div>`;
  }).join("");
}

async function baSyncItem(itemId) {
  // Sync is per-company at the API layer, but the outcome is the same —
  // all items for the company refresh.
  await syncPlaidCompany(selectedCompanyId, _getSelectedCompany()?.name);
  await baReload();
}

async function baReconnect(itemId, institutionName) {
  // Reconnect uses the same Plaid Link flow but for an existing item.
  // For v1 simplicity, re-run the standard connect-bank flow. Plaid's
  // `mergeReconnectedPlaidItem` equivalent is handled server-side on exchange.
  if (!confirm(`Reconnect ${institutionName}? This will re-run Plaid Link. If the same bank is chosen, existing transactions are preserved.`)) return;
  const company = _getSelectedCompany();
  if (!company) return;
  await connectPlaidBank(company.id, company.name);
}

async function baDeleteBank(itemId, institutionName, accountCount) {
  const msg = `Delete ${institutionName}?\n\nThis will:\n• Disconnect the bank at Plaid\n• Remove ${accountCount} linked account${accountCount === 1 ? "" : "s"}\n• Delete ALL transactions from this bank\n\nThis cannot be undone. Reports will change.\n\nType DELETE to confirm.`;
  const answer = prompt(msg);
  if (answer !== "DELETE") {
    if (answer !== null) showToast("Canceled — didn't match.", "info");
    return;
  }
  try {
    await apiPost(`/api/plaid/disconnect/${itemId}`, {});
    showToast(`${institutionName} deleted`, "success");
    await baReload();
    // Refresh the main company list so the Companies page shows "No bank linked" if this was the last one
    if (typeof loadCompanyList === "function") {
      await loadCompanyList();
    }
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}

async function baUpdateCoaMapping(accountId, coaId) {
  try {
    if (_shouldUseRailway()) {
      await apiPatch(`/api/accounts/${accountId}`, { coa_account_id: coaId || null });
    } else {
      await _supaPatchRow("accounts", accountId, { coa_account_id: coaId || null });
    }
    showToast("Mapping updated", "success");
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}

async function baDeleteAccount(accountId, label) {
  const msg = `Remove ${label} from this company?\n\nAll of its transactions will be deleted. The underlying bank at Plaid is NOT affected — the account still exists there and can be re-linked later.\n\nType REMOVE to confirm.`;
  const answer = prompt(msg);
  if (answer !== "REMOVE") {
    if (answer !== null) showToast("Canceled — didn't match.", "info");
    return;
  }
  try {
    await apiDelete(`/api/accounts/${accountId}`);
    showToast(`${label} removed`, "success");
    await baReload();
    if (typeof loadCompanyList === "function") await loadCompanyList();
  } catch (e) { showToast("Failed: " + (e.message || "unknown"), "error"); }
}

async function baLinkAnother() {
  // Reuse the existing Plaid link flow
  const company = _getSelectedCompany();
  if (!company) return;
  await connectPlaidBank(company.id, company.name);
}


// =====================================================================
//  DASHBOARD — scope to selected company when one is picked
// =====================================================================

async function dashInit() {
  // Existing consolidated dashboard logic already runs on load; only intervene
  // when a specific manual company is selected.
  const company = _getSelectedCompany();
  if (!company || company.source !== "manual") {
    // Back to consolidated — re-run existing loader if it exists
    if (typeof loadDashboard === "function") loadDashboard();
    return;
  }
  // Per-company dashboard. Manual+Plaid companies live in Supabase, so the
  // Railway endpoint returns zeros — aggregate directly from Supabase.
  try {
    const data = supabaseAccessToken
      ? await _supaDashboard(company)
      : await apiGet(`/api/dashboard/${company.id}`);
    _renderPerCompanyDashboard(data);
  } catch (e) {
    showToast("Dashboard load failed: " + (e.message || "unknown"), "error");
  }
}

// Supabase-side per-company dashboard aggregation. Mirrors Railway's
// /api/dashboard/{companyId} response shape so _renderPerCompanyDashboard
// works unchanged. Sources:
//   cash_on_hand: sum of bank-account current_balance for depository accounts
//   ytd_revenue / ytd_expense: sum of transaction amounts categorized to a
//     CoA row of type 'income' / 'expense', YTD (Jan 1 → today)
//   ytd_net: revenue - expense
//   uncategorized_count: transactions with category_id null and not is_transfer
//   top_expenses: group expense-categorized txns by category, top 5 by total
//   recent_transactions: 10 most recent rows (date desc)
async function _supaDashboard(company) {
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  const base = `${SUPABASE_URL}/rest/v1`;
  const cid = company.id;
  const today = new Date();
  const yyyy = today.getFullYear();
  const ytdStart = `${yyyy}-01-01`;
  // Pull a full 12-month rolling window so we can compute KPIs for
  // Last Month + Year-to-Last-Month + YTD AND a 12-bar trend chart in
  // one round-trip. PostgREST date filters match string lex order on
  // ISO dates, which is fine.
  const trendStart = new Date(today.getFullYear(), today.getMonth() - 11, 1);
  const trendStartStr = `${trendStart.getFullYear()}-${String(trendStart.getMonth() + 1).padStart(2, '0')}-01`;

  const [accounts, coa, txns, recent, uncatHead] = await Promise.all([
    fetch(`${base}/accounts?company_id=eq.${cid}&select=id,name,type,current_balance`, { headers })
      .then((r) => r.ok ? r.json() : []),
    fetch(`${base}/chart_of_accounts?company_id=eq.${cid}&select=id,name,type`, { headers })
      .then((r) => r.ok ? r.json() : []),
    // 12-month window of categorized txns. We slice to YTD / last month /
    // YTLM in JS.
    fetch(`${base}/transactions?company_id=eq.${cid}&date=gte.${trendStartStr}&is_transfer=eq.false&parent_transaction_id=is.null&select=id,date,amount,merchant_name,description,category_id,category:categories(coa_account_id,name)&limit=20000`, { headers })
      .then((r) => r.ok ? r.json() : []),
    fetch(`${base}/transactions?company_id=eq.${cid}&order=date.desc&limit=10&select=date,merchant_name,description,amount`, { headers })
      .then((r) => r.ok ? r.json() : []),
    fetch(`${base}/transactions?company_id=eq.${cid}&category_id=is.null&is_transfer=eq.false&select=id`, {
      headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
    }),
  ]);

  // Filter the 12-month set down to YTD for the legacy KPIs/top-expenses
  // logic below.
  const ytdTxns = txns.filter((t) => t.date >= ytdStart);

  // Index CoA by id so each transaction's category → CoA type lookup is O(1).
  const coaById = new Map(coa.map((c) => [c.id, c]));

  // Cash on hand: depository accounts' current balance. (Loans are not cash.)
  const cashOnHand = accounts
    .filter((a) => a.type === "depository")
    .reduce((s, a) => s + parseFloat(a.current_balance || 0), 0);

  // Walk YTD transactions, partition into revenue/expense by CoA type.
  // Plaid sign convention: positive amount = outflow (Spent), negative = inflow.
  // Use raw signed amounts so refunds offset the expense (matches the P&L
  // builder _supaProfitLoss). Income flips sign so revenue reads positive;
  // expense leaves as-is so refunds (negative amounts) reduce the total.
  let ytdRevenue = 0, ytdExpense = 0;
  const expenseByCat = new Map();
  for (const t of ytdTxns) {
    const coaId = t.category?.coa_account_id;
    const coaRow = coaId ? coaById.get(coaId) : null;
    const raw = parseFloat(t.amount || 0);
    if (coaRow?.type === "income") {
      ytdRevenue += -raw;
    } else if (coaRow?.type === "expense") {
      ytdExpense += raw;
      const key = t.category?.name || "Uncategorized";
      expenseByCat.set(key, (expenseByCat.get(key) || 0) + raw);
    }
  }
  // Drop net-zero or negative-net categories from the "top expenses" list —
  // they're informative on the P&L but visually weird on the dashboard.
  const topExpenses = Array.from(expenseByCat.entries())
    .filter(([, total]) => total > 0.005)
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  // Pull total count from Content-Range header on the count-only request.
  let uncategorizedCount = 0;
  if (uncatHead && uncatHead.ok) {
    const cr = uncatHead.headers.get("content-range") || "";
    const m = /\/(\d+|\*)/.exec(cr);
    if (m && m[1] !== "*") uncategorizedCount = parseInt(m[1], 10);
  }

  // Period helpers — Last Month, Year-to-Last-Month
  const lastMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lmYear = lastMonthDate.getFullYear();
  const lmMonth = lastMonthDate.getMonth(); // 0-indexed
  const lmStart = `${lmYear}-${String(lmMonth + 1).padStart(2, '0')}-01`;
  const lmEndDay = new Date(lmYear, lmMonth + 1, 0).getDate();
  const lmEnd = `${lmYear}-${String(lmMonth + 1).padStart(2, '0')}-${String(lmEndDay).padStart(2, '0')}`;
  const lmLabel = lastMonthDate.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const sumPL = (rows) => {
    let rev = 0, exp = 0;
    for (const t of rows) {
      const coaId = t.category?.coa_account_id;
      const coaRow = coaId ? coaById.get(coaId) : null;
      const raw = parseFloat(t.amount || 0);
      if (coaRow?.type === "income") rev += -raw;
      else if (coaRow?.type === "expense") exp += raw;
    }
    return { rev, exp, net: rev - exp };
  };
  const lmAgg = sumPL(txns.filter((t) => t.date >= lmStart && t.date <= lmEnd));
  const ytlmAgg = sumPL(txns.filter((t) => t.date >= ytdStart && t.date <= lmEnd));

  // 12-month trend buckets (oldest → newest), each bucket = one calendar month.
  const monthBuckets = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const y = d.getFullYear(), m = d.getMonth();
    const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(y, m + 1, 0).getDate();
    const end = `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const label = d.toLocaleString('en-US', { month: 'short', year: '2-digit' });
    const agg = sumPL(txns.filter((t) => t.date >= start && t.date <= end));
    monthBuckets.push({ key: start.slice(0, 7), label, revenue: agg.rev, expenses: agg.exp });
  }

  return {
    company: { id: cid, name: company.name },
    kpi: {
      cash_on_hand: cashOnHand,
      ytd_revenue: ytdRevenue,
      ytd_expense: ytdExpense,
      ytd_net: ytdRevenue - ytdExpense,
      last_month_revenue: lmAgg.rev,
      last_month_expense: lmAgg.exp,
      last_month_net: lmAgg.net,
      last_month_label: lmLabel,
      ytlm_revenue: ytlmAgg.rev,
      ytlm_expense: ytlmAgg.exp,
      ytlm_net: ytlmAgg.net,
    },
    uncategorized_count: uncategorizedCount,
    top_expenses: topExpenses,
    recent_transactions: recent,
    trend_months: monthBuckets,
  };
}

function _renderPerCompanyDashboard(data) {
  // Minimal render: find a container within the existing dashboard page and swap.
  // Create a wrapper element if it doesn't exist.
  const page = document.getElementById("page-dashboard");
  if (!page) return;
  let wrap = document.getElementById("per-company-dash-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "per-company-dash-wrap";
    page.insertBefore(wrap, page.firstChild);
  }
  const k = data.kpi || {};
  const months = data.trend_months || [];
  const topExp = data.top_expenses || [];
  const recent = data.recent_transactions || [];

  const lmLabel = k.last_month_label || "Last Month";
  wrap.innerHTML = `
    <div class="card mb-4" style="padding:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <h2 style="margin:0;font-size:var(--text-lg);">${_escapeHtml(data.company.name)} · Dashboard</h2>
        <span class="badge badge-neutral">Manual + Plaid</span>
      </div>

      <div style="font-size:var(--text-xs);text-transform:uppercase;color:var(--color-text-secondary);letter-spacing:0.05em;margin-bottom:6px;">${_escapeHtml(lmLabel)} · Last Month</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px;">
        ${_kpiCard("Revenue", k.last_month_revenue)}
        ${_kpiCard("Expenses", k.last_month_expense)}
        ${_kpiCard("Net Income", k.last_month_net, k.last_month_net >= 0 ? "var(--color-success)" : "var(--color-error)")}
        ${_kpiCard("Cash on hand", k.cash_on_hand)}
      </div>

      <div style="font-size:var(--text-xs);text-transform:uppercase;color:var(--color-text-secondary);letter-spacing:0.05em;margin-bottom:6px;">Year to ${_escapeHtml(lmLabel)} · YTLM</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px;">
        ${_kpiCard("Revenue", k.ytlm_revenue)}
        ${_kpiCard("Expenses", k.ytlm_expense)}
        ${_kpiCard("Net Income", k.ytlm_net, k.ytlm_net >= 0 ? "var(--color-success)" : "var(--color-error)")}
      </div>

      <div style="font-size:var(--text-xs);text-transform:uppercase;color:var(--color-text-secondary);letter-spacing:0.05em;margin-bottom:6px;">Year to Date · YTD</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px;">
        ${_kpiCard("Revenue", k.ytd_revenue)}
        ${_kpiCard("Expenses", k.ytd_expense)}
        ${_kpiCard("Net Income", k.ytd_net, k.ytd_net >= 0 ? "var(--color-success)" : "var(--color-error)")}
      </div>

      ${data.uncategorized_count > 0 ? `<div style="background:oklch(0.95 0.08 60);border-radius:var(--radius-md);padding:10px 14px;margin-bottom:16px;font-size:var(--text-sm);">
        ⚠ <strong>${data.uncategorized_count}</strong> transactions are uncategorized. <a href="#transactions" onclick="navigateTo('transactions');document.getElementById('tx-filter-uncat').checked=true;txReload();return false;">Review now →</a>
      </div>` : ""}

      <h3 style="font-size:var(--text-sm);margin:16px 0 8px;">Revenue & Expenses · 12-month trend</h3>
      <div style="position:relative;height:240px;margin-bottom:16px;"><canvas id="per-company-trend-chart"></canvas></div>

      <div>
        <h3 style="font-size:var(--text-sm);margin-bottom:8px;">Top Expenses YTD</h3>
        ${topExp.length ? topExp.map((t) => `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:var(--text-sm);">
          <span>${_escapeHtml(t.name)}</span>
          <strong>${formatCurrency(t.total)}</strong>
        </div>`).join("") : '<div style="font-size:var(--text-sm);color:var(--color-text-muted);">No expenses yet.</div>'}
      </div>
      <h3 style="font-size:var(--text-sm);margin:16px 0 8px;">Recent Activity</h3>
      <table class="data-table" style="width:100%;font-size:var(--text-sm);">
        <thead><tr><th>Date</th><th>Merchant</th><th style="text-align:right;">Amount</th></tr></thead>
        <tbody>${recent.length ? recent.map((t) => `<tr>
          <td style="font-size:var(--text-xs);">${formatDate(t.date)}</td>
          <td>${_escapeHtml(prettifyMerchant(t))}</td>
          <td style="text-align:right;color:${(t.amount || 0) > 0 ? "var(--color-text-primary)" : "var(--color-success)"};">${formatCurrency(t.amount)}</td>
        </tr>`).join("") : '<tr><td colspan="3" style="text-align:center;color:var(--color-text-muted);padding:12px;">No transactions yet.</td></tr>'}</tbody>
      </table>
    </div>
  `;

  // Hide the existing consolidated dashboard content
  Array.from(page.children).forEach((el) => {
    if (el.id !== "per-company-dash-wrap") el.style.display = "none";
  });

  // Render the 12-month trend chart now that the canvas is in the DOM.
  if (months.length && typeof Chart !== "undefined") {
    const canvas = document.getElementById("per-company-trend-chart");
    if (canvas) {
      const dk = document.documentElement.getAttribute("data-theme") === "dark";
      const tc = dk ? "#cdccca" : "#28251d";
      const colors = ["#20808D", "#A84B2F"];
      if (chartInstances && chartInstances.perCompanyTrend) chartInstances.perCompanyTrend.destroy();
      const inst = new Chart(canvas, {
        type: "bar",
        data: {
          labels: months.map((m) => m.label),
          datasets: [
            { label: "Revenue",  data: months.map((m) => m.revenue),  backgroundColor: colors[0] },
            { label: "Expenses", data: months.map((m) => m.expenses), backgroundColor: colors[1] },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: "top", labels: { color: tc } } },
          scales: {
            x: { ticks: { color: tc } },
            y: { ticks: { color: tc, callback: (v) => "$" + v.toLocaleString() } },
          },
        },
      });
      if (typeof chartInstances === "object") chartInstances.perCompanyTrend = inst;
    }
  }
}

function _kpiCard(label, value, color) {
  const c = color || "var(--color-text-primary)";
  return `<div style="background:var(--color-bg-muted);padding:12px;border-radius:var(--radius-md);">
    <div style="font-size:var(--text-xs);color:var(--color-text-secondary);text-transform:uppercase;">${label}</div>
    <div style="font-size:var(--text-lg);font-weight:700;color:${c};margin-top:4px;">${formatCurrency(value)}</div>
  </div>`;
}


// =====================================================================
//  QBO → MANUAL IMPORT MODAL
// =====================================================================

let _qboImportPlan = null; // holds the vetted form values after Preview passes

async function qboImportUndo(placeholderAccountId, label, txCount) {
  const msg = `Delete this import?\n\n"${label}" and ALL ${Number(txCount).toLocaleString()} imported transactions will be removed from the destination company.\n\nThe auto-created CoA rows stay (safe in case other data uses them — delete from Chart of Accounts page if needed).\n\nType UNDO to confirm.`;
  const answer = prompt(msg);
  if (answer !== "UNDO") {
    if (answer !== null) showToast("Canceled — didn't match.", "info");
    return;
  }
  try {
    await apiDelete(`/api/accounts/${placeholderAccountId}`);
    showToast("Import deleted", "success");
    closeQboImportModal();
    if (typeof loadCompanyList === "function") await loadCompanyList();
  } catch (e) { showToast("Failed: " + (e.message || "unknown"), "error"); }
}

async function _qboImportLoadPrevious() {
  // Look up existing QBO Import placeholder accounts for the currently-selected dest.
  const destId = document.getElementById("qbo-import-dest").value;
  const previousEl = document.getElementById("qbo-import-previous");
  if (!previousEl) return;
  if (!destId) { previousEl.style.display = "none"; return; }
  try {
    const resp = await apiGet(`/api/plaid/accounts/${destId}`);
    const imports = (resp.accounts || []).filter(
      (a) => !a.plaid_item_id && (a.name || "").startsWith("QBO Import · "),
    );
    if (!imports.length) { previousEl.style.display = "none"; return; }
    previousEl.innerHTML = `
      <strong style="font-size:var(--text-sm);">Previous imports for this company:</strong>
      <ul style="margin:6px 0 0 0;padding:0;list-style:none;font-size:var(--text-sm);">
        ${imports.map((a) => `<li style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;">
          <span>${_escapeHtml(a.name)}</span>
          <button class="btn btn-sm" style="background:var(--color-error);color:white;border:none;" onclick="qboImportUndo('${a.id}','${a.name.replace(/'/g,"\\'")}',0)" type="button">Delete</button>
        </li>`).join("")}
      </ul>
      <div style="font-size:var(--text-xs);color:var(--color-text-secondary);margin-top:4px;">Deleting removes the placeholder account and all its imported transactions. CoA rows stay.</div>`;
    previousEl.style.display = "block";
  } catch (e) {
    previousEl.style.display = "none";
  }
}

function openQboImportModal() {
  // Populate source (QBO) + dest (manual) dropdowns
  const srcSel = document.getElementById("qbo-import-src");
  const destSel = document.getElementById("qbo-import-dest");
  const qboCompanies = (allCompanies || []).filter((c) => (c.source || "qbo") === "qbo");
  const manualCompanies = (allCompanies || []).filter((c) => c.source === "manual");
  if (!qboCompanies.length) {
    showToast("No QuickBooks companies connected to import from.", "error");
    return;
  }
  if (!manualCompanies.length) {
    showToast("No manual companies to import into. Create one first.", "error");
    return;
  }
  srcSel.innerHTML = '<option value="">Select...</option>' +
    qboCompanies.map((c) => `<option value="${c.id}">${_escapeHtml(c.name)}</option>`).join("");
  destSel.innerHTML = '<option value="">Select...</option>' +
    manualCompanies.map((c) => `<option value="${c.id}">${_escapeHtml(c.name)}</option>`).join("");
  const end = document.getElementById("qbo-import-end");
  if (end && !end.value) end.value = new Date().toISOString().slice(0, 10);

  _qboImportPlan = null;
  _qboImportResetUi();

  const modal = document.getElementById("qbo-import-modal");
  modal.classList.add("active");
  modal.style.display = "flex";
}

function closeQboImportModal() {
  const modal = document.getElementById("qbo-import-modal");
  modal.classList.remove("active");
  modal.style.display = "none";
  _qboImportPlan = null;
}

function _qboImportResetUi() {
  document.getElementById("qbo-import-error").style.display = "none";
  document.getElementById("qbo-import-preview").style.display = "none";
  document.getElementById("qbo-import-result").style.display = "none";
  document.getElementById("qbo-import-progress").style.display = "none";
  document.getElementById("qbo-import-preview-btn").style.display = "inline-flex";
  document.getElementById("qbo-import-preview-btn").disabled = false;
  document.getElementById("qbo-import-confirm-btn").style.display = "none";
  document.getElementById("qbo-import-back-btn").style.display = "none";
  const prev = document.getElementById("qbo-import-previous");
  if (prev) prev.style.display = "none";
  _qboImportSetFormEnabled(true);
}

function _qboImportSetFormEnabled(enabled) {
  ["qbo-import-src", "qbo-import-dest", "qbo-import-start",
   "qbo-import-end", "qbo-import-method"].forEach((id) => {
    const el = document.getElementById(id); if (el) el.disabled = !enabled;
  });
}

function qboImportBackToForm() {
  _qboImportPlan = null;
  _qboImportResetUi();
}

function _qboImportCollect() {
  const errEl = document.getElementById("qbo-import-error");
  errEl.style.display = "none";
  const src = document.getElementById("qbo-import-src").value;
  const dest = document.getElementById("qbo-import-dest").value;
  const start = document.getElementById("qbo-import-start").value;
  const end = document.getElementById("qbo-import-end").value;
  const method = document.getElementById("qbo-import-method").value;
  if (!src || !dest || !start || !end) {
    errEl.textContent = "All fields are required."; errEl.style.display = "block"; return null;
  }
  if (src === dest) {
    errEl.textContent = "Source and destination can't be the same company."; errEl.style.display = "block"; return null;
  }
  if (start > end) {
    errEl.textContent = "Start date is after end date."; errEl.style.display = "block"; return null;
  }
  return { source_qbo_company_id: src, dest_manual_company_id: dest,
           start_date: start, end_date: end, accounting_method: method };
}

async function runQboImportPreview() {
  const form = _qboImportCollect();
  if (!form) return;
  const errEl = document.getElementById("qbo-import-error");
  const progEl = document.getElementById("qbo-import-progress");
  const progTextEl = document.getElementById("qbo-import-progress-text");
  const previewEl = document.getElementById("qbo-import-preview");
  const previewBtn = document.getElementById("qbo-import-preview-btn");

  if (progTextEl) progTextEl.textContent = "Previewing... checking QBO and building the plan.";
  progEl.style.display = "block";
  previewBtn.disabled = true;
  previewEl.style.display = "none";

  try {
    const r = await apiPost("/api/import/qbo-to-manual", { ...form, preview: true });
    progEl.style.display = "none";

    const newList = (r.new_coas || []).slice(0, 25);
    const newHtml = newList.length
      ? `<ul style="margin:6px 0 0 16px;font-size:var(--text-xs);max-height:180px;overflow-y:auto;">
           ${newList.map((u) => `<li><code>${_escapeHtml(u.coa_code || "")}</code> ${_escapeHtml(u.qbo_name)} <span style="color:#5a6478;">(${_escapeHtml(u.coa_type)})</span></li>`).join("")}
           ${r.new_coa_count > newList.length ? `<li>… and ${r.new_coa_count - newList.length} more</li>` : ""}
         </ul>`
      : '<div style="margin-top:6px;color:var(--color-success);">Every QBO account name already has an exact match — no new CoA rows will be created.</div>';

    previewEl.innerHTML = `
      <strong>Ready to import</strong>
      <div style="margin-top:6px;">
        <div><strong>Source:</strong> ${_escapeHtml(r.source_company)}</div>
        <div><strong>Destination:</strong> ${_escapeHtml(r.dest_company)}</div>
        <div><strong>Date range:</strong> ${_escapeHtml(r.start_date)} → ${_escapeHtml(r.end_date)} (${r.months_to_process} month${r.months_to_process === 1 ? "" : "s"})</div>
        <div><strong>QBO accounts found:</strong> ${r.qbo_account_count} total · ${r.existing_match_count} already mapped · ${r.new_coa_count} new to create</div>
      </div>
      ${r.new_coa_count ? `<div style="margin-top:10px;"><strong>New CoA accounts that will be created:</strong>${newHtml}</div>` : newHtml}
      <div style="margin-top:10px;font-size:var(--text-xs);color:#5a6478;">
        Nothing has been written yet. Review, then click <strong>Confirm &amp; Run Import</strong> below — or
        <strong>Change options</strong> to tweak the date range.
      </div>`;
    previewEl.style.display = "block";
    _qboImportPlan = form;
    _qboImportSetFormEnabled(false);
    previewBtn.style.display = "none";
    document.getElementById("qbo-import-confirm-btn").style.display = "inline-flex";
    document.getElementById("qbo-import-back-btn").style.display = "inline-flex";
  } catch (e) {
    progEl.style.display = "none";
    previewBtn.disabled = false;
    errEl.textContent = "Preview failed: " + (e.message || "unknown error");
    errEl.style.display = "block";
  }
}

async function runQboImportConfirm() {
  if (!_qboImportPlan) return;
  const form = _qboImportPlan;
  const errEl = document.getElementById("qbo-import-error");
  const progEl = document.getElementById("qbo-import-progress");
  const progTextEl = document.getElementById("qbo-import-progress-text");
  const previewEl = document.getElementById("qbo-import-preview");
  const resultEl = document.getElementById("qbo-import-result");
  const confirmBtn = document.getElementById("qbo-import-confirm-btn");
  const backBtn = document.getElementById("qbo-import-back-btn");

  errEl.style.display = "none";
  if (progTextEl) progTextEl.textContent = "Importing... this can take 30–90 seconds depending on date range.";
  progEl.style.display = "block";
  confirmBtn.disabled = true;
  backBtn.disabled = true;

  try {
    const r = await apiPost("/api/import/qbo-to-manual", { ...form, preview: false });
    progEl.style.display = "none";
    confirmBtn.style.display = "none";
    backBtn.style.display = "none";
    previewEl.style.display = "none";

    const createdList = (r.created_accounts || []).slice(0, 12);
    const createdHtml = createdList.length
      ? `<div style="margin-top:8px;"><strong>${r.created_accounts_count} new CoA account${r.created_accounts_count === 1 ? "" : "s"}</strong> created:
           <ul style="margin:4px 0 0 16px;font-size:var(--text-xs);">
             ${createdList.map((u) => `<li><code>${_escapeHtml(u.coa_code || "")}</code> ${_escapeHtml(u.qbo_name)} <span style="color:#5a6478;">(${_escapeHtml(u.coa_type)})</span></li>`).join("")}
             ${r.created_accounts_count > createdList.length ? `<li>… and ${r.created_accounts_count - createdList.length} more</li>` : ""}
           </ul></div>`
      : '<div style="margin-top:8px;color:var(--color-success);">No new CoA rows needed.</div>';

    const placeholderLabel = `QBO Import · ${r.source_company}`;
    resultEl.innerHTML = `
      <div><strong>${r.imported.toLocaleString()}</strong> transactions imported from
        <strong>${_escapeHtml(r.source_company)}</strong> into
        <strong>${_escapeHtml(r.dest_company)}</strong> across ${r.months_processed} month${r.months_processed === 1 ? "" : "s"}.</div>
      <div style="font-size:var(--text-xs);color:#3a4a3a;margin-top:2px;">Skipped ${r.skipped.toLocaleString()} rows (no account / no amount / no date).</div>
      ${createdHtml}
      <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;">
        <button class="btn btn-sm btn-primary" onclick="setSelectedCompany('${form.dest_manual_company_id}');navigateTo('transactions');closeQboImportModal();" type="button">Open Transactions</button>
        <button class="btn btn-sm btn-secondary" onclick="setSelectedCompany('${form.dest_manual_company_id}');navigateTo('coa');closeQboImportModal();" type="button">Review Chart of Accounts</button>
        <button class="btn btn-sm" style="background:var(--color-error);color:white;border:none;margin-left:auto;" onclick="qboImportUndo('${r.placeholder_account_id}','${placeholderLabel.replace(/'/g,"\\'")}','${r.imported}')" type="button">Delete This Import</button>
      </div>`;
    resultEl.style.display = "block";

    // Post-import: tag every newly-created CoA row with the QBO AccountType
    // it came from (e.g. 'Other Current Liability'), so the Balance Sheet
    // can sub-group the way QBO does. The Railway endpoint already returns
    // qbo_type per created account; we just need to write it to Supabase.
    try { await _qboImportTagAccountTypes(form.dest_manual_company_id, r.created_accounts || []); }
    catch (e) { console.warn("[QBO import] tagging qbo_account_type failed", e); }

    showToast(`Imported ${r.imported.toLocaleString()} transactions`, "success");
    if (typeof loadCompanyList === "function") await loadCompanyList();
  } catch (e) {
    progEl.style.display = "none";
    confirmBtn.disabled = false;
    backBtn.disabled = false;
    errEl.innerHTML = `<div>Import failed: ${_escapeHtml(e.message || "unknown error")}</div>
      <div style="font-size:var(--text-xs);margin-top:4px;color:var(--color-text-secondary);">
        Click <strong>Change options</strong> to adjust and try again, or <strong>Cancel</strong> to abort. Rerunning is safe — partial writes are deduped.
      </div>`;
    errEl.style.display = "block";
  }
}


// After a QBO→Manual import, walk the created_accounts list and write
// each row's QBO AccountType (e.g. 'Other Current Liability') back onto
// the matching chart_of_accounts row in Supabase. Without this the BS
// renderer can't sub-group QBO-style. Best-effort: failures are logged
// but never re-thrown (the import itself already succeeded).
async function _qboImportTagAccountTypes(destCompanyId, createdAccounts) {
  if (!destCompanyId || !supabaseAccessToken || !Array.isArray(createdAccounts) || !createdAccounts.length) return;
  const headers = {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${supabaseAccessToken}`,
    Prefer: "return=minimal",
  };
  // Some Railway responses return the field as `qbo_type`, others as
  // `qbo_account_type`. Accept either.
  for (const row of createdAccounts) {
    const qboType = row.qbo_type || row.qbo_account_type;
    const qboName = row.qbo_name || row.name;
    if (!qboType || !qboName) continue;
    const url = `${SUPABASE_URL}/rest/v1/chart_of_accounts?company_id=eq.${destCompanyId}&name=eq.${encodeURIComponent(qboName)}&qbo_account_type=is.null`;
    await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ qbo_account_type: qboType }) }).catch(() => {});
  }
}

// =====================================================================
//  apiPatch helper (may not exist in older app.js)
// =====================================================================

if (typeof apiPatch === "undefined") {
  window.apiPatch = async function(path, body) {
    const res = await fetch(`${API}${path}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    });
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `API ${res.status}`);
    return data;
  };
}


// =====================================================================
//  CUSTOMERS + VENDORS (shared contact entity)
// =====================================================================

let _contactsState = { kind: "customer", rows: [], editing: null, coa: [] };
let _contactDebounceTimer = null;

async function _contactsLoadCoa() {
  if (!selectedCompanyId) return;
  try {
    const r = await apiGet(`/api/coa/${selectedCompanyId}`);
    _contactsState.coa = r.accounts || [];
  } catch (e) { _contactsState.coa = []; }
}

async function customersInit() {
  const body = document.getElementById("customers-body");
  if (!selectedCompanyId) { body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--color-text-muted);">Pick a company.</td></tr>'; return; }
  const company = _getSelectedCompany();
  if (!company || company.source !== "manual") { body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--color-text-muted);">Customers are only available for manual companies.</td></tr>'; return; }
  document.getElementById("customers-page-title").textContent = `Customers — ${company.name}`;
  _contactsState.kind = "customer";
  await _contactsLoadCoa();
  await customersReload();
}

function customersDebouncedReload() { clearTimeout(_contactDebounceTimer); _contactDebounceTimer = setTimeout(customersReload, 250); }

async function customersReload() {
  if (!selectedCompanyId) return;
  const search = document.getElementById("customers-search").value.trim();
  try {
    const qs = search ? `?search=${encodeURIComponent(search)}` : "";
    const r = await apiGet(`/api/customers/${selectedCompanyId}${qs}`);
    _contactsState.rows = r.customers || [];
    if (!_contactsState.rows.length && supabaseAccessToken) {
      const filters = search ? [{ k: "display_name", v: `ilike.*${search.replace(/[*]/g,"")}*` }] : [];
      const rows = await _supaFetch("customers", {
        select: "id,display_name,company_name,email,phone,terms_days,is_active",
        filters: [{ k: "is_active", v: "eq.true" }, ...filters],
        order: "display_name.asc",
      });
      if (rows) _contactsState.rows = rows;
    }
    _customersRender();
  } catch (e) {
    document.getElementById("customers-body").innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--color-error);">Load failed: ${_escapeHtml(e.message)}</td></tr>`;
  }
}

function _customersRender() {
  const body = document.getElementById("customers-body");
  const rows = _contactsState.rows;
  if (!rows.length) { body.innerHTML = emptyStateCell(6, {title: "No customers yet", body: "Add customers you invoice — stores, wholesale accounts, anyone you bill.", cta: {label: "+ New Customer", onclick: "openCustomerEdit(null)"}}); return; }
  body.innerHTML = rows.map((c) => `<tr>
    <td><strong>${_escapeHtml(c.display_name)}</strong></td>
    <td>${_escapeHtml(c.company_name || "—")}</td>
    <td>${_escapeHtml(c.email || "—")}</td>
    <td>${_escapeHtml(c.phone || "—")}</td>
    <td style="text-align:right;font-variant-numeric:tabular-nums;${(c.balance || 0) > 0 ? "color:var(--color-warning);" : ""}">${formatCurrency(c.balance || 0)}</td>
    <td style="text-align:right;white-space:nowrap;">
      <button class="btn btn-sm btn-ghost" onclick="openCustomerEdit('${c.id}')">Edit</button>
      <button class="btn btn-sm btn-ghost" onclick='rowActionsMenu(event, [{label:"Archive", onClick:"customerDelete(\u0027${c.id}\u0027,\u0027${c.display_name.replace(/'/g, "\\'")}\u0027)", danger:true}])' title="More">⋯</button>
    </td>
  </tr>`).join("");
}

async function openCustomerEdit(id) {
  if (!_contactsState.coa.length) await _contactsLoadCoa();
  _contactsState.kind = "customer";
  const existing = id ? _contactsState.rows.find((x) => x.id === id) : null;
  _contactsState.editing = id || null;
  document.getElementById("contact-edit-title").textContent = id ? "Edit Customer" : "New Customer";
  document.getElementById("contact-vendor-only").style.display = "none";
  _fillContactForm(existing);
  document.getElementById("contact-edit-error").style.display = "none";
  document.getElementById("contact-edit-modal").classList.add("active");
  document.getElementById("contact-edit-modal").style.display = "flex";
}

function _fillContactForm(existing) {
  document.getElementById("contact-display-name").value = existing?.display_name || "";
  document.getElementById("contact-company-name").value = existing?.company_name || "";
  document.getElementById("contact-email").value = existing?.email || "";
  document.getElementById("contact-phone").value = existing?.phone || "";
  document.getElementById("contact-terms-days").value = existing?.terms_days ?? 30;
  const addr = existing?.billing_address || {};
  document.getElementById("contact-bill-line1").value = addr.line1 || "";
  document.getElementById("contact-bill-city").value = addr.city || "";
  document.getElementById("contact-bill-region").value = addr.region || "";
  document.getElementById("contact-bill-postal").value = addr.postal_code || "";
  document.getElementById("contact-bill-country").value = addr.country || "US";
  document.getElementById("contact-notes").value = existing?.notes || "";
  if (_contactsState.kind === "vendor") {
    document.getElementById("contact-tax-id").value = existing?.tax_id || "";
    document.getElementById("contact-is-1099").checked = !!existing?.is_1099;
  }
  const acctSel = document.getElementById("contact-default-account");
  acctSel.innerHTML = '<option value="">— none —</option>' +
    _contactsState.coa.filter((a) => a.is_active).map((a) => `<option value="${a.id}" ${existing?.default_account_id === a.id ? "selected" : ""}>${_escapeHtml(a.code)} ${_escapeHtml(a.name)}</option>`).join("");
}

function closeContactEdit() {
  document.getElementById("contact-edit-modal").classList.remove("active");
  document.getElementById("contact-edit-modal").style.display = "none";
  // Clear pending-refresh flags so a later unrelated vendor save doesn't
  // accidentally trigger a dropdown reload in the bill or rule editors.
  if (_docState)   _docState.pendingPartyRefresh = false;
  if (_rulesState) _rulesState.pendingVendorRefresh = false;
}

async function contactSave() {
  const errEl = document.getElementById("contact-edit-error");
  errEl.style.display = "none";
  const name = document.getElementById("contact-display-name").value.trim();
  if (!name) { errEl.textContent = "Display name required."; errEl.style.display = "block"; return; }
  const kind = _contactsState.kind;
  const body = {
    display_name: name,
    company_name: document.getElementById("contact-company-name").value.trim() || null,
    email: document.getElementById("contact-email").value.trim() || null,
    phone: document.getElementById("contact-phone").value.trim() || null,
    terms_days: parseInt(document.getElementById("contact-terms-days").value || "30", 10),
    default_account_id: document.getElementById("contact-default-account").value || null,
    billing_address: {
      line1: document.getElementById("contact-bill-line1").value.trim(),
      city: document.getElementById("contact-bill-city").value.trim(),
      region: document.getElementById("contact-bill-region").value.trim(),
      postal_code: document.getElementById("contact-bill-postal").value.trim(),
      country: document.getElementById("contact-bill-country").value.trim() || "US",
    },
    notes: document.getElementById("contact-notes").value.trim() || null,
  };
  if (kind === "vendor") {
    body.tax_id = document.getElementById("contact-tax-id").value.trim() || null;
    body.is_1099 = document.getElementById("contact-is-1099").checked;
  }
  try {
    // Source-based routing: QBO → Railway; Plaid/Manual → Supabase direct.
    const __useRailway = _shouldUseRailway();
    if (!__useRailway) {
      const table = kind === "customer" ? "customers" : "vendors";
      const supaHeaders = {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${supabaseAccessToken}`,
      };
      const payload = { ...body };
      if (!_contactsState.editing) payload.company_id = selectedCompanyId;
      const url = _contactsState.editing
        ? `${SUPABASE_URL}/rest/v1/${table}?id=eq.${_contactsState.editing}`
        : `${SUPABASE_URL}/rest/v1/${table}`;
      const r = await fetch(url, {
        method: _contactsState.editing ? "PATCH" : "POST",
        headers: { ...supaHeaders, Prefer: "return=representation" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`Supabase ${table} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    } else {
      const url = kind === "customer"
        ? (_contactsState.editing ? `/api/customers/${_contactsState.editing}` : `/api/customers/${selectedCompanyId}`)
        : (_contactsState.editing ? `/api/vendors/${_contactsState.editing}` : `/api/vendors/${selectedCompanyId}`);
      if (_contactsState.editing) {
        await apiPatch(url, body);
      } else {
        await apiPost(url, body);
      }
    }
    // If the Bill/Invoice editor is awaiting a party refresh, reload its
    // dropdown and auto-select the contact we just saved (or the newest one).
    let newlyCreatedId = null;
    if (_docState && _docState.pendingPartyRefresh) {
      try {
        await _docLoadParties(_docState.kind);
        const match = _docState.parties.find((p) => (p.display_name || "").trim() === name.trim());
        newlyCreatedId = match?.id || null;
        _docRenderPartyOptions(newlyCreatedId);
        if (newlyCreatedId) docPartyChanged();
      } catch (e) { /* best-effort */ }
      _docState.pendingPartyRefresh = false;
    }
    // Same pattern for the Rule editor vendor combobox.
    if (_rulesState && _rulesState.pendingVendorRefresh && kind === "vendor") {
      try {
        const resp = await apiGet(`/api/vendors/${selectedCompanyId}`);
        _rulesState.vendors = resp.vendors || [];
        const match = _rulesState.vendors.find((v) => (v.display_name || "").trim() === name.trim());
        _ruleRenderComboOptions("vendor");
        _ruleSetComboValue("vendor", match?.id || "");
      } catch (e) { /* best-effort */ }
      _rulesState.pendingVendorRefresh = false;
    }
    closeContactEdit();
    if (kind === "customer") await customersReload(); else await vendorsReload();
  } catch (e) { errEl.textContent = "Failed: " + (e.message || "unknown"); errEl.style.display = "block"; }
}

async function customerDelete(id, label) {
  if (!confirm(`Archive customer "${label}"?`)) return;
  try {
    const __useRailway = _shouldUseRailway();
    if (!__useRailway) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/customers?id=eq.${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` },
        body: JSON.stringify({ is_active: false }),
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } else {
      await apiDelete(`/api/customers/${id}`);
    }
    await customersReload();
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}

// ------ VENDORS ------

async function vendorsInit() {
  const body = document.getElementById("vendors-body");
  if (!selectedCompanyId) { body.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--color-text-muted);">Pick a company.</td></tr>'; return; }
  const company = _getSelectedCompany();
  if (!company || company.source !== "manual") { body.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--color-text-muted);">Vendors are only available for manual companies.</td></tr>'; return; }
  document.getElementById("vendors-page-title").textContent = `Vendors — ${company.name}`;
  _contactsState.kind = "vendor";
  await _contactsLoadCoa();
  await vendorsReload();
}

function vendorsDebouncedReload() { clearTimeout(_contactDebounceTimer); _contactDebounceTimer = setTimeout(vendorsReload, 250); }

async function vendorsReload() {
  if (!selectedCompanyId) return;
  const search = document.getElementById("vendors-search").value.trim();
  try {
    const qs = search ? `?search=${encodeURIComponent(search)}` : "";
    const r = await apiGet(`/api/vendors/${selectedCompanyId}${qs}`);
    _contactsState.rows = r.vendors || [];
    if (!_contactsState.rows.length && supabaseAccessToken) {
      const filters = search ? [{ k: "display_name", v: `ilike.*${search.replace(/[*]/g,"")}*` }] : [];
      const rows = await _supaFetch("vendors", {
        select: "id,display_name,company_name,email,phone,terms_days,is_active,is_1099",
        filters: [{ k: "is_active", v: "eq.true" }, ...filters],
        order: "display_name.asc",
      });
      if (rows) _contactsState.rows = rows;
    }
    _vendorsRender();
  } catch (e) {
    document.getElementById("vendors-body").innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--color-error);">Load failed: ${_escapeHtml(e.message)}</td></tr>`;
  }
}

function _vendorsRender() {
  const body = document.getElementById("vendors-body");
  const rows = _contactsState.rows;
  if (!rows.length) { body.innerHTML = emptyStateCell(7, {title: "No vendors yet", body: "Add a vendor for anyone you pay — contractors, suppliers, landlords.", cta: {label: "+ New Vendor", onclick: "openVendorEdit(null)"}}); return; }
  body.innerHTML = rows.map((v) => `<tr>
    <td><strong>${_escapeHtml(v.display_name)}</strong></td>
    <td>${_escapeHtml(v.company_name || "—")}</td>
    <td>${_escapeHtml(v.email || "—")}</td>
    <td>${_escapeHtml(v.phone || "—")}</td>
    <td style="text-align:center;">${v.is_1099 ? '<span class="badge badge-neutral">1099</span>' : ""}</td>
    <td style="text-align:right;font-variant-numeric:tabular-nums;${(v.balance || 0) > 0 ? "color:var(--color-warning);" : ""}">${formatCurrency(v.balance || 0)}</td>
    <td style="text-align:right;white-space:nowrap;">
      <button class="btn btn-sm btn-ghost" onclick="openVendorTransactions('${v.id}','${v.display_name.replace(/'/g, "\\'")}')" title="View transactions for this vendor">Transactions</button>
      <button class="btn btn-sm btn-ghost" onclick='rowActionsMenu(event, [{label:"Edit", onClick:"openVendorEdit(\u0027${v.id}\u0027)"}, null, {label:"Archive", onClick:"vendorDelete(\u0027${v.id}\u0027,\u0027${v.display_name.replace(/'/g, "\\'")}\u0027)", danger:true}])' title="More">⋯</button>
    </td>
  </tr>`).join("");
}

async function openVendorTransactions(vendorId, vendorName) {
  const modal = document.getElementById("txn-detail-modal");
  const loading = document.getElementById("txn-detail-loading");
  const table = document.getElementById("txn-detail-table");
  const _ttl3 = `Transactions — ${vendorName}`;
  document.getElementById("txn-detail-title").textContent = _ttl3;
  document.getElementById("txn-detail-title").title = _ttl3;
  document.getElementById("txn-detail-badge").textContent = `Vendor: ${vendorName}`;
  document.getElementById("txn-detail-date-range").textContent = "";
  loading.classList.remove("hidden");
  table.innerHTML = "";
  modal.classList.add("active");
  try {
    let raw;
    if (_shouldUseRailway()) {
      const r = await apiGet(`/api/transactions/${selectedCompanyId}?vendor_id=${encodeURIComponent(vendorId)}&limit=500&sort=date.desc`);
      raw = r.transactions || [];
    } else {
      // Manual+Plaid companies: transactions.vendor_id is populated in
      // Supabase. Mirror Railway's response shape so the mapping below
      // works unchanged.
      const sel = "id,date,amount,description,merchant_name,notes,category:categories(name)";
      const url = `${SUPABASE_URL}/rest/v1/transactions?company_id=eq.${selectedCompanyId}&vendor_id=eq.${encodeURIComponent(vendorId)}&order=date.desc&limit=500&select=${encodeURIComponent(sel)}`;
      const resp = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` } });
      if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      raw = await resp.json();
    }
    const rows = raw.map((t) => {
      const amt = parseFloat(t.amount) || 0;
      return {
        id: t.id,
        Date: t.date || "",
        "Transaction Type": "Plaid",
        Num: "",
        Name: t.merchant_name || vendorName,
        "Memo/Description": t.description || t.notes || "",
        Account: t.category?.name || "",
        Debit:  amt > 0 ? amt.toFixed(2) : "",
        Credit: amt < 0 ? (-amt).toFixed(2) : "",
        Amount: amt.toFixed(2),
        editable: true,
      };
    });
    currentTxnDetail = { account_name: vendorName, transactions: rows,
                        vendor_id: vendorId, vendor_name: vendorName };
    loading.classList.add("hidden");
    renderTransactionDetail(currentTxnDetail);
  } catch (e) {
    loading.innerHTML = `<p style="color:var(--color-error);padding:var(--space-4);">Error loading transactions: ${e.message}</p>`;
  }
}

async function openVendorEdit(id) {
  if (!_contactsState.coa.length) await _contactsLoadCoa();
  _contactsState.kind = "vendor";
  const existing = id ? _contactsState.rows.find((x) => x.id === id) : null;
  _contactsState.editing = id || null;
  document.getElementById("contact-edit-title").textContent = id ? "Edit Vendor" : "New Vendor";
  document.getElementById("contact-vendor-only").style.display = "block";
  _fillContactForm(existing);
  document.getElementById("contact-edit-error").style.display = "none";
  document.getElementById("contact-edit-modal").classList.add("active");
  document.getElementById("contact-edit-modal").style.display = "flex";
}

async function vendorDelete(id, label) {
  if (!confirm(`Archive vendor "${label}"?`)) return;
  try {
    const __useRailway = _shouldUseRailway();
    if (!__useRailway) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/vendors?id=eq.${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` },
        body: JSON.stringify({ is_active: false }),
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } else {
      await apiDelete(`/api/vendors/${id}`);
    }
    await vendorsReload();
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}


// =====================================================================
//  INVOICES + BILLS (doc editor shared)
// =====================================================================

let _docState = {
  kind: "invoice",   // 'invoice' | 'bill'
  editing: null,
  lines: [],
  parties: [],       // customers or vendors
  coa: [],
  rows: [],          // list page rows
};
let _invoicesState = { rows: [] };
let _billsState = { rows: [] };
// docId -> { tx_id, tx_date, tx_amount, tx_desc } for the bank txn that
// settled this bill/invoice (via payments + payment_applications).
let _docMatchedTxMap = {};

const _INVOICE_STATUSES = [
  ["draft","Draft"],["sent","Sent"],["partially_paid","Partially Paid"],
  ["paid","Paid"],["overdue","Overdue"],["void","Void"],
];
const _BILL_STATUSES = [
  ["open","Open"],["partially_paid","Partially Paid"],["paid","Paid"],
  ["overdue","Overdue"],["void","Void"],
];

function _statusBadge(status) {
  // Alias for the newer unified helper — kept for backward compat.
  return statusBadge(status);
}

async function _docLoadParties(kind) {
  const url = kind === "invoice" ? `/api/customers/${selectedCompanyId}` : `/api/vendors/${selectedCompanyId}`;
  try {
    const r = await apiGet(url);
    _docState.parties = kind === "invoice" ? (r.customers || []) : (r.vendors || []);
  } catch (e) { _docState.parties = []; }
}

async function invoicesInit() {
  const body = document.getElementById("invoices-body");
  if (!selectedCompanyId) { body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--color-text-muted);">Pick a company.</td></tr>'; return; }
  const company = _getSelectedCompany();
  if (!company || company.source !== "manual") { body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--color-text-muted);">Invoices are only available for manual companies.</td></tr>'; return; }
  document.getElementById("invoices-page-title").textContent = `Invoices — ${company.name}`;
  await invoicesReload();
}

async function invoicesReload() {
  if (!selectedCompanyId) return;
  const status = document.getElementById("invoices-filter-status").value;
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  try {
    const r = await apiGet(`/api/invoices/${selectedCompanyId}${qs}`);
    _invoicesState.rows = r.invoices || [];
    if (!_invoicesState.rows.length && supabaseAccessToken) {
      const filters = status ? [{ k: "status", v: `eq.${status}` }] : [];
      const rows = await _supaFetch("invoices", {
        select: "id,number,date,due_date,status,total,balance,customer:customers(display_name)",
        order: "date.desc",
        filters,
      });
      if (rows) _invoicesState.rows = rows;
    }
    await _loadDocMatchedTxs("invoice", _invoicesState.rows);
    _renderDocList("invoice");
  } catch (e) {
    document.getElementById("invoices-body").innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--color-error);">${_escapeHtml(e.message)}</td></tr>`;
  }
}

async function billsInit() {
  const body = document.getElementById("bills-body");
  if (!selectedCompanyId) { body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--color-text-muted);">Pick a company.</td></tr>'; return; }
  const company = _getSelectedCompany();
  if (!company || company.source !== "manual") { body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--color-text-muted);">Bills are only available for manual companies.</td></tr>'; return; }
  document.getElementById("bills-page-title").textContent = `Bills — ${company.name}`;
  await billsReload();
}

// ---------- New Loan Bill (upload statement → extract → prefill bill) ----------

function openNewLoanBillModal() {
  if (!selectedCompanyId) { showToast("Pick a company first.", "info"); return; }
  const company = _getSelectedCompany();
  if (!company || company.source !== "manual") { showToast("Loan bills are only available for manual companies.", "info"); return; }
  const modal = document.getElementById("loan-stmt-upload-modal");
  const status = document.getElementById("loan-stmt-status");
  status.style.display = "none";
  status.textContent = "";
  modal.classList.add("active");
  modal.style.display = "flex";
  _bindLoanStmtDropzone();
}

function closeLoanStmtUploadModal() {
  const modal = document.getElementById("loan-stmt-upload-modal");
  modal.classList.remove("active");
  modal.style.display = "none";
  const input = document.getElementById("loan-stmt-file-input");
  if (input) input.value = "";
}

let _loanStmtBound = false;
function _bindLoanStmtDropzone() {
  if (_loanStmtBound) return;
  _loanStmtBound = true;
  const zone = document.getElementById("loan-stmt-dropzone");
  const input = document.getElementById("loan-stmt-file-input");
  if (!zone || !input) return;
  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loanStmtHandleFile(f);
  });
  ["dragenter", "dragover"].forEach((ev) => {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.style.borderColor = "var(--color-accent)"; zone.style.background = "var(--color-bg-muted)"; });
  });
  ["dragleave", "drop"].forEach((ev) => {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.style.borderColor = "var(--color-border)"; zone.style.background = ""; });
  });
  zone.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loanStmtHandleFile(f);
  });
}

function _loanStmtStatus(msg, kind) {
  const el = document.getElementById("loan-stmt-status");
  if (!el) return;
  const colors = {
    info: "background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe;",
    ok:   "background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;",
    err:  "background:#fef2f2;color:#991b1b;border:1px solid #fecaca;",
  };
  el.style.display = "block";
  el.style.cssText += colors[kind || "info"];
  el.textContent = msg;
}

async function loanStmtHandleFile(file) {
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) { _loanStmtStatus("File too large (max 15 MB).", "err"); return; }
  _loanStmtStatus(`Extracting ${file.name}…`, "info");
  try {
    const fd = new FormData();
    fd.append("file", file);
    const path = `/api/bills/extract-loan-statement?company_id=${encodeURIComponent(selectedCompanyId)}`;
    const resp = await finFetch(path, {
      method: "POST",
      body: fd,
    });
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${detail.slice(0, 200)}`);
    }
    const payload = await resp.json();
    if (!payload || !payload.extracted) throw new Error("Empty extraction response");
    _loanStmtStatus("Extracted. Opening bill…", "ok");
    await prefillBillFromLoanStatement(payload);
    closeLoanStmtUploadModal();
  } catch (e) {
    _loanStmtStatus(`Failed: ${e.message}`, "err");
  }
}

async function prefillBillFromLoanStatement(payload) {
  // Force-refresh CoA + vendors before opening the modal. _openDocEdit's
  // cache check ("if (!_contactsState.coa.length)") would otherwise serve
  // stale data from a different company, leaving the line-item account
  // dropdowns empty for this company.
  _contactsState.coa = [];
  _docState.parties = [];

  // Open the existing Bill edit modal in "create" mode, then overwrite fields
  // with the extracted values and rebuild the lines array.
  await _openDocEdit("bill", null);

  // Railway's /api/coa and /api/vendors return empty for some manual+plaid
  // companies whose data lives only in Supabase (the loan-statement flow's
  // backing store). Fall back to Supabase directly via the JWT bridge so the
  // dropdowns actually populate.
  if (supabaseAccessToken && selectedCompanyId) {
    if (!_contactsState.coa.length) {
      try {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/chart_of_accounts?company_id=eq.${selectedCompanyId}&is_active=eq.true&select=id,code,name,type,is_active&order=code`,
          { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` } },
        );
        if (r.ok) {
          _contactsState.coa = await r.json();
          _docState.coa = _contactsState.coa;
        }
      } catch { /* keep Railway fallback (empty) */ }
    }
    if (!_docState.parties.length) {
      try {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/vendors?company_id=eq.${selectedCompanyId}&is_active=eq.true&select=id,display_name,company_name,terms_days,default_account_id&order=display_name`,
          { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` } },
        );
        if (r.ok) {
          _docState.parties = await r.json();
          _docRenderPartyOptions();
        }
      } catch { /* keep Railway fallback (empty) */ }
    }
  }

  const ex = payload.extracted || {};
  const vendor = payload.vendor || null;     // { id, display_name } | null
  const mapping = payload.mapping || null;   // saved CoA picks per vendor | null

  // Fields
  if (ex.loan_account_number) {
    // Append billing month so monthly statements from the same lender don't
    // collide with the bills(company_id, vendor_id, number) unique key.
    const ym = (ex.billing_date || "").slice(0, 7); // "YYYY-MM"
    document.getElementById("doc-number").value =
      ym ? `${ex.loan_account_number}-${ym}` : ex.loan_account_number;
  }
  if (ex.billing_date)        document.getElementById("doc-date").value = ex.billing_date;
  if (ex.due_date)            document.getElementById("doc-due-date").value = ex.due_date;
  const memoBits = [];
  if (ex.lender)   memoBits.push(`Loan payment — ${ex.lender}`);
  if (ex.property) memoBits.push(ex.property);
  if (memoBits.length) document.getElementById("doc-memo").value = memoBits.join(" · ");

  // Vendor pick — prefer matched id, otherwise leave blank and surface lender name
  if (vendor && vendor.id) {
    const partySel = document.getElementById("doc-party");
    partySel.value = vendor.id;
  } else if (ex.lender) {
    showToast(`Vendor "${ex.lender}" not found — pick or create one.`, "info");
  }

  // Build lines: one per non-zero amount field
  const lineDefs = [
    ["principal",   "Principal",   mapping?.principal_coa_id   || ""],
    ["interest",    "Interest",    mapping?.interest_coa_id    || ""],
    ["escrow",      "Escrow",      mapping?.escrow_coa_id      || ""],
    ["late_charge", "Late Charge", mapping?.late_charge_coa_id || ""],
    ["fees_other",  "Fees / Other",mapping?.fees_coa_id        || ""],
  ];
  const lines = [];
  for (const [key, label, coa] of lineDefs) {
    const amt = parseFloat(ex[key]) || 0;
    if (amt > 0) {
      lines.push({
        description: label,
        quantity: 1,
        unit_price: amt,
        tax_rate: 0,
        coa_account_id: coa,
      });
    }
  }
  if (!lines.length) {
    // Statement had no positive line components — fall back to a single Total line
    lines.push({
      description: "Loan payment",
      quantity: 1,
      unit_price: parseFloat(ex.total) || 0,
      tax_rate: 0,
      coa_account_id: "",
    });
  }
  _docState.lines = lines;
  _docState.isLoanBill = true;
  _docState.loanExtraction = ex;
  _docState.loanMappingSaved = mapping;
  _renderDocLines();

  // Sum check
  const sumLines = lines.reduce((acc, l) => acc + (l.unit_price || 0), 0);
  const stmtTotal = parseFloat(ex.total) || 0;
  if (stmtTotal > 0 && Math.abs(sumLines - stmtTotal) > 0.01) {
    _loanStmtShowMismatch(sumLines, stmtTotal);
  } else {
    _loanStmtClearMismatch();
  }
}

function _loanStmtShowMismatch(sumLines, stmtTotal) {
  const errEl = document.getElementById("doc-edit-error");
  if (!errEl) return;
  errEl.style.cssText = "display:block;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:var(--radius-md);padding:8px 12px;font-size:var(--text-sm);margin-bottom:8px;";
  errEl.textContent = `Heads up — extracted lines total ${sumLines.toFixed(2)} but statement shows ${stmtTotal.toFixed(2)}. Please verify before saving.`;
}

function _loanStmtClearMismatch() {
  const errEl = document.getElementById("doc-edit-error");
  if (!errEl) return;
  errEl.style.cssText = "display:none;";
  errEl.textContent = "";
}

async function billsReload() {
  if (!selectedCompanyId) return;
  const status = document.getElementById("bills-filter-status").value;
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  try {
    const r = await apiGet(`/api/bills/${selectedCompanyId}${qs}`);
    _billsState.rows = r.bills || [];
    if (!_billsState.rows.length && supabaseAccessToken) {
      const filters = status ? [{ k: "status", v: `eq.${status}` }] : [];
      const rows = await _supaFetch("bills", {
        select: "id,number,date,due_date,status,total,balance,vendor:vendors(display_name)",
        order: "date.desc",
        filters,
      });
      if (rows) _billsState.rows = rows;
    }
    await _loadDocMatchedTxs("bill", _billsState.rows);
    _renderDocList("bill");
  } catch (e) {
    document.getElementById("bills-body").innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--color-error);">${_escapeHtml(e.message)}</td></tr>`;
  }
}

function _renderDocList(kind) {
  const body = document.getElementById(kind === "invoice" ? "invoices-body" : "bills-body");
  let rows = kind === "invoice" ? _invoicesState.rows : _billsState.rows;
  // Vendor / customer name filter (client-side, scoped to loaded rows)
  const filterEl = document.getElementById(kind === "invoice" ? "invoices-filter-customer" : "bills-filter-vendor");
  const q = (filterEl?.value || "").trim().toLowerCase();
  if (q) {
    rows = rows.filter((d) => {
      const party = kind === "invoice" ? d.customer : d.vendor;
      const name = (party?.display_name || "").toLowerCase();
      const num = (d.number || "").toLowerCase();
      return name.includes(q) || num.includes(q);
    });
  }
  if (!rows.length) { body.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--color-text-muted);">${q ? "No matches." : "No " + kind + "s yet."}</td></tr>`; return; }
  const partyLabel = (d) => (kind === "invoice" ? d.customer : d.vendor)?.display_name || "—";
  body.innerHTML = rows.map((d) => {
    const matched = _docMatchedTxMap[d.id];
    const matchedLine = matched
      ? `<div style="font-size:var(--text-xs);color:var(--color-success);margin-top:2px;">✓ ${kind === "invoice" ? "Received" : "Paid"} ${formatDate(matched.tx_date)} · ${formatCurrency(matched.tx_amount)}${matched.tx_desc ? ` — ${_escapeHtml(matched.tx_desc.slice(0, 40))}` : ""}</div>`
      : "";
    return `<tr>
      <td><strong>${_escapeHtml(d.number || "—")}</strong>${matchedLine}</td>
      <td>${formatDate(d.date)}</td>
      <td>${d.due_date ? formatDate(d.due_date) : "—"}</td>
      <td>${_escapeHtml(partyLabel(d))}</td>
      <td>${_statusBadge(d.status)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">${formatCurrency(d.total)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;${parseFloat(d.balance || 0) > 0 ? "color:var(--color-warning);" : ""}">${formatCurrency(d.balance)}</td>
      <td style="text-align:right;">
        <button class="btn btn-sm btn-secondary" onclick="openDocDetail('${kind}','${d.id}')">View</button>
        ${d.status !== "paid" && d.status !== "void" ? `<button class="btn btn-sm btn-ghost" onclick="${kind === "invoice" ? "openInvoiceEdit" : "openBillEdit"}('${d.id}')">Edit</button>` : ""}
      </td>
    </tr>`;
  }).join("");
}

// Resolve the bank transaction (date / amount / description) that settled
// each loaded bill or invoice, via payment_applications -> payments. Lets the
// list inline "✓ Paid Apr 6 · $9,664.52 — Transfer To 6398" under each row.
async function _loadDocMatchedTxs(kind, docs) {
  _docMatchedTxMap = {};
  if (!supabaseAccessToken || !selectedCompanyId || !docs || !docs.length) return;
  const docIds = docs.map((d) => d.id);
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  const fkCol = kind === "invoice" ? "invoice_id" : "bill_id";
  try {
    const appRes = await fetch(
      `${SUPABASE_URL}/rest/v1/payment_applications?${fkCol}=in.(${docIds.join(",")})&select=${fkCol},payment_id`,
      { headers }
    );
    const apps = appRes.ok ? await appRes.json() : [];
    if (!apps.length) return;
    const payIds = [...new Set(apps.map((a) => a.payment_id))];
    const payRes = await fetch(
      `${SUPABASE_URL}/rest/v1/payments?id=in.(${payIds.join(",")})&select=id,matched_transaction_id`,
      { headers }
    );
    const pays = payRes.ok ? await payRes.json() : [];
    const txIds = pays.map((p) => p.matched_transaction_id).filter(Boolean);
    if (!txIds.length) return;
    const txRes = await fetch(
      `${SUPABASE_URL}/rest/v1/transactions?id=in.(${txIds.join(",")})&select=id,date,amount,merchant_name,description`,
      { headers }
    );
    const txs = txRes.ok ? await txRes.json() : [];
    const txById = new Map(txs.map((t) => [t.id, t]));
    const payToTx = new Map(pays.map((p) => [p.id, p.matched_transaction_id]));
    for (const a of apps) {
      const docId = a[fkCol];
      const txId = payToTx.get(a.payment_id);
      const tx = txId ? txById.get(txId) : null;
      if (!tx) continue;
      // First match wins — partial-payment cases stay rare for now.
      if (_docMatchedTxMap[docId]) continue;
      _docMatchedTxMap[docId] = {
        tx_id: tx.id,
        tx_date: tx.date,
        tx_amount: Math.abs(parseFloat(tx.amount) || 0),
        tx_desc: tx.merchant_name || tx.description || "",
      };
    }
  } catch (e) {
    console.warn("[supa] doc-matched-tx fetch failed", e);
  }
}

async function openInvoiceEdit(id) { await _openDocEdit("invoice", id); }
async function openBillEdit(id) { await _openDocEdit("bill", id); }

async function _openDocEdit(kind, id) {
  _docState.kind = kind;
  _docState.editing = id;
  _docState.isLoanBill = false;
  _docState.loanExtraction = null;
  _docState.loanMappingSaved = null;
  if (!_contactsState.coa.length) await _contactsLoadCoa();
  _docState.coa = _contactsState.coa;
  await _docLoadParties(kind);

  document.getElementById("doc-edit-title").textContent = (id ? "Edit " : "New ") + (kind === "invoice" ? "Invoice" : "Bill");
  document.getElementById("doc-edit-party-label").textContent = kind === "invoice" ? "Customer" : "Vendor";
  _docRenderPartyOptions();

  // Status options
  const statuses = kind === "invoice" ? _INVOICE_STATUSES : _BILL_STATUSES;
  const statusSel = document.getElementById("doc-status");
  statusSel.innerHTML = statuses.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");

  // Load for edit
  let doc = null, lines = [];
  if (id) {
    const endpoint = kind === "invoice" ? `/api/invoices/detail/${id}` : `/api/bills/detail/${id}`;
    try {
      const r = await apiGet(endpoint);
      doc = kind === "invoice" ? r.invoice : r.bill;
      lines = r.lines || [];
    } catch (e) { showToast("Load failed: " + e.message, "error"); return; }
  }

  const today = new Date().toISOString().slice(0, 10);
  document.getElementById("doc-number").value = doc?.number || _suggestDocNumber(kind);
  document.getElementById("doc-date").value = doc?.date || today;
  document.getElementById("doc-due-date").value = doc?.due_date || "";
  document.getElementById("doc-memo").value = doc?.memo || "";
  document.getElementById("doc-status").value = doc?.status || (kind === "invoice" ? "draft" : "open");
  document.getElementById("doc-party").value = doc?.customer_id || doc?.vendor_id || "";

  _docState.lines = lines.length ? lines.map((l) => ({ ...l })) : [{ description: "", quantity: 1, unit_price: 0, tax_rate: 0, coa_account_id: "" }];

  // Set due date from party terms if creating new
  if (!id) docPartyChanged();

  _renderDocLines();
  document.getElementById("doc-edit-error").style.display = "none";
  document.getElementById("doc-edit-modal").classList.add("active");
  document.getElementById("doc-edit-modal").style.display = "flex";
}

function _suggestDocNumber(kind) {
  const prefix = kind === "invoice" ? "INV-" : "BILL-";
  const rows = kind === "invoice" ? _invoicesState.rows : _billsState.rows;
  const nums = rows.map((r) => {
    const m = (r.number || "").match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return prefix + String(next).padStart(4, "0");
}

function _docRenderPartyOptions(selectedId) {
  const partySel = document.getElementById("doc-party");
  const kind = _docState.kind;
  const label = kind === "invoice" ? "Customer" : "Vendor";
  partySel.innerHTML = '<option value="">— select —</option>'
    + _docState.parties.map((p) => `<option value="${p.id}">${_escapeHtml(p.display_name)}</option>`).join("")
    + `<option value="__new__" style="font-weight:600;">+ New ${label}…</option>`;
  if (selectedId) partySel.value = selectedId;
}

async function docPartyChanged() {
  const sel = document.getElementById("doc-party");
  if (sel.value === "__new__") {
    // Open the contact editor; on save, refresh dropdown and auto-select.
    const kind = _docState.kind;
    sel.value = "";  // clear the sentinel immediately
    _docState.pendingPartyRefresh = true;
    if (kind === "invoice") {
      openCustomerEdit(null);
    } else {
      openVendorEdit(null);
    }
    return;
  }
  const party = _docState.parties.find((p) => p.id === sel.value);
  if (party && party.terms_days) {
    const date = document.getElementById("doc-date").value || new Date().toISOString().slice(0, 10);
    const due = new Date(date + "T00:00:00");
    due.setDate(due.getDate() + party.terms_days);
    document.getElementById("doc-due-date").value = due.toISOString().slice(0, 10);
  }
  // Default account
  if (party?.default_account_id) {
    for (const l of _docState.lines) { if (!l.coa_account_id) l.coa_account_id = party.default_account_id; }
    _renderDocLines();
  }
  // Copy-from-last-bill prefill: when CREATING a new bill/invoice for a vendor
  // who already has prior docs, fill the line items from the most recent one
  // (descriptions + COAs + tax rates only — amounts left blank). Skip if:
  //   - editing an existing doc
  //   - loan-statement upload already populated lines
  //   - user already manually entered any line content
  //   - no party selected
  if (party && !_docState.editing && !_docState.loanExtraction && supabaseAccessToken) {
    const linesAreEmpty = !_docState.lines.length || _docState.lines.every(
      (l) => !l.description && !l.coa_account_id && !parseFloat(l.unit_price || 0)
    );
    if (linesAreEmpty) {
      try { await _docPrefillFromLastDoc(party.id); }
      catch (e) { console.warn("[doc] copy-from-last failed", e); }
    }
  }
}

// Pull the most recent bill (or invoice) for a vendor/customer, then fill
// _docState.lines from its line items with unit_price zeroed. Best-effort —
// silently does nothing if the request fails or there's no prior doc.
async function _docPrefillFromLastDoc(partyId) {
  if (!partyId || !selectedCompanyId || !supabaseAccessToken) return;
  const isInvoice = _docState.kind === "invoice";
  const headerTable = isInvoice ? "invoices" : "bills";
  const linesTable = isInvoice ? "invoice_lines" : "bill_lines";
  const partyField = isInvoice ? "customer_id" : "vendor_id";
  const fkField = isInvoice ? "invoice_id" : "bill_id";
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  const url = `${SUPABASE_URL}/rest/v1/${headerTable}?company_id=eq.${selectedCompanyId}&${partyField}=eq.${partyId}&order=date.desc&limit=1&select=id,${linesTable}(line_no,description,quantity,unit_price,tax_rate,coa_account_id)`;
  const r = await fetch(url, { headers });
  if (!r.ok) return;
  const rows = await r.json();
  const last = rows && rows[0];
  const priorLines = last && last[linesTable] || [];
  if (!priorLines.length) return;
  // Sort by line_no for stability and prefill amounts blank.
  priorLines.sort((a, b) => (a.line_no || 0) - (b.line_no || 0));
  _docState.lines = priorLines.map((l) => ({
    description: l.description || "",
    quantity: parseFloat(l.quantity) || 1,
    unit_price: 0,
    tax_rate: parseFloat(l.tax_rate) || 0,
    coa_account_id: l.coa_account_id || "",
  }));
  _renderDocLines();
  // Subtle, non-blocking hint that lines came from a previous doc.
  if (typeof showToast === "function") {
    showToast(`Lines copied from last ${_docState.kind} — fill in amounts.`, "info");
  }
}

function _renderDocLines() {
  const body = document.getElementById("doc-lines-body");
  const coa = _docState.coa.filter((a) => a.is_active);
  // For invoices, prefer income accounts; for bills, expense — but show all for flexibility
  const sortedCoa = [...coa].sort((a, b) => {
    const rank = { income: 1, expense: 2, asset: 3, liability: 4, equity: 5 };
    return (rank[a.type] || 9) - (rank[b.type] || 9) || a.code.localeCompare(b.code);
  });
  body.innerHTML = _docState.lines.map((l, i) => {
    const amt = (parseFloat(l.quantity) || 0) * (parseFloat(l.unit_price) || 0);
    const currentLabel = l.coa_account_id ? _coaLabelById(l.coa_account_id) : (l._coa_typed || "");
    return `<tr>
      <td><input class="form-input form-input-sm" type="text" value="${_escapeHtml(l.description || "")}" oninput="_docLine(${i},'description',this.value)"></td>
      <td>
        <input class="form-input form-input-sm doc-coa-input" type="text"
               id="doc-coa-input-${i}"
               placeholder="Click to pick or type to search…"
               value="${_escapeHtml(currentLabel)}"
               autocomplete="off"
               onfocus="_coaPopoverOpen(${i})"
               oninput="_coaPopoverFilter(${i}, this.value)"
               onkeydown="_coaPopoverKey(event, ${i})"
               onblur="setTimeout(() => _coaPopoverClose(${i}), 150)"
               style="width:100%;">
      </td>
      <td><input class="form-input form-input-sm" type="number" step="0.01" value="${l.quantity || 1}" oninput="_docLine(${i},'quantity',this.value)" style="text-align:right;"></td>
      <td><input class="form-input form-input-sm" type="number" step="0.01" value="${l.unit_price || 0}" oninput="_docLine(${i},'unit_price',this.value)" style="text-align:right;"></td>
      <td><input class="form-input form-input-sm" type="number" step="0.001" value="${((l.tax_rate || 0) * 100).toFixed(2)}" oninput="_docLine(${i},'tax_rate_pct',this.value)" style="text-align:right;"></td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">${amt.toFixed(2)}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="_docRemoveLine(${i})" type="button">×</button></td>
    </tr>`;
  }).join("");
  _updateDocTotals();
}

// --- Inline CoA combobox (click-to-open, type-to-filter, +Create at bottom) ---
// Popover is body-level so it isn't clipped by the table wrapper's overflow.

function _ensureCoaPopover() {
  let pop = document.getElementById("doc-coa-popover");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "doc-coa-popover";
    pop.style.cssText = "display:none;position:absolute;z-index:10000;background:var(--color-surface,#fff);border:1px solid var(--color-border,#ddd);border-radius:6px;max-height:280px;overflow-y:auto;box-shadow:0 6px 24px rgba(0,0,0,0.15);";
    document.body.appendChild(pop);
  }
  return pop;
}

function _coaPopoverOpen(i) {
  const input = document.getElementById(`doc-coa-input-${i}`);
  if (!input) return;
  const pop = _ensureCoaPopover();
  pop.dataset.activeIdx = String(i);
  const r = input.getBoundingClientRect();
  pop.style.top = `${r.bottom + window.scrollY + 2}px`;
  pop.style.left = `${r.left + window.scrollX}px`;
  pop.style.width = `${r.width}px`;
  _coaPopoverFilter(i, input.value || "");
  pop.style.display = "block";
}

function _coaPopoverClose(i) {
  const pop = document.getElementById("doc-coa-popover");
  if (!pop) return;
  // Only close if we're still on this input (so a quick mousedown→pick→blur
  // sequence doesn't race with a re-open from another row).
  if (pop.dataset.activeIdx === String(i)) pop.style.display = "none";
}

function _coaPopoverFilter(i, raw) {
  const q = (raw || "").toLowerCase().trim();
  const pop = _ensureCoaPopover();
  pop.dataset.activeIdx = String(i);
  const all = (_docState.coa || []).filter((a) => a.is_active);
  const rank = { income: 1, expense: 2, asset: 3, liability: 4, equity: 5 };
  const filtered = all.filter((a) => {
    if (!q) return true;
    return (a.code || "").toLowerCase().includes(q)
      || (a.name || "").toLowerCase().includes(q)
      || (a.type || "").toLowerCase().includes(q);
  }).sort((a, b) => (rank[a.type] || 9) - (rank[b.type] || 9) || (a.code || "").localeCompare(b.code || ""));

  // Track currently-typed text so + Create knows what name to use
  _docState.lines[i]._coa_typed = raw || "";
  // Also keep coa_account_id consistent with the input — only set if exact match
  const exact = all.find((a) => _coaLabel(a) === raw);
  _docState.lines[i].coa_account_id = exact ? exact.id : "";

  let html = filtered.slice(0, 30).map((a) => `
    <div class="doc-coa-row" onmousedown="_coaPopoverPick(${i}, '${a.id}')"
         style="padding:6px 10px;cursor:pointer;font-size:var(--text-sm);"
         onmouseenter="this.style.background='var(--color-bg-muted,#f3f4f6)'"
         onmouseleave="this.style.background=''">
      <strong>${_escapeHtml(a.code)}</strong> ${_escapeHtml(a.name)}
      <span style="color:var(--color-text-muted,#888);font-size:12px;">(${a.type})</span>
    </div>`).join("");

  if (!filtered.length) {
    html += `<div style="padding:6px 10px;color:var(--color-text-muted,#888);font-size:var(--text-sm);">No matches.</div>`;
  }
  // + Create new — always offered when something is typed
  if (q && !exact) {
    html += `
      <div onmousedown="_coaPopoverCreate(${i})"
           style="padding:8px 10px;cursor:pointer;border-top:1px solid var(--color-border,#ddd);
                  font-size:var(--text-sm);color:var(--color-accent,#1a56db);font-weight:500;"
           onmouseenter="this.style.background='var(--color-bg-muted,#f3f4f6)'"
           onmouseleave="this.style.background=''">
        + Create new account: "${_escapeHtml(raw)}"
      </div>`;
  }
  pop.innerHTML = html;
}

function _coaPopoverPick(i, id) {
  const a = (_docState.coa || []).find((x) => x.id === id);
  if (!a) return;
  _docState.lines[i].coa_account_id = a.id;
  _docState.lines[i]._coa_typed = "";
  const input = document.getElementById(`doc-coa-input-${i}`);
  if (input) input.value = _coaLabel(a);
  _coaPopoverClose(i);
  _updateDocTotals();
}

function _coaPopoverKey(e, i) {
  if (e.key === "Enter") {
    e.preventDefault();
    // Pick first match if any
    const input = document.getElementById(`doc-coa-input-${i}`);
    const q = (input?.value || "").toLowerCase().trim();
    if (!q) return;
    const all = (_docState.coa || []).filter((a) => a.is_active);
    const match = all.find((a) =>
      (a.code || "").toLowerCase().includes(q) ||
      (a.name || "").toLowerCase().includes(q),
    );
    if (match) _coaPopoverPick(i, match.id);
  } else if (e.key === "Escape") {
    _coaPopoverClose(i);
  }
}

async function _coaPopoverCreate(i) {
  const typed = (_docState.lines[i]._coa_typed || "").trim();
  if (!typed) { _coaPopoverClose(i); return; }
  // Quick prompts only for type + code (we already have name = typed text)
  const type = (prompt(`Type for "${typed}" — asset / liability / equity / income / expense:`, "expense") || "").toLowerCase().trim();
  if (!["asset","liability","equity","income","expense"].includes(type)) {
    showToast("Invalid type — account not created.", "error"); return;
  }
  const baseCode = { asset: 1000, liability: 2000, equity: 3000, income: 4000, expense: 6000 }[type];
  const used = (_docState.coa || []).filter((a) => a.type === type).map((a) => parseInt(a.code, 10) || 0);
  const suggested = String(Math.max(baseCode - 10, ...used) + 10);
  const code = prompt("Account code:", suggested);
  if (!code) return;

  try {
    let acc;
    if (supabaseAccessToken) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/chart_of_accounts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Prefer: "return=representation",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${supabaseAccessToken}`,
        },
        body: JSON.stringify({ company_id: selectedCompanyId, code, name: typed, type, is_active: true }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const rows = await r.json();
      acc = Array.isArray(rows) ? rows[0] : rows;
    } else {
      acc = await apiPost(`/api/coa/${selectedCompanyId}`, { code, name: typed, type });
    }
    _docState.coa = [..._docState.coa, acc];
    _contactsState.coa = _docState.coa;
    _docState.lines[i].coa_account_id = acc.id;
    _docState.lines[i]._coa_typed = "";
    _renderDocLines();
    showToast(`Created ${acc.code} — ${acc.name}`, "success");
  } catch (e) {
    showToast("Failed to create: " + (e.message || "unknown"), "error");
  }
}

function _coaLabel(a) {
  return `${a.code} — ${a.name} (${a.type})`;
}

function _coaLabelById(id) {
  const a = (_docState.coa || []).find((x) => x.id === id);
  return a ? _coaLabel(a) : "";
}

function _docCoaInput(i, raw) {
  const val = (raw || "").trim();
  const a = (_docState.coa || []).find((x) => _coaLabel(x) === val);
  if (a) {
    _docState.lines[i].coa_account_id = a.id;
    _docState.lines[i]._coa_typed = "";
  } else if (val === "") {
    _docState.lines[i].coa_account_id = "";
    _docState.lines[i]._coa_typed = "";
  } else {
    _docState.lines[i].coa_account_id = "";
    _docState.lines[i]._coa_typed = val;
  }
  _updateDocTotals();
}

async function _docNewCoaFromLine(i) {
  const typed = (_docState.lines[i]._coa_typed || "").trim();
  const name = typed || prompt("New account name?");
  if (!name) return;
  const type = (prompt("Type — asset / liability / equity / income / expense:", "expense") || "").toLowerCase().trim();
  if (!["asset","liability","equity","income","expense"].includes(type)) {
    showToast("Invalid type. Aborted.", "error"); return;
  }
  // Suggest a code based on existing codes for that type
  const existing = (_docState.coa || []).filter((a) => a.type === type).map((a) => parseInt(a.code, 10) || 0);
  const baseCode = { asset: 1000, liability: 2000, equity: 3000, income: 4000, expense: 6000 }[type];
  const suggested = String(Math.max(baseCode, ...existing) + 10);
  const code = prompt("Code:", suggested);
  if (!code) return;

  // Try Supabase first (manual+plaid companies); fall back to Railway.
  try {
    if (supabaseAccessToken) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/chart_of_accounts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Prefer": "return=representation",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${supabaseAccessToken}`,
        },
        body: JSON.stringify({ company_id: selectedCompanyId, code, name, type, is_active: true }),
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const rows = await r.json();
      const acc = Array.isArray(rows) ? rows[0] : rows;
      _docState.coa = [..._docState.coa, acc];
      _contactsState.coa = _docState.coa;
      _docState.lines[i].coa_account_id = acc.id;
      _docState.lines[i]._coa_typed = "";
      _renderDocLines();
      showToast(`Created ${acc.code} — ${acc.name}`, "success");
    } else {
      const created = await apiPost(`/api/coa/${selectedCompanyId}`, { code, name, type });
      _docState.coa = [..._docState.coa, created];
      _contactsState.coa = _docState.coa;
      _docState.lines[i].coa_account_id = created.id;
      _docState.lines[i]._coa_typed = "";
      _renderDocLines();
      showToast(`Created ${created.code} — ${created.name}`, "success");
    }
  } catch (e) {
    showToast("Failed to create account: " + (e.message || "unknown"), "error");
  }
}

function _docLine(i, field, value) {
  if (field === "tax_rate_pct") {
    _docState.lines[i].tax_rate = (parseFloat(value) || 0) / 100;
  } else if (field === "quantity" || field === "unit_price") {
    _docState.lines[i][field] = parseFloat(value) || 0;
  } else {
    _docState.lines[i][field] = value;
  }
  _updateDocTotals();
}

function _docRemoveLine(i) {
  if (_docState.lines.length <= 1) { showToast("At least one line required.", "info"); return; }
  _docState.lines.splice(i, 1);
  _renderDocLines();
}

function docAddLine() {
  _docState.lines.push({ description: "", quantity: 1, unit_price: 0, tax_rate: 0, coa_account_id: "" });
  _renderDocLines();
}

function _updateDocTotals() {
  let subtotal = 0, tax = 0;
  for (const l of _docState.lines) {
    const amt = (parseFloat(l.quantity) || 0) * (parseFloat(l.unit_price) || 0);
    subtotal += amt;
    tax += amt * (parseFloat(l.tax_rate) || 0);
  }
  const total = subtotal + tax;
  document.getElementById("doc-totals").innerHTML = `
    Subtotal: <strong>${subtotal.toFixed(2)}</strong>
    &nbsp;·&nbsp; Tax: <strong>${tax.toFixed(2)}</strong>
    &nbsp;·&nbsp; <strong style="font-size:var(--text-md);">Total: ${total.toFixed(2)}</strong>`;
}

function closeDocEdit() {
  document.getElementById("doc-edit-modal").classList.remove("active");
  document.getElementById("doc-edit-modal").style.display = "none";
}

async function docSave() {
  const errEl = document.getElementById("doc-edit-error");
  errEl.style.display = "none";
  const kind = _docState.kind;
  const party_id = document.getElementById("doc-party").value;
  if (!party_id) { errEl.textContent = `${kind === "invoice" ? "Customer" : "Vendor"} required.`; errEl.style.display = "block"; return; }
  const number = document.getElementById("doc-number").value.trim();
  const date = document.getElementById("doc-date").value;
  if (!date) { errEl.textContent = "Date required."; errEl.style.display = "block"; return; }
  if (kind === "invoice" && !number) { errEl.textContent = "Invoice number required."; errEl.style.display = "block"; return; }
  if (!_docState.lines.length) { errEl.textContent = "At least one line required."; errEl.style.display = "block"; return; }
  if (_docState.lines.some((l) => !l.coa_account_id)) { errEl.textContent = "Every line needs a category."; errEl.style.display = "block"; return; }

  const body = {
    number,
    date,
    due_date: document.getElementById("doc-due-date").value || null,
    status: document.getElementById("doc-status").value,
    memo: document.getElementById("doc-memo").value.trim() || null,
    lines: _docState.lines.map((l) => ({
      description: l.description || null,
      quantity: parseFloat(l.quantity) || 0,
      unit_price: parseFloat(l.unit_price) || 0,
      tax_rate: parseFloat(l.tax_rate) || 0,
      coa_account_id: l.coa_account_id,
    })),
  };
  if (kind === "invoice") body.customer_id = party_id; else body.vendor_id = party_id;

  try {
    const base = kind === "invoice" ? "/api/invoices" : "/api/bills";
    if (_docState.editing) {
      // Manual+Plaid bills/invoices live in Supabase only — Railway PATCH
      // 404s for them. Try Supabase first when we have a session; fall back
      // to Railway for QBO companies.
      let updated = false;
      if (supabaseAccessToken && selectedCompanyId) {
        const co = (allCompanies || []).find((c) => c.id === selectedCompanyId);
        if (co && (co.source || "qbo") !== "qbo") {
          await _docUpdateViaSupabase(kind, _docState.editing, body);
          updated = true;
        }
      }
      if (!updated) {
        await apiPatch(`${base}/${_docState.editing}`, body);
      }
    } else {
      // Railway's POST /api/{bills,invoices}/<id> hits a {bills,invoices}_company_id_fkey
      // violation for manual+Plaid companies whose data lives in Supabase.
      // Always prefer Supabase direct for both; if there's no session,
      // prompt for the password (the parallel sign-in at login can fail
      // silently when Railway and Supabase passwords drift).
      let saved = false;
      if ((kind === "bill" || kind === "invoice") && selectedCompanyId) {
        if (!supabaseAccessToken && currentUser?.email) {
          const pw = window.prompt(
            `To save ${kind}s, we need a Supabase session.\nRe-enter the password for ${currentUser.email}:`,
          );
          if (pw) {
            const ok = await _supabaseSignIn(currentUser.email, pw);
            if (!ok) throw new Error("Supabase sign-in failed — password may differ from Railway. Ask Rachel to reset your Supabase password.");
          } else {
            throw new Error(`${kind === "invoice" ? "Invoice" : "Bill"} save requires Supabase session — password prompt cancelled.`);
          }
        }
        if (supabaseAccessToken) {
          await _docCreateViaSupabase(kind, selectedCompanyId, body);
          saved = true;
        }
      }
      if (!saved) {
        await apiPost(`${base}/${selectedCompanyId}`, body);
      }
    }
    if (kind === "bill" && _docState.isLoanBill) {
      _maybeSaveLoanCoaMapping(party_id).catch((err) => console.warn("loan CoA mapping save failed:", err));
    }
    _docState.isLoanBill = false;
    _docState.loanExtraction = null;
    _docState.loanMappingSaved = null;
    closeDocEdit();
    if (kind === "invoice") await invoicesReload(); else await billsReload();
  } catch (e) {
    const last = window.__lastApiError;
    let detail = e.message || "unknown";
    if (last && last.raw) {
      detail += " — server response: " + last.raw.slice(0, 800);
    }
    errEl.textContent = "Failed: " + detail;
    errEl.style.display = "block";
    errEl.style.whiteSpace = "pre-wrap";
    errEl.style.maxHeight = "200px";
    errEl.style.overflow = "auto";
    console.error("docSave failed", { error: e, lastApiError: last, reqBody: body });
  }
}

// Insert a bill/invoice + its lines directly into Supabase. Used when
// Railway's POST /api/{bills,invoices}/<id> is broken for the company
// (manual+Plaid companies whose company_id Railway doesn't map correctly
// to the Supabase row).
async function _docCreateViaSupabase(kind, companyId, body) {
  const isInvoice = kind === "invoice";
  const headerTable = isInvoice ? "invoices" : "bills";
  const linesTable = isInvoice ? "invoice_lines" : "bill_lines";
  const fkField = isInvoice ? "invoice_id" : "bill_id";
  const partyField = isInvoice ? "customer_id" : "vendor_id";
  const partyId = isInvoice ? body.customer_id : body.vendor_id;
  const defaultStatus = isInvoice ? "draft" : "open";

  const supaHeaders = {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${supabaseAccessToken}`,
  };

  const lines = (body.lines || []).map((l, i) => {
    const qty = parseFloat(l.quantity) || 0;
    const price = parseFloat(l.unit_price) || 0;
    const tax_rate = parseFloat(l.tax_rate) || 0;
    const amount = qty * price;
    const tax_amount = amount * tax_rate;
    return {
      line_no: i + 1,
      description: l.description || null,
      quantity: qty,
      unit_price: price,
      amount,
      tax_rate,
      tax_amount,
      coa_account_id: l.coa_account_id || null,
    };
  });
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const tax_total = lines.reduce((s, l) => s + l.tax_amount, 0);
  const total = subtotal + tax_total;
  const status = body.status || defaultStatus;
  const paidStatuses = isInvoice ? ["paid"] : ["paid"];
  const balance = paidStatuses.includes(status) ? 0 : total;

  const headerPayload = {
    company_id: companyId,
    [partyField]: partyId,
    number: body.number || (isInvoice ? "" : null),
    date: body.date,
    due_date: body.due_date || null,
    status,
    memo: body.memo || null,
    subtotal, tax_total, total, balance,
    currency: "USD",
  };

  const headerRes = await fetch(`${SUPABASE_URL}/rest/v1/${headerTable}`, {
    method: "POST",
    headers: { ...supaHeaders, Prefer: "return=representation" },
    body: JSON.stringify(headerPayload),
  });
  if (!headerRes.ok) {
    throw new Error(`Supabase ${headerTable} ${headerRes.status}: ${(await headerRes.text()).slice(0, 300)}`);
  }
  const rows = await headerRes.json();
  const header = Array.isArray(rows) ? rows[0] : rows;

  if (lines.length) {
    const linesRes = await fetch(`${SUPABASE_URL}/rest/v1/${linesTable}`, {
      method: "POST",
      headers: { ...supaHeaders, Prefer: "return=minimal" },
      body: JSON.stringify(lines.map((l) => ({ ...l, [fkField]: header.id }))),
    });
    if (!linesRes.ok) {
      // Roll back the header so we don't leave an orphan with no lines.
      await fetch(`${SUPABASE_URL}/rest/v1/${headerTable}?id=eq.${header.id}`, {
        method: "DELETE",
        headers: supaHeaders,
      }).catch(() => {});
      throw new Error(`Supabase ${linesTable} ${linesRes.status}: ${(await linesRes.text()).slice(0, 300)}`);
    }
  }

  // GL emit: book the bill/invoice creation. No-op for companies not on
  // the GL. Bills are Dr expense (per line), Cr A/P (total). Invoices flip:
  // Dr A/R (total), Cr revenue (per line).
  try {
    const apOrAr = isInvoice ? "ar" : "ap";
    const clearingCoa = await _glLookupClearingCoa(companyId, apOrAr);
    if (clearingCoa && lines.length) {
      const eventLines = lines
        .filter((l) => l.coa_account_id && Math.abs(parseFloat(l.amount) || 0) > 0.005)
        .map((l) => isInvoice
          ? { coa_account_id: l.coa_account_id, debit: 0, credit: parseFloat(l.amount), description: l.description || null }
          : { coa_account_id: l.coa_account_id, debit: parseFloat(l.amount), credit: 0, description: l.description || null }
        );
      const totalAmount = eventLines.reduce((s, l) => s + (parseFloat(l.debit) || 0) + (parseFloat(l.credit) || 0), 0);
      const clearingLine = isInvoice
        ? { coa_account_id: clearingCoa, debit: totalAmount, credit: 0, description: "A/R" }
        : { coa_account_id: clearingCoa, debit: 0, credit: totalAmount, description: "A/P" };
      const allLines = isInvoice ? [clearingLine, ...eventLines] : [...eventLines, clearingLine];
      await _glEmit(isInvoice ? "invoice" : "bill", header.id, headerPayload.date, allLines, { company_id: companyId });
    }
  } catch (e) {
    console.warn("[GL] bill/invoice emit failed", e);
  }

  return header;
}

// Supabase-side update for an existing bill/invoice. Mirrors
// _docCreateViaSupabase: PATCH the header, replace bill_lines/invoice_lines
// (delete old + insert new) so a line removal/edit doesn't leave orphans,
// and re-emit the auto JE so the GL stays in sync. Used for manual+Plaid
// companies where Railway PATCH 404s.
async function _docUpdateViaSupabase(kind, docId, body) {
  const isInvoice = kind === "invoice";
  const headerTable = isInvoice ? "invoices" : "bills";
  const linesTable = isInvoice ? "invoice_lines" : "bill_lines";
  const fkField = isInvoice ? "invoice_id" : "bill_id";

  const supaHeaders = {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${supabaseAccessToken}`,
  };

  const lines = (body.lines || []).map((l, i) => {
    const qty = parseFloat(l.quantity) || 0;
    const price = parseFloat(l.unit_price) || 0;
    const tax_rate = parseFloat(l.tax_rate) || 0;
    const amount = qty * price;
    const tax_amount = amount * tax_rate;
    return {
      line_no: i + 1,
      description: l.description || null,
      quantity: qty,
      unit_price: price,
      amount,
      tax_rate,
      tax_amount,
      coa_account_id: l.coa_account_id || null,
    };
  });
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const tax_total = lines.reduce((s, l) => s + l.tax_amount, 0);
  const total = subtotal + tax_total;
  const status = body.status || (isInvoice ? "draft" : "open");
  const balance = (status === "paid") ? 0 : total;

  // 1. Patch the header row
  const headerPayload = {
    number: body.number || (isInvoice ? "" : null),
    date: body.date,
    due_date: body.due_date || null,
    status,
    memo: body.memo || null,
    subtotal, tax_total, total, balance,
  };
  if (isInvoice) {
    if (body.customer_id) headerPayload.customer_id = body.customer_id;
  } else {
    if (body.vendor_id) headerPayload.vendor_id = body.vendor_id;
  }
  const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/${headerTable}?id=eq.${docId}`, {
    method: "PATCH",
    headers: { ...supaHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(headerPayload),
  });
  if (!patchRes.ok) throw new Error(`Supabase ${headerTable} ${patchRes.status}: ${(await patchRes.text()).slice(0, 300)}`);

  // 2. Replace lines: delete old, insert new
  await fetch(`${SUPABASE_URL}/rest/v1/${linesTable}?${fkField}=eq.${docId}`, {
    method: "DELETE",
    headers: { ...supaHeaders, Prefer: "return=minimal" },
  }).catch(() => {});
  if (lines.length) {
    const linesRes = await fetch(`${SUPABASE_URL}/rest/v1/${linesTable}`, {
      method: "POST",
      headers: { ...supaHeaders, Prefer: "return=minimal" },
      body: JSON.stringify(lines.map((l) => ({ ...l, [fkField]: docId }))),
    });
    if (!linesRes.ok) throw new Error(`Supabase ${linesTable} ${linesRes.status}: ${(await linesRes.text()).slice(0, 300)}`);
  }

  // 3. Re-emit the auto JE (idempotent — same memo replaces the old JE)
  try {
    const apOrAr = isInvoice ? "ar" : "ap";
    const clearingCoa = await _glLookupClearingCoa(selectedCompanyId, apOrAr);
    if (clearingCoa && lines.length) {
      const eventLines = lines
        .filter((l) => l.coa_account_id && Math.abs(parseFloat(l.amount) || 0) > 0.005)
        .map((l) => isInvoice
          ? { coa_account_id: l.coa_account_id, debit: 0, credit: parseFloat(l.amount), description: l.description || null }
          : { coa_account_id: l.coa_account_id, debit: parseFloat(l.amount), credit: 0, description: l.description || null }
        );
      const eventTotal = eventLines.reduce((s, l) => s + (parseFloat(l.debit) || 0) + (parseFloat(l.credit) || 0), 0);
      const clearingLine = isInvoice
        ? { coa_account_id: clearingCoa, debit: eventTotal, credit: 0, description: "A/R" }
        : { coa_account_id: clearingCoa, debit: 0, credit: eventTotal, description: "A/P" };
      const allLines = isInvoice ? [clearingLine, ...eventLines] : [...eventLines, clearingLine];
      await _glEmit(isInvoice ? "invoice" : "bill", docId, body.date, allLines, { company_id: selectedCompanyId });
    }
  } catch (e) {
    console.warn("[GL] bill/invoice update emit failed", e);
  }

  return { id: docId };
}

// After saving a loan bill, persist the vendor → CoA mapping for next time.
// Fire-and-forget: a failure here doesn't roll back the bill.
async function _maybeSaveLoanCoaMapping(vendorId) {
  if (!vendorId || !selectedCompanyId) return;
  const lineByDesc = (desc) => _docState.lines.find((l) => l.description === desc);
  const next = {
    company_id: selectedCompanyId,
    vendor_id: vendorId,
    principal_coa_id:   lineByDesc("Principal")?.coa_account_id    || null,
    interest_coa_id:    lineByDesc("Interest")?.coa_account_id     || null,
    escrow_coa_id:      lineByDesc("Escrow")?.coa_account_id       || null,
    late_charge_coa_id: lineByDesc("Late Charge")?.coa_account_id  || null,
    fees_coa_id:        lineByDesc("Fees / Other")?.coa_account_id || null,
  };
  // Skip the upsert if nothing changed vs. what the backend returned earlier.
  const prev = _docState.loanMappingSaved;
  if (prev) {
    const same =
      prev.principal_coa_id   === next.principal_coa_id   &&
      prev.interest_coa_id    === next.interest_coa_id    &&
      prev.escrow_coa_id      === next.escrow_coa_id      &&
      prev.late_charge_coa_id === next.late_charge_coa_id &&
      prev.fees_coa_id        === next.fees_coa_id;
    if (same) return;
  }
  // Use Next.js Financials app (Supabase-backed) rather than Railway for this
  // table, since vendor_loan_coa_mapping lives in Supabase.
  const resp = await finFetch("/api/vendor-loan-coa-mapping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${detail.slice(0, 200)}`);
  }
}


// ---------- Detail modal ----------

let _docDetailState = { kind: null, id: null, data: null };

async function openDocDetail(kind, id) {
  _docDetailState = { kind, id, data: null };
  const endpoint = kind === "invoice" ? `/api/invoices/detail/${id}` : `/api/bills/detail/${id}`;
  try {
    const r = _shouldUseRailway()
      ? await apiGet(endpoint)
      : await _supaDocDetail(kind, id);
    _docDetailState.data = r;
    _renderDocDetail();
    document.getElementById("doc-detail-modal").classList.add("active");
    document.getElementById("doc-detail-modal").style.display = "flex";
  } catch (e) { showToast("Load failed: " + e.message, "error"); }
}

// Supabase-side equivalent of Railway's /api/{bills,invoices}/detail/{id}.
// Returns { bill|invoice, vendor|customer, lines, payments } so
// _renderDocDetail works unchanged. Lines are joined to chart_of_accounts
// for the line "Account" column label.
async function _supaDocDetail(kind, id) {
  if (!supabaseAccessToken) throw new Error("Supabase session required.");
  const isInvoice = kind === "invoice";
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  const base = `${SUPABASE_URL}/rest/v1`;
  const headerTable = isInvoice ? "invoices" : "bills";
  const linesTable = isInvoice ? "invoice_lines" : "bill_lines";
  const fkField = isInvoice ? "invoice_id" : "bill_id";
  const partyTable = isInvoice ? "customers" : "vendors";
  const partyKey = isInvoice ? "customer_id" : "vendor_id";

  // Header includes the party embed so we can split it out for renderer.
  const headerSel = `*,party:${partyTable}(*)`;
  const docs = await fetch(`${base}/${headerTable}?id=eq.${id}&select=${encodeURIComponent(headerSel)}`, { headers })
    .then((r) => r.ok ? r.json() : []);
  if (!docs.length) throw new Error(`${kind} not found`);
  const doc = docs[0];
  const party = doc.party || null;
  delete doc.party;

  const linesSel = "id,description,quantity,unit_price,tax_rate,amount,account:chart_of_accounts(id,code,name)";
  const lines = await fetch(`${base}/${linesTable}?${fkField}=eq.${id}&order=id&select=${encodeURIComponent(linesSel)}`, { headers })
    .then((r) => r.ok ? r.json() : []);
  const linesShaped = lines.map((l) => ({
    id: l.id,
    description: l.description,
    quantity: l.quantity,
    unit_price: l.unit_price,
    tax_rate: l.tax_rate,
    amount: l.amount,
    account_name: l.account ? `${l.account.code ? l.account.code + " " : ""}${l.account.name}` : "",
  }));

  // Payments table is shared across kinds; filter by FK to either bill or invoice.
  const payments = await fetch(`${base}/payments?${fkField}=eq.${id}&order=date.desc&select=*`, { headers })
    .then((r) => r.ok ? r.json() : []);

  return {
    [headerTable.slice(0, -1)]: doc,            // "bill" or "invoice"
    [partyTable.slice(0, -1)]: party,            // "vendor" or "customer"
    lines: linesShaped,
    payments,
  };
}

function closeDocDetail() {
  document.getElementById("doc-detail-modal").classList.remove("active");
  document.getElementById("doc-detail-modal").style.display = "none";
}

function _renderDocDetail() {
  const { kind, data } = _docDetailState;
  const doc = kind === "invoice" ? data.invoice : data.bill;
  const party = kind === "invoice" ? data.customer : data.vendor;
  const lines = data.lines || [];
  const payments = data.payments || [];
  document.getElementById("doc-detail-title").textContent = `${kind === "invoice" ? "Invoice" : "Bill"} ${doc.number || ""}`;

  const canPay = doc.status !== "paid" && doc.status !== "void" && parseFloat(doc.balance || 0) > 0.005;

  const linesHtml = lines.map((l) => `<tr>
    <td>${_escapeHtml(l.account_name || "—")}</td>
    <td>${_escapeHtml(l.description || "—")}</td>
    <td style="text-align:right;">${parseFloat(l.quantity || 0).toFixed(2)}</td>
    <td style="text-align:right;">${parseFloat(l.unit_price || 0).toFixed(2)}</td>
    <td style="text-align:right;">${((parseFloat(l.tax_rate || 0)) * 100).toFixed(2)}%</td>
    <td style="text-align:right;font-variant-numeric:tabular-nums;">${formatCurrency(l.amount)}</td>
  </tr>`).join("");

  const paymentsHtml = payments.length
    ? `<table class="data-table" style="width:100%;font-size:var(--text-sm);margin-top:12px;">
         <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th style="text-align:right;">Amount</th><th></th></tr></thead>
         <tbody>${payments.map((p) => `<tr>
           <td>${formatDate(p.date)}</td>
           <td>${_escapeHtml(p.payment_method || "—")}</td>
           <td>${_escapeHtml(p.reference || "—")}</td>
           <td style="text-align:right;">${formatCurrency(p.amount)}</td>
           <td><button class="btn btn-sm btn-ghost" style="color:var(--color-error);" onclick="_docDetailDeletePayment('${p.id}')">×</button></td>
         </tr>`).join("")}</tbody>
       </table>`
    : '<div style="font-size:var(--text-sm);color:var(--color-text-muted);margin-top:8px;">No payments recorded yet.</div>';

  document.getElementById("doc-detail-body").innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;font-size:var(--text-sm);">
      <div>
        <strong>${_escapeHtml(party?.display_name || "—")}</strong>
        ${party?.company_name ? `<div>${_escapeHtml(party.company_name)}</div>` : ""}
        ${party?.email ? `<div style="color:var(--color-text-secondary);">${_escapeHtml(party.email)}</div>` : ""}
      </div>
      <div style="text-align:right;">
        ${_statusBadge(doc.status)}
        <div style="margin-top:4px;">Date: ${formatDate(doc.date)}${doc.due_date ? " · Due: " + formatDate(doc.due_date) : ""}</div>
      </div>
    </div>
    <table class="data-table" style="width:100%;font-size:var(--text-sm);">
      <thead><tr><th>Account</th><th>Description</th><th style="text-align:right;">Qty</th><th style="text-align:right;">Unit</th><th style="text-align:right;">Tax</th><th style="text-align:right;">Amount</th></tr></thead>
      <tbody>${linesHtml}</tbody>
    </table>
    <div style="text-align:right;margin-top:8px;font-size:var(--text-sm);">
      Subtotal: <strong>${formatCurrency(doc.subtotal)}</strong>
      &nbsp;·&nbsp; Tax: <strong>${formatCurrency(doc.tax_total)}</strong>
      &nbsp;·&nbsp; <strong style="font-size:var(--text-md);">Total: ${formatCurrency(doc.total)}</strong>
    </div>
    <div style="text-align:right;font-size:var(--text-md);margin-top:4px;${parseFloat(doc.balance || 0) > 0.005 ? "color:var(--color-warning);" : ""}">
      Balance: <strong>${formatCurrency(doc.balance)}</strong>
    </div>
    ${doc.memo ? `<div style="margin-top:8px;padding:8px;background:var(--color-bg-muted);border-radius:6px;font-size:var(--text-sm);"><strong>Memo:</strong> ${_escapeHtml(doc.memo)}</div>` : ""}
    <h4 style="margin:16px 0 4px;font-size:var(--text-sm);">Payments</h4>
    ${paymentsHtml}
    <div style="display:flex;gap:8px;margin-top:16px;">
      ${canPay ? `<button class="btn btn-primary btn-sm" onclick="openPaymentModal()" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
        Record Payment</button>` : ""}
      <button class="btn btn-secondary btn-sm" onclick="docPrint()" type="button" title="Print or Save as PDF">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        Print / PDF
      </button>
      ${kind === "invoice" ? `<button class="btn btn-secondary btn-sm" onclick="openEmailInvoice()" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
        Email
      </button>` : ""}
      <button class="btn btn-ghost btn-sm" onclick="closeDocDetail()" type="button">Close</button>
    </div>`;
}

async function _docDetailDeletePayment(paymentId) {
  if (!confirm("Void this payment? The invoice/bill balance will be restored.")) return;
  try {
    await apiDelete(`/api/payments/${paymentId}`);
    // Refresh detail view
    await openDocDetail(_docDetailState.kind, _docDetailState.id);
    // Also refresh list
    if (_docDetailState.kind === "invoice") await invoicesReload(); else await billsReload();
  } catch (e) { showToast("Failed: " + e.message, "error"); }
}


// ---------- Payment modal ----------

async function openPaymentModal() {
  const { kind, data } = _docDetailState;
  const doc = kind === "invoice" ? data.invoice : data.bill;
  const balance = parseFloat(doc.balance || 0);
  // Load bank accounts from current _txState
  let bankAccounts = _txState.accounts || [];
  if (!bankAccounts.length) {
    try {
      const r = await apiGet(`/api/plaid/accounts/${selectedCompanyId}`);
      bankAccounts = r.accounts || [];
    } catch (e) {}
  }
  document.getElementById("payment-context").innerHTML = `
    <strong>${kind === "invoice" ? "Invoice" : "Bill"} ${doc.number || ""}</strong> — Balance due: <strong>${balance.toFixed(2)}</strong>
  `;
  document.getElementById("payment-date").value = new Date().toISOString().slice(0, 10);
  document.getElementById("payment-amount").value = balance.toFixed(2);
  document.getElementById("payment-method").value = "";
  document.getElementById("payment-reference").value = "";
  document.getElementById("payment-memo").value = "";
  const bankSel = document.getElementById("payment-bank-account");
  bankSel.innerHTML = '<option value="">— optional —</option>' +
    bankAccounts.filter((a) => a.plaid_item_id).map((a) => `<option value="${a.id}">${_escapeHtml(a.name)}${a.mask ? " ···" + a.mask : ""}</option>`).join("");
  document.getElementById("payment-error").style.display = "none";
  document.getElementById("payment-modal").classList.add("active");
  document.getElementById("payment-modal").style.display = "flex";
}

function closePaymentModal() {
  document.getElementById("payment-modal").classList.remove("active");
  document.getElementById("payment-modal").style.display = "none";
}

async function paymentSave() {
  const { kind, data } = _docDetailState;
  const doc = kind === "invoice" ? data.invoice : data.bill;
  const errEl = document.getElementById("payment-error");
  errEl.style.display = "none";
  const date = document.getElementById("payment-date").value;
  const amount = parseFloat(document.getElementById("payment-amount").value || "0");
  if (!date || !amount || amount <= 0) { errEl.textContent = "Date and positive amount required."; errEl.style.display = "block"; return; }
  if (amount - parseFloat(doc.balance || 0) > 0.005) {
    if (!confirm(`Amount ${amount.toFixed(2)} exceeds balance ${parseFloat(doc.balance).toFixed(2)}. Record anyway?`)) return;
  }

  const body = {
    date,
    amount,
    kind: kind === "invoice" ? "invoice_payment" : "bill_payment",
    bank_account_id: document.getElementById("payment-bank-account").value || null,
    payment_method: document.getElementById("payment-method").value || null,
    reference: document.getElementById("payment-reference").value.trim() || null,
    memo: document.getElementById("payment-memo").value.trim() || null,
    applications: [{
      [kind === "invoice" ? "invoice_id" : "bill_id"]: doc.id,
      amount,
    }],
  };

  try {
    await apiPost(`/api/payments/${selectedCompanyId}`, body);
    closePaymentModal();
    // Refresh detail + list
    await openDocDetail(kind, doc.id);
    if (kind === "invoice") await invoicesReload(); else await billsReload();
  } catch (e) {
    errEl.textContent = "Failed: " + (e.message || "unknown");
    errEl.style.display = "block";
  }
}


// =====================================================================
//  AR / AP AGING
// =====================================================================

async function arAgingInit() { return _agingInit("ar"); }
async function apAgingInit() { return _agingInit("ap"); }
async function arAgingReload() { return _agingLoad("ar"); }
async function apAgingReload() { return _agingLoad("ap"); }

async function _agingInit(kind) {
  const body = document.getElementById(`${kind}-aging-body`);
  if (!selectedCompanyId) { body.innerHTML = '<div style="text-align:center;padding:24px;color:var(--color-text-muted);">Pick a company.</div>'; return; }
  const company = _getSelectedCompany();
  // Page works for manual/Plaid companies (Supabase) and unknown source
  // when we have a Supabase session (e.g. Railway company list failed to
  // load but we still have access).
  if (company && company.source === "qbo") { body.innerHTML = '<div style="text-align:center;padding:24px;color:var(--color-text-muted);">Aging report is for non-QBO companies. QBO companies use the QuickBooks aging report.</div>'; return; }
  document.getElementById(`${kind}-aging-page-title`).textContent = `${kind.toUpperCase()} Aging — ${company?.name || ""}`.trim();
  const asOf = document.getElementById(`${kind}-aging-as-of`);
  if (!asOf.value) asOf.value = new Date().toISOString().slice(0, 10);
  await _agingLoad(kind);
}

async function _agingLoad(kind) {
  const body = document.getElementById(`${kind}-aging-body`);
  body.innerHTML = '<div style="text-align:center;padding:24px;color:var(--color-text-muted);">Loading...</div>';
  const asOf = document.getElementById(`${kind}-aging-as-of`).value || new Date().toISOString().slice(0, 10);
  try {
    let r;
    if (!_shouldUseRailway()) {
      r = await _supaAgingReport(kind, asOf);
    } else {
      r = await apiGet(`/api/reports/${kind}-aging/${selectedCompanyId}?as_of=${asOf}`);
    }
    _agingRender(kind, r);
  } catch (e) {
    body.innerHTML = `<div style="text-align:center;padding:24px;color:var(--color-error);">${_escapeHtml(e.message)}</div>`;
  }
}

// AR/AP aging report from Supabase. Buckets open bills/invoices by days
// overdue (current, 1-30, 31-60, 61-90, 90+) and groups by party.
async function _supaAgingReport(kind, asOf) {
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` };
  const isAR = kind === "ar";
  const url = isAR
    ? `${SUPABASE_URL}/rest/v1/invoices?company_id=eq.${selectedCompanyId}&status=in.(sent,partially_paid,overdue)&select=id,number,date,due_date,total,balance,party:customers(id,display_name)`
    : `${SUPABASE_URL}/rest/v1/bills?company_id=eq.${selectedCompanyId}&status=in.(open,partially_paid,overdue)&select=id,number,date,due_date,total,balance,party:vendors(id,display_name)`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`Supabase ${resp.status}`);
  const docs = await resp.json();

  const asOfMs = new Date(asOf + "T00:00:00Z").getTime();
  const dayMs = 86400000;
  const partiesMap = new Map();
  for (const d of docs) {
    const ref = d.due_date || d.date;
    const refMs = new Date(ref + "T00:00:00Z").getTime();
    const daysOverdue = Math.floor((asOfMs - refMs) / dayMs);
    const balance = parseFloat(d.balance ?? d.total ?? 0);
    if (Math.abs(balance) < 0.005) continue;
    const partyName = d.party?.display_name || "(unknown)";
    const partyId = d.party?.id || "_unknown";
    let p = partiesMap.get(partyId);
    if (!p) {
      p = { party_id: partyId, party_name: partyName, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0, docs: [] };
      partiesMap.set(partyId, p);
    }
    p.docs.push({ date: d.date, due_date: d.due_date, number: d.number, days_overdue: Math.max(0, daysOverdue), total: parseFloat(d.total || 0), balance });
    if (daysOverdue <= 0) p.current += balance;
    else if (daysOverdue <= 30) p.d1_30 += balance;
    else if (daysOverdue <= 60) p.d31_60 += balance;
    else if (daysOverdue <= 90) p.d61_90 += balance;
    else p.d90_plus += balance;
    p.total += balance;
  }
  const parties = Array.from(partiesMap.values()).sort((a, b) => b.total - a.total);
  const totals = parties.reduce((s, p) => ({
    current: s.current + p.current,
    d1_30: s.d1_30 + p.d1_30,
    d31_60: s.d31_60 + p.d31_60,
    d61_90: s.d61_90 + p.d61_90,
    d90_plus: s.d90_plus + p.d90_plus,
    total: s.total + p.total,
  }), { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 });
  return { as_of: asOf, parties, totals };
}

function _agingRender(kind, r) {
  const body = document.getElementById(`${kind}-aging-body`);
  const parties = r.parties || [];
  const t = r.totals || {};
  const label = kind === "ar" ? "Customer" : "Vendor";
  if (!parties.length) {
    body.innerHTML = `<div style="text-align:center;padding:24px;color:var(--color-text-muted);">No open ${kind === "ar" ? "invoices" : "bills"} as of ${r.as_of}. 🎉</div>`;
    return;
  }
  const fmt = (v) => v ? formatCurrency(v) : "—";
  body.innerHTML = `
    <table class="data-table" style="width:100%;font-size:var(--text-sm);">
      <thead><tr>
        <th style="text-align:left;">${label}</th>
        <th style="text-align:right;">Current</th>
        <th style="text-align:right;">1–30</th>
        <th style="text-align:right;">31–60</th>
        <th style="text-align:right;">61–90</th>
        <th style="text-align:right;">90+</th>
        <th style="text-align:right;">Total</th>
      </tr></thead>
      <tbody>
        ${parties.map((p) => `<tr>
          <td><strong>${_escapeHtml(p.party_name)}</strong></td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;">${fmt(p.current)}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;">${fmt(p.d1_30)}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;">${fmt(p.d31_60)}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;">${fmt(p.d61_90)}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;${p.d90_plus > 0 ? "color:var(--color-error);" : ""}">${fmt(p.d90_plus)}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">${fmt(p.total)}</td>
        </tr>`).join("")}
        <tr style="border-top:2px solid var(--color-border);">
          <td><strong>TOTAL</strong></td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;"><strong>${fmt(t.current)}</strong></td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;"><strong>${fmt(t.d1_30)}</strong></td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;"><strong>${fmt(t.d31_60)}</strong></td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;"><strong>${fmt(t.d61_90)}</strong></td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;${t.d90_plus > 0 ? "color:var(--color-error);" : ""}"><strong>${fmt(t.d90_plus)}</strong></td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;font-size:var(--text-md);"><strong>${fmt(t.total)}</strong></td>
        </tr>
      </tbody>
    </table>
    <details style="margin-top:12px;">
      <summary style="cursor:pointer;font-size:var(--text-sm);color:var(--color-text-secondary);">Show documents by age</summary>
      <div style="margin-top:8px;">
        ${parties.map((p) => `<div style="margin-top:10px;">
          <div style="font-weight:600;font-size:var(--text-sm);">${_escapeHtml(p.party_name)}</div>
          <table class="data-table" style="width:100%;font-size:var(--text-xs);margin-top:4px;">
            <thead><tr><th>Date</th><th>Due</th><th>#</th><th style="text-align:center;">Age</th><th style="text-align:right;">Total</th><th style="text-align:right;">Balance</th></tr></thead>
            <tbody>${(p.docs || []).map((d) => `<tr>
              <td>${d.date}</td>
              <td>${d.due_date || "—"}</td>
              <td>${_escapeHtml(d.number || "—")}</td>
              <td style="text-align:center;${d.days_overdue > 0 ? "color:var(--color-warning);" : ""}">${d.days_overdue > 0 ? d.days_overdue + "d" : "current"}</td>
              <td style="text-align:right;">${fmt(d.total)}</td>
              <td style="text-align:right;">${fmt(d.balance)}</td>
            </tr>`).join("")}</tbody>
          </table>
        </div>`).join("")}
      </div>
    </details>
    <div style="margin-top:8px;font-size:var(--text-xs);color:var(--color-text-muted);">As of ${r.as_of}</div>`;
}

function arAgingExportCsv() { return _agingExport("ar"); }
function apAgingExportCsv() { return _agingExport("ap"); }

async function _agingExport(kind) {
  const asOf = document.getElementById(`${kind}-aging-as-of`).value || new Date().toISOString().slice(0, 10);
  try {
    const r = !_shouldUseRailway()
      ? await _supaAgingReport(kind, asOf)
      : await apiGet(`/api/reports/${kind}-aging/${selectedCompanyId}?as_of=${asOf}`);
    const header = [kind === "ar" ? "Customer" : "Vendor", "Current", "1-30", "31-60", "61-90", "90+", "Total"];
    const lines = [header.join(",")];
    for (const p of r.parties || []) {
      const row = [p.party_name, p.current, p.d1_30, p.d31_60, p.d61_90, p.d90_plus, p.total]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`);
      lines.push(row.join(","));
    }
    const t = r.totals || {};
    lines.push(["TOTAL", t.current, t.d1_30, t.d31_60, t.d61_90, t.d90_plus, t.total]
      .map((v) => `"${v}"`).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${kind}-aging-${asOf}.csv`; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { showToast("Export failed: " + e.message, "error"); }
}


// =====================================================================
//  TRANSFER DETECTION
// =====================================================================

let _xferPairs = [];

function openTransferDetect() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 90);
  document.getElementById("xfer-date-from").value = from.toISOString().slice(0, 10);
  document.getElementById("xfer-date-to").value = today.toISOString().slice(0, 10);
  document.getElementById("xfer-window").value = "3";
  document.getElementById("xfer-same-co-only").checked = false;
  document.getElementById("xfer-summary").textContent = "";
  document.getElementById("xfer-results").innerHTML = '<div style="text-align:center;padding:24px;color:var(--color-text-muted);">Click <strong>Scan for pairs</strong> to find transfers.</div>';
  document.getElementById("xfer-error").style.display = "none";
  const m = document.getElementById("transfer-detect-modal");
  m.classList.add("active"); m.style.display = "flex";
}
function closeTransferDetect() {
  const m = document.getElementById("transfer-detect-modal");
  m.classList.remove("active"); m.style.display = "none";
}

async function transferScan() {
  const errEl = document.getElementById("xfer-error");
  errEl.style.display = "none";
  const btn = document.getElementById("xfer-scan-btn");
  const results = document.getElementById("xfer-results");
  const summary = document.getElementById("xfer-summary");
  btn.disabled = true; btn.textContent = "Scanning...";
  results.innerHTML = '<div style="text-align:center;padding:24px;color:var(--color-text-muted);">Scanning transactions...</div>';
  const opts = {
    date_from: document.getElementById("xfer-date-from").value,
    date_to: document.getElementById("xfer-date-to").value,
    date_window_days: parseInt(document.getElementById("xfer-window").value || "3", 10),
    same_company_only: document.getElementById("xfer-same-co-only").checked,
  };
  try {
    let r = null;
    let railwayWorked = false;
    try {
      r = await apiPost("/api/transfers/detect", opts);
      railwayWorked = !!(r && (r.pairs || r.scanned != null));
    } catch { /* fall through to Supabase */ }
    if (!railwayWorked && supabaseAccessToken) {
      r = await _supaTransferScan(opts);
    }
    if (!r) throw new Error("No data source available for transfer detection");
    _xferPairs = r.pairs || [];
    summary.textContent = `Scanned ${r.scanned.toLocaleString()} txns (${r.outflows_scanned} outflows · ${r.inflows_scanned} inflows) → ${_xferPairs.length} suggested pair${_xferPairs.length === 1 ? "" : "s"}`;
    _renderTransferResults();
  } catch (e) {
    errEl.textContent = "Scan failed: " + e.message;
    errEl.style.display = "block";
    results.innerHTML = "";
  } finally {
    btn.disabled = false; btn.textContent = "Scan for pairs";
  }
}

// Supabase-side transfer detection. Pairs each outflow (positive amount)
// with a candidate inflow (negative amount, equal abs value, different
// account, within ±date_window_days). Excludes already-categorized,
// already-transferred, or pending transactions.
async function _supaTransferScan(opts) {
  if (!supabaseAccessToken || !selectedCompanyId) return null;
  const sp = new URLSearchParams();
  sp.append("company_id", `eq.${selectedCompanyId}`);
  sp.append("select", "id,date,amount,description,merchant_name,account_id,category_id,is_transfer,transfer_pair_id,pending");
  sp.append("order", "date.asc");
  sp.append("limit", "5000");
  if (opts.date_from) sp.append("date", `gte.${opts.date_from}`);
  if (opts.date_to)   sp.append("date", `lte.${opts.date_to}`);
  // Skip QBO journal imports — those already net to zero internally
  sp.append("plaid_txn_id", "not.like.qbo:*");

  const r = await fetch(`${SUPABASE_URL}/rest/v1/transactions?${sp.toString()}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` },
  });
  if (!r.ok) return null;
  const all = await r.json();

  // Eligible txns: not pending, not already transferred, no category yet
  const eligible = all.filter((t) =>
    !t.pending && !t.is_transfer && !t.transfer_pair_id && !t.category_id,
  );
  const outflows = eligible.filter((t) => parseFloat(t.amount) > 0);
  const inflows  = eligible.filter((t) => parseFloat(t.amount) < 0);

  // For each outflow, find best inflow within window with matching abs amount
  const window = opts.date_window_days || 3;
  const acctById = Object.fromEntries((_txState.accounts || []).map((a) => [a.id, a]));
  const pairs = [];
  const usedInflowIds = new Set();
  const dayDiff = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);

  for (const out of outflows) {
    const outAmt = Math.abs(parseFloat(out.amount));
    let best = null;
    let bestScore = -Infinity;
    for (const inn of inflows) {
      if (usedInflowIds.has(inn.id)) continue;
      if (inn.account_id === out.account_id) continue;          // different accounts only
      const innAmt = Math.abs(parseFloat(inn.amount));
      if (Math.abs(outAmt - innAmt) > 0.01) continue;           // amount must match
      const dd = dayDiff(out.date, inn.date);
      if (dd > window) continue;                                // within window
      // Score: closer dates = higher; same merchant adds bonus
      const merchMatch = out.merchant_name && inn.merchant_name &&
        out.merchant_name.toLowerCase() === inn.merchant_name.toLowerCase();
      const score = (window - dd) * 10 + (merchMatch ? 5 : 0);
      if (score > bestScore) { best = inn; bestScore = score; }
    }
    if (!best) continue;
    usedInflowIds.add(best.id);
    const outAcct = acctById[out.account_id]?.name || "—";
    const inAcct  = acctById[best.account_id]?.name || "—";
    pairs.push({
      outflow: {
        id: out.id, date: out.date, amount: out.amount,
        merchant: out.merchant_name || (out.description ? out.description.slice(0, 60) : ""),
        company_name: outAcct,
      },
      inflow: {
        id: best.id, date: best.date, amount: best.amount,
        merchant: best.merchant_name || (best.description ? best.description.slice(0, 60) : ""),
        company_name: inAcct,
      },
      score: Math.round(bestScore),
      days_diff: dayDiff(out.date, best.date),
      is_intercompany: false,
    });
  }
  return {
    scanned: all.length,
    outflows_scanned: outflows.length,
    inflows_scanned: inflows.length,
    pairs: pairs.sort((a, b) => b.score - a.score),
  };
}

// Supabase-side transfer confirm: link two transactions via a shared
// transfer_pair_id and mark both is_transfer=true. Also clears category.
async function _supaTransferConfirm(outflowId, inflowId) {
  const pairId = crypto.randomUUID();
  const body = { is_transfer: true, transfer_pair_id: pairId, category_id: null };
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/transactions?id=in.(${outflowId},${inflowId})`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=representation",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${supabaseAccessToken}`,
      },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length !== 2) {
    throw new Error(`expected 2 rows updated, got ${rows.length}`);
  }
}

function _renderTransferResults() {
  const results = document.getElementById("xfer-results");
  if (!_xferPairs.length) {
    results.innerHTML = '<div style="text-align:center;padding:24px;color:var(--color-text-muted);">No transfer pairs detected in this window.</div>';
    return;
  }
  results.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <div style="font-size:var(--text-xs);color:var(--color-text-secondary);">
        Each pair: one outflow matched with one inflow of equal amount. Confirming marks both as transfer (drops from P&L).
      </div>
      <button class="btn btn-primary btn-sm" onclick="transferConfirmAll()" type="button">Confirm all (${_xferPairs.length})</button>
    </div>
    <table class="data-table" style="width:100%;font-size:var(--text-sm);">
      <thead><tr>
        <th>Date</th>
        <th style="text-align:right;">Amount</th>
        <th>Out of</th>
        <th>Into</th>
        <th style="text-align:center;">Score</th>
        <th style="text-align:right;">Actions</th>
      </tr></thead>
      <tbody>${_xferPairs.map((p, i) => {
        const amt = Math.abs(parseFloat(p.outflow.amount)).toFixed(2);
        const intercoTag = p.is_intercompany ? ' <span class="badge badge-neutral" style="font-size:var(--text-xxs, 0.625rem);">inter-co</span>' : "";
        const dateLabel = p.days_diff ? `${p.outflow.date} → ${p.inflow.date} (${p.days_diff}d)` : p.outflow.date;
        return `<tr data-pair-idx="${i}">
          <td>${dateLabel}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;"><strong>${amt}</strong></td>
          <td>
            <div><strong>${_escapeHtml(p.outflow.company_name || "")}</strong>${intercoTag}</div>
            <div style="font-size:var(--text-xs);color:var(--color-text-secondary);">${_escapeHtml(p.outflow.merchant || "—")}</div>
          </td>
          <td>
            <div><strong>${_escapeHtml(p.inflow.company_name || "")}</strong></div>
            <div style="font-size:var(--text-xs);color:var(--color-text-secondary);">${_escapeHtml(p.inflow.merchant || "—")}</div>
          </td>
          <td style="text-align:center;font-variant-numeric:tabular-nums;">${p.score}</td>
          <td style="text-align:right;">
            <button class="btn btn-sm btn-primary" onclick="transferConfirmOne(${i})" type="button">Confirm</button>
            <button class="btn btn-sm btn-ghost" onclick="transferSkipOne(${i})" type="button">Skip</button>
          </td>
        </tr>`;
      }).join("")}</tbody>
    </table>`;
}

async function transferConfirmOne(idx) {
  const p = _xferPairs[idx];
  if (!p) return;
  try {
    let railwayWorked = false;
    try {
      await apiPost("/api/transfers/confirm", { outflow_id: p.outflow.id, inflow_id: p.inflow.id });
      railwayWorked = true;
    } catch { /* fall through */ }
    if (!railwayWorked) await _supaTransferConfirm(p.outflow.id, p.inflow.id);
    _xferPairs.splice(idx, 1);
    _renderTransferResults();
    showToast("Transfer confirmed", "success");
    if ((location.hash || "").includes("transactions")) txReload();
  } catch (e) {
    showToast("Failed: " + e.message, "error");
  }
}

function transferSkipOne(idx) {
  _xferPairs.splice(idx, 1);
  _renderTransferResults();
}

async function transferConfirmAll() {
  if (!_xferPairs.length) return;
  if (!confirm(`Confirm all ${_xferPairs.length} suggested transfer pairs?`)) return;
  let ok = 0, fail = 0;
  for (const p of [..._xferPairs]) {
    try {
      let railwayWorked = false;
      try {
        await apiPost("/api/transfers/confirm", { outflow_id: p.outflow.id, inflow_id: p.inflow.id });
        railwayWorked = true;
      } catch { /* fall through */ }
      if (!railwayWorked) await _supaTransferConfirm(p.outflow.id, p.inflow.id);
      ok++;
    } catch (e) { fail++; }
  }
  _xferPairs = [];
  _renderTransferResults();
  document.getElementById("xfer-summary").textContent = `Confirmed ${ok}${fail ? `, ${fail} failed` : ""}`;
  showToast(`Confirmed ${ok} transfers`, "success");
  if ((location.hash || "").includes("transactions")) txReload();
}


// =====================================================================
//  Wire company switcher into existing load flow
// =====================================================================

// Patch loadCompanyList to re-render the switcher after the list refreshes
const _origLoadCompanyList = typeof loadCompanyList === "function" ? loadCompanyList : null;
if (_origLoadCompanyList) {
  window.loadCompanyList = async function(...args) {
    const wasNull = !selectedCompanyId;
    const r = await _origLoadCompanyList.apply(this, args);
    _loadPersistedSelection();
    // If the persisted id no longer exists, reset
    if (selectedCompanyId && !(allCompanies || []).some((c) => c.id === selectedCompanyId)) {
      selectedCompanyId = null;
      _persistSelection();
    }
    renderCompanySwitcher();
    // On initial page load, txInit/coaInit/etc. may have already run with
    // selectedCompanyId === null and rendered "Select a company" empty
    // states. Now that we restored the persisted selection, re-init the
    // active per-company page so it actually renders.
    if (wasNull && selectedCompanyId) {
      const currentPage = (location.hash || "#dashboard").slice(1);
      const perCompanyPages = ["transactions", "coa", "rules", "manual-journal", "bank-accounts"];
      if (perCompanyPages.includes(currentPage)) {
        try { navigateTo(currentPage); } catch (e) { /* non-fatal */ }
      } else if (currentPage === "dashboard" && typeof dashInit === "function") {
        try { dashInit(); } catch (e) { /* non-fatal */ }
      }
    }
    return r;
  };
}
