// ============================================
//  證件到期管理系統 v3 - Supabase Auth + 雲端同步
// ============================================

const SUPABASE_URL = 'https://zgkfuejazoloiodhucng.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpna2Z1ZWphem9sb2lvZGh1Y25nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MjA5MTYsImV4cCI6MjA5MTI5NjkxNn0.7C0lpRScT5OTJwDBYrx-GNRaH-jsfC4M_GvFSBSoPXI';
const GCAL_CLIENT_ID_KEY = 'gcal_client_id';

let supabase = null;
let currentUser = null;

const CATEGORIES = {
  identity: { label: '身份證件', icon: '🪪', color: '#7aadff' },
  travel:   { label: '旅遊證件', icon: '✈️', color: '#a78bfa' },
  vehicle:  { label: '車輛相關', icon: '🚗', color: '#fb923c' },
  insurance:{ label: '保險', icon: '🛡️', color: '#34d399' },
  medical:  { label: '醫療健康', icon: '🏥', color: '#f472b6' },
  finance:  { label: '財務證件', icon: '💳', color: '#fbbf24' },
  property: { label: '物業/租約', icon: '🏠', color: '#60a5fa' },
  license:  { label: '牌照/執照', icon: '📜', color: '#c084fc' },
  family:   { label: '家庭/兒童', icon: '👨‍👩‍👧', color: '#f9a8d4' },
  other:    { label: '其他', icon: '📁', color: '#94a3b8' },
};

const RECURRENCE_OPTIONS = [
  { value: 'none', label: '不重複（單次）' },
  { value: 'yearly', label: '每年（同一日期）' },
  { value: 'biennial', label: '每兩年' },
  { value: '3years', label: '每三年' },
  { value: '5years', label: '每五年' },
  { value: '10years', label: '每十年' },
  { value: 'custom', label: '自訂年數' },
];

let docs = [], editingId = null, filterStatus = 'all', filterCategory = 'all', searchQuery = '';
let gapiReady = false, gisReady = false, tokenClient = null, isGCalSignedIn = false, viewMode = 'list', isLoading = false;

function uuid() { return 'doc_' + Date.now().toString(36) + Math.random().toString(36).slice(2); }
function effectiveExpiry(doc) {
  if (!doc.expiry) return null;
  if (!doc.recurrence || doc.recurrence === 'none') return doc.expiry;
  const cycleYears = { yearly: 1, biennial: 2, '3years': 3, '5years': 5, '10years': 10, custom: parseInt(doc.recurrence_custom_years) || 1 }[doc.recurrence] || 1;
  const today = new Date(); today.setHours(0,0,0,0);
  let d = new Date(doc.expiry); d.setHours(0,0,0,0);
  while (d < today) d.setFullYear(d.getFullYear() + cycleYears);
  return d.toISOString().slice(0, 10);
}
function daysUntil(dateStr) { if (!dateStr) return null; const today = new Date(); today.setHours(0,0,0,0); const exp = new Date(dateStr); exp.setHours(0,0,0,0); return Math.round((exp - today) / 86400000); }
function statusOf(days) { if (days === null) return 'ok'; if (days < 0) return 'expired'; if (days <= 30) return 'urgent'; if (days <= 90) return 'warning'; return 'ok'; }
function statusLabel(s) { return { expired:'已過期', urgent:'緊急', warning:'注意', ok:'正常' }[s] || ''; }
function formatDate(dateStr) { if (!dateStr) return '—'; const d = new Date(dateStr); return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`; }
function recurrenceLabel(doc) { if (!doc.recurrence || doc.recurrence === 'none') return ''; const map = { yearly:'每年', biennial:'每兩年', '3years':'每三年', '5years':'每五年', '10years':'每十年', custom: `每${doc.recurrence_custom_years||1}年` }; return map[doc.recurrence] || ''; }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// ============================================
//  Supabase Auth & Data
// ============================================
async function initSupabase() {
  try {
    console.log('[Auth] Initializing Supabase...');
    if (typeof window.supabase === 'undefined') {
      console.log('[Auth] Loading Supabase JS SDK...');
      await new Promise((resolve, reject) => { 
        const script = document.createElement('script'); 
        script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js'; 
        script.onload = resolve; 
        script.onerror = () => reject(new Error('Failed to load Supabase SDK'));
        document.head.appendChild(script); 
      });
    }
    
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error('Supabase library not loaded properly');
    }
    
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('[Auth] Supabase client created');
    
    // Test connection
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) {
      console.error('[Auth] getSession error:', error);
      showAuthScreen();
      return;
    }
    
    if (session) { 
      console.log('[Auth] User already logged in:', session.user.email);
      currentUser = session.user; 
      await loadDocsFromSupabase(); 
      showMainApp(); 
    }
    else { 
      console.log('[Auth] No session, showing auth screen');
      showAuthScreen(); 
    }
    
    supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('[Auth] State change:', event);
      if (event === 'SIGNED_IN' && session) { currentUser = session.user; await loadDocsFromSupabase(); showMainApp(); }
      else if (event === 'SIGNED_OUT') { currentUser = null; docs = []; showAuthScreen(); }
    });
  } catch (err) {
    console.error('[Auth] Init error:', err);
    showAuthScreenWithError(err.message);
  }
}

function showAuthScreenWithError(errorMsg) {
  console.log('[Auth] Showing auth screen with error:', errorMsg);
  const appWrapper = document.querySelector('.app-wrapper');
  if (appWrapper) appWrapper.style.display = 'none';
  
  let authOverlay = document.getElementById('auth-overlay');
  if (!authOverlay) {
    authOverlay = document.createElement('div');
    authOverlay.id = 'auth-overlay';
    authOverlay.className = 'auth-overlay';
    authOverlay.innerHTML = `
      <div class="auth-box">
        <div class="auth-logo">📋</div>
        <h2>證件到期管理系統</h2>
        <div class="auth-tabs">
          <button class="auth-tab active" data-tab="login">登入</button>
          <button class="auth-tab" data-tab="signup">註冊</button>
        </div>
        <div class="auth-form" id="auth-form-login">
          <input type="email" id="login-email" class="auth-input" placeholder="電郵地址" />
          <input type="password" id="login-password" class="auth-input" placeholder="密碼" />
          <button id="btn-login" class="auth-button">登入</button>
        </div>
        <div class="auth-form" id="auth-form-signup" style="display:none">
          <input type="email" id="signup-email" class="auth-input" placeholder="電郵地址" />
          <input type="password" id="signup-password" class="auth-input" placeholder="密碼（至少6位）" />
          <input type="password" id="signup-confirm" class="auth-input" placeholder="確認密碼" />
          <button id="btn-signup" class="auth-button">註冊</button>
        </div>
        <div id="auth-error" class="auth-error">${errorMsg ? '⚠️ ' + errorMsg : ''}</div>
      </div>
    `;
    document.body.appendChild(authOverlay);
    document.querySelectorAll('.auth-tab').forEach(tab => tab.addEventListener('click', () => switchAuthTab(tab.dataset.tab)));
    document.getElementById('btn-login').addEventListener('click', handleLogin);
    document.getElementById('btn-signup').addEventListener('click', handleSignup);
    ['login-email','login-password'].forEach(id => document.getElementById(id).addEventListener('keypress', e => { if(e.key==='Enter') handleLogin(); }));
    ['signup-email','signup-password','signup-confirm'].forEach(id => document.getElementById(id).addEventListener('keypress', e => { if(e.key==='Enter') handleSignup(); }));
  }
  authOverlay.style.display = 'flex';
}

async function loadDocsFromSupabase() {
  if (!currentUser) return;
  isLoading = true; render();
  const { data, error } = await supabase.from('documents').select('*').eq('user_id', currentUser.id).order('expiry', { ascending: true });
  if (error) { showToast('載入數據失敗：' + error.message, 'error'); docs = []; }
  else { docs = data || []; }
  isLoading = false; render();
}

async function saveDocToSupabase(doc) {
  if (!currentUser) return;
  const docData = { ...doc, user_id: currentUser.id };
  delete docData.id; delete docData.created_at; delete docData.updated_at;
  if (doc.id && !doc.id.startsWith('doc_')) {
    const { error } = await supabase.from('documents').update(docData).eq('id', doc.id).eq('user_id', currentUser.id);
    if (error) { showToast('更新失敗：' + error.message, 'error'); return false; }
  } else {
    const { data, error } = await supabase.from('documents').insert([docData]).select();
    if (error) { showToast('新增失敗：' + error.message, 'error'); return false; }
    if (data) doc.id = data[0].id;
  }
  return true;
}

async function deleteDocFromSupabase(id) {
  if (!currentUser) return;
  const { error } = await supabase.from('documents').delete().eq('id', id).eq('user_id', currentUser.id);
  if (error) { showToast('刪除失敗：' + error.message, 'error'); return false; }
  return true;
}

async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) { showToast('註冊失敗：' + error.message, 'error'); return false; }
  showToast('註冊成功！請檢查郵箱驗證', 'success'); return true;
}

async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) { showToast('登入失敗：' + error.message, 'error'); return false; }
  return true;
}

async function signOut() {
  await supabase.auth.signOut();
  currentUser = null; docs = []; showAuthScreen();
}

// ============================================
//  Auth UI
// ============================================
function showAuthScreen() {
  console.log('[Auth] Showing auth screen...');
  const appWrapper = document.querySelector('.app-wrapper');
  if (appWrapper) appWrapper.style.display = 'none';
  
  let authOverlay = document.getElementById('auth-overlay');
  if (!authOverlay) {
    console.log('[Auth] Creating auth overlay...');
    authOverlay = document.createElement('div');
    authOverlay.id = 'auth-overlay';
    authOverlay.className = 'auth-overlay';
    authOverlay.innerHTML = `
      <div class="auth-box">
        <div class="auth-logo">📋</div>
        <h2>證件到期管理系統</h2>
        <div class="auth-tabs">
          <button class="auth-tab active" data-tab="login">登入</button>
          <button class="auth-tab" data-tab="signup">註冊</button>
        </div>
        <div class="auth-form" id="auth-form-login">
          <input type="email" id="login-email" class="auth-input" placeholder="電郵地址" />
          <input type="password" id="login-password" class="auth-input" placeholder="密碼" />
          <button id="btn-login" class="auth-button">登入</button>
        </div>
        <div class="auth-form" id="auth-form-signup" style="display:none">
          <input type="email" id="signup-email" class="auth-input" placeholder="電郵地址" />
          <input type="password" id="signup-password" class="auth-input" placeholder="密碼（至少6位）" />
          <input type="password" id="signup-confirm" class="auth-input" placeholder="確認密碼" />
          <button id="btn-signup" class="auth-button">註冊</button>
        </div>
        <div id="auth-error" class="auth-error"></div>
      </div>
    `;
    document.body.appendChild(authOverlay);
    document.querySelectorAll('.auth-tab').forEach(tab => tab.addEventListener('click', () => switchAuthTab(tab.dataset.tab)));
    document.getElementById('btn-login').addEventListener('click', handleLogin);
    document.getElementById('btn-signup').addEventListener('click', handleSignup);
    ['login-email','login-password'].forEach(id => document.getElementById(id).addEventListener('keypress', e => { if(e.key==='Enter') handleLogin(); }));
    ['signup-email','signup-password','signup-confirm'].forEach(id => document.getElementById(id).addEventListener('keypress', e => { if(e.key==='Enter') handleSignup(); }));
  }
  authOverlay.style.display = 'flex';
  console.log('[Auth] Auth overlay displayed');
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('auth-form-login').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('auth-form-signup').style.display = tab === 'signup' ? 'block' : 'none';
  document.getElementById('auth-error').textContent = '';
}

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) { document.getElementById('auth-error').textContent = '請填寫電郵和密碼'; return; }
  await signIn(email, password);
}

async function handleSignup() {
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const confirm = document.getElementById('signup-confirm').value;
  if (!email || !password) { document.getElementById('auth-error').textContent = '請填寫電郵和密碼'; return; }
  if (password.length < 6) { document.getElementById('auth-error').textContent = '密碼至少6位'; return; }
  if (password !== confirm) { document.getElementById('auth-error').textContent = '密碼不一致'; return; }
  const ok = await signUp(email, password);
  if (ok) switchAuthTab('login');
}

function showMainApp() {
  const authOverlay = document.getElementById('auth-overlay');
  if (authOverlay) authOverlay.style.display = 'none';
  document.querySelector('.app-wrapper').style.display = 'block';
  initGoogleApis(); updateGCalUI(); render();
}

// ============================================
//  Render
// ============================================
function render() {
  renderSummary();
  renderCategoryFilters();
  viewMode === 'group' ? renderGrouped() : renderList();
}

function getFilteredDocs() {
  let filtered = docs.map(d => ({ ...d, _expiry: effectiveExpiry(d) }));
  if (filterStatus !== 'all') filtered = filtered.filter(d => statusOf(daysUntil(d._expiry)) === filterStatus);
  if (filterCategory !== 'all') filtered = filtered.filter(d => (d.category || 'other') === filterCategory);
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(d => d.name.toLowerCase().includes(q) || (d.owner||'').toLowerCase().includes(q) || (d.note||'').toLowerCase().includes(q));
  }
  filtered.sort((a, b) => { const da = daysUntil(a._expiry) ?? 99999, db = daysUntil(b._expiry) ?? 99999; return da - db; });
  return filtered;
}

function renderSummary() {
  const withExpiry = docs.map(d => ({ ...d, _expiry: effectiveExpiry(d) }));
  document.getElementById('stat-total').textContent = docs.length;
  document.getElementById('stat-expired').textContent = withExpiry.filter(d => statusOf(daysUntil(d._expiry)) === 'expired').length;
  document.getElementById('stat-urgent').textContent = withExpiry.filter(d => statusOf(daysUntil(d._expiry)) === 'urgent').length;
  document.getElementById('stat-ok').textContent = withExpiry.filter(d => statusOf(daysUntil(d._expiry)) === 'ok').length;
}

function renderCategoryFilters() {
  const wrap = document.getElementById('category-filters');
  const counts = {};
  docs.forEach(d => { const cat = d.category || 'other'; counts[cat] = (counts[cat] || 0) + 1; });
  const all = `<button class="cat-btn ${filterCategory==='all'?'active':''}" onclick="setCategoryFilter('all')">全部 <span class="cat-count">${docs.length}</span></button>`;
  const cats = Object.entries(CATEGORIES).filter(([k]) => counts[k]).map(([k, v]) => `<button class="cat-btn ${filterCategory===k?'active':''}" onclick="setCategoryFilter('${k}')" style="--cat-color:${v.color}">${v.icon} ${v.label} <span class="cat-count">${counts[k]||0}</span></button>`).join('');
  wrap.innerHTML = all + cats;
}

function docCardHtml(doc) {
  const expiry = doc._expiry, days = daysUntil(expiry), status = statusOf(days), cat = CATEGORIES[doc.category] || CATEGORIES.other, recLabel = recurrenceLabel(doc);
  let countdownHtml;
  if (!expiry) countdownHtml = `<div class="countdown-val">—</div><div class="countdown-unit">無期限</div>`;
  else if (days < 0) countdownHtml = `<div class="countdown-val">${Math.abs(days)}</div><div class="countdown-unit">天前已過期</div>`;
  else if (days === 0) countdownHtml = `<div class="countdown-val">今天</div><div class="countdown-unit">到期</div>`;
  else countdownHtml = `<div class="countdown-val">${days}</div><div class="countdown-unit">天後到期</div>`;
  const recBadge = recLabel ? `<span class="badge recurrence">🔄 ${escHtml(recLabel)}</span>` : '';
  const originalExpiry = (doc.recurrence && doc.recurrence !== 'none' && doc._expiry !== doc.expiry) ? `<span style="font-size:11px;color:var(--text-muted)">原始：${formatDate(doc.expiry)}</span>` : '';
  return `<div class="doc-card ${status}" data-id="${doc.id}"><div class="doc-status-dot"></div><div class="doc-cat-icon" style="color:${cat.color}" title="${cat.label}">${cat.icon}</div><div class="doc-main"><div class="doc-name">${escHtml(doc.name)}</div><div class="doc-meta">${doc.owner ? `<span class="doc-owner">👤 ${escHtml(doc.owner)}</span>` : ''}<span class="doc-date">📅 ${formatDate(expiry)}</span><span class="badge ${status}">${statusLabel(status)}</span>${recBadge}${originalExpiry}</div>${doc.note ? `<div class="doc-note">📝 ${escHtml(doc.note)}</div>` : ''}</div><div class="doc-countdown">${countdownHtml}</div><div class="doc-actions"><button class="btn btn-ghost btn-sm btn-icon" title="同步至 Google Calendar" onclick="syncOneToGCal('${doc.id}')">📆</button><button class="btn btn-ghost btn-sm btn-icon" title="編輯" onclick="openEdit('${doc.id}')">✏️</button><button class="btn btn-danger btn-sm btn-icon" title="刪除" onclick="deleteDoc('${doc.id}')">🗑️</button></div></div>`;
}

function renderList() {
  const container = document.getElementById('doc-list');
  if (isLoading) { container.innerHTML = `<div class="empty-state"><div class="icon">⏳</div><h3>載入中...</h3></div>`; return; }
  const filtered = getFilteredDocs();
  if (!filtered.length) { container.innerHTML = `<div class="empty-state"><div class="icon">🗂️</div><h3>暫無記錄</h3><p>點擊右上角「新增證件」開始管理</p></div>`; return; }
  container.innerHTML = filtered.map(docCardHtml).join('');
}

function renderGrouped() {
  const container = document.getElementById('doc-list');
  if (isLoading) { container.innerHTML = `<div class="empty-state"><div class="icon">⏳</div><h3>載入中...</h3></div>`; return; }
  const filtered = getFilteredDocs();
  if (!filtered.length) { container.innerHTML = `<div class="empty-state"><div class="icon">🗂️</div><h3>暫無記錄</h3><p>點擊右上角「新增證件」開始管理</p></div>`; return; }
  const groups = {};
  filtered.forEach(d => { const k = d.category || 'other'; if (!groups[k]) groups[k] = []; groups[k].push(d); });
  let html = '';
  Object.entries(CATEGORIES).forEach(([key, cat]) => {
    const items = groups[key];
    if (!items || !items.length) return;
    html += `<div class="group-section"><div class="group-header"><span class="group-icon" style="color:${cat.color}">${cat.icon}</span><span class="group-label">${cat.label}</span><span class="group-count">${items.length}</span></div><div class="group-cards">${items.map(docCardHtml).join('')}</div></div>`;
  });
  container.innerHTML = html;
}

function setCategoryFilter(cat) { filterCategory = cat; renderCategoryFilters(); viewMode === 'group' ? renderGrouped() : renderList(); }

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => { filterStatus = btn.dataset.filter; document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); viewMode === 'group' ? renderGrouped() : renderList(); });
});

document.getElementById('search-input').addEventListener('input', e => { searchQuery = e.target.value.trim(); viewMode === 'group' ? renderGrouped() : renderList(); });

function setView(mode) {
  viewMode = mode;
  document.getElementById('btn-view-list').classList.toggle('active', mode === 'list');
  document.getElementById('btn-view-group').classList.toggle('active', mode === 'group');
  viewMode === 'group' ? renderGrouped() : renderList();
}

document.getElementById('btn-view-list').addEventListener('click', () => setView('list'));
document.getElementById('btn-view-group').addEventListener('click', () => setView('group'));

function refreshOwnerList() {
  const dl = document.getElementById('owner-list'); if (!dl) return;
  const defaults = ['本人', '太太', '丈夫', '兒子', '女兒', '父親', '母親'];
  const fromDocs = [...new Set(docs.map(d => d.owner).filter(Boolean))];
  dl.innerHTML = [...new Set([...fromDocs, ...defaults])].map(n => `<option value="${escHtml(n)}"></option>`).join('');
}

function refreshNameList() {
  const dl = document.getElementById('name-list'); if (!dl) return;
  const defaults = ['澳門居民身份證','香港特區護照','回鄉証（港澳居民來往內地通行証）','港澳通行証','台灣入台證','各國簽證','駕駛執照','車輛牌照（道路稅）','車輛驗車（行車安全檢驗）','私家車保險','家居保險','人壽保險','醫療保險','信用卡','銀行卡','定期健康檢查','疫苗接種','牙科定期檢查','物業租約','水電申請','商業牌照','食肆牌照'];
  const fromDocs = [...new Set(docs.map(d => d.name).filter(Boolean))];
  dl.innerHTML = [...new Set([...fromDocs, ...defaults])].map(n => `<option value="${escHtml(n)}"></option>`).join('');
}

function buildCategoryOptions(selected) { return Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}" ${selected===k?'selected':''}>${v.icon} ${v.label}</option>`).join(''); }
function buildRecurrenceOptions(selected) { return RECURRENCE_OPTIONS.map(o => `<option value="${o.value}" ${selected===o.value?'selected':''}>${o.label}</option>`).join(''); }

function openAdd() {
  editingId = null;
  document.getElementById('modal-title').textContent = '新增證件';
  document.getElementById('form-name').value = '';
  document.getElementById('form-owner').value = '';
  document.getElementById('form-expiry').value = '';
  document.getElementById('form-note').value = '';
  document.getElementById('form-remind').value = '30';
  document.getElementById('form-category').innerHTML = buildCategoryOptions('identity');
  document.getElementById('form-recurrence').innerHTML = buildRecurrenceOptions('none');
  document.getElementById('form-custom-years').value = '1';
  refreshOwnerList(); refreshNameList(); toggleCustomYears(); openModal();
}

function openEdit(id) {
  const doc = docs.find(d => d.id === id); if (!doc) return;
  editingId = id;
  document.getElementById('modal-title').textContent = '編輯證件';
  document.getElementById('form-name').value = doc.name || '';
  document.getElementById('form-owner').value = doc.owner || '';
  document.getElementById('form-expiry').value = doc.expiry || '';
  document.getElementById('form-note').value = doc.note || '';
  document.getElementById('form-remind').value = doc.remind_days || '30';
  document.getElementById('form-category').innerHTML = buildCategoryOptions(doc.category || 'other');
  document.getElementById('form-recurrence').innerHTML = buildRecurrenceOptions(doc.recurrence || 'none');
  document.getElementById('form-custom-years').value = doc.recurrence_custom_years || '1';
  refreshOwnerList(); refreshNameList(); toggleCustomYears(); openModal();
}

function toggleCustomYears() { document.getElementById('custom-years-wrap').style.display = document.getElementById('form-recurrence').value === 'custom' ? 'block' : 'none'; }
function openModal() { document.getElementById('modal-overlay').classList.add('open'); document.getElementById('form-recurrence').addEventListener('change', toggleCustomYears); }
function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); }
document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target === document.getElementById('modal-overlay')) closeModal(); });

async function saveDoc() {
  const name = document.getElementById('form-name').value.trim();
  const owner = document.getElementById('form-owner').value.trim();
  const expiry = document.getElementById('form-expiry').value;
  const note = document.getElementById('form-note').value.trim();
  const remind = parseInt(document.getElementById('form-remind').value) || 30;
  const category = document.getElementById('form-category').value;
  const recurrence = document.getElementById('form-recurrence').value;
  const customYrs = parseInt(document.getElementById('form-custom-years').value) || 1;
  if (!name) { showToast('請輸入證件名稱', 'error'); return; }
  
  const data = { name, owner, expiry, note, remind_days: remind, category, recurrence, recurrence_custom_years: recurrence === 'custom' ? customYrs : null };
  
  if (editingId) {
    const idx = docs.findIndex(d => d.id === editingId);
    if (idx > -1) {
      const updated = { ...docs[idx], ...data };
      const ok = await saveDocToSupabase(updated);
      if (ok) { docs[idx] = updated; showToast('已更新 ✓', 'success'); }
    }
  } else {
    const newDoc = { ...data };
    const ok = await saveDocToSupabase(newDoc);
    if (ok) { docs.push(newDoc); showToast('已新增 ✓', 'success'); }
  }
  closeModal(); render();
}

async function deleteDoc(id) {
  if (!confirm('確定要刪除此證件記錄？')) return;
  const ok = await deleteDocFromSupabase(id);
  if (ok) { docs = docs.filter(d => d.id !== id); render(); showToast('已刪除', 'info'); }
}

function showToast(msg, type = 'info') {
  const wrap = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 2900);
}

// ============================================
//  Google Calendar
// ============================================
const GAPI_DISCOVERY = 'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest';
const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
function getClientId() { return localStorage.getItem(GCAL_CLIENT_ID_KEY) || ''; }

function updateGCalUI() {
  const banner = document.getElementById('gcal-status'), btnSign = document.getElementById('btn-gcal-signin'), btnOut = document.getElementById('btn-gcal-signout'), btnSync = document.getElementById('btn-sync-all'), clientId = getClientId();
  if (!clientId) { banner.innerHTML = `<span class="gcal-icon">📅</span><div class="gcal-text"><strong>Google Calendar 尚未設定</strong><span>請先點擊「⚙️ 設定 Google API」輸入您的 Client ID</span></div>`; btnSign.style.display = btnOut.style.display = btnSync.style.display = 'none'; return; }
  if (isGCalSignedIn) { banner.innerHTML = `<span class="gcal-icon">✅</span><div class="gcal-text"><strong style="color:#4CAF82">已連結 Google Calendar</strong><span>可將到期提醒同步至您的 Google 日曆</span></div>`; btnSign.style.display = 'none'; btnOut.style.display = btnSync.style.display = 'inline-flex'; }
  else { banner.innerHTML = `<span class="gcal-icon">📅</span><div class="gcal-text"><strong>Google Calendar（未登入）</strong><span>登入後可將到期日同步至您的 Google 日曆</span></div>`; btnSign.style.display = 'inline-flex'; btnOut.style.display = btnSync.style.display = 'none'; }
}

function initGoogleApis() {
  const clientId = getClientId(); if (!clientId) return;
  if (typeof gapi === 'undefined') { const s = document.createElement('script'); s.src = 'https://apis.google.com/js/api.js'; s.onload = () => { gapi.load('client', async () => { await gapi.client.init({}); await gapi.client.load(GAPI_DISCOVERY); gapiReady = true; tryFinishInit(); }); }; document.head.appendChild(s); }
  if (typeof google === 'undefined' || !google.accounts) { const s2 = document.createElement('script'); s2.src = 'https://accounts.google.com/gsi/client'; s2.onload = () => { tokenClient = google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: GCAL_SCOPE, callback: (resp) => { if (resp.error) { showToast('Google 登入失敗：' + resp.error, 'error'); return; } isGCalSignedIn = true; updateGCalUI(); showToast('已成功連結 Google Calendar ✓', 'success'); } }); gisReady = true; tryFinishInit(); }; document.head.appendChild(s2); }
}
function tryFinishInit() { if (gapiReady && gisReady) updateGCalUI(); }
function signIn() { if (!tokenClient) { showToast('請先設定 Google API Client ID', 'error'); return; } tokenClient.requestAccessToken({ prompt: 'consent' }); }
function signOut() { const token = gapi?.client?.getToken()?.access_token; if (token) { google.accounts.oauth2.revoke(token, () => {}); gapi.client.setToken(null); } isGCalSignedIn = false; updateGCalUI(); showToast('已登出 Google Calendar', 'info'); }

async function createGCalEvent(doc) {
  if (!isGCalSignedIn || !gapiReady) { showToast('請先登入 Google Calendar', 'error'); return false; }
  const expiry = effectiveExpiry(doc); if (!expiry) { showToast(`「${doc.name}」未設定到期日，跳過`, 'info'); return false; }
  const cat = CATEGORIES[doc.category] || CATEGORIES.other, recLabel = recurrenceLabel(doc), remind = doc.remind_days || 30;
  const rruleMap = { yearly:'FREQ=YEARLY', biennial:'FREQ=YEARLY;INTERVAL=2', '3years':'FREQ=YEARLY;INTERVAL=3', '5years':'FREQ=YEARLY;INTERVAL=5', '10years':'FREQ=YEARLY;INTERVAL=10', custom:`FREQ=YEARLY;INTERVAL=${doc.recurrence_custom_years||1}` };
  const rrule = (doc.recurrence && doc.recurrence !== 'none') ? rruleMap[doc.recurrence] : null;
  const event = { summary: `${cat.icon}【${cat.label}】${doc.owner?doc.owner+' - ':''}${doc.name}`, description: [`📋 證件名稱：${doc.name}`,`🏷 分類：${cat.icon} ${cat.label}`,doc.owner ? `👤 持有人：${doc.owner}` : '',`📅 到期日期：${formatDate(expiry)}`,recLabel ? `🔄 循環週期：${recLabel}` : '',doc.note ? `📝 備注：${doc.note}` : '','','─ 由「證件到期管理系統」自動建立 ─'].filter(Boolean).join('\n'), start: { date: expiry }, end: { date: expiry }, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: remind * 24 * 60 },{ method: 'email', minutes: remind * 24 * 60 }] }, colorId: statusOf(daysUntil(expiry)) === 'expired' ? '11' : statusOf(daysUntil(expiry)) === 'urgent' ? '6' : '5' };
  if (rrule) event.recurrence = [`RRULE:${rrule}`];
  try { const resp = await gapi.client.calendar.events.insert({ calendarId: 'primary', resource: event }); return resp.status === 200; } catch (err) { console.error(err); return false; }
}

async function syncOneToGCal(id) { const doc = docs.find(d => d.id === id); if (!doc) return; if (!isGCalSignedIn) { showToast('請先登入 Google Calendar', 'error'); return; } showToast('正在同步…', 'info'); const ok = await createGCalEvent(doc); showToast(ok ? `「${doc.name}」已加入 Google Calendar ✓` : '同步失敗，請檢查設定', ok?'success':'error'); }
async function syncAllToGCal() { if (!isGCalSignedIn) { showToast('請先登入 Google Calendar', 'error'); return; } const eligible = docs.filter(d => effectiveExpiry(d)); if (!eligible.length) { showToast('沒有設有到期日的記錄', 'info'); return; } showToast(`正在同步 ${eligible.length} 項記錄…`, 'info'); let success = 0; for (const doc of eligible) { if (await createGCalEvent(doc)) success++; await new Promise(r => setTimeout(r, 300)); } showToast(`完成！成功同步 ${success}/${eligible.length} 項 ✓`, 'success'); }

function openSetupModal() { document.getElementById('setup-client-id').value = getClientId(); document.getElementById('setup-overlay').classList.add('open'); }
function closeSetupModal() { document.getElementById('setup-overlay').classList.remove('open'); }
document.getElementById('setup-overlay').addEventListener('click', e => { if (e.target === document.getElementById('setup-overlay')) closeSetupModal(); });
document.getElementById('btn-setup-save').addEventListener('click', () => { const cid = document.getElementById('setup-client-id').value.trim(); if (!cid) { showToast('請輸入 Client ID', 'error'); return; } localStorage.setItem(GCAL_CLIENT_ID_KEY, cid); closeSetupModal(); showToast('設定已儲存，正在初始化 Google API…', 'success'); gapiReady = false; gisReady = false; isGCalSignedIn = false; tokenClient = null; initGoogleApis(); setTimeout(updateGCalUI, 500); });

// ============================================
//  Wire Buttons & Init
// ============================================
document.getElementById('btn-add').addEventListener('click', openAdd);
document.getElementById('btn-setup').addEventListener('click', openSetupModal);
document.getElementById('btn-gcal-signin').addEventListener('click', signIn);
document.getElementById('btn-gcal-signout').addEventListener('click', signOut);
document.getElementById('btn-sync-all').addEventListener('click', syncAllToGCal);
document.getElementById('btn-cancel').addEventListener('click', closeModal);
document.getElementById('btn-save').addEventListener('click', saveDoc);
document.getElementById('btn-logout').addEventListener('click', signOut);

document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeSetupModal(); } if ((e.ctrlKey||e.metaKey) && e.key === 'n') { e.preventDefault(); openAdd(); } });

function setFilter(f) { filterStatus = f; document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === f)); viewMode === 'group' ? renderGrouped() : renderList(); }

// Init
document.addEventListener('DOMContentLoaded', initSupabase);
