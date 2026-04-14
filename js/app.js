// ============================================
//  證件到期管理系統 v2 - 分類 + 週期循環 + 密碼保護
// ============================================

const STORAGE_KEY = 'doc_renewal_v2';
const GCAL_CLIENT_ID_KEY = 'gcal_client_id';
const AUTH_KEY = 'doc_renewal_auth'; // 登入狀態 key

// ---- 分類定義 ----
const CATEGORIES = {
  identity: { label: '身份證件',    icon: '🪪', color: '#7aadff' },
  travel:   { label: '旅遊證件',    icon: '✈️', color: '#a78bfa' },
  vehicle:  { label: '車輛相關',    icon: '🚗', color: '#fb923c' },
  insurance:{ label: '保險',        icon: '🛡️', color: '#34d399' },
  medical:  { label: '醫療健康',    icon: '🏥', color: '#f472b6' },
  finance:  { label: '財務證件',    icon: '💳', color: '#fbbf24' },
  property: { label: '物業/租約',   icon: '🏠', color: '#60a5fa' },
  license:  { label: '牌照/執照',   icon: '📜', color: '#c084fc' },
  family:   { label: '家庭/兒童',   icon: '👨‍👩‍👧', color: '#f9a8d4' },
  other:    { label: '其他',        icon: '📁', color: '#94a3b8' },
};

// ---- 週期定義 ----
const RECURRENCE_OPTIONS = [
  { value: 'none',     label: '不重複（單次）' },
  { value: 'yearly',   label: '每年（同一日期）' },
  { value: 'biennial', label: '每兩年' },
  { value: '3years',   label: '每三年' },
  { value: '5years',   label: '每五年' },
  { value: '10years',  label: '每十年' },
  { value: 'custom',   label: '自訂年數' },
];

// ---- State ----
let docs = [];
let editingId = null;
let filterStatus   = 'all';
let filterCategory = 'all';
let searchQuery    = '';
let gapiReady  = false;
let gisReady   = false;
let tokenClient = null;
let isSignedIn  = false;
let viewMode = 'list'; // 'list' | 'group'
let isAuthenticated = false; // 登入狀態

// ---- 密碼設定（可自行修改）----
const APP_PASSWORD = '123456'; // 預設密碼，建議改為更安全的密碼

// ---- Helpers ----
function uuid() {
  return 'doc_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function loadDocs() {
  try { docs = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { docs = []; }
}
function saveDocs() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(docs));
}

// 計算「有效到期日」—— 若有週期，自動推算最近的下次到期日
function effectiveExpiry(doc) {
  if (!doc.expiry) return null;
  if (!doc.recurrence || doc.recurrence === 'none') return doc.expiry;

  const cycleYears = {
    yearly: 1, biennial: 2, '3years': 3,
    '5years': 5, '10years': 10,
    custom: parseInt(doc.recurrenceCustomYears) || 1
  }[doc.recurrence] || 1;

  const today = new Date(); today.setHours(0,0,0,0);
  let d = new Date(doc.expiry); d.setHours(0,0,0,0);

  // 往前推算直到找到未來最近的到期日
  while (d < today) {
    d.setFullYear(d.getFullYear() + cycleYears);
  }
  return d.toISOString().slice(0, 10);
}

// 計算距離天數（用有效到期日）
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const exp   = new Date(dateStr); exp.setHours(0,0,0,0);
  return Math.round((exp - today) / 86400000);
}

function statusOf(days) {
  if (days === null) return 'ok';
  if (days < 0)    return 'expired';
  if (days <= 30)  return 'urgent';
  if (days <= 90)  return 'warning';
  return 'ok';
}

function statusLabel(s) {
  return { expired:'已過期', urgent:'緊急', warning:'注意', ok:'正常' }[s] || '';
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
}

function recurrenceLabel(doc) {
  if (!doc.recurrence || doc.recurrence === 'none') return '';
  const map = {
    yearly:'每年', biennial:'每兩年', '3years':'每三年',
    '5years':'每五年', '10years':'每十年',
    custom: `每${doc.recurrenceCustomYears||1}年`
  };
  return map[doc.recurrence] || '';
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ---- Render ----
function render() {
  renderSummary();
  renderCategoryFilters();
  viewMode === 'group' ? renderGrouped() : renderList();
}

function getFilteredDocs() {
  let filtered = docs.map(d => ({
    ...d,
    _expiry: effectiveExpiry(d)
  }));

  if (filterStatus !== 'all') {
    filtered = filtered.filter(d => statusOf(daysUntil(d._expiry)) === filterStatus);
  }
  if (filterCategory !== 'all') {
    filtered = filtered.filter(d => (d.category || 'other') === filterCategory);
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(d =>
      d.name.toLowerCase().includes(q) ||
      (d.owner||'').toLowerCase().includes(q) ||
      (d.note||'').toLowerCase().includes(q)
    );
  }
  // Sort: expired/urgent first, then by days
  filtered.sort((a, b) => {
    const da = daysUntil(a._expiry) ?? 99999;
    const db = daysUntil(b._expiry) ?? 99999;
    return da - db;
  });
  return filtered;
}

function renderSummary() {
  const withExpiry = docs.map(d => ({ ...d, _expiry: effectiveExpiry(d) }));
  document.getElementById('stat-total').textContent   = docs.length;
  document.getElementById('stat-expired').textContent = withExpiry.filter(d => statusOf(daysUntil(d._expiry)) === 'expired').length;
  document.getElementById('stat-urgent').textContent  = withExpiry.filter(d => statusOf(daysUntil(d._expiry)) === 'urgent').length;
  document.getElementById('stat-ok').textContent      = withExpiry.filter(d => statusOf(daysUntil(d._expiry)) === 'ok').length;
}

function renderCategoryFilters() {
  const wrap = document.getElementById('category-filters');
  const counts = {};
  docs.forEach(d => {
    const cat = d.category || 'other';
    counts[cat] = (counts[cat] || 0) + 1;
  });

  const all = `<button class="cat-btn ${filterCategory==='all'?'active':''}" onclick="setCategoryFilter('all')">
    全部 <span class="cat-count">${docs.length}</span></button>`;

  const cats = Object.entries(CATEGORIES)
    .filter(([k]) => counts[k])
    .map(([k, v]) => `
      <button class="cat-btn ${filterCategory===k?'active':''}" onclick="setCategoryFilter('${k}')"
              style="--cat-color:${v.color}">
        ${v.icon} ${v.label} <span class="cat-count">${counts[k]||0}</span>
      </button>`).join('');

  wrap.innerHTML = all + cats;
}

function docCardHtml(doc) {
  const expiry = doc._expiry;
  const days   = daysUntil(expiry);
  const status = statusOf(days);
  const cat    = CATEGORIES[doc.category] || CATEGORIES.other;
  const recLabel = recurrenceLabel(doc);

  let countdownHtml;
  if (!expiry) {
    countdownHtml = `<div class="countdown-val">—</div><div class="countdown-unit">無期限</div>`;
  } else if (days < 0) {
    countdownHtml = `<div class="countdown-val">${Math.abs(days)}</div><div class="countdown-unit">天前已過期</div>`;
  } else if (days === 0) {
    countdownHtml = `<div class="countdown-val">今天</div><div class="countdown-unit">到期</div>`;
  } else {
    countdownHtml = `<div class="countdown-val">${days}</div><div class="countdown-unit">天後到期</div>`;
  }

  const recBadge = recLabel
    ? `<span class="badge recurrence">🔄 ${escHtml(recLabel)}</span>`
    : '';

  const originalExpiry = (doc.recurrence && doc.recurrence !== 'none' && doc._expiry !== doc.expiry)
    ? `<span style="font-size:11px;color:var(--text-muted)">原始：${formatDate(doc.expiry)}</span>`
    : '';

  return `
    <div class="doc-card ${status}" data-id="${doc.id}">
      <div class="doc-status-dot"></div>
      <div class="doc-cat-icon" style="color:${cat.color}" title="${cat.label}">${cat.icon}</div>
      <div class="doc-main">
        <div class="doc-name">${escHtml(doc.name)}</div>
        <div class="doc-meta">
          ${doc.owner ? `<span class="doc-owner">👤 ${escHtml(doc.owner)}</span>` : ''}
          <span class="doc-date">📅 ${formatDate(expiry)}</span>
          <span class="badge ${status}">${statusLabel(status)}</span>
          ${recBadge}
          ${originalExpiry}
        </div>
        ${doc.note ? `<div class="doc-note">📝 ${escHtml(doc.note)}</div>` : ''}
      </div>
      <div class="doc-countdown">${countdownHtml}</div>
      <div class="doc-actions">
        <button class="btn btn-ghost btn-sm btn-icon" title="同步至 Google Calendar" onclick="syncOneToGCal('${doc.id}')">📆</button>
        <button class="btn btn-ghost btn-sm btn-icon" title="編輯" onclick="openEdit('${doc.id}')">✏️</button>
        <button class="btn btn-danger btn-sm btn-icon" title="刪除" onclick="deleteDoc('${doc.id}')">🗑️</button>
      </div>
    </div>`;
}

function renderList() {
  const container = document.getElementById('doc-list');
  const filtered = getFilteredDocs();
  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🗂️</div>
      <h3>暫無記錄</h3><p>點擊右上角「新增證件」開始管理您的重要文件</p></div>`;
    return;
  }
  container.innerHTML = filtered.map(docCardHtml).join('');
}

function renderGrouped() {
  const container = document.getElementById('doc-list');
  const filtered = getFilteredDocs();

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🗂️</div>
      <h3>暫無記錄</h3><p>點擊右上角「新增證件」開始管理您的重要文件</p></div>`;
    return;
  }

  // Group by category
  const groups = {};
  filtered.forEach(d => {
    const k = d.category || 'other';
    if (!groups[k]) groups[k] = [];
    groups[k].push(d);
  });

  // Render each group in CATEGORIES order
  let html = '';
  Object.entries(CATEGORIES).forEach(([key, cat]) => {
    const items = groups[key];
    if (!items || !items.length) return;
    html += `
      <div class="group-section">
        <div class="group-header">
          <span class="group-icon" style="color:${cat.color}">${cat.icon}</span>
          <span class="group-label">${cat.label}</span>
          <span class="group-count">${items.length}</span>
        </div>
        <div class="group-cards">${items.map(docCardHtml).join('')}</div>
      </div>`;
  });

  container.innerHTML = html;
}

// ---- Category Filter ----
function setCategoryFilter(cat) {
  filterCategory = cat;
  renderCategoryFilters();
  viewMode === 'group' ? renderGrouped() : renderList();
}

// ---- Status Filter ----
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    filterStatus = btn.dataset.filter;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    viewMode === 'group' ? renderGrouped() : renderList();
  });
});

// ---- Search ----
document.getElementById('search-input').addEventListener('input', e => {
  searchQuery = e.target.value.trim();
  viewMode === 'group' ? renderGrouped() : renderList();
});

// ---- View Toggle ----
function setView(mode) {
  viewMode = mode;
  document.getElementById('btn-view-list').classList.toggle('active', mode === 'list');
  document.getElementById('btn-view-group').classList.toggle('active', mode === 'group');
  viewMode === 'group' ? renderGrouped() : renderList();
}

document.getElementById('btn-view-list').addEventListener('click', () => setView('list'));
document.getElementById('btn-view-group').addEventListener('click', () => setView('group'));

// ---- Owner datalist: 從現有記錄中提取不重複人名 ----
function refreshOwnerList() {
  const dl = document.getElementById('owner-list');
  if (!dl) return;
  // 固定預設選項 + 已存檔的人名（去重）
  const defaults = ['本人', '太太', '丈夫', '兒子', '女兒', '父親', '母親'];
  const fromDocs = [...new Set(docs.map(d => d.owner).filter(Boolean))];
  // 合併，保留順序：已存檔優先，預設補充
  const merged = [...new Set([...fromDocs, ...defaults])];
  dl.innerHTML = merged.map(n => `<option value="${escHtml(n)}"></option>`).join('');
}

// ---- Name datalist: 從現有記錄中提取證件名稱 ----
function refreshNameList() {
  const dl = document.getElementById('name-list');
  if (!dl) return;
  // 常用預設 + 已存檔的名稱（去重）
  const defaults = [
    '澳門居民身份證', '香港特區護照', '回鄉証（港澳居民來往內地通行証）',
    '港澳通行証', '台灣入台證', '各國簽證',
    '駕駛執照', '車輛牌照（道路稅）', '車輛驗車（行車安全檢驗）',
    '私家車保險', '家居保險', '人壽保險', '醫療保險',
    '信用卡', '銀行卡', '定期健康檢查', '疫苗接種', '牙科定期檢查',
    '物業租約', '水電申請', '商業牌照', '食肆牌照'
  ];
  const fromDocs = [...new Set(docs.map(d => d.name).filter(Boolean))];
  const merged = [...new Set([...fromDocs, ...defaults])];
  dl.innerHTML = merged.map(n => `<option value="${escHtml(n)}"></option>`).join('');
}

// ---- Modal: Add/Edit ----
function buildCategoryOptions(selected) {
  return Object.entries(CATEGORIES).map(([k, v]) =>
    `<option value="${k}" ${selected===k?'selected':''}>${v.icon} ${v.label}</option>`
  ).join('');
}

function buildRecurrenceOptions(selected) {
  return RECURRENCE_OPTIONS.map(o =>
    `<option value="${o.value}" ${selected===o.value?'selected':''}>${o.label}</option>`
  ).join('');
}

function openAdd() {
  editingId = null;
  document.getElementById('modal-title').textContent = '新增證件';
  document.getElementById('form-name').value    = '';
  document.getElementById('form-owner').value   = '';
  document.getElementById('form-expiry').value  = '';
  document.getElementById('form-note').value    = '';
  document.getElementById('form-remind').value  = '30';
  document.getElementById('form-category').innerHTML   = buildCategoryOptions('identity');
  document.getElementById('form-recurrence').innerHTML = buildRecurrenceOptions('none');
  document.getElementById('form-custom-years').value   = '1';
  refreshOwnerList();
  refreshNameList();
  toggleCustomYears();
  openModal();
}

function openEdit(id) {
  const doc = docs.find(d => d.id === id);
  if (!doc) return;
  editingId = id;
  document.getElementById('modal-title').textContent = '編輯證件';
  document.getElementById('form-name').value    = doc.name  || '';
  document.getElementById('form-owner').value   = doc.owner || '';
  document.getElementById('form-expiry').value  = doc.expiry || '';
  document.getElementById('form-note').value    = doc.note  || '';
  document.getElementById('form-remind').value  = doc.remindDays || '30';
  document.getElementById('form-category').innerHTML   = buildCategoryOptions(doc.category || 'other');
  document.getElementById('form-recurrence').innerHTML = buildRecurrenceOptions(doc.recurrence || 'none');
  document.getElementById('form-custom-years').value   = doc.recurrenceCustomYears || '1';
  refreshOwnerList();
  refreshNameList();
  toggleCustomYears();
  openModal();
}

function toggleCustomYears() {
  const val = document.getElementById('form-recurrence').value;
  document.getElementById('custom-years-wrap').style.display = (val === 'custom') ? 'block' : 'none';
}

function openModal() {
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('form-recurrence').addEventListener('change', toggleCustomYears);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

document.getElementById('btn-save').addEventListener('click', saveDoc);

function saveDoc() {
  const name       = document.getElementById('form-name').value.trim();
  const owner      = document.getElementById('form-owner').value.trim();
  const expiry     = document.getElementById('form-expiry').value;
  const note       = document.getElementById('form-note').value.trim();
  const remind     = parseInt(document.getElementById('form-remind').value) || 30;
  const category   = document.getElementById('form-category').value;
  const recurrence = document.getElementById('form-recurrence').value;
  const customYrs  = parseInt(document.getElementById('form-custom-years').value) || 1;

  if (!name) { showToast('請輸入證件名稱', 'error'); return; }

  const data = { name, owner, expiry, note, remindDays: remind,
                 category, recurrence,
                 recurrenceCustomYears: recurrence === 'custom' ? customYrs : undefined };

  if (editingId) {
    const idx = docs.findIndex(d => d.id === editingId);
    if (idx > -1) docs[idx] = { ...docs[idx], ...data };
    showToast('已更新證件資料 ✓', 'success');
  } else {
    docs.push({ id: uuid(), ...data, createdAt: new Date().toISOString() });
    showToast('已新增證件 ✓', 'success');
  }
  saveDocs();
  closeModal();
  render();
}

// ---- Delete ----
function deleteDoc(id) {
  if (!confirm('確定要刪除此證件記錄？')) return;
  docs = docs.filter(d => d.id !== id);
  saveDocs();
  render();
  showToast('已刪除', 'info');
}

// ---- Toast ----
function showToast(msg, type = 'info') {
  const wrap = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 2900);
}

// ============================================
//  Google Calendar 整合
// ============================================
const GAPI_DISCOVERY = 'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest';
const GCAL_SCOPE     = 'https://www.googleapis.com/auth/calendar.events';

function getClientId() { return localStorage.getItem(GCAL_CLIENT_ID_KEY) || ''; }

function updateGCalUI() {
  const banner  = document.getElementById('gcal-status');
  const btnSign = document.getElementById('btn-gcal-signin');
  const btnOut  = document.getElementById('btn-gcal-signout');
  const btnSync = document.getElementById('btn-sync-all');
  const clientId = getClientId();

  if (!clientId) {
    banner.innerHTML = `<span class="gcal-icon">📅</span>
      <div class="gcal-text"><strong>Google Calendar 尚未設定</strong>
      <span>請先點擊「⚙️ 設定 Google API」輸入您的 Client ID</span></div>`;
    btnSign.style.display = btnOut.style.display = btnSync.style.display = 'none';
    return;
  }
  if (isSignedIn) {
    banner.innerHTML = `<span class="gcal-icon">✅</span>
      <div class="gcal-text"><strong style="color:#4CAF82">已連結 Google Calendar</strong>
      <span>可將到期提醒（含循環事件）同步至您的 Google 日曆</span></div>`;
    btnSign.style.display = 'none';
    btnOut.style.display = btnSync.style.display = 'inline-flex';
  } else {
    banner.innerHTML = `<span class="gcal-icon">📅</span>
      <div class="gcal-text"><strong>Google Calendar（未登入）</strong>
      <span>登入後可將到期日同步至您的 Google 日曆</span></div>`;
    btnSign.style.display = 'inline-flex';
    btnOut.style.display = btnSync.style.display = 'none';
  }
}

function initGoogleApis() {
  const clientId = getClientId();
  if (!clientId) return;

  if (typeof gapi === 'undefined') {
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.onload = () => {
      gapi.load('client', async () => {
        await gapi.client.init({});
        await gapi.client.load(GAPI_DISCOVERY);
        gapiReady = true;
        tryFinishInit();
      });
    };
    document.head.appendChild(s);
  }

  if (typeof google === 'undefined' || !google.accounts) {
    const s2 = document.createElement('script');
    s2.src = 'https://accounts.google.com/gsi/client';
    s2.onload = () => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: GCAL_SCOPE,
        callback: (resp) => {
          if (resp.error) { showToast('Google 登入失敗：' + resp.error, 'error'); return; }
          isSignedIn = true;
          updateGCalUI();
          showToast('已成功連結 Google Calendar ✓', 'success');
        }
      });
      gisReady = true;
      tryFinishInit();
    };
    document.head.appendChild(s2);
  }
}

function tryFinishInit() {
  if (gapiReady && gisReady) updateGCalUI();
}

function signIn() {
  if (!tokenClient) { showToast('請先設定 Google API Client ID', 'error'); return; }
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

function signOut() {
  const token = gapi?.client?.getToken()?.access_token;
  if (token) { google.accounts.oauth2.revoke(token, () => {}); gapi.client.setToken(null); }
  isSignedIn = false;
  updateGCalUI();
  showToast('已登出 Google Calendar', 'info');
}

async function createGCalEvent(doc) {
  if (!isSignedIn || !gapiReady) { showToast('請先登入 Google Calendar', 'error'); return false; }
  const expiry = effectiveExpiry(doc);
  if (!expiry) { showToast(`「${doc.name}」未設定到期日，跳過`, 'info'); return false; }

  const cat = CATEGORIES[doc.category] || CATEGORIES.other;
  const recLabel = recurrenceLabel(doc);
  const remind = doc.remindDays || 30;

  // Build RRULE for recurring events
  const rruleMap = {
    yearly:'FREQ=YEARLY', biennial:'FREQ=YEARLY;INTERVAL=2',
    '3years':'FREQ=YEARLY;INTERVAL=3', '5years':'FREQ=YEARLY;INTERVAL=5',
    '10years':'FREQ=YEARLY;INTERVAL=10',
    custom:`FREQ=YEARLY;INTERVAL=${doc.recurrenceCustomYears||1}`
  };
  const rrule = (doc.recurrence && doc.recurrence !== 'none') ? rruleMap[doc.recurrence] : null;

  const event = {
    summary: `${cat.icon}【${cat.label}】${doc.owner?doc.owner+' - ':''}${doc.name}`,
    description: [
      `📋 證件名稱：${doc.name}`,
      `🏷 分類：${cat.icon} ${cat.label}`,
      doc.owner ? `👤 持有人：${doc.owner}` : '',
      `📅 到期日期：${formatDate(expiry)}`,
      recLabel ? `🔄 循環週期：${recLabel}` : '',
      doc.note ? `📝 備注：${doc.note}` : '',
      '',
      '─ 由「證件到期管理系統」自動建立 ─'
    ].filter(Boolean).join('\n'),
    start: { date: expiry },
    end:   { date: expiry },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: remind * 24 * 60 },
        { method: 'email', minutes: remind * 24 * 60 }
      ]
    },
    colorId: statusOf(daysUntil(expiry)) === 'expired' ? '11' :
             statusOf(daysUntil(expiry)) === 'urgent'  ? '6'  : '5'
  };

  if (rrule) event.recurrence = [`RRULE:${rrule}`];

  try {
    const resp = await gapi.client.calendar.events.insert({ calendarId: 'primary', resource: event });
    return resp.status === 200;
  } catch (err) {
    console.error(err);
    return false;
  }
}

async function syncOneToGCal(id) {
  const doc = docs.find(d => d.id === id);
  if (!doc) return;
  if (!isSignedIn) { showToast('請先登入 Google Calendar', 'error'); return; }
  showToast('正在同步…', 'info');
  const ok = await createGCalEvent(doc);
  showToast(ok ? `「${doc.name}」已加入 Google Calendar ✓` : '同步失敗，請檢查設定', ok?'success':'error');
}

async function syncAllToGCal() {
  if (!isSignedIn) { showToast('請先登入 Google Calendar', 'error'); return; }
  const eligible = docs.filter(d => effectiveExpiry(d));
  if (!eligible.length) { showToast('沒有設有到期日的記錄', 'info'); return; }
  showToast(`正在同步 ${eligible.length} 項記錄…`, 'info');
  let success = 0;
  for (const doc of eligible) {
    if (await createGCalEvent(doc)) success++;
    await new Promise(r => setTimeout(r, 300));
  }
  showToast(`完成！成功同步 ${success}/${eligible.length} 項 ✓`, 'success');
}

// ---- Setup Modal ----
function openSetupModal() {
  document.getElementById('setup-client-id').value = getClientId();
  document.getElementById('setup-overlay').classList.add('open');
}
function closeSetupModal() { document.getElementById('setup-overlay').classList.remove('open'); }

document.getElementById('setup-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('setup-overlay')) closeSetupModal();
});
document.getElementById('btn-setup-save').addEventListener('click', () => {
  const cid = document.getElementById('setup-client-id').value.trim();
  if (!cid) { showToast('請輸入 Client ID', 'error'); return; }
  localStorage.setItem(GCAL_CLIENT_ID_KEY, cid);
  closeSetupModal();
  showToast('設定已儲存，正在初始化 Google API…', 'success');
  gapiReady = false; gisReady = false; isSignedIn = false; tokenClient = null;
  initGoogleApis();
  setTimeout(updateGCalUI, 500);
});

// ---- Wire Buttons ----
document.getElementById('btn-add').addEventListener('click', openAdd);
document.getElementById('btn-setup').addEventListener('click', openSetupModal);
document.getElementById('btn-gcal-signin').addEventListener('click', signIn);
document.getElementById('btn-gcal-signout').addEventListener('click', signOut);
document.getElementById('btn-sync-all').addEventListener('click', syncAllToGCal);
document.getElementById('btn-cancel').addEventListener('click', closeModal);
document.getElementById('btn-logout').addEventListener('click', logout);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeSetupModal(); }
  if ((e.ctrlKey||e.metaKey) && e.key === 'n') { e.preventDefault(); openAdd(); }
});

// ---- Summary card click ----
function setFilter(f) {
  filterStatus = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === f));
  viewMode === 'group' ? renderGrouped() : renderList();
}

// ---- 密碼保護功能 ----
function checkAuth() {
  // 檢查 sessionStorage（分頁級別）和 localStorage（持久級別）
  const sessionAuth = sessionStorage.getItem(AUTH_KEY);
  const persistentAuth = localStorage.getItem(AUTH_KEY);
  isAuthenticated = sessionAuth === 'true' || persistentAuth === 'true';
  return isAuthenticated;
}

function login(password, remember = false) {
  if (password === APP_PASSWORD) {
    isAuthenticated = true;
    sessionStorage.setItem(AUTH_KEY, 'true');
    if (remember) {
      localStorage.setItem(AUTH_KEY, 'true');
    }
    return true;
  }
  return false;
}

function logout() {
  isAuthenticated = false;
  sessionStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(AUTH_KEY);
  showLoginScreen();
}

function showLoginScreen() {
  const appWrapper = document.querySelector('.app-wrapper');
  if (appWrapper) {
    appWrapper.style.display = 'none';
  }
  
  let loginOverlay = document.getElementById('login-overlay');
  if (!loginOverlay) {
    loginOverlay = document.createElement('div');
    loginOverlay.id = 'login-overlay';
    loginOverlay.className = 'login-overlay';
    loginOverlay.innerHTML = `
      <div class="login-box">
        <div class="login-icon">🔒</div>
        <h2>證件到期管理系統</h2>
        <p class="login-subtitle">請輸入密碼以繼續</p>
        <div class="login-form">
          <input type="password" id="login-password" class="login-input" placeholder="輸入密碼..." />
          <label class="login-remember">
            <input type="checkbox" id="login-remember" /> 記住我（在此裝置上保持登入）
          </label>
          <button id="login-btn" class="login-button">登入</button>
          <div id="login-error" class="login-error"></div>
        </div>
        <p class="login-hint">預設密碼：123456<br>建議首次登入後修改密碼</p>
      </div>
    `;
    document.body.appendChild(loginOverlay);
    
    // 綁定事件
    document.getElementById('login-btn').addEventListener('click', handleLogin);
    document.getElementById('login-password').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleLogin();
    });
  }
  loginOverlay.style.display = 'flex';
  document.getElementById('login-password').focus();
}

function handleLogin() {
  const password = document.getElementById('login-password').value;
  const remember = document.getElementById('login-remember').checked;
  const errorEl = document.getElementById('login-error');
  
  if (login(password, remember)) {
    hideLoginScreen();
    initApp();
  } else {
    errorEl.textContent = '密碼錯誤，請重試';
    document.getElementById('login-password').value = '';
    document.getElementById('login-password').focus();
  }
}

function hideLoginScreen() {
  const loginOverlay = document.getElementById('login-overlay');
  if (loginOverlay) {
    loginOverlay.style.display = 'none';
  }
  const appWrapper = document.querySelector('.app-wrapper');
  if (appWrapper) {
    appWrapper.style.display = 'block';
  }
}

// ---- 初始化應用 ----
function initApp() {
  loadDocs();
  initGoogleApis();
  updateGCalUI();
  render();
}

// ---- Init ----
if (checkAuth()) {
  initApp();
} else {
  // 等待 DOM 載入後顯示登入畫面
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showLoginScreen);
  } else {
    showLoginScreen();
  }
}
