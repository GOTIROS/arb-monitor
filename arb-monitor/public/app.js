/* =======================================================
   arb-monitor — public/app.js  （完整替换版）
   修复点：
   1) 汉堡菜单事件绑定兼容多写法（不再失灵）
   2) 盘口总览：仅显示“已勾选”的书商；同一赛事只一行；稳定排序；OU/AH 必须成对且来自已勾选书商才展示
   3) 移除写死的 singbet/parimatch，书商动态发现
   其它功能（设置存取、WS心跳、快照/增量、套利计算/提醒）保持原样
   ======================================================= */
'use strict';

/* ------------------ 全局变量 ------------------ */
let ws = null;
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let lastHeartbeat = 0;
let heartbeatTimer = null;

let settings = {};

// 赛事行情盘面：eventKey -> { league, home, away, score, books:Set, ou:{line,over,under}, ah:{line,home,away}, updatedAt }
let marketBoard = new Map();

// 已提醒签名
let alertedSignatures = new Set();

// 用户是否有交互（用于播放声音）
let hasUserInteracted = false;

// 运行期实际发现的书商（动态），不再硬编码 singbet/parimatch
let discoveredBooks = new Set();

// 活动 Toast（避免重复）
let activeToasts = new Map(); // key -> { toast, timer }

/* ------------------ 默认设置 ------------------ */
const DEFAULT_SETTINGS = {
  datasource: {
    wsMode: 'custom',  // 'auto' | 'custom'
    wsUrl: '',         // 自定义WS地址（如：wss://your-server/ws/opps）
    token: '',
    useMock: false
  },
  // 书商开关（动态）
  books: {},
  // 返水设置（动态）
  rebates: {},
  stake: {
    aBook: '',         // A 平台（会根据勾选自动校正）
    amountA: 10000,
    minProfit: 0
  },
  notify: {
    systemEnabled: false,
    soundEnabled: true,
    toastEnabled: true,
    toastDurationS: 5,
    autoHideRowS: 30
  }
};

/* ------------------ 设置存取 ------------------ */
function loadSettings() {
  try {
    const raw = localStorage.getItem('arb_settings_v1');
    const loaded = raw ? JSON.parse(raw) : {};
    const merged = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      datasource: { ...DEFAULT_SETTINGS.datasource, ...(loaded.datasource||{}) },
      books:      { ...DEFAULT_SETTINGS.books,      ...(loaded.books||{}) },
      rebates:    { ...DEFAULT_SETTINGS.rebates,    ...(loaded.rebates||{}) },
      stake:      { ...DEFAULT_SETTINGS.stake,      ...(loaded.stake||{}) },
      notify:     { ...DEFAULT_SETTINGS.notify,     ...(loaded.notify||{}) }
    };
    return merged;
  } catch (e) {
    console.error('加载设置失败:', e);
    return DEFAULT_SETTINGS;
  }
}
function saveSettings() {
  try { localStorage.setItem('arb_settings_v1', JSON.stringify(settings)); }
  catch (e) { console.error('保存设置失败:', e); }
}

// 兼容
window.LoadSettings = loadSettings;
window.SaveSettings  = saveSettings;

/* ------------------ 书商管理 ------------------ */
const normBookKey = b => (b||'').toLowerCase();

function addDiscoveredBook(bookName) {
  if (!bookName) return;
  const b = normBookKey(bookName);
  if (!discoveredBooks.has(b)) {
    discoveredBooks.add(b);
    // 新发现书商默认启用
    if (!(b in settings.books)) {
      settings.books[b] = true;
      // 若A平台未选，首个发现的作为默认A
      if (!settings.stake?.aBook) settings.stake.aBook = b;
      saveSettings();
    }
    renderBookList();
    renderRebateSettings();
    updateABookOptions();
  }
}

function clearDiscoveredBooks() {
  discoveredBooks.clear();
  renderBookList();
  renderRebateSettings();
  updateABookOptions();
}

/* ------------------ 工具函数 ------------------ */
function getEventKey(opp) {
  // 优先 event_id，避免同一场赛事重复
  if (opp.event_id) return String(opp.event_id);
  return `${opp.league || ''}|${opp.event_name || ''}`;
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString('zh-CN', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

/* ------------------ WebSocket 连接管理 ------------------ */
function connectWS() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  // mock 关闭 + 自定义模式但未填URL：不连
  if (!settings.datasource?.useMock
      && settings.datasource?.wsMode === 'custom'
      && !((settings.datasource?.wsUrl || '').trim())) {
    updateConnectionStatus('connecting');
    return;
  }

  let wsUrl;
  if (!settings.datasource?.useMock && settings.datasource?.wsMode === 'custom') {
    wsUrl = settings.datasource.wsUrl.trim();
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
        console.error('解析 WebSocket 消息失败:', e);
      }
    };

    ws.onclose = () => {
      updateConnectionStatus('reconnecting');
      stopHeartbeatMonitor();
      const needReconnect =
        settings.datasource?.useMock ||
        (settings.datasource?.wsMode === 'custom' && !!(settings.datasource?.wsUrl || '').trim());
      if (needReconnect) scheduleReconnect();
    };

    ws.onerror = (err) => console.error('WebSocket 错误:', err);
  } catch (e) {
    console.error('创建 WebSocket 连接失败:', e);
    updateConnectionStatus('reconnecting');
    scheduleReconnect();
  }
}

function reconnectNow() {
  try { ws && ws.close(); } catch (_) {}
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  wsReconnectAttempts = 0;
  setTimeout(connectWS, 120);
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
    if (lastHeartbeat && (Date.now() - lastHeartbeat > 30000)) {
      try { ws && ws.close(); } catch (_) {}
    }
  }, 5000);
}

function stopHeartbeatMonitor() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

/* ------------------ WebSocket 消息处理 ------------------ */
function handleWebSocketMessage(message) {
  const realReady = !settings.datasource?.useMock
    && settings.datasource?.wsMode === 'custom'
    && !!(settings.datasource?.wsUrl || '').trim();

  if (!settings.datasource?.useMock && !realReady) return;

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
      // 为兼容调试，若直接是数组，也按快照处理
      if (Array.isArray(message)) {
        handleSnapshot(message);
        updateLastUpdateTime();
      } else {
        console.warn('未知消息类型:', message.type);
      }
  }
}

function handleSnapshot(opportunities) {
  console.log('收到快照数据:', opportunities.length, '条');
  marketBoard.clear();
  clearArbitrageTable();
  clearDiscoveredBooks();

  opportunities.forEach(opp => {
    if (opp?.pickA?.book) addDiscoveredBook(opp.pickA.book);
    if (opp?.pickB?.book) addDiscoveredBook(opp.pickB.book);
    processOpportunity(opp, false);
  });

  renderMarketBoard();
}

function handleOpportunity(opportunity) {
  if (!opportunity) return;

  if (opportunity?.pickA?.book) addDiscoveredBook(opportunity.pickA.book);
  if (opportunity?.pickB?.book) addDiscoveredBook(opportunity.pickB.book);

  processOpportunity(opportunity, true);
  renderMarketBoard();
}

/* ------------------ 盘口 & 套利计算 ------------------ */
function processOpportunity(opp, shouldAlert = false) {
  if (!opp) return;

  // 更新盘口
  updateMarketBoard(opp);

  // 计算套利
  const result = calculateArbitrage(opp);
  if (result) addArbitrageOpportunity(result, shouldAlert);
}

function updateMarketBoard(opp) {
  const eventId = getEventKey(opp);
  const existing = marketBoard.get(eventId) || {
    league: '',
    home: '',
    away: '',
    score: '',
    books: new Set(),
    ou: { line: '', over: null, under: null },
    ah: { line: '', home: null, away: null },
    updatedAt: 0
  };

  // 基本信息
  if (opp.league) existing.league = opp.league;
  if (opp.event_name) {
    const parts = String(opp.event_name).split(' vs ').map(s => (s || '').trim());
    if (parts.length >= 2) {
      existing.home = parts[0];
      existing.away = parts[1];
    }
  }
  if (opp.score) existing.score = opp.score;

  // 书商集合
  if (opp.pickA?.book) existing.books.add(normBookKey(opp.pickA.book));
  if (opp.pickB?.book) existing.books.add(normBookKey(opp.pickB.book));

  // 盘口行情
  if (opp.market === 'ou') {
    existing.ou.line = opp.line_text || (opp.line_numeric?.toString() || existing.ou.line);
    if (opp.pickA?.selection === 'over') {
      existing.ou.over = { book: normBookKey(opp.pickA.book), odds: opp.pickA.odds };
    }
    if (opp.pickB?.selection === 'under') {
      existing.ou.under = { book: normBookKey(opp.pickB.book), odds: opp.pickB.odds };
    }
  } else if (opp.market === 'ah') {
    existing.ah.line = opp.line_text || (opp.line_numeric?.toString() || existing.ah.line);
    if (opp.pickA?.selection === 'home') {
      existing.ah.home = { book: normBookKey(opp.pickA.book), odds: opp.pickA.odds };
    }
    if (opp.pickB?.selection === 'away') {
      existing.ah.away = { book: normBookKey(opp.pickB.book), odds: opp.pickB.odds };
    }
  }

  existing.updatedAt = Date.now();
  marketBoard.set(eventId, existing);
}

function calculateArbitrage(opp) {
  if (!opp.pickA || !opp.pickB || !settings) return null;

  const bookA = normBookKey(opp.pickA.book);
  const bookB = normBookKey(opp.pickB.book);
  const aBook = normBookKey(settings.stake?.aBook || '');

  // 只计算已勾选书商
  if (!settings.books[bookA] || !settings.books[bookB]) return null;

  let pickA, pickB, sideA, sideB, aInvolved = false;

  if (aBook && bookA === aBook) {
    aInvolved = true;
    pickA = opp.pickA;
    pickB = opp.pickB;
    sideA = 'A';
    sideB = 'B';
  } else if (aBook && bookB === aBook) {
    aInvolved = true;
    pickA = opp.pickB;
    pickB = opp.pickA;
    sideA = 'B';
    sideB = 'A';
  } else {
    pickA = opp.pickA;
    pickB = opp.pickB;
    sideA = '—';
    sideB = 'B';
  }

  const oA = parseFloat(pickA.odds) || 0;
  const oB = parseFloat(pickB.odds) || 0;
  const sA = parseInt(settings.stake?.amountA) || 10000;

  if (oA <= 1 || oB <= 1) return null;

  const rebateA = settings.rebates?.[normBookKey(pickA.book)] || { type: 'turnover', rate: 0 };
  const rebateB = settings.rebates?.[normBookKey(pickB.book)] || { type: 'turnover', rate: 0 };

  const rA = rebateA.rate || 0;
  const rB = rebateB.rate || 0;
  const tA = rebateA.type || 'turnover';
  const tB = rebateB.type || 'turnover';

  let sB;
  if (tA === 'turnover' && tB === 'turnover') {
    sB = sA * oA / oB;
  } else if (tA === 'net_loss' && tB === 'net_loss') {
    const denominator = oB - rB; if (denominator <= 0) return null;
    sB = sA * (oA - rA) / denominator;
  } else if (tA === 'turnover' && tB === 'net_loss') {
    const denominator = oB - rB; if (denominator <= 0) return null;
    sB = sA * oA / denominator;
  } else if (tA === 'net_loss' && tB === 'turnover') {
    sB = sA * (oA - rA) / oB;
  } else {
    return null;
  }

  if (sB <= 0) return null;

  const profit = sA * oA - (sA + sB) + (tA === 'turnover' ? rA * sA : 0) + rB * sB;
  const minProfit = parseInt(settings.stake?.minProfit) || 0;

  return {
    opportunity: opp,
    sideA, sideB,
    pickA, pickB,
    waterA: (oA - 1).toFixed(3),
    waterB: (oB - 1).toFixed(3),
    stakeB: Math.round(sB),
    profit: Math.round(profit),
    shouldAlert: aInvolved && profit >= minProfit,
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

/* ------------------ 套利表格 ------------------ */
function addArbitrageOpportunity(result, shouldAlert) {
  const tbody = document.querySelector('#arbitrageTable tbody');
  if (!tbody) return;

  const signature = result.signature;
  const minProfit = parseInt(settings.stake?.minProfit) || 0;

  // 已存在
  const existingRow = tbody.querySelector(`tr[data-signature="${signature}"]`);
  if (existingRow) {
    if (result.profit < minProfit) {
      existingRow.remove();
      alertedSignatures.delete(signature);
      return;
    }
    updateArbitrageRow(existingRow, result);
    if (shouldAlert && result.shouldAlert) highlightRow(existingRow);
    return;
  }

  // 新机会
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
  const marketText = opp.market === 'ah' ? '让球' : '大小球';
  const lineText = opp.line_text || (opp.line_numeric?.toString() || '');

  row.innerHTML = `
    <td>${opp.event_name || ''}</td>
    <td>${marketText} ${lineText}</td>
    <td>${result.sideA} (${result.pickA.selection})</td>
    <td>${result.sideB} (${result.pickB.selection})</td>
    <td>${result.waterA}</td>
    <td>${result.waterB}</td>
    <td>${result.sideA === '—' ? '—' : result.stakeB.toLocaleString()}</td>
    <td>${result.profit.toLocaleString()}</td>
  `;
  return row;
}

function updateArbitrageRow(row, result) {
  const cells = row.cells;
  if (cells.length < 8) return;
  cells[4].textContent = result.waterA;
  cells[5].textContent = result.waterB;
  cells[6].textContent = result.sideA === '—' ? '—' : result.stakeB.toLocaleString();
  cells[7].textContent = result.profit.toLocaleString();
}

function highlightRow(row) {
  row.classList.add('highlighted');
  setTimeout(() => row.classList.remove('highlighted'), 1800);
}

function clearArbitrageTable() {
  const tbody = document.querySelector('#arbitrageTable tbody');
  if (tbody) tbody.innerHTML = '<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
}

/* ------------------ 盘口总览（去重 + 稳定排序 + 过滤） ------------------ */
function renderMarketBoard() {
  const tbody = document.querySelector('#marketTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (marketBoard.size === 0) {
    tbody.innerHTML = '<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
    return;
  }

  // 当前启用书商
  const enabled = new Set(
    Object.entries(settings.books)
      .filter(([, v]) => !!v)
      .map(([k]) => normBookKey(k))
  );

  const entries = Array.from(marketBoard.entries());
  const sortByTime = document.getElementById('sortByTime')?.classList.contains('active');

  // 稳定排序：默认按 联赛 -> 主队 -> 客队；按时间则按 updatedAt 倒序
  if (sortByTime) {
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  } else {
    entries.sort((a, b) =>
      (a[1].league || '').localeCompare(b[1].league || '') ||
      (a[1].home   || '').localeCompare(b[1].home   || '') ||
      (a[1].away   || '').localeCompare(b[1].away   || '')
    );
  }

  let added = 0;

  for (const [eventId, data] of entries) {
    // 只显示“包含已勾选书商”的赛事（同一赛事只渲染一行）
    const shownBooks = Array.from(data.books).filter(b => enabled.has(normBookKey(b)));
    if (shownBooks.length === 0) continue;

    // 只有在两边书商都勾选的前提下才展示 OU/AH 赔率，否则 '-'
    let ouText = '-';
    if (data.ou.line && data.ou.over && data.ou.under &&
        enabled.has(data.ou.over.book) && enabled.has(data.ou.under.book)) {
      ouText = `${data.ou.line} (${data.ou.over.odds}/${data.ou.under.odds})`;
    }

    let ahText = '-';
    if (data.ah.line && data.ah.home && data.ah.away &&
        enabled.has(data.ah.home.book) && enabled.has(data.ah.away.book)) {
      ahText = `${data.ah.line} (${data.ah.home.odds}/${data.ah.away.odds})`;
    }

    const timeText = data.updatedAt ? formatTime(new Date(data.updatedAt)) : '-';

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${shownBooks.join(', ')}</td>
      <td>${data.league || ''}</td>
      <td>${data.home   || ''}</td>
      <td>${data.away   || ''}</td>
      <td>${data.score  || ''}</td>
      <td>${ouText}</td>
      <td>${ahText}</td>
      <td>${timeText}</td>
    `;
    tbody.appendChild(row);
    added++;
  }

  if (added === 0) {
    tbody.innerHTML = '<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
  }
}

/* ------------------ 重新计算全部套利 ------------------ */
function recalculateAllArbitrageOpportunities() {
  clearArbitrageTable();

  marketBoard.forEach((data, eventId) => {
    // 大小球
    if (data.ou.line && data.ou.over && data.ou.under) {
      const ouOpp = {
        event_id: eventId,
        event_name: `${data.home} vs ${data.away}`,
        league: data.league,
        market: 'ou',
        line_text: data.ou.line,
        line_numeric: parseFloat(data.ou.line) || 0,
        pickA: { book: data.ou.over.book,  selection: 'over',  odds: data.ou.over.odds },
        pickB: { book: data.ou.under.book, selection: 'under', odds: data.ou.under.odds },
        score: data.score
      };
      const r = calculateArbitrage(ouOpp);
      if (r) addArbitrageOpportunity(r, false);
    }
    // 让球
    if (data.ah.line && data.ah.home && data.ah.away) {
      const ahOpp = {
        event_id: eventId,
        event_name: `${data.home} vs ${data.away}`,
        league: data.league,
        market: 'ah',
        line_text: data.ah.line,
        line_numeric: parseFloat(data.ah.line) || 0,
        pickA: { book: data.ah.home.book, selection: 'home', odds: data.ah.home.odds },
        pickB: { book: data.ah.away.book, selection: 'away', odds: data.ah.away.odds },
        score: data.score
      };
      const r = calculateArbitrage(ahOpp);
      if (r) addArbitrageOpportunity(r, false);
    }
  });
}

/* ------------------ 提醒 ------------------ */
function sendAlert(result) {
  const signature = result.signature;

  const realReady = !settings.datasource?.useMock
    && settings.datasource?.wsMode === 'custom'
    && !!(settings.datasource?.wsUrl || '').trim();
  if (!settings.datasource?.useMock && !realReady) return;

  if (alertedSignatures.has(signature)) return;
  alertedSignatures.add(signature);

  const opp = result.opportunity;
  const marketText = opp.market === 'ah' ? '让球' : '大小球';
  const lineText = opp.line_text || (opp.line_numeric?.toString() || '');
  const sA = settings.stake?.amountA || 10000;

  const message = `提醒：A平台${marketText}${lineText}水位${result.waterA}固定下注${sA.toLocaleString()}，B平台${marketText}${lineText}水位${result.waterB}应下注金额${result.stakeB.toLocaleString()}，均衡盈利${result.profit.toLocaleString()}`;

  if (settings.notify?.toastEnabled) showToast('套利机会', message, 'success');

  if (settings.notify?.systemEnabled && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('套利机会', { body: message, icon: '/favicon.ico' });
  }

  if (settings.notify?.soundEnabled && hasUserInteracted) {
    playNotificationSound();
  }
}

function showToast(title, message, type = 'info') {
  const container = document.getElementById('toast-stack');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-title">${title}</div>
    <div class="toast-message">${message}</div>
  `;
  container.appendChild(toast);
  const duration = (settings.notify?.toastDurationS || 5) * 1000;
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => { toast.remove(); }, 200);
  }, duration);
}

function playNotificationSound() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
    oscillator.frequency.setValueAtTime(1040, audioContext.currentTime + 0.1);
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime + 0.2);
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.3);
  } catch (_) {}
}

/* ------------------ UI 初始化 ------------------ */
function initUI(loadedSettings) {
  settings = loadedSettings;

  // 汉堡 & 抽屉
  initHamburgerMenu();

  // 面板 & 设置
  initSettingsPanels();

  // 市场控制（排序/折叠）
  initMarketControls();

  // 通知权限
  requestNotificationPermission();

  // 用户交互监听（声音）
  document.addEventListener('click', () => hasUserInteracted = true, { once: true });
  document.addEventListener('keydown', () => hasUserInteracted = true, { once: true });
}

/* --- 汉堡菜单：兼容多写法 & 稳定遮罩 --- */
function initHamburgerMenu() {
  const btn = document.getElementById('hamburger')
            || document.getElementById('hamburgerBtn')
            || document.querySelector('.hamburger, .hamburger-btn, .menu-btn, [data-hamburger]');
  const drawer = document.getElementById('drawer')
               || document.querySelector('#drawer, .drawer, [data-drawer]');

  if (!btn || !drawer) {
    console.warn('hamburger: 未找到按钮或抽屉', { btn: !!btn, drawer: !!drawer });
    return;
  }

  let overlay = document.getElementById('drawerOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'drawerOverlay';
    overlay.className = 'drawer-overlay';
    document.body.appendChild(overlay);
  }

  const openDrawer = () => {
    drawer.classList.add('active');
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  };
  const closeDrawer = () => {
    drawer.classList.remove('active');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
  };

  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openDrawer(); });
  overlay.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  // 初始强制关闭，避免卡住
  closeDrawer();

  // 展开/折叠控制（如果页面有按钮）
  const expandAllBtn  = document.getElementById('expandAllBtn');
  const collapseAllBtn= document.getElementById('collapseAllBtn');
  if (expandAllBtn)  expandAllBtn.addEventListener('click', () => {
    document.querySelectorAll('#drawer details').forEach(d => d.open = true); savePanelStates();
  });
  if (collapseAllBtn) collapseAllBtn.addEventListener('click', () => {
    document.querySelectorAll('#drawer details').forEach(d => d.open = false); savePanelStates();
  });
}

/* --- 设置面板 --- */
function initSettingsPanels() {
  loadPanelStates();
  document.querySelectorAll('#drawer details').forEach(d => d.addEventListener('toggle', savePanelStates));

  // 数据源面板
  initDatasourcePanel();

  // 书商 & 返水
  renderBookList();
  renderRebateSettings();

  // 投注设置
  updateStakeInputs();
  const aBookSelect   = document.getElementById('a-book');
  const amountAInput  = document.getElementById('amount-a');
  const minProfitInput= document.getElementById('min-profit');

  if (aBookSelect) aBookSelect.addEventListener('change', () => {
    settings.stake = settings.stake || {};
    settings.stake.aBook = aBookSelect.value;
    saveSettings();
  });
  if (amountAInput) amountAInput.addEventListener('input', () => {
    settings.stake = settings.stake || {};
    settings.stake.amountA = parseInt(amountAInput.value) || 0;
    saveSettings();
    recalculateAllArbitrageOpportunities();
  });
  if (minProfitInput) minProfitInput.addEventListener('input', () => {
    settings.stake = settings.stake || {};
    settings.stake.minProfit = parseInt(minProfitInput.value) || 0;
    saveSettings();
    recalculateAllArbitrageOpportunities();
  });

  // 通知设置
  updateNotifyInputs();
  const systemNotify  = document.getElementById('system-notify');
  const soundNotify   = document.getElementById('sound-notify');
  const toastNotify   = document.getElementById('toast-notify');
  const toastDuration = document.getElementById('toast-duration');
  const autoHideRow   = document.getElementById('auto-hide-row');
  const clearAlerts   = document.getElementById('clear-alerts');

  systemNotify && systemNotify.addEventListener('change', () => {
    settings.notify = settings.notify || {};
    settings.notify.systemEnabled = systemNotify.checked;
    saveSettings();
    if (systemNotify.checked) requestNotificationPermission();
  });
  soundNotify  && soundNotify.addEventListener('change', () => {
    settings.notify = settings.notify || {};
    settings.notify.soundEnabled = soundNotify.checked;
    saveSettings();
  });
  toastNotify  && toastNotify.addEventListener('change', () => {
    settings.notify = settings.notify || {};
    settings.notify.toastEnabled = toastNotify.checked;
    saveSettings();
  });
  toastDuration && toastDuration.addEventListener('input', () => {
    settings.notify = settings.notify || {};
    settings.notify.toastDurationS = parseInt(toastDuration.value) || 5;
    saveSettings();
  });
  autoHideRow && autoHideRow.addEventListener('input', () => {
    settings.notify = settings.notify || {};
    settings.notify.autoHideRowS = parseInt(autoHideRow.value) || 0;
    saveSettings();
  });
  clearAlerts && clearAlerts.addEventListener('click', () => {
    alertedSignatures.clear();
    document.querySelectorAll('#arbitrageTable tbody tr.hidden-row').forEach(row => row.classList.remove('hidden-row'));
    showToast('系统', '已清除提醒记录', 'success');
  });
}

/* --- 书商列表 --- */
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

    const id = `chk-book-${book}`;
    item.innerHTML = `
      <input type="checkbox" id="${id}" ${settings.books[book] ? 'checked' : ''}>
      <label for="${id}">${book.charAt(0).toUpperCase() + book.slice(1)}</label>
    `;

    const checkbox = item.querySelector('input');
    checkbox.addEventListener('change', () => {
      settings.books[book] = checkbox.checked;
      saveSettings();

      // 若当前 A 平台被取消勾选，自动切到第一个仍勾选的书商
      const currentABook = normBookKey(settings.stake?.aBook || '');
      if (!checkbox.checked && currentABook === book) {
        const enabled = Object.entries(settings.books).filter(([,v]) => v).map(([k]) => k);
        settings.stake.aBook = enabled[0] || '';
        updateABookOptions();
      }

      renderRebateSettings();
      renderMarketBoard();
      recalculateAllArbitrageOpportunities();
    });

    container.appendChild(item);
  });
}

/* --- 返水设置（仅显示已勾选书商） --- */
function renderRebateSettings() {
  const container = document.querySelector('#panel-rebates .panel-content');
  if (!container) return;
  container.innerHTML = '';

  if (discoveredBooks.size === 0) {
    container.innerHTML = '<div class="no-books-message">暂无书商数据</div>';
    return;
  }

  const enabledBooks = Array.from(discoveredBooks).filter(b => !!settings.books[b]).sort();
  if (enabledBooks.length === 0) {
    container.innerHTML = '<div class="no-books-message">请先选择书商</div>';
    return;
  }

  enabledBooks.forEach(book => {
    const currentRebate = settings.rebates[book] || { type: 'turnover', rate: 0.006 };
    const group = document.createElement('div');
    group.className = 'rebate-group';
    group.innerHTML = `
      <h4>${book.charAt(0).toUpperCase() + book.slice(1)}</h4>
      <div class="form-row">
        <label>类型：</label>
        <select id="${book}-type">
          <option value="turnover" ${currentRebate.type === 'turnover' ? 'selected' : ''}>Turnover</option>
          <option value="net_loss" ${currentRebate.type === 'net_loss' ? 'selected' : ''}>Net Loss</option>
        </select>
      </div>
      <div class="form-row">
        <label>比例：</label>
        <input type="number" id="${book}-rate" step="0.001" min="0" max="1" value="${currentRebate.rate}">
      </div>
    `;
    container.appendChild(group);

    const typeSel = group.querySelector(`#${book}-type`);
    const rateInp = group.querySelector(`#${book}-rate`);

    typeSel.addEventListener('change', () => {
      settings.rebates[book] = settings.rebates[book] || {};
      settings.rebates[book].type = typeSel.value;
      saveSettings();
      recalculateAllArbitrageOpportunities();
    });

    rateInp.addEventListener('input', () => {
      settings.rebates[book] = settings.rebates[book] || {};
      settings.rebates[book].rate = parseFloat(rateInp.value) || 0;
      saveSettings();
      recalculateAllArbitrageOpportunities();
    });
  });
}

/* --- A平台选择（仅显示已勾选书商） --- */
function updateABookOptions() {
  const select = document.getElementById('a-book');
  if (!select) return;

  const current = select.value;
  select.innerHTML = '';

  const enabled = Array.from(discoveredBooks).filter(b => !!settings.books[b]).sort();
  if (enabled.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '请先选择书商';
    option.disabled = true;
    select.appendChild(option);
    return;
  }

  enabled.forEach(book => {
    const option = document.createElement('option');
    option.value = book;
    option.textContent = book.charAt(0).toUpperCase() + book.slice(1);
    select.appendChild(option);
  });

  if (enabled.includes(current)) {
    select.value = current;
  } else {
    select.value = enabled[0];
    settings.stake.aBook = enabled[0];
    saveSettings();
  }
}

/* --- 数据源面板 --- */
function initDatasourcePanel() {
  const wsModeAuto   = document.getElementById('ws-mode-auto');
  const wsModeCustom = document.getElementById('ws-mode-custom');
  const wsUrlInput   = document.getElementById('ws-url');
  const wsTokenInput = document.getElementById('ws-token');
  const useMockChk   = document.getElementById('use-mock');
  const testBtn      = document.getElementById('test-connection');
  const reconnectBtn = document.getElementById('reconnect-now');

  const ds = settings.datasource || {};

  // 初始状态
  if (ds.wsMode === 'custom') {
    wsModeCustom && (wsModeCustom.checked = true);
    wsUrlInput && (wsUrlInput.disabled = false);
  } else {
    wsModeAuto && (wsModeAuto.checked = true);
    wsUrlInput && (wsUrlInput.disabled = true);
  }
  wsUrlInput && (wsUrlInput.value = ds.wsUrl || '');
  wsTokenInput && (wsTokenInput.value = ds.token || '');
  if (useMockChk) useMockChk.checked = ds.useMock === true;

  // 切换
  wsModeAuto && wsModeAuto.addEventListener('change', () => {
    if (wsModeAuto.checked) {
      settings.datasource.wsMode = 'auto';
      wsUrlInput && (wsUrlInput.disabled = true);
      saveSettings();
      showReconnectButton();
    }
  });
  wsModeCustom && wsModeCustom.addEventListener('change', () => {
    if (wsModeCustom.checked) {
      settings.datasource.wsMode = 'custom';
      wsUrlInput && (wsUrlInput.disabled = false);
      saveSettings();
      showReconnectButton();
    }
  });

  wsUrlInput && wsUrlInput.addEventListener('input', () => {
    settings.datasource.wsUrl = wsUrlInput.value;
    saveSettings();
    showReconnectButton();
  });

  wsTokenInput && wsTokenInput.addEventListener('input', () => {
    settings.datasource.token = wsTokenInput.value;
    saveSettings();
    showReconnectButton();
  });

  if (useMockChk) {
    const syncMock = () => {
      settings.datasource.useMock = useMockChk.checked;
      saveSettings();

      marketBoard.clear();
      clearArbitrageTable();
      clearDiscoveredBooks();
      renderMarketBoard();
      alertedSignatures.clear();
      const stack = document.getElementById('toast-stack');
      if (stack) stack.innerHTML = '';

      try { ws && ws.close(); } catch (_) {}
      if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
      reconnectNow();
    };
    useMockChk.addEventListener('change', syncMock);

    const parent = useMockChk.closest('.toggle-item');
    parent && parent.addEventListener('click', (e) => {
      if (e.target !== useMockChk) {
        e.preventDefault();
        useMockChk.checked = !useMockChk.checked;
        syncMock();
      }
    });
  }

  testBtn && testBtn.addEventListener('click', testConnection);
  reconnectBtn && reconnectBtn.addEventListener('click', () => { reconnectNow(); hideReconnectButton(); });
}

function testConnection() {
  const btn = document.getElementById('test-connection');
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = '测试中...';

  let testWsUrl;
  if (settings.datasource?.wsMode === 'custom' && (settings.datasource?.wsUrl || '').trim()) {
    testWsUrl = settings.datasource.wsUrl.trim();
  } else {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    testWsUrl = `${protocol}://${location.host}/ws/opps`;
  }

  const t = new WebSocket(testWsUrl);
  const timeout = setTimeout(() => {
    try { t.close(); } catch (_) {}
    btn.disabled = false;
    btn.textContent = '测试连接';
    showToast('连接测试', '连接超时', 'error');
  }, 5000);

  t.onopen = () => {
    clearTimeout(timeout);
    try { t.close(); } catch (_) {}
    btn.disabled = false;
    btn.textContent = '测试连接';
    showToast('连接测试', '连接成功', 'success');
  };

  t.onerror = () => {
    clearTimeout(timeout);
    btn.disabled = false;
    btn.textContent = '测试连接';
    showToast('连接测试', '连接失败', 'error');
  };
}

function showReconnectButton() {
  const btn = document.getElementById('reconnect-now');
  if (btn) btn.style.display = 'block';
}
function hideReconnectButton() {
  const btn = document.getElementById('reconnect-now');
  if (btn) btn.style.display = 'none';
}

/* --- 面板状态 --- */
function loadPanelStates() {
  try {
    const raw = localStorage.getItem('panel_state_v1');
    const states = raw ? JSON.parse(raw) : {};
    ['panel-datasource', 'panel-books', 'panel-rebates', 'panel-stake', 'panel-notify', 'panel-marketboard'].forEach(id => {
      const panel = document.getElementById(id);
      if (!panel) return;
      if (id === 'panel-marketboard') panel.open = states[id] === true; // 默认折叠
      else panel.open = states[id] !== false;                           // 默认展开
    });
  } catch (e) {}
}

function savePanelStates() {
  try {
    const states = {};
    ['panel-datasource', 'panel-books', 'panel-rebates', 'panel-stake', 'panel-notify', 'panel-marketboard'].forEach(id => {
      const panel = document.getElementById(id);
      if (panel) states[id] = !!panel.open;
    });
    localStorage.setItem('panel_state_v1', JSON.stringify(states));
  } catch (e) {}
}

/* --- 市场控制 --- */
function initMarketControls() {
  const sortByLeague = document.getElementById('sortByLeague');
  const sortByTime   = document.getElementById('sortByTime');
  const collapseBtn  = document.getElementById('market-collapse-btn');
  const marketPanel  = document.getElementById('panel-marketboard');

  sortByLeague && sortByLeague.addEventListener('click', () => {
    sortByLeague.classList.add('active');
    sortByTime && sortByTime.classList.remove('active');
    renderMarketBoard();
  });

  sortByTime && sortByTime.addEventListener('click', () => {
    sortByTime.classList.add('active');
    sortByLeague && sortByLeague.classList.remove('active');
    renderMarketBoard();
  });

  if (collapseBtn && marketPanel) {
    collapseBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      marketPanel.open = !marketPanel.open;
      savePanelStates();
    });
  }
}

/* --- 其它小工具 --- */
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function updateConnectionStatus(status) {
  const badge = document.getElementById('statusBadge');
  const errorAlert = document.getElementById('connectionError');
  if (!badge || !errorAlert) return;

  badge.className = `status-badge ${status}`;
  if (status === 'connected') {
    badge.textContent = '已连接';
    errorAlert.style.display = 'none';
  } else if (status === 'connecting') {
    badge.textContent = '连接中...';
    errorAlert.style.display = 'none';
  } else {
    badge.textContent = '重连中...';
    errorAlert.style.display = 'block';
  }
}

function updateLastUpdateTime() {
  const element = document.getElementById('lastUpdateTime');
  if (element) element.textContent = formatTime();
}

/* ------------------ 启动入口 ------------------ */
document.addEventListener('DOMContentLoaded', () => {
  console.log('应用启动');
  const loadedSettings = loadSettings();
  initUI(loadedSettings);
  connectWS();
});
