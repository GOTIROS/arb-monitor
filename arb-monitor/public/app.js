/* ==== app.js (full replacement) ==== */

/* ========== 全局变量 ========== */
let ws = null;
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let lastHeartbeat = 0;
let heartbeatTimer = null;
let settings = {};
let marketBoard = new Map();
let alertedSignatures = new Set();
let hasUserInteracted = false;
let discoveredBooks = new Set(['parimatch', 'singbet']); // 默认展示两个书商，避免空状态
let activeToasts = new Map(); // key -> { toast, timer }

/* ========== 默认设置 ========== */
const DEFAULT_SETTINGS = {
  datasource: { wsMode: 'auto', wsUrl: '', token: '', useMock: true },
  books: {},
  rebates: {
    parimatch: { type: 'turnover', rate: 0.006 },
    singbet: { type: 'turnover', rate: 0.006 }
  },
  stake: { aBook: 'parimatch', amountA: 10000, minProfit: 0 },
  notify: {
    systemEnabled: false,
    soundEnabled: true,
    toastEnabled: true,
    toastDurationS: 5,
    autoHideRowS: 30
  }
};

/* ========== 设置管理 ========== */
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
      notify: { ...DEFAULT_SETTINGS.notify, ...(loaded.notify || {}) }
    };
    return merged;
  } catch (e) {
    console.error('加载设置失败：', e);
    return DEFAULT_SETTINGS;
  }
}
function saveSettings() {
  try {
    localStorage.setItem('arb_settings_v1', JSON.stringify(settings));
  } catch (e) {
    console.error('保存设置失败：', e);
  }
}
window.LoadSettings = loadSettings;
window.SaveSettings = saveSettings;

/* ========== 书商管理 ========== */
function normBookKey(book) {
  return book ? book.toLowerCase() : '';
}
function addDiscoveredBook(bookName) {
  if (!bookName) return;
  const b = normBookKey(bookName);
  if (!discoveredBooks.has(b)) {
    discoveredBooks.add(b);
    if (!(b in settings.books)) {
      settings.books[b] = true; // 新发现书商默认启用
      saveSettings();
    }
    renderBookList();
    renderRebateSettings();
    updateABookOptions();
  }
}
function clearDiscoveredBooks() {
  discoveredBooks.clear();
  if (settings.datasource?.useMock) {
    discoveredBooks.add('parimatch');
    discoveredBooks.add('singbet');
  }
  renderBookList();
  renderRebateSettings();
  updateABookOptions();
}

function renderBookList() {
  const container = document.getElementById('book-list');
  if (!container) return;

  container.innerHTML = '';
  if (discoveredBooks.size === 0) {
    container.innerHTML = '<div class="no-books-message">暂无书商数据</div>';
    return;
  }
  const sortedBooks = Array.from(discoveredBooks).sort();
  sortedBooks.forEach(book => {
    const item = document.createElement('div');
    item.className = 'book-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `chk-book-${book}`;
    checkbox.value = book;
    checkbox.checked = settings.books[book] || false;

    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    label.textContent = book.charAt(0).toUpperCase() + book.slice(1);

    checkbox.addEventListener('change', () => {
      settings.books[book] = checkbox.checked;

      const currentABook = normBookKey(settings.stake?.aBook || '');
      if (!checkbox.checked && currentABook === book) {
        const enabledBooks = Object.entries(settings.books)
          .filter(([_, enabled]) => enabled)
          .map(([bookName, _]) => bookName);
        settings.stake.aBook = enabledBooks[0] || '';
        updateABookOptions();
      }
      saveSettings();
      renderRebateSettings();
      renderMarketBoard();       // 立即刷新盘口总览（受书商过滤）
      recalculateAllArbitrageOpportunities(); // 重新计算套利机会
    });

    item.appendChild(checkbox);
    item.appendChild(label);
    container.appendChild(item);
  });
}

function renderRebateSettings() {
  const container = document.querySelector('#panel-rebates .panel-content');
  if (!container) return;

  container.innerHTML = '';
  if (discoveredBooks.size === 0) {
    container.innerHTML = '<div class="no-books-message">暂无书商数据</div>';
    return;
  }

  const enabled = Array.from(discoveredBooks).filter(b => settings.books[b]).sort();
  if (enabled.length === 0) {
    container.innerHTML = '<div class="no-books-message">请先选择书商</div>';
    return;
  }

  enabled.forEach(book => {
    const rebateGroup = document.createElement('div');
    rebateGroup.className = 'rebate-group';

    const bookTitle = book.charAt(0).toUpperCase() + book.slice(1);
    const current = settings.rebates[book] || { type: 'turnover', rate: 0.006 };

    rebateGroup.innerHTML = `
      <h4>${bookTitle}</h4>
      <div class="form-row">
        <label>类型：</label>
        <select id="${book}-type">
          <option value="turnover" ${current.type === 'turnover' ? 'selected' : ''}>Turnover</option>
          <option value="net_loss" ${current.type === 'net_loss' ? 'selected' : ''}>Net Loss</option>
        </select>
      </div>
      <div class="form-row">
        <label>比例：</label>
        <input type="number" id="${book}-rate" step="0.001" min="0" max="1" value="${current.rate}" placeholder="0.006">
      </div>
    `;
    container.appendChild(rebateGroup);

    const typeSelect = rebateGroup.querySelector(`#${book}-type`);
    const rateInput  = rebateGroup.querySelector(`#${book}-rate`);

    typeSelect.addEventListener('change', () => {
      settings.rebates[book] = settings.rebates[book] || {};
      settings.rebates[book].type = typeSelect.value;
      saveSettings();
      recalculateAllArbitrageOpportunities();
    });
    rateInput.addEventListener('input', () => {
      settings.rebates[book] = settings.rebates[book] || {};
      settings.rebates[book].rate = parseFloat(rateInput.value) || 0;
      saveSettings();
      recalculateAllArbitrageOpportunities();
    });
  });
}

function updateABookOptions() {
  const select = document.getElementById('a-book');
  if (!select) return;

  const currentValue = select.value;
  select.innerHTML = '';

  const enabled = Array.from(discoveredBooks).filter(b => settings.books[b]).sort();
  if (enabled.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '请先选择书商';
    opt.disabled = true;
    select.appendChild(opt);
    settings.stake.aBook = '';
    saveSettings();
    return;
  }
  enabled.forEach(book => {
    const opt = document.createElement('option');
    opt.value = book;
    opt.textContent = book.charAt(0).toUpperCase() + book.slice(1);
    select.appendChild(opt);
  });

  if (enabled.includes(currentValue)) {
    select.value = currentValue;
  } else {
    select.value = enabled[0];
    settings.stake.aBook = enabled[0];
    saveSettings();
  }
}

/* ========== 通用工具 ========== */
function getEventKey(opp) {
  return `${opp.league || ''}|${opp.event_name || ''}`;
}
function formatTime(date = new Date()) {
  return date.toLocaleTimeString('zh-CN', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

// 中文展示
function zhMarket(market) {
  return market === 'ah' ? '让球' : '大小球';
}
function zhSelection(market, selection) {
  if (market === 'ah') {
    if (selection === 'home')  return '主队';
    if (selection === 'away')  return '客队';
    return selection;
  } else { // ou
    if (selection === 'over')  return '大';
    if (selection === 'under') return '小';
    return selection;
  }
}
function fmtMoney(n) {
  return Number(n || 0).toLocaleString();
}

/* ========== WebSocket 连接 ========== */
function connectWS() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  if (!settings.datasource?.useMock
    && settings.datasource?.wsMode === 'custom'
    && !((settings.datasource?.wsUrl || '').trim())) {
    updateConnectionStatus('connecting');
    return;
  }

  let wsUrl;
  if (!settings.datasource?.useMock && settings.datasource?.wsMode === 'custom') {
    wsUrl = settings.datasource.wsUrl;
  } else {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    wsUrl = `${protocol}://${location.host}/ws/opps`;
  }

  updateConnectionStatus('connecting');
  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      wsReconnectAttempts = 0;
      updateConnectionStatus('connected');
      startHeartbeatMonitor();
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWebSocketMessage(msg);
      } catch (e) {
        console.error('解析 WebSocket 消息失败：', e);
      }
    };
    ws.onclose = () => {
      updateConnectionStatus('reconnecting');
      stopHeartbeatMonitor();
      if (!(!settings.datasource?.useMock && settings.datasource?.wsMode !== 'custom')) {
        scheduleReconnect();
      }
    };
    ws.onerror = (err) => {
      console.error('WebSocket 错误：', err);
    };
  } catch (e) {
    console.error('创建 WebSocket 连接失败：', e);
    updateConnectionStatus('reconnecting');
    scheduleReconnect();
  }
}
function reconnectNow() {
  if (ws) ws.close();
  wsReconnectAttempts = 0;
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  setTimeout(connectWS, 100);
}
function testConnection() {
  const btn = document.getElementById('test-connection');
  if (!btn) return;
  btn.disabled = true; btn.textContent = '测试中...';

  const url = (settings.datasource?.wsMode === 'custom' && settings.datasource?.wsUrl)
    ? settings.datasource.wsUrl
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/opps`;

  const testWs = new WebSocket(url);
  const timeout = setTimeout(() => {
    testWs.close();
    btn.disabled = false; btn.textContent = '测试连接';
    showToast('连接测试', '连接超时', 'error');
  }, 5000);

  testWs.onopen = () => {
    clearTimeout(timeout); testWs.close();
    btn.disabled = false; btn.textContent = '测试连接';
    showToast('连接测试', '连接成功', 'success');
  };
  testWs.onerror = (e) => {
    clearTimeout(timeout);
    btn.disabled = false; btn.textContent = '测试连接';
    showToast('连接测试', '连接失败：' + (e.message || '未知错误'), 'error');
  };
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
    const now = Date.now();
    if (lastHeartbeat && (now - lastHeartbeat > 30000)) {
      ws?.close();
    }
  }, 5000);
}
function stopHeartbeatMonitor() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

/* ========== WebSocket 消息处理 ========== */
function handleWebSocketMessage(message) {
  const realBackendReady = !settings.datasource?.useMock
    && settings.datasource?.wsMode === 'custom'
    && !!(settings.datasource?.wsUrl || '').trim();
  if (!settings.datasource?.useMock && !realBackendReady) return;

  switch (message.type) {
    case 'heartbeat':
      lastHeartbeat = message.ts || Date.now();
      updateLastUpdateTime();
      break;
    case 'snapshot':
      handleSnapshot(message.data || []);
      updateLastUpdateTime();
      break;
    case 'opportunity':
      handleOpportunity(message.data);
      updateLastUpdateTime();
      break;
    default:
      console.warn('未知消息类型：', message.type);
  }
}

/* ========== 盘口与套利 ========== */
function handleSnapshot(opps) {
  marketBoard.clear();
  clearArbitrageTable();
  if (settings.datasource?.useMock) clearDiscoveredBooks();

  opps.forEach(opp => {
    if (opp.pickA?.book) addDiscoveredBook(opp.pickA.book);
    if (opp.pickB?.book) addDiscoveredBook(opp.pickB.book);
    processOpportunity(opp, false);
  });
  renderMarketBoard();
}
function handleOpportunity(opp) {
  if (!opp) return;
  if (opp.pickA?.book) addDiscoveredBook(opp.pickA.book);
  if (opp.pickB?.book) addDiscoveredBook(opp.pickB.book);
  processOpportunity(opp, true);
  renderMarketBoard();
}

function processOpportunity(opp, shouldAlert = false) {
  if (!opp?.event_id) return;
  updateMarketBoard(opp);
  const result = calculateArbitrage(opp);
  if (result) addArbitrageOpportunity(result, shouldAlert);
}

function updateMarketBoard(opp) {
  const eventId = getEventKey(opp);
  const existing = marketBoard.get(eventId) || {
    league: '', home: '', away: '', score: '',
    books: new Set(),
    ou: { line: '', over: null, under: null },
    ah: { line: '', home: null, away: null },
    updatedAt: 0
  };

  if (opp.league) existing.league = opp.league;
  if (opp.event_name) {
    const parts = opp.event_name.split(' vs ');
    if (parts.length >= 2) { existing.home = parts[0].trim(); existing.away = parts[1].trim(); }
  }
  if (opp.score) existing.score = opp.score;
  existing.updatedAt = Date.now();

  if (opp.pickA?.book) existing.books.add(normBookKey(opp.pickA.book));
  if (opp.pickB?.book) existing.books.add(normBookKey(opp.pickB.book));

  if (opp.market === 'ou') {
    existing.ou.line = opp.line_text || String(opp.line_numeric || '');
    if (opp.pickA?.selection === 'over')  existing.ou.over  = { book: normBookKey(opp.pickA.book), odds: opp.pickA.odds };
    if (opp.pickB?.selection === 'under') existing.ou.under = { book: normBookKey(opp.pickB.book), odds: opp.pickB.odds };
  } else {
    existing.ah.line = opp.line_text || String(opp.line_numeric || '');
    if (opp.pickA?.selection === 'home') existing.ah.home = { book: normBookKey(opp.pickA.book), odds: opp.pickA.odds };
    if (opp.pickB?.selection === 'away') existing.ah.away = { book: normBookKey(opp.pickB.book), odds: opp.pickB.odds };
  }

  marketBoard.set(eventId, existing);
}

function calculateArbitrage(opp) {
  if (!opp.pickA || !opp.pickB || !settings) return null;

  const bookA = normBookKey(opp.pickA.book);
  const bookB = normBookKey(opp.pickB.book);
  const aBook  = normBookKey(settings.stake?.aBook || '');

  // 只有启用的书商才参与计算
  if (!settings.books[bookA] || !settings.books[bookB]) return null;

  let isABookInvolved = false, pickA, pickB, sideA, sideB;
  if (bookA === aBook) {
    isABookInvolved = true; pickA = opp.pickA; pickB = opp.pickB; sideA = 'A'; sideB = 'B';
  } else if (bookB === aBook) {
    isABookInvolved = true; pickA = opp.pickB; pickB = opp.pickA; sideA = 'B'; sideB = 'A';
  } else {
    pickA = opp.pickA; pickB = opp.pickB; sideA = '—'; sideB = 'B';
  }

  const oA = parseFloat(pickA.odds) || 0;
  const oB = parseFloat(pickB.odds) || 0;
  const sA = parseInt(settings.stake?.amountA) || 10000;
  if (oA <= 1 || oB <= 1) return null;

  const rebateA = settings.rebates?.[normBookKey(pickA.book)] || { type: 'turnover', rate: 0 };
  const rebateB = settings.rebates?.[normBookKey(pickB.book)] || { type: 'turnover', rate: 0 };
  const rA = rebateA.rate || 0, rB = rebateB.rate || 0;
  const tA = rebateA.type || 'turnover', tB = rebateB.type || 'turnover';

  let sB;
  if (tA === 'turnover' && tB === 'turnover') {
    sB = sA * oA / oB;
  } else if (tA === 'net_loss' && tB === 'net_loss') {
    const d = oB - rB; if (d <= 0) return null;
    sB = sA * (oA - rA) / d;
  } else if (tA === 'turnover' && tB === 'net_loss') {
    const d = oB - rB; if (d <= 0) return null;
    sB = sA * oA / d;
  } else if (tA === 'net_loss' && tB === 'turnover') {
    sB = sA * (oA - rA) / oB;
  } else {
    return null;
  }
  if (sB <= 0) return null;

  const profit = sA * oA - (sA + sB) + (tA === 'turnover' ? rA * sA : 0) + rB * sB;
  const minProfit = parseInt(settings.stake?.minProfit) || 0;
  const shouldAlert = isABookInvolved && profit >= minProfit;

  return {
    opportunity: opp,
    sideA, sideB,
    pickA, pickB,
    waterA: (oA - 1).toFixed(3),
    waterB: (oB - 1).toFixed(3),
    stakeB: Math.round(sB),
    profit: Math.round(profit),
    shouldAlert,
    signature: generateSignature(opp)
  };
}

function generateSignature(opp) {
  const books = [
    `${opp.pickA?.book || ''}_${opp.pickA?.selection || ''}`,
    `${opp.pickB?.book || ''}_${opp.pickB?.selection || ''}`
  ].sort();
  return `${getEventKey(opp)}_${opp.market}_${opp.line_text || opp.line_numeric || ''}_${books.join('_')}`;
}

/* ========== 套利机会表格 ========== */
function addArbitrageOpportunity(result, shouldAlert) {
  const tbody = document.querySelector('#arbitrageTable tbody');
  const signature = result.signature;
  const minProfit = parseInt(settings.stake?.minProfit) || 0;

  const existingRow = tbody.querySelector(`tr[data-signature="${signature}"]`);
  if (existingRow) {
    if (result.profit < minProfit) {
      existingRow.remove();
      alertedSignatures.delete(signature);
      return;
    }
    updateArbitrageRow(existingRow, result);
    if (shouldAlert) highlightRow(existingRow);
    return;
  }

  if (result.profit < minProfit) return;

  const noDataRow = tbody.querySelector('.no-data');
  if (noDataRow) noDataRow.remove();

  const row = createArbitrageRow(result);
  tbody.appendChild(row);

  if (result.shouldAlert && shouldAlert) {
    highlightRow(row);
    sendAlert(result);
    if (settings.notify?.autoHideRowS > 0) {
      setTimeout(() => row.classList.add('hidden-row'), settings.notify.autoHideRowS * 1000);
    }
  }
}
function createArbitrageRow(result) {
  const row = document.createElement('tr');
  row.setAttribute('data-signature', result.signature);

  const opp = result.opportunity;
  const marketText = zhMarket(opp.market);
  const lineText   = opp.line_text || String(opp.line_numeric || '');

  row.innerHTML = `
    <td>${opp.event_name || ''}</td>
    <td>${marketText} ${lineText}</td>
    <td>${result.sideA}（${zhSelection(opp.market, result.pickA.selection)}）</td>
    <td>${result.sideB}（${zhSelection(opp.market, result.pickB.selection)}）</td>
    <td>${result.waterA}</td>
    <td>${result.waterB}</td>
    <td>${result.sideA === '—' ? '—' : fmtMoney(result.stakeB)}</td>
    <td>${fmtMoney(result.profit)}</td>
  `;
  return row;
}
function updateArbitrageRow(row, result) {
  const cells = row.cells;
  if (cells.length >= 8) {
    cells[4].textContent = result.waterA;
    cells[5].textContent = result.waterB;
    cells[6].textContent = (result.sideA === '—') ? '—' : fmtMoney(result.stakeB);
    cells[7].textContent = fmtMoney(result.profit);
  }
}
function highlightRow(row) {
  row.classList.add('highlighted');
  setTimeout(() => row.classList.remove('highlighted'), 1800);
}
function clearArbitrageTable() {
  const tbody = document.querySelector('#arbitrageTable tbody');
  tbody.innerHTML = '<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
}
function recalculateAllArbitrageOpportunities() {
  clearArbitrageTable();
  marketBoard.forEach((data, eventId) => {
    // 大小球
    if (data.ou.line && data.ou.over && data.ou.under) {
      const ouOpp = {
        event_id: eventId, event_name: `${data.home} vs ${data.away}`,
        league: data.league, market: 'ou',
        line_text: data.ou.line, line_numeric: parseFloat(data.ou.line) || 0,
        pickA: { book: data.ou.over.book, selection: 'over',  odds: data.ou.over.odds },
        pickB: { book: data.ou.under.book, selection: 'under', odds: data.ou.under.odds },
        score: data.score
      };
      const r = calculateArbitrage(ouOpp);
      if (r) addArbitrageOpportunity(r, false);
    }
    // 让球
    if (data.ah.line && data.ah.home && data.ah.away) {
      const ahOpp = {
        event_id: eventId, event_name: `${data.home} vs ${data.away}`,
        league: data.league, market: 'ah',
        line_text: data.ah.line, line_numeric: parseFloat(data.ah.line) || 0,
        pickA: { book: data.ah.home.book, selection: 'home', odds: data.ah.home.odds },
        pickB: { book: data.ah.away.book, selection: 'away', odds: data.ah.away.odds },
        score: data.score
      };
      const r = calculateArbitrage(ahOpp);
      if (r) addArbitrageOpportunity(r, false);
    }
  });
}

/* ========== 提醒：中文文案 + 金额 ========== */
function sendAlert(result) {
  const signature = result.signature;

  const realBackendReady = !settings.datasource?.useMock
    && settings.datasource?.wsMode === 'custom'
    && !!(settings.datasource?.wsUrl || '').trim();
  if (!settings.datasource?.useMock && !realBackendReady) return;

  if (alertedSignatures.has(signature)) return;
  alertedSignatures.add(signature);

  const opp = result.opportunity;
  const marketText = zhMarket(opp.market);
  const lineText   = opp.line_text || String(opp.line_numeric || '');

  const sA = Number(settings.stake?.amountA || 10000);
  const sB = Number(result.stakeB || 0);

  const pickAZh = zhSelection(opp.market, result.pickA.selection);
  const pickBZh = zhSelection(opp.market, result.pickB.selection);

  const message =
    `A平台：${marketText}${lineText} ${pickAZh}，水位${result.waterA}，固定下注 ¥${fmtMoney(sA)}；` +
    `B平台：${marketText}${lineText} ${pickBZh}，水位${result.waterB}，应下注 ¥${fmtMoney(sB)}。` +
    `均衡盈利：¥${fmtMoney(result.profit)}。`;

  if (settings.notify?.toastEnabled) showToast('套利机会', message, 'success');

  if (settings.notify?.systemEnabled && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('套利机会', { body: message, icon: '/favicon.ico' });
  }

  if (settings.notify?.soundEnabled && hasUserInteracted) {
    playNotificationSound();
  }
}

/* ========== Toast & 声音 ========== */
function showToast(title, message, type = 'info') {
  const container = document.getElementById('toast-stack');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-title">${title}</div><div class="toast-message">${message}</div>`;
  container.appendChild(toast);

  const duration = (settings.notify?.toastDurationS || 5) * 1000;
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.parentNode && toast.parentNode.removeChild(toast), 200);
  }, duration);
}
function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.setValueAtTime(1000, ctx.currentTime + 0.1);
    osc.frequency.setValueAtTime(800, ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.3);
  } catch (e) { console.warn('无法播放通知音：', e); }
}

/* ========== 盘口行情渲染（受书商过滤） ========== */
function renderMarketBoard() {
  const tbody = document.querySelector('#marketTable tbody');
  tbody.innerHTML = '';

  const enabledBooks = new Set(Object.entries(settings.books).filter(([_, v]) => v).map(([k]) => k));
  if (enabledBooks.size === 0 || marketBoard.size === 0) {
    tbody.innerHTML = '<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
    return;
  }

  const entries = Array.from(marketBoard.entries());
  // 书商过滤：若该场赛事的 books 与已启用书商没有交集，则不显示
  const filtered = entries.filter(([_, data]) => {
    const hasAny = Array.from(data.books).some(b => enabledBooks.has(b));
    return hasAny;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
    return;
  }

  const sortByTime = document.getElementById('sortByTime')?.classList.contains('active');
  if (sortByTime) filtered.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  else filtered.sort((a, b) => a[1].league.localeCompare(b[1].league));

  filtered.forEach(([eventId, data]) => {
    const row = document.createElement('tr');
    const booksText = Array.from(data.books).join(', ');
    const ouText = data.ou.line
      ? `${data.ou.line} (${data.ou.over ? data.ou.over.odds : '-'}/${data.ou.under ? data.ou.under.odds : '-'})`
      : '-';
    const ahText = data.ah.line
      ? `${data.ah.line} (${data.ah.home ? data.ah.home.odds : '-'}/${data.ah.away ? data.ah.away.odds : '-'})`
      : '-';
    const timeText = data.updatedAt ? formatTime(new Date(data.updatedAt)) : '-';

    row.innerHTML = `
      <td>${booksText}</td>
      <td>${data.league}</td>
      <td>${data.home}</td>
      <td>${data.away}</td>
      <td>${data.score}</td>
      <td>${ouText}</td>
      <td>${ahText}</td>
      <td>${timeText}</td>
    `;
    tbody.appendChild(row);
  });
}

/* ========== UI 初始化 ========== */
function initUI(loadedSettings) {
  settings = loadedSettings;

  initHamburgerMenu();
  initSettingsPanels();
  initMarketControls();
  requestNotificationPermission();

  document.addEventListener('click', () => hasUserInteracted = true, { once: true });
  document.addEventListener('keydown', () => hasUserInteracted = true, { once: true });
}

function initHamburgerMenu() {
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const drawer = document.getElementById('drawer');
  const drawerOverlay = document.getElementById('drawerOverlay');

  function openDrawer() {
    drawer.classList.add('active');
    drawerOverlay.classList.add('active');
    hamburgerBtn.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
  function closeDrawer() {
    drawer.classList.remove('active');
    drawerOverlay.classList.remove('active');
    hamburgerBtn.classList.remove('active');
    document.body.style.overflow = '';
  }

  hamburgerBtn?.addEventListener('click', openDrawer);
  drawerOverlay?.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer?.classList.contains('active')) closeDrawer(); });

  const expandAllBtn = document.getElementById('expandAllBtn');
  const collapseAllBtn = document.getElementById('collapseAllBtn');
  expandAllBtn?.addEventListener('click', () => {
    document.querySelectorAll('#drawer details').forEach(d => d.open = true);
    savePanelStates();
  });
  collapseAllBtn?.addEventListener('click', () => {
    document.querySelectorAll('#drawer details').forEach(d => d.open = false);
    savePanelStates();
  });
}

function initSettingsPanels() {
  loadPanelStates();
  document.querySelectorAll('#drawer details').forEach(details => {
    details.addEventListener('toggle', savePanelStates);
  });

  initDatasourcePanel();
  renderBookList();
  renderRebateSettings();

  updateStakeInputs();
  const aBookSelect  = document.getElementById('a-book');
  const amountAInput = document.getElementById('amount-a');
  const minProfitInp = document.getElementById('min-profit');

  aBookSelect?.addEventListener('change', () => {
    settings.stake = settings.stake || {};
    settings.stake.aBook = aBookSelect.value;
    saveSettings();
  });
  amountAInput?.addEventListener('input', () => {
    settings.stake = settings.stake || {};
    settings.stake.amountA = parseInt(amountAInput.value) || 0;
    saveSettings();
    recalculateAllArbitrageOpportunities();
  });
  minProfitInp?.addEventListener('input', () => {
    settings.stake = settings.stake || {};
    settings.stake.minProfit = parseInt(minProfitInp.value) || 0;
    saveSettings();
    recalculateAllArbitrageOpportunities();
  });

  updateNotifyInputs();
  const systemNotify  = document.getElementById('system-notify');
  const soundNotify   = document.getElementById('sound-notify');
  const toastNotify   = document.getElementById('toast-notify');
  const toastDuration = document.getElementById('toast-duration');
  const autoHideRow   = document.getElementById('auto-hide-row');
  const clearAlerts   = document.getElementById('clear-alerts');

  systemNotify?.addEventListener('change', () => {
    settings.notify = settings.notify || {};
    settings.notify.systemEnabled = systemNotify.checked;
    saveSettings();
    if (systemNotify.checked) requestNotificationPermission();
  });
  soundNotify?.addEventListener('change', () => {
    settings.notify = settings.notify || {};
    settings.notify.soundEnabled = soundNotify.checked;
    saveSettings();
  });
  toastNotify?.addEventListener('change', () => {
    settings.notify = settings.notify || {};
    settings.notify.toastEnabled = toastNotify.checked;
    saveSettings();
  });
  toastDuration?.addEventListener('input', () => {
    settings.notify = settings.notify || {};
    settings.notify.toastDurationS = parseInt(toastDuration.value) || 5;
    saveSettings();
  });
  autoHideRow?.addEventListener('input', () => {
    settings.notify = settings.notify || {};
    settings.notify.autoHideRowS = parseInt(autoHideRow.value) || 0;
    saveSettings();
  });
  clearAlerts?.addEventListener('click', () => {
    alertedSignatures.clear();
    document.querySelectorAll('#arbitrageTable tbody tr.hidden-row').forEach(r => r.classList.remove('hidden-row'));
    showToast('系统', '已清除提醒记录', 'success');
  });
}

function initDatasourcePanel() {
  const wsModeAuto   = document.getElementById('ws-mode-auto');
  const wsModeCustom = document.getElementById('ws-mode-custom');
  const wsUrlInput   = document.getElementById('ws-url');
  const wsTokenInput = document.getElementById('ws-token');
  const useMockCheck = document.getElementById('use-mock');
  const testBtn      = document.getElementById('test-connection');
  const reconnectBtn = document.getElementById('reconnect-now');

  const ds = settings.datasource || {};
  if (ds.wsMode === 'custom') { wsModeCustom.checked = true; wsUrlInput.disabled = false; }
  else                         { wsModeAuto.checked   = true; wsUrlInput.disabled = true;  }

  wsUrlInput.value   = ds.wsUrl   || '';
  wsTokenInput.value = ds.token   || '';
  useMockCheck.checked = ds.useMock !== false;

  wsModeAuto?.addEventListener('change', () => {
    if (wsModeAuto.checked) { settings.datasource.wsMode = 'auto'; wsUrlInput.disabled = true; saveSettings(); showReconnectButton(); }
  });
  wsModeCustom?.addEventListener('change', () => {
    if (wsModeCustom.checked) { settings.datasource.wsMode = 'custom'; wsUrlInput.disabled = false; saveSettings(); showReconnectButton(); }
  });
  wsUrlInput?.addEventListener('input', () => { settings.datasource.wsUrl = wsUrlInput.value; saveSettings(); showReconnectButton(); });
  wsTokenInput?.addEventListener('input', () => { settings.datasource.token = wsTokenInput.value; saveSettings(); showReconnectButton(); });

  const handleMockToggle = () => {
    settings.datasource.useMock = useMockCheck.checked; saveSettings();
    if (!useMockCheck.checked) {
      marketBoard.clear(); clearArbitrageTable(); clearDiscoveredBooks(); renderMarketBoard();
      alertedSignatures.clear(); document.getElementById('toast-stack').innerHTML = '';
      if (ws) ws.close(); if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    } else {
      discoveredBooks.add('parimatch'); discoveredBooks.add('singbet');
      renderBookList(); renderRebateSettings(); updateABookOptions();
    }
    alertedSignatures.clear(); reconnectNow();
  };
  useMockCheck?.addEventListener('change', handleMockToggle);
  useMockCheck?.addEventListener('click',  handleMockToggle);
  const container = useMockCheck?.closest('.toggle-item');
  container?.addEventListener('click', (e) => { if (e.target !== useMockCheck) { e.preventDefault(); useMockCheck.checked = !useMockCheck.checked; handleMockToggle(); } });

  testBtn?.addEventListener('click', testConnection);
  reconnectBtn?.addEventListener('click', () => { reconnectNow(); hideReconnectButton(); });
}
function showReconnectButton() {
  const btn = document.getElementById('reconnect-now');
  if (btn) btn.style.display = 'block';
}
function hideReconnectButton() {
  const btn = document.getElementById('reconnect-now');
  if (btn) btn.style.display = 'none';
}

function updateStakeInputs() {
  const stake = settings.stake || {};
  const amountAInput = document.getElementById('amount-a');
  const minProfitInp = document.getElementById('min-profit');
  if (amountAInput) amountAInput.value = stake.amountA || 10000;
  if (minProfitInp)  minProfitInp.value  = stake.minProfit || 0;
  updateABookOptions();
}
function updateNotifyInputs() {
  const notify = settings.notify || {};
  const systemNotify  = document.getElementById('system-notify');
  const soundNotify   = document.getElementById('sound-notify');
  const toastNotify   = document.getElementById('toast-notify');
  const toastDuration = document.getElementById('toast-duration');
  const autoHideRow   = document.getElementById('auto-hide-row');

  if (systemNotify)  systemNotify.checked  = !!notify.systemEnabled;
  if (soundNotify)   soundNotify.checked   = notify.soundEnabled !== false;
  if (toastNotify)   toastNotify.checked   = notify.toastEnabled !== false;
  if (toastDuration) toastDuration.value   = notify.toastDurationS || 5;
  if (autoHideRow)   autoHideRow.value     = notify.autoHideRowS || 30;
}

function initMarketControls() {
  const sortByLeague = document.getElementById('sortByLeague');
  const sortByTime   = document.getElementById('sortByTime');
  const collapseBtn  = document.getElementById('market-collapse-btn');
  const marketPanel  = document.getElementById('panel-marketboard');

  sortByLeague?.addEventListener('click', () => {
    sortByLeague.classList.add('active'); sortByTime.classList.remove('active'); renderMarketBoard();
  });
  sortByTime?.addEventListener('click', () => {
    sortByTime.classList.add('active');   sortByLeague.classList.remove('active'); renderMarketBoard();
  });

  if (collapseBtn && marketPanel) {
    collapseBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); marketPanel.open = !marketPanel.open; savePanelStates(); });
  }
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

function updateConnectionStatus(status) {
  const badge = document.getElementById('statusBadge');
  const errorAlert = document.getElementById('connectionError');
  if (!badge) return;
  badge.className = `status-badge ${status}`;
  switch (status) {
    case 'connected':   badge.textContent = '已连接';  if (errorAlert) errorAlert.style.display = 'none'; break;
    case 'connecting':  badge.textContent = '连接中...'; if (errorAlert) errorAlert.style.display = 'none'; break;
    case 'reconnecting':badge.textContent = '重连中...'; if (errorAlert) errorAlert.style.display = 'block'; break;
  }
}
function updateLastUpdateTime() {
  const el = document.getElementById('lastUpdateTime');
  if (el) el.textContent = formatTime();
}

/* ========== 启动入口 ========== */
document.addEventListener('DOMContentLoaded', () => {
  const loaded = loadSettings();
  initUI(loaded);
  connectWS();
});
