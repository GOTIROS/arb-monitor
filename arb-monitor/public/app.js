/* =======================================================
   arb-monitor — public/app.js
   完整版（直接替换）
   ======================================================= */
'use strict';

/* ------------------ 全局变量 ------------------ */
let ws = null;
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let lastHeartbeat = 0;
let heartbeatTimer = null;

let settings = {};
let marketBoard = new Map();       // eventKey -> {league, home, away, score, books:Set, ou:{}, ah:{}, updatedAt, kickoffAt}
let alertedSignatures = new Set(); // 已提醒的签名
let hasUserInteracted = false;
let discoveredBooks = new Set();   // 动态发现（不再预置）
let activeToasts = new Map();      // key -> { toastEl, timer }

// 排序 & 稳定行序
let sortMode = 'time'; // 'time' | 'league'
const rowOrder = new Map(); // key: eventKey|book -> stable index
let rowSeq = 0;

function rowKey(eventKey, book) {
  return `${eventKey}|${(book||'').toLowerCase()}`;
}

function guessKickoffTs(obj) {
  const cands = [
    obj.kickoffAt, obj.kickoff_at, obj.kickoff,
    obj.matchTime, obj.match_time,
    obj.start_time, obj.start_ts, obj.startTime
  ];
  for (const v of cands) {
    if (v == null) continue;
    const n = typeof v === 'string' ? Date.parse(v) : Number(v);
    if (!Number.isNaN(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  }
  return undefined;
}

/* ------------------ 默认设置 ------------------ */
const DEFAULT_SETTINGS = {
  datasource: {
    wsMode: 'auto',     // 'auto' | 'custom'
    wsUrl: '',          // 当 mode=custom 时生效
    token: '',
    useMock: false
  },
  books: {             // 动态渲染
  },
  rebates: {
  },
  stake: {
    aBook: '',
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
  } catch(e) {
    console.error('加载设置失败:', e);
    return DEFAULT_SETTINGS;
  }
}

function saveSettings() {
  try {
    localStorage.setItem('arb_settings_v1', JSON.stringify(settings));
  } catch(e) {
    console.error('保存设置失败:', e);
  }
}

// 兼容全局函数名
window.LoadSettings = loadSettings;
window.SaveSettings  = saveSettings;

/* ------------------ 书商管理 ------------------ */
function normBookKey(book) {
  return (book || '').toLowerCase();
}

function addDiscoveredBook(book) {
  if (!book) return;
  const b = normBookKey(book);
  if (!discoveredBooks.has(b)) {
    discoveredBooks.add(b);
    if (!(b in settings.books)) {
      settings.books[b] = true; // 新书商默认启用
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
  // 使用 league + event_name 作为唯一键
  return `${opp.league || ''}|${opp.event_name || ''}`;
}

function formatTime(date=new Date()) {
  return date.toLocaleTimeString('zh-CN', {
    hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit'
  });
}

/* ------------------ WebSocket ------------------ */
function connectWS() {
  if (ws && (ws.readyState===WebSocket.CONNECTING || ws.readyState===WebSocket.OPEN)) {
    return;
  }

  // 改成：如果是自定义且没填 URL，就不尝试连接
  if (settings.datasource?.wsMode==='custom'
      && !((settings.datasource?.wsUrl||'').trim())) {
    updateConnectionStatus('connecting'); // 显示待配置
    return;
  }

  let wsUrl;
  if (settings.datasource?.wsMode==='custom') {
    wsUrl = settings.datasource.wsUrl.trim();
  } else {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    wsUrl = `${protocol}://${location.host}/ws/opps`;
  }

  updateConnectionStatus('connecting');
  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WS 连接成功');
      wsReconnectAttempts = 0;
      updateConnectionStatus('connected');
      startHeartbeatMonitor();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        handleWebSocketMessage(msg);
      } catch(err) {
        console.error('解析消息失败:', err);
      }
    };

    ws.onclose = (ev) => {
      console.log('WS 关闭:', ev.code, ev.reason);
      updateConnectionStatus('reconnecting');
      stopHeartbeatMonitor();
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('WS 错误:', err);
    };

  } catch(err) {
    console.error('创建 WS 失败:', err);
    updateConnectionStatus('reconnecting');
    scheduleReconnect();
  }
}

function reconnectNow() {
  console.log('手动重连 WS');
  if (ws) ws.close();
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer=null; }
  wsReconnectAttempts = 0;
  setTimeout(connectWS, 120);
}

function testConnection() {
  const btn = document.getElementById('test-connection');
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = '测试中...';

  let url;
  if (settings.datasource?.wsMode==='custom' && (settings.datasource?.wsUrl||'').trim()) {
    url = settings.datasource.wsUrl.trim();
  } else {
    const protocol = location.protocol==='https:' ? 'wss' : 'ws';
    url = `${protocol}://${location.host}/ws/opps`;
  }

  const t = new WebSocket(url);
  const timeout = setTimeout(() => {
    try { t.close(); } catch(_){}
    btn.disabled=false; btn.textContent='测试连接';
    showToast('连接测试','连接超时','error');
  }, 5000);

  t.onopen = () => {
    clearTimeout(timeout);
    try { t.close(); } catch(_){}
    btn.disabled=false; btn.textContent='测试连接';
    showToast('连接测试','连接成功','success');
  };
  t.onerror = (e) => {
    clearTimeout(timeout);
    btn.disabled=false; btn.textContent='测试连接';
    showToast('连接测试','连接失败','error');
  };
}

function scheduleReconnect() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectAttempts++;
  const delay = Math.min(30000, Math.pow(2, wsReconnectAttempts-1)*1000);
  wsReconnectTimer = setTimeout(connectWS, delay);
}

function startHeartbeatMonitor() {
  stopHeartbeatMonitor();
  heartbeatTimer = setInterval(() => {
    if (lastHeartbeat && (Date.now()-lastHeartbeat>30000)) {
      console.log('心跳超时，关闭 WS');
      try { ws && ws.close(); } catch(_){}
    }
  }, 5000);
}

function stopHeartbeatMonitor() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer=null; }
}

/* ------------------ 消息处理 ------------------ */
function handleWebSocketMessage(message) {
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
      console.warn('未知消息类型:', message.type);
  }
}

function handleSnapshot(opps) {
  console.log('收到快照:', opps.length,'条');
  marketBoard.clear();
  clearArbitrageTable();
  clearDiscoveredBooks();

  for (const opp of opps) {
    if (opp?.pickA?.book) addDiscoveredBook(opp.pickA.book);
    if (opp?.pickB?.book) addDiscoveredBook(opp.pickB.book);
    processOpportunity(opp, false);
  }
  renderMarketBoard();
}

function handleOpportunity(opp) {
  if (!opp) return;
  if (opp?.pickA?.book) addDiscoveredBook(opp.pickA.book);
  if (opp?.pickB?.book) addDiscoveredBook(opp.pickB.book);
  processOpportunity(opp, true);
  renderMarketBoard();
}

/* ------------------ 盘口 & 套利计算 ------------------ */
function processOpportunity(opp, shouldAlert) {
  if (!opp?.event_id && !opp?.event_name) return;
  updateMarketBoard(opp);

  const result = calculateArbitrage(opp);
  if (result) addArbitrageOpportunity(result, shouldAlert);
}

function updateMarketBoard(opp) {
  const key = getEventKey(opp);
  const cur = marketBoard.get(key) || {
    league:'', home:'', away:'', score:'',
    books:new Set(),
    ou:{line:'', over:null, under:null},
    ah:{line:'', home:null, away:null},
    updatedAt: 0,
    kickoffAt: undefined
  };

  if (opp.league) cur.league = opp.league;
  if (opp.event_name) {
    // 允许传“home vs away”或直接 home/away 字段
    if (opp.home && opp.away) {
      cur.home = opp.home;
      cur.away = opp.away;
    } else {
      const [h,a] = opp.event_name.split(' vs ').map(s=>s?.trim()||'');
      if (h) cur.home = h;
      if (a) cur.away = a;
    }
  }
  if (opp.score) cur.score = opp.score;

  // 开赛时间
  const k = guessKickoffTs(opp);
  if (k && (!cur.kickoffAt || Math.abs(k - (cur.kickoffAt||0)) > 1000)) {
    cur.kickoffAt = k;
  }

  cur.updatedAt = Date.now();

  if (opp.pickA?.book) cur.books.add(normBookKey(opp.pickA.book));
  if (opp.pickB?.book) cur.books.add(normBookKey(opp.pickB.book));

  if (opp.market==='ou') {
    cur.ou.line = opp.line_text || (opp.line_numeric?.toString()||'');
    if ((opp.pickA?.selection||'').toLowerCase()==='over') {
      cur.ou.over = { book:normBookKey(opp.pickA.book), odds: opp.pickA.odds };
    }
    if ((opp.pickB?.selection||'').toLowerCase()==='under') {
      cur.ou.under = { book:normBookKey(opp.pickB.book), odds: opp.pickB.odds };
    }
  } else if (opp.market==='ah') {
    cur.ah.line = opp.line_text || (opp.line_numeric?.toString()||'');
    if ((opp.pickA?.selection||'').toLowerCase()==='home') {
      cur.ah.home = { book:normBookKey(opp.pickA.book), odds: opp.pickA.odds };
    }
    if ((opp.pickB?.selection||'').toLowerCase()==='away') {
      cur.ah.away = { book:normBookKey(opp.pickB.book), odds: opp.pickB.odds };
    }
  }

  marketBoard.set(key, cur);
}

function calculateArbitrage(opp) {
  if (!opp?.pickA || !opp?.pickB) return null;

  const bookA = normBookKey(opp.pickA.book);
  const bookB = normBookKey(opp.pickB.book);
  const aBook  = normBookKey(settings.stake?.aBook||'');

  // 只计算勾选书商
  if (!settings.books[bookA] || !settings.books[bookB]) return null;

  let pickA, pickB, sideA, sideB, aInvolved=false;
  if (bookA===aBook) {
    aInvolved=true; pickA=opp.pickA; pickB=opp.pickB; sideA='A'; sideB='B';
  } else if (bookB===aBook) {
    aInvolved=true; pickA=opp.pickB; pickB=opp.pickA; sideA='B'; sideB='A';
  } else {
    pickA=opp.pickA; pickB=opp.pickB; sideA='—'; sideB='B';
  }

  const oA = parseFloat(pickA.odds)||0;
  const oB = parseFloat(pickB.odds)||0;
  const sA = parseInt(settings.stake?.amountA)||10000;
  if (oA<=1 || oB<=1) return null;

  const ra = settings.rebates?.[normBookKey(pickA.book)] || {type:'turnover', rate:0};
  const rb = settings.rebates?.[normBookKey(pickB.book)] || {type:'turnover', rate:0};
  const rA = ra.rate||0, rB=rb.rate||0, tA=ra.type||'turnover', tB=rb.type||'turnover';

  let sB;
  if (tA==='turnover' && tB==='turnover') {
    sB = sA * oA / oB;
  } else if (tA==='net_loss' && tB==='net_loss') {
    const d = oB - rB; if (d<=0) return null;
    sB = sA * (oA - rA) / d;
  } else if (tA==='turnover' && tB==='net_loss') {
    const d = oB - rB; if (d<=0) return null;
    sB = sA * oA / d;
  } else if (tA==='net_loss' && tB==='turnover') {
    sB = sA * (oA - rA) / oB;
  } else {
    return null;
  }
  if (sB<=0) return null;

  const profit = sA*oA - (sA+sB) + (tA==='turnover'? rA*sA : 0) + rB*sB;
  const minProfit = parseInt(settings.stake?.minProfit)||0;

  return {
    opportunity: opp,
    sideA, sideB,
    pickA, pickB,
    waterA: (oA-1).toFixed(3),
    waterB: (oB-1).toFixed(3),
    stakeB: Math.round(sB),
    profit: Math.round(profit),
    shouldAlert: aInvolved && profit>=minProfit,
    signature: generateSignature(opp)
  };
}

function generateSignature(opp) {
  const books = [
    `${opp.pickA?.book||''}_${opp.pickA?.selection||''}`,
    `${opp.pickB?.book||''}_${opp.pickB?.selection||''}`
  ].sort();
  return `${getEventKey(opp)}_${opp.market}_${opp.line_text||opp.line_numeric||''}_${books.join('_')}`;
}

/* ------------------ 套利表格 ------------------ */
function addArbitrageOpportunity(result, shouldAlert) {
  const tbody = document.querySelector('#arbitrageTable tbody');
  const sig = result.signature;
  const minProfit = parseInt(settings.stake?.minProfit)||0;

  const existed = tbody.querySelector(`tr[data-signature="${sig}"]`);
  if (existed) {
    if (result.profit < minProfit) {
      existed.remove();
      alertedSignatures.delete(sig);
      return;
    }
    updateArbitrageRow(existed, result);
    if (shouldAlert && result.shouldAlert) highlightRow(existed);
    return;
  }

  if (result.profit < minProfit) return;
  const noData = tbody.querySelector('.no-data');
  if (noData) noData.remove();

  const row = createArbitrageRow(result);
  tbody.appendChild(row);

  if (result.shouldAlert && shouldAlert) {
    highlightRow(row);
    sendAlert(result);
    if ((settings.notify?.autoHideRowS||0)>0) {
      setTimeout(()=> row.classList.add('hidden-row'), settings.notify.autoHideRowS*1000);
    }
  }
}

function createArbitrageRow(result) {
  const row = document.createElement('tr');
  row.setAttribute('data-signature', result.signature);

  const opp = result.opportunity;
  const marketText = opp.market==='ah' ? '让球' : '大小球';
  const lineText = opp.line_text || (opp.line_numeric?.toString()||'');

  row.innerHTML = `
    <td>${opp.event_name||''}</td>
    <td>${marketText} ${lineText}</td>
    <td>${result.sideA} (${result.pickA.selection})</td>
    <td>${result.sideB} (${result.pickB.selection})</td>
    <td>${result.waterA}</td>
    <td>${result.waterB}</td>
    <td>${result.sideA==='—' ? '—' : result.stakeB.toLocaleString()}</td>
    <td>${result.profit.toLocaleString()}</td>
  `;
  return row;
}

function updateArbitrageRow(row, result) {
  const c = row.cells;
  if (c.length<8) return;
  c[4].textContent = result.waterA;
  c[5].textContent = result.waterB;
  c[6].textContent = result.sideA==='—' ? '—' : result.stakeB.toLocaleString();
  c[7].textContent = result.profit.toLocaleString();
}

function highlightRow(row) {
  row.classList.add('highlighted');
  setTimeout(()=> row.classList.remove('highlighted'), 1800);
}

function clearArbitrageTable() {
  const tbody = document.querySelector('#arbitrageTable tbody');
  if (tbody) tbody.innerHTML = `<tr class="no-data"><td colspan="8">暂无数据</td></tr>`;
}

function recalculateAllArbitrageOpportunities() {
  const tbody = document.querySelector('#arbitrageTable tbody');
  if (!tbody) return;
  clearArbitrageTable();
  marketBoard.forEach((data, eventId) => {
    if (data.ou.line && data.ou.over && data.ou.under) {
      const opp = {
        event_id: eventId,
        event_name: `${data.home} vs ${data.away}`,
        league: data.league,
        market: 'ou',
        line_text: data.ou.line,
        line_numeric: parseFloat(data.ou.line)||0,
        pickA: { book:data.ou.over.book, selection:'over', odds: data.ou.over.odds },
        pickB: { book:data.ou.under.book, selection:'under', odds: data.ou.under.odds },
        score: data.score
      };
      const r = calculateArbitrage(opp);
      if (r) addArbitrageOpportunity(r,false);
    }
    if (data.ah.line && data.ah.home && data.ah.away) {
      const opp = {
        event_id: eventId,
        event_name: `${data.home} vs ${data.away}`,
        league: data.league,
        market: 'ah',
        line_text: data.ah.line,
        line_numeric: parseFloat(data.ah.line)||0,
        pickA: { book:data.ah.home.book, selection:'home', odds: data.ah.home.odds },
        pickB: { book:data.ah.away.book, selection:'away', odds: data.ah.away.odds },
        score: data.score
      };
      const r = calculateArbitrage(opp);
      if (r) addArbitrageOpportunity(r,false);
    }
  });
}

/* ------------------ 提醒 ------------------ */
function sendAlert(result) {
  const sig = result.signature;
  if (alertedSignatures.has(sig)) return;
  alertedSignatures.add(sig);

  const opp        = result.opportunity;
  const marketText = opp.market === 'ah' ? '让球' : '大小球';
  const lineText   = opp.line_text || (opp.line_numeric?.toString() || '');
  const league     = opp.league || '';
  const teams      = opp.event_name || '';
  const sA         = settings.stake?.amountA || 10000;

  // 标题带上联赛与球队
  const title = `套利机会 · ${league} · ${teams}`;
  // 用 <br> 强制换行，避免样式依赖
  const msg =
    `盘口：${marketText} ${lineText}<br>` +
    `A 水位：${result.waterA}（固定 ${sA.toLocaleString()}）<br>` +
    `B 水位：${result.waterB}（应下 ${result.stakeB.toLocaleString()}）<br>` +
    `均衡盈利：${result.profit.toLocaleString()}`;

  if (settings.notify?.toastEnabled) showToast(title, msg, 'success');

  if (settings.notify?.systemEnabled && 'Notification' in window && Notification.permission==='granted') {
    new Notification(title, { body: `${league} ${teams}  ${marketText}${lineText}  盈利 ${result.profit.toLocaleString()}`, icon:'/favicon.ico' });
  }
  if (settings.notify?.soundEnabled && hasUserInteracted) {
    playNotificationSound();
  }
}

function showToast(title, message, type='info') {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <div class="toast-title">${title}</div>
    <div class="toast-message">${message}</div>
  `;
  stack.appendChild(el);
  const duration = (settings.notify?.toastDurationS||5)*1000;
  setTimeout(()=> {
    el.classList.add('removing');
    setTimeout(()=> el.remove(), 200);
  }, duration);
}

function playNotificationSound() {
  try {
    const ac = new (window.AudioContext||window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain); gain.connect(ac.destination);
    osc.frequency.setValueAtTime(880, ac.currentTime);
    osc.frequency.setValueAtTime(1040, ac.currentTime+0.1);
    osc.frequency.setValueAtTime(880, ac.currentTime+0.2);
    gain.gain.setValueAtTime(0.3, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ac.currentTime+0.3);
    osc.start(ac.currentTime);
    osc.stop(ac.currentTime+0.3);
  } catch(e) { /* 忽略 */ }
}

/* ------------------ 盘口总览渲染（单书商一行 + 稳定排序） ------------------ */
function renderMarketBoard() {
  const tbody = document.querySelector('#marketTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (marketBoard.size===0) {
    tbody.innerHTML = '<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
    return;
  }

  // 当前启用书商集合
  const enabled = new Set(
    Object.entries(settings.books)
      .filter(([,v]) => !!v)
      .map(([k]) => normBookKey(k))
  );

  // 拆分：一行一个书商
  const rows = [];
  for (const [eventId, data] of marketBoard.entries()) {
    const enabledBooks = [...data.books].filter(b => enabled.has(normBookKey(b)));
    if (enabledBooks.length === 0) continue;

    enabledBooks.forEach(book => {
      const rk = rowKey(eventId, book);
      if (!rowOrder.has(rk)) rowOrder.set(rk, ++rowSeq);

      rows.push({
        rk,
        stable: rowOrder.get(rk),
        book,
        league: data.league || '',
        home: data.home || '',
        away: data.away || '',
        score: data.score || '',
        ouText: data.ou.line ? `${data.ou.line} (${data.ou.over ? data.ou.over.odds : '-'}/${data.ou.under ? data.ou.under.odds : '-'})` : '-',
        ahText: data.ah.line ? `${data.ah.line} (${data.ah.home ? data.ah.home.odds : '-'}/${data.ah.away ? data.ah.away.odds : '-'})` : '-',
        kickoffAt: data.kickoffAt || 0,
        updatedAt: data.updatedAt || 0
      });
    });
  }

  if (rows.length === 0) {
    tbody.innerHTML = '<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
    return;
  }

  // 排序
  if (sortMode === 'league') {
    rows.sort((a, b) => {
      const l = a.league.localeCompare(b.league);
      if (l) return l;
      const t = (a.kickoffAt || a.updatedAt) - (b.kickoffAt || b.updatedAt);
      if (t) return t;
      return a.stable - b.stable;
    });
  } else {
    rows.sort((a, b) => {
      const t = (a.kickoffAt || a.updatedAt) - (b.kickoffAt || b.updatedAt);
      if (t) return t;
      const l = a.league.localeCompare(b.league);
      if (l) return l;
      return a.stable - b.stable;
    });
  }

  // 渲染：一行一个书商
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement('tr');
    const timeText = (r.kickoffAt || r.updatedAt) ? formatTime(new Date(r.kickoffAt || r.updatedAt)) : '-';

    tr.innerHTML = `
      <td>${r.book}</td>
      <td>${r.league}</td>
      <td>${r.home}</td>
      <td>${r.away}</td>
      <td>${r.score || '-'}</td>
      <td>${r.ouText}</td>
      <td>${r.ahText}</td>
      <td>${timeText}</td>
    `;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

/* ------------------ UI 初始化 ------------------ */
function initUI(loaded) {
  settings = loaded;

  initHamburgerMenu();
  initSettingsPanels();
  initMarketControls();

  requestNotificationPermission();

  document.addEventListener('click', ()=> hasUserInteracted=true, {once:true});
  document.addEventListener('keydown', ()=> hasUserInteracted=true, {once:true});
}

/* --- 汉堡按钮：稳固修复版（不会再被遮罩挡住） --- */
function initHamburgerMenu() {
  const btn = document.querySelector('#hamburgerBtn, #hamburger, .hamburger-btn, .hamburger, .menu-btn, [data-hamburger]');
  const drawer = document.querySelector('#drawer, [data-drawer], .drawer');

  // 确保有遮罩
  let overlay = document.getElementById('drawerOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'drawerOverlay';
    overlay.className = 'drawer-overlay';
    overlay.style.pointerEvents = 'none';
    document.body.appendChild(overlay);
  } else {
    overlay.classList.remove('active');
    overlay.style.pointerEvents = 'none';
  }

  if (!btn || !drawer) {
    console.warn('hamburger: 未找到按钮或抽屉', {btn:!!btn, drawer:!!drawer});
    return;
  }

  function openDrawer() {
    drawer.classList.add('active');
    overlay.classList.add('active');
    overlay.style.pointerEvents = 'auto';
    document.body.style.overflow = 'hidden';
  }
  function closeDrawer() {
    drawer.classList.remove('active');
    overlay.classList.remove('active');
    overlay.style.pointerEvents = 'none';
    document.body.style.overflow = '';
  }

  btn.addEventListener('click', (e)=> { e.preventDefault(); e.stopPropagation(); openDrawer(); });
  overlay.addEventListener('click', (e)=> { e.preventDefault(); closeDrawer(); });
  document.addEventListener('keydown', (e)=> { if (e.key==='Escape') closeDrawer(); });

  // 初始状态强制关闭
  closeDrawer();

  // 展开/折叠控制按钮（存在则启用）
  const expandAllBtn  = document.getElementById('expandAllBtn');
  const collapseAllBtn= document.getElementById('collapseAllBtn');
  if (expandAllBtn) expandAllBtn.addEventListener('click', ()=>{
    document.querySelectorAll('#drawer details').forEach(d=> d.open=true);
    savePanelStates();
  });
  if (collapseAllBtn) collapseAllBtn.addEventListener('click', ()=>{
    document.querySelectorAll('#drawer details').forEach(d=> d.open=false);
    savePanelStates();
  });
}

/* --- 面板 & 设置 --- */
function initSettingsPanels() {
  loadPanelStates();
  document.querySelectorAll('#drawer details').forEach(d => d.addEventListener('toggle', savePanelStates));

  initDatasourcePanel();

  renderBookList();
  renderRebateSettings();

  updateStakeInputs();
  const aBookSelect = document.getElementById('a-book');
  const amountAInput= document.getElementById('amount-a');
  const minProfitInput=document.getElementById('min-profit');

  if (aBookSelect) aBookSelect.addEventListener('change', ()=>{
    settings.stake=settings.stake||{};
    settings.stake.aBook = aBookSelect.value;
    saveSettings();
  });
  if (amountAInput) amountAInput.addEventListener('input', ()=>{
    settings.stake=settings.stake||{};
    settings.stake.amountA = parseInt(amountAInput.value)||0;
    saveSettings();
    recalculateAllArbitrageOpportunities();
  });
  if (minProfitInput) minProfitInput.addEventListener('input', ()=>{
    settings.stake=settings.stake||{};
    settings.stake.minProfit = parseInt(minProfitInput.value)||0;
    saveSettings();
    recalculateAllArbitrageOpportunities();
  });

  updateNotifyInputs();
  const systemNotify = document.getElementById('system-notify');
  const soundNotify  = document.getElementById('sound-notify');
  const toastNotify  = document.getElementById('toast-notify');
  const toastDuration= document.getElementById('toast-duration');
  const autoHideRow  = document.getElementById('auto-hide-row');
  const clearAlerts  = document.getElementById('clear-alerts');

  if (systemNotify) systemNotify.addEventListener('change', ()=>{
    settings.notify=settings.notify||{};
    settings.notify.systemEnabled = systemNotify.checked;
    saveSettings();
    if (systemNotify.checked) requestNotificationPermission();
  });
  if (soundNotify)  soundNotify.addEventListener('change', ()=>{
    settings.notify=settings.notify||{};
    settings.notify.soundEnabled = soundNotify.checked;
    saveSettings();
  });
  if (toastNotify)  toastNotify.addEventListener('change', ()=>{
    settings.notify=settings.notify||{};
    settings.notify.toastEnabled = toastNotify.checked;
    saveSettings();
  });
  if (toastDuration) toastDuration.addEventListener('input', ()=>{
    settings.notify=settings.notify||{};
    settings.notify.toastDurationS = parseInt(toastDuration.value)||5;
    saveSettings();
  });
  if (autoHideRow)  autoHideRow.addEventListener('input', ()=>{
    settings.notify=settings.notify||{};
    settings.notify.autoHideRowS = parseInt(autoHideRow.value)||0;
    saveSettings();
  });
  if (clearAlerts) clearAlerts.addEventListener('click', ()=>{
    alertedSignatures.clear();
    document.querySelectorAll('#arbitrageTable tbody tr.hidden-row').forEach(r => r.classList.remove('hidden-row'));
    showToast('系统','已清除提醒记录','success');
  });
}

/* 书商 UI 渲染 */
function renderBookList() {
  const container = document.getElementById('book-list');
  if (!container) return;

  container.innerHTML = '';
  if (discoveredBooks.size===0) {
    container.innerHTML = `<div class="no-books-message">暂无书商数据</div>`;
    return;
  }

  const sorted = Array.from(discoveredBooks).sort();
  sorted.forEach(book => {
    const item = document.createElement('div'); item.className='book-item';
    const id = `chk-book-${book}`;
    item.innerHTML = `
      <input type="checkbox" id="${id}" ${settings.books[book] ? 'checked' : ''}>
      <label for="${id}">${book.charAt(0).toUpperCase()+book.slice(1)}</label>
    `;
    const chk = item.querySelector('input');
    chk.addEventListener('change', ()=>{
      settings.books[book] = chk.checked;
      saveSettings();
      // A 平台自动校正
      const currentABook = normBookKey(settings.stake?.aBook||'');
      if (!chk.checked && currentABook===book) {
        const enabled = Object.entries(settings.books).filter(([,v])=>v).map(([k])=>k);
        settings.stake.aBook = enabled[0] || '';
        updateABookOptions();
      }
      renderRebateSettings();
      renderMarketBoard(); // 立即按勾选过滤盘口总览
      recalculateAllArbitrageOpportunities(); // 重新计算套利
    });
    container.appendChild(item);
  });
}

function renderRebateSettings() {
  const container = document.querySelector('#panel-rebates .panel-content');
  if (!container) return;
  container.innerHTML = '';

  if (discoveredBooks.size===0) {
    container.innerHTML = '<div class="no-books-message">暂无书商数据</div>';
    return;
  }
  const enabled = Array.from(discoveredBooks).filter(b => !!settings.books[b]).sort();
  if (enabled.length===0) {
    container.innerHTML = '<div class="no-books-message">请先选择书商</div>';
    return;
  }

  enabled.forEach(book => {
    const r = settings.rebates[book] || { type:'turnover', rate:0.006 };
    const group = document.createElement('div');
    group.className = 'rebate-group';
    group.innerHTML = `
      <h4>${book.charAt(0).toUpperCase()+book.slice(1)}</h4>
      <div class="form-row">
        <label>类型：</label>
        <select id="${book}-type">
          <option value="turnover" ${r.type==='turnover'?'selected':''}>Turnover</option>
          <option value="net_loss" ${r.type==='net_loss'?'selected':''}>Net Loss</option>
        </select>
      </div>
      <div class="form-row">
        <label>比例：</label>
        <input type="number" id="${book}-rate" step="0.001" min="0" max="1" value="${r.rate}">
      </div>
    `;
    container.appendChild(group);

    const typeSel = group.querySelector(`#${book}-type`);
    const rateInp = group.querySelector(`#${book}-rate`);
    typeSel.addEventListener('change', ()=>{
      settings.rebates[book] = settings.rebates[book]||{};
      settings.rebates[book].type = typeSel.value;
      saveSettings();
      recalculateAllArbitrageOpportunities();
    });
    rateInp.addEventListener('input', ()=>{
      settings.rebates[book] = settings.rebates[book]||{};
      settings.rebates[book].rate = parseFloat(rateInp.value)||0;
      saveSettings();
      recalculateAllArbitrageOpportunities();
    });
  });
}

function updateABookOptions() {
  const sel = document.getElementById('a-book');
  if (!sel) return;
  const val = sel.value;
  sel.innerHTML = '';

  const enabled = Array.from(discoveredBooks).filter(b=>!!settings.books[b]).sort();
  if (enabled.length===0) {
    const opt = document.createElement('option');
    opt.value=''; opt.textContent='请先选择书商'; opt.disabled=true;
    sel.appendChild(opt);
    return;
  }
  enabled.forEach(b=>{
    const opt = document.createElement('option');
    opt.value=b; opt.textContent=b.charAt(0).toUpperCase()+b.slice(1);
    sel.appendChild(opt);
  });

  if (enabled.includes(val)) {
    sel.value = val;
  } else {
    sel.value = enabled[0];
    settings.stake.aBook = enabled[0];
    saveSettings();
  }
}

/* 数据源面板 */
function initDatasourcePanel() {
  const wsModeAuto   = document.getElementById('ws-mode-auto');
  const wsModeCustom = document.getElementById('ws-mode-custom');
  const wsUrlInput   = document.getElementById('ws-url');
  const wsTokenInput = document.getElementById('ws-token');
  const useMockChk   = document.getElementById('use-mock');
  const testBtn      = document.getElementById('test-connection');
  const reconnectBtn = document.getElementById('reconnect-now');

  const ds = settings.datasource || {};
  if (ds.wsMode==='custom') {
    wsModeCustom && (wsModeCustom.checked=true);
    wsUrlInput && (wsUrlInput.disabled=false);
  } else {
    wsModeAuto && (wsModeAuto.checked=true);
    wsUrlInput && (wsUrlInput.disabled=true);
  }
  wsUrlInput && (wsUrlInput.value = ds.wsUrl||'');
  wsTokenInput && (wsTokenInput.value = ds.token||'');
  if (useMockChk) useMockChk.checked = ds.useMock!==false;

  wsModeAuto && wsModeAuto.addEventListener('change', ()=>{
    if (wsModeAuto.checked) {
      settings.datasource.wsMode='auto';
      if (wsUrlInput) wsUrlInput.disabled=true;
      saveSettings(); showReconnectButton();
    }
  });
  wsModeCustom && wsModeCustom.addEventListener('change', ()=>{
    if (wsModeCustom.checked) {
      settings.datasource.wsMode='custom';
      if (wsUrlInput) wsUrlInput.disabled=false;
      saveSettings(); showReconnectButton();
    }
  });
  wsUrlInput && wsUrlInput.addEventListener('input', ()=>{
    settings.datasource.wsUrl = wsUrlInput.value;
    saveSettings(); showReconnectButton();
  });
  wsTokenInput && wsTokenInput.addEventListener('input', ()=>{
    settings.datasource.token = wsTokenInput.value;
    saveSettings(); showReconnectButton();
  });

  if (useMockChk) {
    const syncMock = ()=>{
      settings.datasource.useMock = useMockChk.checked;
      saveSettings();
      if (!useMockChk.checked) {
        marketBoard.clear();
        clearArbitrageTable();
        clearDiscoveredBooks();
        renderMarketBoard();
        alertedSignatures.clear();
        const stack = document.getElementById('toast-stack'); if (stack) stack.innerHTML='';
        try { ws && ws.close(); } catch(_){}
        if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer=null; }
        console.log('已关闭模拟数据，清空显示');
      } else {
        renderBookList(); renderRebateSettings(); updateABookOptions();
      }
      alertedSignatures.clear();
      reconnectNow();
    };
    useMockChk.addEventListener('change', syncMock);
    const parent = useMockChk.closest('.toggle-item');
    parent && parent.addEventListener('click', (e)=>{
      if (e.target!==useMockChk) {
        e.preventDefault();
        useMockChk.checked = !useMockChk.checked;
        syncMock();
      }
    });
  }

  testBtn && testBtn.addEventListener('click', testConnection);
  reconnectBtn && reconnectBtn.addEventListener('click', ()=>{ reconnectNow(); hideReconnectButton(); });
}

function showReconnectButton(){ const b=document.getElementById('reconnect-now'); if(b) b.style.display='block'; }
function hideReconnectButton(){ const b=document.getElementById('reconnect-now'); if(b) b.style.display='none'; }

function updateStakeInputs() {
  const s = settings.stake||{};
  const amountAInput = document.getElementById('amount-a');
  const minProfitInput= document.getElementById('min-profit');
  if (amountAInput) amountAInput.value = s.amountA||10000;
  if (minProfitInput) minProfitInput.value = s.minProfit||0;
  updateABookOptions();
}

function updateNotifyInputs() {
  const n = settings.notify||{};
  const systemNotify = document.getElementById('system-notify');
  const soundNotify  = document.getElementById('sound-notify');
  const toastNotify  = document.getElementById('toast-notify');
  const toastDuration= document.getElementById('toast-duration');
  const autoHideRow  = document.getElementById('auto-hide-row');
  if (systemNotify) systemNotify.checked = !!n.systemEnabled;
  if (soundNotify)  soundNotify.checked  = n.soundEnabled!==false;
  if (toastNotify)  toastNotify.checked  = n.toastEnabled!==false;
  if (toastDuration) toastDuration.value  = n.toastDurationS||5;
  if (autoHideRow)   autoHideRow.value    = n.autoHideRowS||30;
}

/* 面板状态 */
function loadPanelStates() {
  try {
    const raw = localStorage.getItem('panel_state_v1');
    const s = raw ? JSON.parse(raw) : {};
    ['panel-datasource','panel-books','panel-rebates','panel-stake','panel-notify','panel-marketboard'].forEach(id=>{
      const el = document.getElementById(id);
      if (!el) return;
      if (id==='panel-marketboard') el.open = s[id]===true; // 默认折叠
      else el.open = s[id]!==false;                         // 默认展开
    });
  } catch(e) {}
}
function savePanelStates() {
  try {
    const s = {};
    ['panel-datasource','panel-books','panel-rebates','panel-stake','panel-notify','panel-marketboard'].forEach(id=>{
      const el = document.getElementById(id);
      if (el) s[id] = !!el.open;
    });
    localStorage.setItem('panel_state_v1', JSON.stringify(s));
  } catch(e) {}
}

/* 市场控制面板 */
function initMarketControls() {
  const sortByLeagueBtn = document.querySelector('#sortByLeague, [data-sort="league"]');
  const sortByTimeBtn   = document.querySelector('#sortByTime, [data-sort="time"]');
  const collapseBtn     = document.getElementById('market-collapse-btn');
  const marketPanel     = document.getElementById('panel-marketboard');

  if (sortByLeagueBtn) {
    sortByLeagueBtn.addEventListener('click', () => {
      sortMode = 'league';
      sortByLeagueBtn.classList.add('active');
      sortByTimeBtn && sortByTimeBtn.classList.remove('active');
      renderMarketBoard();
    });
  }

  if (sortByTimeBtn) {
    sortByTimeBtn.addEventListener('click', () => {
      sortMode = 'time';
      sortByTimeBtn.classList.add('active');
      sortByLeagueBtn && sortByLeagueBtn.classList.remove('active');
      renderMarketBoard();
    });
  }

  if (collapseBtn && marketPanel) {
    collapseBtn.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); marketPanel.open=!marketPanel.open; savePanelStates(); });
  }
}

/* 其它工具 */
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission==='default') {
    Notification.requestPermission();
  }
}

function updateConnectionStatus(status) {
  const badge = document.getElementById('statusBadge');
  const alert = document.getElementById('connectionError');
  if (!badge || !alert) return;
  badge.className = `status-badge ${status}`;
  if (status==='connected') { badge.textContent='已连接'; alert.style.display='none'; }
  else if (status==='connecting') { badge.textContent='连接中...'; alert.style.display='none'; }
  else { badge.textContent='重连中...'; alert.style.display='block'; }
}

function updateLastUpdateTime() {
  const el = document.getElementById('lastUpdateTime');
  if (el) el.textContent = formatTime();
}

/* ------------------ 启动入口 ------------------ */
document.addEventListener('DOMContentLoaded', ()=>{
  console.log('应用启动');
  const loaded = loadSettings();
  initUI(loaded);
  connectWS();
});
