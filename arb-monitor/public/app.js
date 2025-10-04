/* ==== app.js (full replacement, JS only) ==== */

/* ---------------- 全局变量 ---------------- */
let ws = null;
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let lastHeartbeat = 0;
let heartbeatTimer = null;

let settings = {};
let marketBoard = new Map();           // eventKey -> {league, home, away, score, books:Set, ou:{...}, ah:{...}, updatedAt}
let alertedSignatures = new Set();
let discoveredBooks = new Set(['parimatch', 'singbet']); // 默认书商，避免空白态
let hasUserInteracted = false;

/* ---------------- 默认设置 ---------------- */
const DEFAULT_SETTINGS = {
  datasource: { wsMode: 'auto', wsUrl: '', token: '', useMock: true },
  books: {},                                               // 书商开关
  rebates: { parimatch: { type: 'turnover', rate: 0.006 }, singbet: { type: 'turnover', rate: 0.006 } },
  stake: { aBook: 'parimatch', amountA: 10000, minProfit: 0 },
  notify: { systemEnabled: false, soundEnabled: true, toastEnabled: true, toastDurationS: 5, autoHideRowS: 30 },
};

/* ---------------- 工具&设置 ---------------- */
function normBookKey(book) { return (book || '').toLowerCase(); }
function getEventKey(opp) { return `${opp.league || ''}|${opp.event_name || ''}`; }
function formatTime(date = new Date()) {
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function loadSettings() {
  try {
    const saved = localStorage.getItem('arb_settings_v1');
    const loaded = saved ? JSON.parse(saved) : {};
    const merged = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      datasource: { ...DEFAULT_SETTINGS.datasource, ...(loaded.datasource || {}) },
      books: { ...DEFAULT_SETTINGS.books, ...(loaded.books || {}) },
      rebates: { ...DEFAULT_SETTINGS.rebates, ...(loaded.rebates || {}) },
      stake: { ...DEFAULT_SETTINGS.stake, ...(loaded.stake || {}) },
      notify: { ...DEFAULT_SETTINGS.notify, ...(loaded.notify || {}) },
    };
    return merged;
  } catch (_) { return DEFAULT_SETTINGS; }
}
function saveSettings() {
  try { localStorage.setItem('arb_settings_v1', JSON.stringify(settings)); } catch (_) {}
}
window.LoadSettings = loadSettings;
window.SaveSettings = saveSettings;

/* ---------------- 书商管理（动态） ---------------- */
function addDiscoveredBook(bookName) {
  if (!bookName) return;
  const k = normBookKey(bookName);
  if (!discoveredBooks.has(k)) {
    discoveredBooks.add(k);
    if (!(k in settings.books)) { settings.books[k] = true; saveSettings(); }
    renderBookList(); updateABookOptions(); renderRebateSettings?.();
  }
}
function clearDiscoveredBooks() {
  discoveredBooks.clear();
  if (settings.datasource?.useMock) { discoveredBooks.add('parimatch'); discoveredBooks.add('singbet'); }
  renderBookList(); updateABookOptions(); renderRebateSettings?.();
}
function renderBookList() {
  const container = document.getElementById('book-list');
  if (!container) return;
  container.innerHTML = '';

  if (discoveredBooks.size === 0) {
    container.innerHTML = '<div class="no-books-message">暂无书商数据</div>';
    return;
  }

  Array.from(discoveredBooks).sort().forEach(book => {
    const item = document.createElement('div'); item.className = 'book-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.id = `chk-book-${book}`; checkbox.value = book;
    checkbox.checked = settings.books[book] === true;

    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    label.textContent = book.charAt(0).toUpperCase() + book.slice(1);

    checkbox.addEventListener('change', () => {
      settings.books[book] = checkbox.checked; saveSettings();

      // 如果取消了当前 A 平台，自动切换
      const aSel = normBookKey(settings.stake?.aBook || '');
      if (!checkbox.checked && aSel === book) {
        const enabled = Object.entries(settings.books).filter(([, v]) => v).map(([k]) => k);
        settings.stake.aBook = enabled[0] || '';
        saveSettings(); updateABookOptions();
      }

      // 关键：切换书商后刷新表格（会过滤）
      renderMarketBoard();
      // 如果你在用套利表，也可以在这里触发重新计算：recalculateAllArbitrageOpportunities?.();
    });

    item.appendChild(checkbox);
    item.appendChild(label);
    container.appendChild(item);
  });
}
function updateABookOptions() {
  const select = document.getElementById('a-book');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '';

  const enabled = Array.from(discoveredBooks).filter(b => settings.books[b] === true).sort();
  if (enabled.length === 0) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '请先选择书商'; opt.disabled = true;
    select.appendChild(opt); return;
  }
  enabled.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b; opt.textContent = b.charAt(0).toUpperCase() + b.slice(1);
    select.appendChild(opt);
  });
  if (enabled.includes(current)) select.value = current;
  else { select.value = enabled[0]; settings.stake.aBook = enabled[0]; saveSettings(); }
}

/* ---------------- WebSocket ---------------- */
function connectWS() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  // mock 关闭 + 选自定义但没 URL -> 不连
  if (!settings.datasource?.useMock && settings.datasource?.wsMode === 'custom' && !(settings.datasource?.wsUrl || '').trim()) {
    updateConnectionStatus('connecting'); return;
  }

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = (!settings.datasource?.useMock && settings.datasource?.wsMode === 'custom')
    ? settings.datasource.wsUrl
    : `${protocol}://${location.host}/ws/opps`;

  updateConnectionStatus('connecting');

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => { wsReconnectAttempts = 0; updateConnectionStatus('connected'); startHeartbeatMonitor(); };
    ws.onmessage = (evt) => {
      try { handleWebSocketMessage(JSON.parse(evt.data)); } catch (e) { console.error('WS parse:', e); }
    };
    ws.onclose = () => { updateConnectionStatus('reconnecting'); stopHeartbeatMonitor(); scheduleReconnect(); };
    ws.onerror = (e) => { console.error('WS error:', e); };
  } catch (e) {
    console.error('WS create failed:', e); updateConnectionStatus('reconnecting'); scheduleReconnect();
  }
}
function scheduleReconnect() {
  const hasReal = settings.datasource?.wsMode === 'custom' && !!(settings.datasource?.wsUrl || '').trim();
  if (!settings.datasource?.useMock && !hasReal) return;
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectAttempts++;
  const delay = Math.min(30000, Math.pow(2, wsReconnectAttempts - 1) * 1000);
  wsReconnectTimer = setTimeout(connectWS, delay);
}
function startHeartbeatMonitor() {
  stopHeartbeatMonitor();
  heartbeatTimer = setInterval(() => {
    if (lastHeartbeat && Date.now() - lastHeartbeat > 30000) { try { ws.close(); } catch (_) {} }
  }, 5000);
}
function stopHeartbeatMonitor() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }
function reconnectNow() { try { ws && ws.close(); } catch (_) {} wsReconnectAttempts = 0; if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; } setTimeout(connectWS, 100); }

/* ---------------- WS 消息处理 ---------------- */
function handleWebSocketMessage(msg) {
  const realReady = !settings.datasource?.useMock && settings.datasource?.wsMode === 'custom' && !!(settings.datasource?.wsUrl || '').trim();
  if (!settings.datasource?.useMock && !realReady) return;

  switch (msg.type) {
    case 'heartbeat': lastHeartbeat = msg.ts || Date.now(); updateLastUpdateTime(); break;
    case 'snapshot':  handleSnapshot(msg.data || []); updateLastUpdateTime(); break;
    case 'opportunity': handleOpportunity(msg.data); updateLastUpdateTime(); break;
    default: console.warn('unknown msg:', msg.type);
  }
}

function handleSnapshot(list) {
  marketBoard.clear();
  clearArbitrageTable?.();

  if (settings.datasource?.useMock) clearDiscoveredBooks();

  list.forEach(opp => {
    if (opp?.pickA?.book) addDiscoveredBook(opp.pickA.book);
    if (opp?.pickB?.book) addDiscoveredBook(opp.pickB.book);
    updateMarketBoard(opp);
  });

  renderBookList();         // 确保左侧勾选 UI 同步
  renderMarketBoard();      // 重要：渲染时会按书商过滤
}

function handleOpportunity(opp) {
  if (!opp) return;
  if (opp?.pickA?.book) addDiscoveredBook(opp.pickA.book);
  if (opp?.pickB?.book) addDiscoveredBook(opp.pickB.book);
  updateMarketBoard(opp);
  renderMarketBoard();
}

/* ---------------- 行情维护 ---------------- */
function updateMarketBoard(opp) {
  const key = getEventKey(opp);
  const obj = marketBoard.get(key) || {
    league: '', home: '', away: '', score: '', books: new Set(),
    ou: { line: '', over: null, under: null }, ah: { line: '', home: null, away: null }, updatedAt: 0
  };

  if (opp.league) obj.league = opp.league;
  if (opp.event_name) {
    const ps = opp.event_name.split(' vs '); if (ps.length >= 2) { obj.home = ps[0].trim(); obj.away = ps[1].trim(); }
  }
  if (opp.score) obj.score = opp.score;
  obj.updatedAt = Date.now();

  if (opp.pickA?.book) obj.books.add(normBookKey(opp.pickA.book));
  if (opp.pickB?.book) obj.books.add(normBookKey(opp.pickB.book));

  if (opp.market === 'ou') {
    obj.ou.line = opp.line_text || String(opp.line_numeric ?? '');
    if (opp.pickA?.selection === 'over') obj.ou.over = { book: normBookKey(opp.pickA.book), odds: opp.pickA.odds };
    if (opp.pickB?.selection === 'under') obj.ou.under = { book: normBookKey(opp.pickB.book), odds: opp.pickB.odds };
  } else if (opp.market === 'ah') {
    obj.ah.line = opp.line_text || String(opp.line_numeric ?? '');
    if (opp.pickA?.selection === 'home') obj.ah.home = { book: normBookKey(opp.pickA.book), odds: opp.pickA.odds };
    if (opp.pickB?.selection === 'away') obj.ah.away = { book: normBookKey(opp.pickB.book), odds: opp.pickB.odds };
  }

  marketBoard.set(key, obj);
}

/* ---------------- 行情渲染（带过滤） ---------------- */
function renderMarketBoard() {
  const tbody = document.querySelector('#marketTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (marketBoard.size === 0) {
    tbody.innerHTML = '<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
    return;
  }

  const entries = Array.from(marketBoard.entries());
  const sortByTime = document.getElementById('sortByTime')?.classList.contains('active');
  if (sortByTime) entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  else entries.sort((a, b) => a[1].league.localeCompare(b[1].league));

  // 关键：当前启用的书商集合
  const enabled = new Set(Object.entries(settings.books).filter(([, v]) => v).map(([k]) => k));
  let shown = 0;

  for (const [, data] of entries) {
    // 没有任何书商选中 -> 不展示
    if (enabled.size === 0) continue;

    // 行中与启用书商是否有交集
    const hasEnabledBook = [...data.books].some(b => enabled.has(b));
    if (!hasEnabledBook) continue;

    const booksText = Array.from(data.books).join(', ');
    const ouText = data.ou.line
      ? `${data.ou.line} (${data.ou.over ? data.ou.over.odds : '-'}/${data.ou.under ? data.ou.under.odds : '-'})` : '-';
    const ahText = data.ah.line
      ? `${data.ah.line} (${data.ah.home ? data.ah.home.odds : '-'}/${data.ah.away ? data.ah.away.odds : '-'})` : '-';
    const timeText = data.updatedAt ? formatTime(new Date(data.updatedAt)) : '-';

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${booksText}</td>
      <td>${data.league || ''}</td>
      <td>${data.home || ''}</td>
      <td>${data.away || ''}</td>
      <td>${data.score || ''}</td>
      <td>${ouText}</td>
      <td>${ahText}</td>
      <td>${timeText}</td>
    `;
    tbody.appendChild(row);
    shown++;
  }

  if (shown === 0) {
    tbody.innerHTML = '<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
  }
}

/* ---------------- UI & 面板 ---------------- */
function updateConnectionStatus(status) {
  const badge = document.getElementById('statusBadge');
  const errorAlert = document.getElementById('connectionError');
  if (!badge) return;
  badge.className = `status-badge ${status}`;
  if (status === 'connected') { badge.textContent = '已连接'; if (errorAlert) errorAlert.style.display = 'none'; }
  else if (status === 'connecting') { badge.textContent = '连接中...'; if (errorAlert) errorAlert.style.display = 'none'; }
  else { badge.textContent = '重连中...'; if (errorAlert) errorAlert.style.display = 'block'; }
}
function updateLastUpdateTime() {
  const el = document.getElementById('lastUpdateTime');
  if (el) el.textContent = formatTime();
}

function initDatasourcePanel() {
  const wsModeAuto = document.getElementById('ws-mode-auto');
  const wsModeCustom = document.getElementById('ws-mode-custom');
  const wsUrlInput = document.getElementById('ws-url');
  const wsTokenInput = document.getElementById('ws-token');
  const useMockCheckbox = document.getElementById('use-mock');
  const testBtn = document.getElementById('test-connection');
  const reconnectBtn = document.getElementById('reconnect-now');

  const ds = settings.datasource || {};
  if (ds.wsMode === 'custom') { wsModeCustom && (wsModeCustom.checked = true); wsUrlInput && (wsUrlInput.disabled = false); }
  else { wsModeAuto && (wsModeAuto.checked = true); wsUrlInput && (wsUrlInput.disabled = true); }
  if (wsUrlInput) wsUrlInput.value = ds.wsUrl || '';
  if (wsTokenInput) wsTokenInput.value = ds.token || '';
  if (useMockCheckbox) useMockCheckbox.checked = ds.useMock !== false;

  wsModeAuto?.addEventListener('change', () => { if (wsModeAuto.checked) { settings.datasource.wsMode = 'auto'; wsUrlInput.disabled = true; saveSettings(); showReconnectButton(); }});
  wsModeCustom?.addEventListener('change', () => { if (wsModeCustom.checked) { settings.datasource.wsMode = 'custom'; wsUrlInput.disabled = false; saveSettings(); showReconnectButton(); }});
  wsUrlInput?.addEventListener('input', () => { settings.datasource.wsUrl = wsUrlInput.value; saveSettings(); showReconnectButton(); });
  wsTokenInput?.addEventListener('input', () => { settings.datasource.token = wsTokenInput.value; saveSettings(); showReconnectButton(); });

  function handleMockToggle() {
    settings.datasource.useMock = !!useMockCheckbox.checked; saveSettings();
    // 关闭 mock 时清屏
    if (!useMockCheckbox.checked) {
      marketBoard.clear(); renderMarketBoard();
      alertedSignatures.clear(); document.getElementById('toast-stack') && (document.getElementById('toast-stack').innerHTML = '');
      try { ws && ws.close(); } catch (_) {}
      if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    } else {
      discoveredBooks.add('parimatch'); discoveredBooks.add('singbet'); renderBookList(); updateABookOptions();
    }
    reconnectNow();
  }
  useMockCheckbox?.addEventListener('change', handleMockToggle);
  useMockCheckbox?.addEventListener('click', handleMockToggle);

  testBtn?.addEventListener('click', testConnection);
  reconnectBtn?.addEventListener('click', () => { reconnectNow(); hideReconnectButton(); });
}
function testConnection() {
  const btn = document.getElementById('test-connection'); if (!btn) return;
  btn.disabled = true; btn.textContent = '测试中...';

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = (settings.datasource?.wsMode === 'custom' && settings.datasource?.wsUrl)
    ? settings.datasource.wsUrl : `${protocol}://${location.host}/ws/opps`;

  const t = new WebSocket(url);
  const to = setTimeout(() => { try { t.close(); } catch (_) {} btn.disabled = false; btn.textContent = '测试连接'; showToast('连接测试', '连接超时', 'error'); }, 5000);

  t.onopen = () => { clearTimeout(to); try { t.close(); } catch (_) {} btn.disabled = false; btn.textContent = '测试连接'; showToast('连接测试', '连接成功', 'success'); };
  t.onerror = () => { clearTimeout(to); btn.disabled = false; btn.textContent = '测试连接'; showToast('连接测试', '连接失败', 'error'); };
}
function showReconnectButton() { const b = document.getElementById('reconnect-now'); b && (b.style.display = 'block'); }
function hideReconnectButton() { const b = document.getElementById('reconnect-now'); b && (b.style.display = 'none'); }

function initMarketControls() {
  const sortByLeague = document.getElementById('sortByLeague');
  const sortByTime = document.getElementById('sortByTime');
  sortByLeague?.addEventListener('click', () => { sortByLeague.classList.add('active'); sortByTime?.classList.remove('active'); renderMarketBoard(); });
  sortByTime?.addEventListener('click', () => { sortByTime.classList.add('active'); sortByLeague?.classList.remove('active'); renderMarketBoard(); });

  const collapseBtn = document.getElementById('market-collapse-btn');
  const marketPanel = document.getElementById('panel-marketboard');
  collapseBtn && marketPanel && collapseBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); marketPanel.open = !marketPanel.open; savePanelStates(); });
}

/* ---------------- Toast（简单版） ---------------- */
function showToast(title, message, type = 'info') {
  const container = document.getElementById('toast-stack'); if (!container) return;
  const toast = document.createElement('div'); toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-title">${title}</div><div class="toast-message">${message}</div>`;
  container.appendChild(toast);
  const d = (settings.notify?.toastDurationS || 5) * 1000;
  setTimeout(() => { toast.classList.add('removing'); setTimeout(() => toast.remove(), 200); }, d);
}

/* ---------------- 面板展开/收起状态 ---------------- */
function loadPanelStates() {
  try {
    const saved = localStorage.getItem('panel_state_v1');
    const states = saved ? JSON.parse(saved) : {};
    ['panel-datasource', 'panel-books', 'panel-rebates', 'panel-stake', 'panel-notify', 'panel-marketboard']
      .forEach(id => { const p = document.getElementById(id); if (p) { p.open = (id === 'panel-marketboard') ? (states[id] === true) : (states[id] !== false); } });
  } catch (_) {}
}
function savePanelStates() {
  try {
    const states = {};
    ['panel-datasource', 'panel-books', 'panel-rebates', 'panel-stake', 'panel-notify', 'panel-marketboard']
      .forEach(id => { const p = document.getElementById(id); if (p) states[id] = p.open; });
    localStorage.setItem('panel_state_v1', JSON.stringify(states));
  } catch (_) {}
}

/* ---------------- 套利表（只留空壳避免报错） ---------------- */
function clearArbitrageTable() {
  const t = document.querySelector('#arbitrageTable tbody');
  if (t) t.innerHTML = '<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
}

/* ---------------- 页面启动 ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  settings = loadSettings();

  // 左边抽屉/面板
  loadPanelStates();
  document.querySelectorAll('#drawer details').forEach(d => d.addEventListener('toggle', savePanelStates));

  // 数据源配置 & 市场控制
  initDatasourcePanel();
  initMarketControls();

  // 书商面板
  renderBookList(); updateABookOptions();

  // 通知权限
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();

  // 用户交互标记（用于声音等）
  document.addEventListener('click', () => hasUserInteracted = true, { once: true });
  document.addEventListener('keydown', () => hasUserInteracted = true, { once: true });

  // 连接 WS
  connectWS();
});
