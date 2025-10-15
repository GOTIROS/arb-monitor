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
let marketBoard = new Map();       // eventKey -> {league, home, away, score, books:Set, ouMap:Map, ahMap:Map, updatedAt, kickoffAt}
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
    // 新书商默认启用：只要不是显式 false
    if (!(b in settings.books)) {
      settings.books[b] = true;
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
  const id = opp.event_id || opp.eventId || opp.match_id || '';
  if (id) return String(id);
  const home = opp.home || '';
  const away = opp.away || '';
  if (home || away) return `${opp.league||''}|${home} vs ${away}`;
  return `${opp.league || ''}|${opp.event_name || ''}`;
}

function formatTime(date=new Date()) {
  return date.toLocaleTimeString('zh-CN', {
    hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit'
  });
}

/* ------------------ WebSocket ------------------ */
function connectWS() {
  if (ws && (ws.readyState===WebSocket.CONNECTING || ws.readyState===WebSocket.OPEN)) return;

  if (settings.datasource?.wsMode==='custom' && !((settings.datasource?.wsUrl||'').trim())) {
    updateConnectionStatus('connecting');
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

/* ------------------ 消息处理（新增兼容层） ------------------ */
function _num(v){ const n=(typeof v==='string')?parseFloat(v):Number(v); return Number.isFinite(n)?n:undefined; }
function _str(v){ if(v==null) return ''; return (typeof v==='string')?v:String(v); }
function _pick(obj, keys, fallback){ for(const k of keys){ if(obj && obj[k]!=null && obj[k]!=='') return obj[k]; } return fallback; }

const _OU_ALIASES = new Set(['ou','o/u','totals','total','大小','大小球','大/小','daxiao']);
const _AH_ALIASES = new Set(['ah','hdp','handicap','让球','让盘','让分','亚洲盘','亚洲让球']);
const _OVER_ALIASES  = new Set(['over','o','大','大球','overline','overbet']);
const _UNDER_ALIASES = new Set(['under','u','小','小球','underline','underbet']);
const _HOME_ALIASES  = new Set(['home','h','主','主队','1']);
const _AWAY_ALIASES  = new Set(['away','a','客','客队','2']);

function _normSel(s){
  const t=_str(s).trim().toLowerCase();
  if(_OVER_ALIASES.has(t)) return 'over';
  if(_UNDER_ALIASES.has(t)) return 'under';
  if(_HOME_ALIASES.has(t)) return 'home';
  if(_AWAY_ALIASES.has(t)) return 'away';
  return t;
}
function _normMarket(m,pickA,pickB){
  let t=_str(m).trim().toLowerCase();
  if(_OU_ALIASES.has(t)) return 'ou';
  if(_AH_ALIASES.has(t)) return 'ah';
  const sa=_normSel(pickA?.selection), sb=_normSel(pickB?.selection);
  if((sa==='over'&&sb==='under')||(sa==='under'&&sb==='over')) return 'ou';
  if((sa==='home'&&sb==='away')||(sa==='away'&&sb==='home')) return 'ah';
  const ms=_str(m).toLowerCase();
  if(ms.includes('handicap')||ms.includes('让')) return 'ah';
  if(ms.includes('total')||ms.includes('大小')) return 'ou';
  return 'ou';
}

/* 🔧 递归提取器：从任意嵌套里取数组或单条记录 */
function _extractList(obj){
  if(Array.isArray(obj)) return obj;
  if(!obj || typeof obj!=='object') return null;
  const keys=['rows','list','items','opps','payload','snapshot','data'];
  for(const k of keys){
    const v=obj[k];
    const r=_extractList(v);
    if(r) return r;
  }
  return null;
}
function _extractOpp(obj){
  if(!obj || typeof obj!=='object') return null;
  // 看起来像一条机会
  if(obj.pickA || obj.pickB || obj.oddsA || obj.oddsB || obj.over_odds || obj.home_odds) return obj;
  const keys=['data','opp','item','record','payload','row'];
  for(const k of keys){
    const v=obj[k];
    if(v && typeof v==='object'){
      const r=_extractOpp(v);
      if(r) return r;
    }
  }
  return null;
}

/** 规格化一条机会 Opp —— 兼容 raw.pickA / raw.pickB */
function _normalizeOpp(raw){
  if (!raw || typeof raw !== 'object') return null;

  const league = _str(_pick(raw, ['league','leagueName','league_name','league_cn','联赛','联赛名'], ''));
  const home   = _str(_pick(raw, ['home','homeTeam','home_name','主队','team_a'], ''));
  const away   = _str(_pick(raw, ['away','awayTeam','away_name','客队','team_b'], ''));
  const eventName = _str(_pick(raw, ['event_name','eventName','赛事','比赛','match_name'], (home && away) ? `${home} vs ${away}` : ''));

  const lineText = _str(_pick(raw, ['line_text','lineText','line','handicap','ah','ou','total','盘口','大小'], ''));
  const lineNum  = _num(_pick(raw, ['line_numeric','lineNum','lineValue','total_points','handicap_value'], undefined));

  const overOdds  = _num(_pick(raw, ['over_odds','o_odds','odds_over','overOdds'], undefined));
  const underOdds = _num(_pick(raw, ['under_odds','u_odds','odds_under','underOdds'], undefined));
  const homeOdds  = _num(_pick(raw, ['home_odds','h_odds','odds_home','odds1','homeOdds'], undefined));
  const awayOdds  = _num(_pick(raw, ['away_odds','a_odds','odds_away','odds2','awayOdds'], undefined));
  const oddsA     = _num(_pick(raw, ['oddsA','odds_a','pickA_odds','aOdds'], undefined));
  const oddsB     = _num(_pick(raw, ['oddsB','odds_b','pickB_odds','bOdds'], undefined));

  // 顶层可能带 bookA/bookB（但很多时候没有）
  const topBookA = _str(_pick(raw, ['bookA','book_a','pickA_book','bookNameA','a_book','aBook','book1'], ''));
  const topBookB = _str(_pick(raw, ['bookB','book_b','pickB_book','bookNameB','b_book','bBook','book2','bookAlt'], ''));

  let selA = _normSel(_pick(raw, ['selA','selectionA','pickA_sel','pickA_selection','selection_a'], ''));
  let selB = _normSel(_pick(raw, ['selB','selectionB','pickB_sel','pickB_selection','selection_b'], ''));

  let pickA, pickB;

  // ✅ 1) 明确兼容：raw.pickA / raw.pickB
  if (raw.pickA && raw.pickB) {
    const p1 = raw.pickA || {};
    const p2 = raw.pickB || {};
    pickA = {
      book: _str(p1.book || p1.bk || p1.book_name || p1.name || topBookA || 'bookA').toLowerCase(),
      selection: _normSel(p1.selection || p1.sel),
      odds: _num(p1.odds)
    };
    pickB = {
      book: _str(p2.book || p2.bk || p2.book_name || p2.name || topBookB || 'bookB').toLowerCase(),
      selection: _normSel(p2.selection || p2.sel),
      odds: _num(p2.odds)
    };
  }

  // 2) over/under 成对赔率
  if ((!pickA || !pickB) && overOdds && underOdds) {
    if (!selA) selA = 'over';
    if (!selB) selB = 'under';
    pickA = pickA || { book: (topBookA || (pickA && pickA.book) || 'bookA').toLowerCase(), selection: selA, odds: overOdds };
    pickB = pickB || { book: (topBookB || (pickB && pickB.book) || 'bookB').toLowerCase(), selection: selB, odds: underOdds };
  }

  // 3) home/away 成对赔率
  if ((!pickA || !pickB) && homeOdds && awayOdds) {
    if (!selA) selA = 'home';
    if (!selB) selB = 'away';
    pickA = pickA || { book: (topBookA || (pickA && pickA.book) || 'bookA').toLowerCase(), selection: selA, odds: homeOdds };
    pickB = pickB || { book: (topBookB || (pickB && pickB.book) || 'bookB').toLowerCase(), selection: selB, odds: awayOdds };
  }

  // 4) A/B + selA/selB
  if ((!pickA || !pickB) && oddsA && oddsB && (selA || selB)) {
    pickA = pickA || { book: (topBookA || 'bookA').toLowerCase(), selection: selA, odds: oddsA };
    pickB = pickB || { book: (topBookB || 'bookB').toLowerCase(), selection: selB, odds: oddsB };
  }

  // 5) picks 数组兜底
  if (!pickA || !pickB) {
    const picks = _pick(raw, ['picks','quotes','markets','legs'], []);
    if (Array.isArray(picks) && picks.length >= 2) {
      const p1 = picks[0] || {}, p2 = picks[1] || {};
      pickA = { book: _str(p1.book || p1.bk || p1.book_name || 'bookA').toLowerCase(), selection: _normSel(p1.selection || p1.sel), odds: _num(p1.odds) };
      pickB = { book: _str(p2.book || p2.bk || p2.book_name || 'bookB').toLowerCase(), selection: _normSel(p2.selection || p2.sel), odds: _num(p2.odds) };
    }
  }

  // 无效就丢弃
  if (!pickA || !pickB) return null;
  if (!(pickA.odds > 1 && pickB.odds > 1)) return null;

  // 市场类型推断（让球/大小）
  const market = _normMarket(_pick(raw, ['market','market_type','mkt','type','玩法'], ''), pickA, pickB);

  const eventId = _pick(raw, ['event_id','eventId','match_id','fid','mid','id'], `${home}-${away}-${lineText}`);

  return {
    event_id: eventId,
    event_name: eventName,
    league, home, away,
    score: _str(_pick(raw, ['score','sc','比分'], '')),
    market,
    line_text: lineText || (lineNum != null ? String(lineNum) : ''),
    line_numeric: (lineNum != null ? lineNum : undefined),
    pickA, pickB,
    kickoffAt: _pick(raw, ['kickoffAt','kickoff_at','kickoff','matchTime','match_time','start_time','start_ts','startTime'], undefined)
  };
}

/** 规格化“外层消息” -> {type:'snapshot'|'opportunity'|'heartbeat', data?, ts?} */
function _normalizeMessage(message){
  if(!message) return null;

  // 直接数组 => 快照
  if(Array.isArray(message)){
    return { type:'snapshot', data: message.map(_normalizeOpp).filter(Boolean), ts: Date.now() };
  }

  let type=_str(message.type).toLowerCase();
  const ts  = message.ts || Date.now();

  if(!type || type==='ping' || type==='hello') return { type:'heartbeat', ts };
  if(type==='heartbeat') return { type:'heartbeat', ts };

  if(['snapshot','full','list'].includes(type)){
    const list=_extractList(message);
    const opps=Array.isArray(list) ? list.map(_normalizeOpp).filter(Boolean) : [];
    console.log('snapshot count:', opps.length);
    return { type:'snapshot', data: opps, ts };
  }

  if(['opportunity','delta','change','upd','update'].includes(type)){
    const raw=_extractOpp(message);
    const opp=_normalizeOpp(raw);
    if(!opp) return { type:'heartbeat', ts };
    return { type:'opportunity', data: opp, ts };
  }

  // 无类型：尝试解析
  const list2=_extractList(message);
  if(Array.isArray(list2)){
    const opps=list2.map(_normalizeOpp).filter(Boolean);
    console.log('snapshot count:', opps.length);
    return { type:'snapshot', data: opps, ts };
  }
  const raw2=_extractOpp(message);
  if(raw2){
    const opp=_normalizeOpp(raw2);
    if(opp) return { type:'opportunity', data: opp, ts };
  }
  return null;
}

/** 改造后的消息入口：统一先规范化，再走原有逻辑 */
function handleWebSocketMessage(message){
  const m=_normalizeMessage(message);
  if(!m) return;

  switch(m.type){
    case 'heartbeat':
      lastHeartbeat = m.ts || Date.now();
      updateLastUpdateTime();
      break;
    case 'snapshot':
      handleSnapshot(m.data || []);
      updateLastUpdateTime();
      break;
    case 'opportunity':
      handleOpportunity(m.data);
      updateLastUpdateTime();
      break;
    default:
      console.warn('未知消息（已规范化但不支持）:', m);
  }
}

/* ===== 快照 & 单条机会处理 ===== */
function handleSnapshot(opps){
  try{
    marketBoard.clear();
    alertedSignatures.clear();
    clearArbitrageTable();
    clearDiscoveredBooks();

    for(const opp of (opps||[])){
      if(!opp) continue;
      if(opp.pickA?.book) addDiscoveredBook(opp.pickA.book);
      if(opp.pickB?.book) addDiscoveredBook(opp.pickB.book);
      updateMarketBoard(opp);
    }

    renderBookList();
    renderRebateSettings();
    updateABookOptions();
    renderMarketBoard();
    recalculateAllArbitrageOpportunities();
  }catch(e){
    console.error('handleSnapshot error:', e);
  }
}

function handleOpportunity(opp){
  try{
    if(!opp) return;
    if(opp.pickA?.book) addDiscoveredBook(opp.pickA.book);
    if(opp.pickB?.book) addDiscoveredBook(opp.pickB.book);
    processOpportunity(opp, true);
    renderMarketBoard();
  }catch(e){
    console.error('handleOpportunity error:', e);
  }
}

/* ------------------ 盘口 & 套利计算 ------------------ */
function processOpportunity(opp, shouldAlert){
  if(!opp?.event_id && !opp?.event_name) return;
  updateMarketBoard(opp);
  const result=calculateArbitrage(opp);
  if(result) addArbitrageOpportunity(result, shouldAlert);
}

function ensureEventContainer(key){
  const cur=marketBoard.get(key);
  if(cur) return cur;
  const obj={ league:'', home:'', away:'', score:'',
    books:new Set(), ouMap:new Map(), ahMap:new Map(),
    updatedAt:0, kickoffAt:undefined };
  marketBoard.set(key,obj);
  return obj;
}

function setOUForBook(cur,book,line,selection,odds){
  if(!book) return;
  const b=normBookKey(book);
  const entry=cur.ouMap.get(b)||{ line:'', over:null, under:null };
  entry.line=line||entry.line||'';
  const sel=(selection||'').toLowerCase();
  if(sel==='over') entry.over=odds;
  if(sel==='under') entry.under=odds;
  cur.ouMap.set(b,entry);
  cur.books.add(b);
}
function setAHForBook(cur,book,line,selection,odds){
  if(!book) return;
  const b=normBookKey(book);
  const entry=cur.ahMap.get(b)||{ line:'', home:null, away:null };
  entry.line=line||entry.line||'';
  const sel=(selection||'').toLowerCase();
  if(sel==='home') entry.home=odds;
  if(sel==='away') entry.away=odds;
  cur.ahMap.set(b,entry);
  cur.books.add(b);
}

function updateMarketBoard(opp){
  const key=getEventKey(opp);
  const cur=ensureEventContainer(key);

  if(opp.league) cur.league=opp.league;
  if(opp.home) cur.home=opp.home;
  if(opp.away) cur.away=opp.away;
  if((!cur.home||!cur.away) && opp.event_name){
    const [h,a]=(opp.event_name||'').split(' vs ').map(s=>s?.trim()||'');
    if(h && !cur.home) cur.home=h;
    if(a && !cur.away) cur.away=a;
  }
  if(opp.score!=null) cur.score=opp.score;

  const k=guessKickoffTs(opp);
  if(k && (!cur.kickoffAt || Math.abs(k-(cur.kickoffAt||0))>1000)) cur.kickoffAt=k;

  cur.updatedAt=Date.now();

  const lineText=opp.line_text || (opp.line_numeric?.toString()||'');
  if(opp.market==='ou'){
    if(opp.pickA) setOUForBook(cur, opp.pickA.book, lineText, opp.pickA.selection, opp.pickA.odds);
    if(opp.pickB) setOUForBook(cur, opp.pickB.book, lineText, opp.pickB.selection, opp.pickB.odds);
  }else if(opp.market==='ah'){
    if(opp.pickA) setAHForBook(cur, opp.pickA.book, lineText, opp.pickA.selection, opp.pickA.odds);
    if(opp.pickB) setAHForBook(cur, opp.pickB.book, lineText, opp.pickB.selection, opp.pickB.odds);
  }
}

function calculateArbitrage(opp){
  if(!opp?.pickA || !opp?.pickB) return null;

  const bookA=normBookKey(opp.pickA.book);
  const bookB=normBookKey(opp.pickB.book);
  const aBook =normBookKey(settings.stake?.aBook||'');

  const enabledA=settings.books[bookA]!==false;
  const enabledB=settings.books[bookB]!==false;
  if(!enabledA || !enabledB) return null;

  let pickA, pickB, sideA, sideB, aInvolved=false;
  if(bookA===aBook){ aInvolved=true; pickA=opp.pickA; pickB=opp.pickB; sideA='A'; sideB='B'; }
  else if(bookB===aBook){ aInvolved=true; pickA=opp.pickB; pickB=opp.pickA; sideA='B'; sideB='A'; }
  else { pickA=opp.pickA; pickB=opp.pickB; sideA='—'; sideB='B'; }

  const oA=parseFloat(pickA.odds)||0;
  const oB=parseFloat(pickB.odds)||0;
  const sA=parseInt(settings.stake?.amountA)||10000;
  if(oA<=1 || oB<=1) return null;

  const ra=settings.rebates?.[normBookKey(pickA.book)] || {type:'turnover', rate:0};
  const rb=settings.rebates?.[normBookKey(pickB.book)] || {type:'turnover', rate:0};
  const rA=ra.rate||0, rB=rb.rate||0, tA=ra.type||'turnover', tB=rb.type||'turnover';

  let sB;
  if(tA==='turnover' && tB==='turnover'){ sB = sA * oA / oB; }
  else if(tA==='net_loss' && tB==='net_loss'){ const d=oB - rB; if(d<=0) return null; sB = sA * (oA - rA) / d; }
  else if(tA==='turnover' && tB==='net_loss'){ const d=oB - rB; if(d<=0) return null; sB = sA * oA / d; }
  else if(tA==='net_loss' && tB==='turnover'){ sB = sA * (oA - rA) / oB; }
  else return null;
  if(sB<=0) return null;

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

function generateSignature(opp){
  const books=[
    `${opp.pickA?.book||''}_${opp.pickA?.selection||''}`,
    `${opp.pickB?.book||''}_${opp.pickB?.selection||''}`
  ].sort();
  return `${getEventKey(opp)}_${opp.market}_${opp.line_text||opp.line_numeric||''}_${books.join('_')}`;
}

/* ------------------ 套利表格 ------------------ */
function addArbitrageOpportunity(result, shouldAlert){
  const tbody=document.querySelector('#arbitrageTable tbody');
  if(!tbody) return;

  const sig=result.signature;
  const minProfit=parseInt(settings.stake?.minProfit)||0;

  const existed=tbody.querySelector(`tr[data-signature="${sig}"]`);
  if(existed){
    if(result.profit<minProfit){ existed.remove(); alertedSignatures.delete(sig); return; }
    updateArbitrageRow(existed,result);
    if(shouldAlert && result.shouldAlert) highlightRow(existed);
    return;
  }

  if(result.profit<minProfit) return;
  const noData=tbody.querySelector('.no-data');
  if(noData) noData.remove();

  const row=createArbitrageRow(result);
  tbody.appendChild(row);

  if(result.shouldAlert && shouldAlert){
    highlightRow(row);
    sendAlert(result);
    if((settings.notify?.autoHideRowS||0)>0){
      setTimeout(()=> row.classList.add('hidden-row'), settings.notify.autoHideRowS*1000);
    }
  }
}

function createArbitrageRow(result){
  const row=document.createElement('tr');
  row.setAttribute('data-signature', result.signature);

  const opp=result.opportunity;
  const marketText=opp.market==='ah'?'让球':'大小球';
  const lineText=opp.line_text || (opp.line_numeric?.toString()||'');

  row.innerHTML=`
    <td>${opp.event_name||(`${opp.home||''} vs ${opp.away||''}`)}</td>
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
function updateArbitrageRow(row,result){
  const c=row.cells;
  if(c.length<8) return;
  c[4].textContent=result.waterA;
  c[5].textContent=result.waterB;
  c[6].textContent=result.sideA==='—' ? '—' : result.stakeB.toLocaleString();
  c[7].textContent=result.profit.toLocaleString();
}
function highlightRow(row){ row.classList.add('highlighted'); setTimeout(()=> row.classList.remove('highlighted'), 1800); }
function clearArbitrageTable(){
  const tbody=document.querySelector('#arbitrageTable tbody');
  if(tbody) tbody.innerHTML=`<tr class="no-data"><td colspan="8">暂无数据</td></tr>`;
}

/* 按当前盘口数据“重新配对重算” */
function recalculateAllArbitrageOpportunities(){
  const tbody=document.querySelector('#arbitrageTable tbody');
  if(!tbody) return;
  clearArbitrageTable();

  marketBoard.forEach((data,eventKey)=>{
    const ouEntries=Array.from(data.ouMap.entries());
    for(const [bOver,eOver] of ouEntries){
      for(const [bUnder,eUnder] of ouEntries){
        if(bOver===bUnder) continue;
        if(eOver?.over && eUnder?.under){
          const opp={
            event_id:eventKey,
            event_name:`${data.home} vs ${data.away}`,
            league:data.league,
            market:'ou',
            line_text:eOver.line || eUnder.line || '',
            line_numeric:parseFloat(eOver.line||eUnder.line)||0,
            pickA:{book:bOver, selection:'over', odds:eOver.over},
            pickB:{book:bUnder,selection:'under',odds:eUnder.under},
            score:data.score, home:data.home, away:data.away
          };
          const r=calculateArbitrage(opp);
          if(r) addArbitrageOpportunity(r,false);
        }
      }
    }
    const ahEntries=Array.from(data.ahMap.entries());
    for(const [bHome,eHome] of ahEntries){
      for(const [bAway,eAway] of ahEntries){
        if(bHome===bAway) continue;
        if(eHome?.home && eAway?.away){
          const opp={
            event_id:eventKey,
            event_name:`${data.home} vs ${data.away}`,
            league:data.league,
            market:'ah',
            line_text:eHome.line || eAway.line || '',
            line_numeric:parseFloat(eHome.line||eAway.line)||0,
            pickA:{book:bHome,selection:'home',odds:eHome.home},
            pickB:{book:bAway,selection:'away',odds:eAway.away},
            score:data.score, home:data.home, away:data.away
          };
          const r=calculateArbitrage(opp);
          if(r) addArbitrageOpportunity(r,false);
        }
      }
    }
  });
}

/* ------------------ 提醒 ------------------ */
function sendAlert(result){
  const sig=result.signature;
  if(alertedSignatures.has(sig)) return;
  alertedSignatures.add(sig);

  const opp=result.opportunity;
  const marketText=opp.market==='ah'?'让球':'大小球';
  const lineText =opp.line_text || (opp.line_numeric?.toString()||'');
  const league   =opp.league || '';
  const teams    =opp.event_name || `${opp.home||''} vs ${opp.away||''}`;
  const sA       =settings.stake?.amountA || 10000;

  const title=`套利机会 · ${league} · ${teams}`;
  const msg=
    `盘口：${marketText} ${lineText}<br>` +
    `A 水位：${result.waterA}（固定 ${sA.toLocaleString()}）<br>` +
    `B 水位：${result.waterB}（应下 ${result.stakeB.toLocaleString()}）<br>` +
    `均衡盈利：${result.profit.toLocaleString()}`;

  if(settings.notify?.toastEnabled) showToast(title,msg,'success');

  if(settings.notify?.systemEnabled && 'Notification' in window && Notification.permission==='granted'){
    new Notification(title,{body:`${league} ${teams}  ${marketText}${lineText}  盈利 ${result.profit.toLocaleString()}`,icon:'/favicon.ico'});
  }
  if(settings.notify?.soundEnabled && hasUserInteracted){
    playNotificationSound();
  }
}
function showToast(title,message,type='info'){
  const stack=document.getElementById('toast-stack');
  if(!stack) return;
  const el=document.createElement('div');
  el.className=`toast ${type}`;
  el.innerHTML=`<div class="toast-title">${title}</div><div class="toast-message">${message}</div>`;
  stack.appendChild(el);
  const duration=(settings.notify?.toastDurationS||5)*1000;
  setTimeout(()=>{ el.classList.add('removing'); setTimeout(()=> el.remove(),200); }, duration);
}
function playNotificationSound(){
  try{
    const ac=new (window.AudioContext||window.webkitAudioContext)();
    const osc=ac.createOscillator();
    const gain=ac.createGain();
    osc.connect(gain); gain.connect(ac.destination);
    osc.frequency.setValueAtTime(880,ac.currentTime);
    osc.frequency.setValueAtTime(1040,ac.currentTime+0.1);
    osc.frequency.setValueAtTime(880,ac.currentTime+0.2);
    gain.gain.setValueAtTime(0.3,ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01,ac.currentTime+0.3);
    osc.start(ac.currentTime); osc.stop(ac.currentTime+0.3);
  }catch(e){}
}

/* ------------------ 盘口总览渲染 ------------------ */
function renderMarketBoard(){
  const tbody=document.querySelector('#marketTable tbody');
  if(!tbody) return;
  tbody.innerHTML='';

  if(marketBoard.size===0){
    tbody.innerHTML='<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
    return;
  }

  const enabled=new Set(
    Array.from(discoveredBooks).filter(b=>settings.books[b]!==false).map(b=>normBookKey(b))
  );

  const rows=[];
  for(const [eventId,data] of marketBoard.entries()){
    const enabledBooks=[...data.books].filter(b=>enabled.has(normBookKey(b)));
    if(enabledBooks.length===0) continue;

    enabledBooks.forEach(book=>{
      const rk=rowKey(eventId,book);
      if(!rowOrder.has(rk)) rowOrder.set(rk,++rowSeq);

      const ouE=data.ouMap.get(book);
      const ahE=data.ahMap.get(book);

      rows.push({
        rk, stable:rowOrder.get(rk), book,
        league:data.league||'', home:data.home||'', away:data.away||'',
        score:data.score||'',
        ouText:ouE?`${ouE.line||''} (${ouE.over ?? '-'} / ${ouE.under ?? '-'})`:'-',
        ahText:ahE?`${ahE.line||''} (${ahE.home ?? '-'} / ${ahE.away ?? '-'})`:'-',
        kickoffAt:data.kickoffAt||0, updatedAt:data.updatedAt||0
      });
    });
  }

  if(rows.length===0){
    tbody.innerHTML='<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
    return;
  }

  if(sortMode==='league'){
    rows.sort((a,b)=>{
      const l=a.league.localeCompare(b.league); if(l) return l;
      const t=(a.kickoffAt||a.updatedAt)-(b.kickoffAt||b.updatedAt); if(t) return t;
      return a.stable-b.stable;
    });
  }else{
    rows.sort((a,b)=>{
      const t=(a.kickoffAt||a.updatedAt)-(b.kickoffAt||b.updatedAt); if(t) return t;
      const l=a.league.localeCompare(b.league); if(l) return l;
      return a.stable-b.stable;
    });
  }

  const frag=document.createDocumentFragment();
  for(const r of rows){
    const tr=document.createElement('tr');
    const timeText=(r.kickoffAt||r.updatedAt)?formatTime(new Date(r.kickoffAt||r.updatedAt)):'-';
    tr.innerHTML=`
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
function initUI(loaded){
  settings=loaded;

  initHamburgerMenu();
  initSettingsPanels();
  initMarketControls();

  requestNotificationPermission();

  document.addEventListener('click', ()=> hasUserInteracted=true, {once:true});
  document.addEventListener('keydown', ()=> hasUserInteracted=true, {once:true});
}

/* --- 汉堡按钮 --- */
function initHamburgerMenu(){
  const btn=document.querySelector('#hamburgerBtn, #hamburger, .hamburger-btn, .hamburger, .menu-btn, [data-hamburger]');
  const drawer=document.querySelector('#drawer, [data-drawer], .drawer');

  let overlay=document.getElementById('drawerOverlay');
  if(!overlay){
    overlay=document.createElement('div');
    overlay.id='drawerOverlay';
    overlay.className='drawer-overlay';
    overlay.style.pointerEvents='none';
    document.body.appendChild(overlay);
  }else{
    overlay.classList.remove('active');
    overlay.style.pointerEvents='none';
  }

  if(!btn || !drawer){
    console.warn('hamburger: 未找到按钮或抽屉',{btn:!!btn,drawer:!!drawer});
    return;
  }

  function openDrawer(){ drawer.classList.add('active'); overlay.classList.add('active'); overlay.style.pointerEvents='auto'; document.body.style.overflow='hidden'; }
  function closeDrawer(){ drawer.classList.remove('active'); overlay.classList.remove('active'); overlay.style.pointerEvents='none'; document.body.style.overflow=''; }

  btn.addEventListener('click',(e)=>{ e.preventDefault(); e.stopPropagation(); openDrawer(); });
  overlay.addEventListener('click',(e)=>{ e.preventDefault(); closeDrawer(); });
  document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') closeDrawer(); });

  closeDrawer();

  const expandAllBtn=document.getElementById('expandAllBtn');
  const collapseAllBtn=document.getElementById('collapseAllBtn');
  if(expandAllBtn) expandAllBtn.addEventListener('click',()=>{
    document.querySelectorAll('#drawer details').forEach(d=> d.open=true); savePanelStates();
  });
  if(collapseAllBtn) collapseAllBtn.addEventListener('click',()=>{
    document.querySelectorAll('#drawer details').forEach(d=> d.open=false); savePanelStates();
  });
}

/* --- 面板 & 设置 --- */
function initSettingsPanels(){
  loadPanelStates();
  document.querySelectorAll('#drawer details').forEach(d=> d.addEventListener('toggle', savePanelStates));

  initDatasourcePanel();

  renderBookList();
  renderRebateSettings();

  updateStakeInputs();
  const aBookSelect=document.getElementById('a-book');
  const amountAInput=document.getElementById('amount-a');
  const minProfitInput=document.getElementById('min-profit');

  if(aBookSelect) aBookSelect.addEventListener('change',()=>{
    settings.stake=settings.stake||{};
    settings.stake.aBook=aBookSelect.value;
    saveSettings();
  });
  if(amountAInput) amountAInput.addEventListener('input',()=>{
    settings.stake=settings.stake||{};
    settings.stake.amountA=parseInt(amountAInput.value)||0;
    saveSettings();
    recalculateAllArbitrageOpportunities();
  });
  if(minProfitInput) minProfitInput.addEventListener('input',()=>{
    settings.stake=settings.stake||{};
    settings.stake.minProfit=parseInt(minProfitInput.value)||0;
    saveSettings();
    recalculateAllArbitrageOpportunities();
  });

  updateNotifyInputs();
  const systemNotify=document.getElementById('system-notify');
  const soundNotify =document.getElementById('sound-notify');
  const toastNotify =document.getElementById('toast-notify');
  const toastDuration=document.getElementById('toast-duration');
  const autoHideRow  =document.getElementById('auto-hide-row');
  const clearAlerts  =document.getElementById('clear-alerts');

  if(systemNotify) systemNotify.addEventListener('change',()=>{
    settings.notify=settings.notify||{};
    settings.notify.systemEnabled=systemNotify.checked;
    saveSettings();
    if(systemNotify.checked) requestNotificationPermission();
  });
  if(soundNotify) soundNotify.addEventListener('change',()=>{
    settings.notify=settings.notify||{};
    settings.notify.soundEnabled=soundNotify.checked;
    saveSettings();
  });
  if(toastNotify) toastNotify.addEventListener('change',()=>{
    settings.notify=settings.notify||{};
    settings.notify.toastEnabled=toastNotify.checked;
    saveSettings();
  });
  if(toastDuration) toastDuration.addEventListener('input',()=>{
    settings.notify=settings.notify||{};
    settings.notify.toastDurationS=parseInt(toastDuration.value)||5;
    saveSettings();
  });
  if(autoHideRow) autoHideRow.addEventListener('input',()=>{
    settings.notify=settings.notify||{};
    settings.notify.autoHideRowS=parseInt(autoHideRow.value)||0;
    saveSettings();
  });
  if(clearAlerts) clearAlerts.addEventListener('click',()=>{
    alertedSignatures.clear();
    document.querySelectorAll('#arbitrageTable tbody tr.hidden-row').forEach(r=> r.classList.remove('hidden-row'));
    showToast('系统','已清除提醒记录','success');
  });
}

/* 书商 UI 渲染 */
function renderBookList(){
  const container=document.getElementById('book-list');
  if(!container) return;

  container.innerHTML='';
  if(discoveredBooks.size===0){
    container.innerHTML=`<div class="no-books-message">暂无书商数据</div>`;
    return;
  }

  const sorted=Array.from(discoveredBooks).sort();
  sorted.forEach(book=>{
    const item=document.createElement('div'); item.className='book-item';
    const id=`chk-book-${book}`;
    const checked=settings.books[book]!==false;
    item.innerHTML=`
      <input type="checkbox" id="${id}" ${checked?'checked':''}>
      <label for="${id}">${book.charAt(0).toUpperCase()+book.slice(1)}</label>
    `;
    const chk=item.querySelector('input');
    chk.addEventListener('change',()=>{
      settings.books[book]=chk.checked;
      saveSettings();
      const currentABook=normBookKey(settings.stake?.aBook||'');
      if(!chk.checked && currentABook===book){
        const enabled=Array.from(discoveredBooks).filter(b=>settings.books[b]!==false);
        settings.stake.aBook=enabled[0]||'';
        updateABookOptions();
      }
      renderRebateSettings();
      renderMarketBoard();
      recalculateAllArbitrageOpportunities();
    });
    container.appendChild(item);
  });
}

function renderRebateSettings(){
  const container=document.querySelector('#panel-rebates .panel-content');
  if(!container) return;
  container.innerHTML='';

  if(discoveredBooks.size===0){
    container.innerHTML='<div class="no-books-message">暂无书商数据</div>';
    return;
  }
  const enabled=Array.from(discoveredBooks).filter(b=>settings.books[b]!==false).sort();
  if(enabled.length===0){
    container.innerHTML='<div class="no-books-message">请先选择书商</div>';
    return;
  }

  enabled.forEach(book=>{
    const r=settings.rebates[book] || {type:'turnover', rate:0.006};
    const group=document.createElement('div');
    group.className='rebate-group';
    group.innerHTML=`
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

    const typeSel=group.querySelector(`#${book}-type`);
    const rateInp=group.querySelector(`#${book}-rate`);
    typeSel.addEventListener('change',()=>{
      settings.rebates[book]=settings.rebates[book]||{};
      settings.rebates[book].type=typeSel.value;
      saveSettings();
      recalculateAllArbitrageOpportunities();
    });
    rateInp.addEventListener('input',()=>{
      settings.rebates[book]=settings.rebates[book]||{};
      settings.rebates[book].rate=parseFloat(rateInp.value)||0;
      saveSettings();
      recalculateAllArbitrageOpportunities();
    });
  });
}

function updateABookOptions(){
  const sel=document.getElementById('a-book');
  if(!sel) return;
  const prev=sel.value;
  sel.innerHTML='';

  const enabled=Array.from(discoveredBooks).filter(b=>settings.books[b]!==false).sort();
  if(enabled.length===0){
    const opt=document.createElement('option');
    opt.value=''; opt.textContent='请先选择书商'; opt.disabled=true;
    sel.appendChild(opt);
    return;
  }
  enabled.forEach(b=>{
    const opt=document.createElement('option');
    opt.value=b; opt.textContent=b.charAt(0).toUpperCase()+b.slice(1);
    sel.appendChild(opt);
  });

  if(enabled.includes(prev)){ sel.value=prev; }
  else { sel.value=enabled[0]; settings.stake.aBook=enabled[0]; saveSettings(); }
}

/* 数据源面板 */
function initDatasourcePanel(){
  const wsModeAuto   = document.getElementById('ws-mode-auto');
  const wsModeCustom = document.getElementById('ws-mode-custom');
  const wsUrlInput   = document.getElementById('ws-url');
  const wsTokenInput = document.getElementById('ws-token');
  const useMockChk   = document.getElementById('use-mock');
  const testBtn      = document.getElementById('test-connection');
  const reconnectBtn = document.getElementById('reconnect-now');

  const ds=settings.datasource||{};
  if(ds.wsMode==='custom'){ wsModeCustom && (wsModeCustom.checked=true); wsUrlInput && (wsUrlInput.disabled=false); }
  else { wsModeAuto && (wsModeAuto.checked=true); wsUrlInput && (wsUrlInput.disabled=true); }
  wsUrlInput && (wsUrlInput.value=ds.wsUrl||'');
  wsTokenInput && (wsTokenInput.value=ds.token||'');
  if(useMockChk) useMockChk.checked = ds.useMock!==false;

  wsModeAuto && wsModeAuto.addEventListener('change', ()=>{
    if(wsModeAuto.checked){ settings.datasource.wsMode='auto'; if(wsUrlInput) wsUrlInput.disabled=true; saveSettings(); showReconnectButton(); }
  });
  wsModeCustom && wsModeCustom.addEventListener('change', ()=>{
    if(wsModeCustom.checked){ settings.datasource.wsMode='custom'; if(wsUrlInput) wsUrlInput.disabled=false; saveSettings(); showReconnectButton(); }
  });
  wsUrlInput && wsUrlInput.addEventListener('input', ()=>{
    settings.datasource.wsUrl=wsUrlInput.value; saveSettings(); showReconnectButton();
  });
  wsTokenInput && wsTokenInput.addEventListener('input', ()=>{
    settings.datasource.token=wsTokenInput.value; saveSettings(); showReconnectButton();
  });

  if(useMockChk){
    const syncMock=()=>{
      settings.datasource.useMock=useMockChk.checked; saveSettings();
      if(!useMockChk.checked){
        marketBoard.clear(); clearArbitrageTable(); clearDiscoveredBooks(); renderMarketBoard();
        alertedSignatures.clear();
        const stack=document.getElementById('toast-stack'); if(stack) stack.innerHTML='';
        try{ ws && ws.close(); }catch(_){}
        if(wsReconnectTimer){ clearTimeout(wsReconnectTimer); wsReconnectTimer=null; }
        console.log('已关闭模拟数据，清空显示');
      }else{
        renderBookList(); renderRebateSettings(); updateABookOptions();
      }
      alertedSignatures.clear();
      reconnectNow();
    };
    useMockChk.addEventListener('change', syncMock);
    const parent=useMockChk.closest('.toggle-item');
    parent && parent.addEventListener('click',(e)=>{
      if(e.target!==useMockChk){ e.preventDefault(); useMockChk.checked=!useMockChk.checked; syncMock(); }
    });
  }

  testBtn && testBtn.addEventListener('click', testConnection);
  reconnectBtn && reconnectBtn.addEventListener('click', ()=>{ reconnectNow(); hideReconnectButton(); });
}

function showReconnectButton(){ const b=document.getElementById('reconnect-now'); if(b) b.style.display='block'; }
function hideReconnectButton(){ const b=document.getElementById('reconnect-now'); if(b) b.style.display='none'; }

function updateStakeInputs(){
  const s=settings.stake||{};
  const amountAInput=document.getElementById('amount-a');
  const minProfitInput=document.getElementById('min-profit');
  if(amountAInput) amountAInput.value=s.amountA||10000;
  if(minProfitInput) minProfitInput.value=s.minProfit||0;
  updateABookOptions();
}

function updateNotifyInputs(){
  const n=settings.notify||{};
  const systemNotify=document.getElementById('system-notify');
  const soundNotify =document.getElementById('sound-notify');
  const toastNotify =document.getElementById('toast-notify');
  const toastDuration=document.getElementById('toast-duration');
  const autoHideRow  =document.getElementById('auto-hide-row');
  if(systemNotify) systemNotify.checked=!!n.systemEnabled;
  if(soundNotify)  soundNotify.checked = n.soundEnabled!==false;
  if(toastNotify)  toastNotify.checked = n.toastEnabled!==false;
  if(toastDuration)toastDuration.value  = n.toastDurationS||5;
  if(autoHideRow)  autoHideRow.value    = n.autoHideRowS||30;
}

/* 面板状态 */
function loadPanelStates(){
  try{
    const raw=localStorage.getItem('panel_state_v1');
    const s=raw?JSON.parse(raw):{};
    ['panel-datasource','panel-books','panel-rebates','panel-stake','panel-notify','panel-marketboard'].forEach(id=>{
      const el=document.getElementById(id);
      if(!el) return;
      if(id==='panel-marketboard') el.open = s[id]===true; else el.open = s[id]!==false;
    });
  }catch(e){}
}
function savePanelStates(){
  try{
    const s={};
    ['panel-datasource','panel-books','panel-rebates','panel-stake','panel-notify','panel-marketboard'].forEach(id=>{
      const el=document.getElementById(id);
      if(el) s[id]=!!el.open;
    });
    localStorage.setItem('panel_state_v1', JSON.stringify(s));
  }catch(e){}
}

/* 市场控制面板 */
function initMarketControls(){
  let sortByLeagueBtn=document.querySelector('#sortByLeague, [data-sort="league"]');
  let sortByTimeBtn  =document.querySelector('#sortByTime,   [data-sort="time"]');

  // 🔧 如果按钮被放在 <summary> 里，搬到外面，避免“禁止的后代”导致点击不稳定
  const marketPanel=document.getElementById('panel-marketboard');
  const summary=marketPanel ? marketPanel.querySelector('summary') : null;
  if(summary){
    const moveOut=(el)=>{
      if(!el) return el;
      if(el.closest('summary')){
        let wrap=document.getElementById('sortBtnsWrap');
        if(!wrap){
          wrap=document.createElement('div');
          wrap.id='sortBtnsWrap';
          wrap.style.display='flex'; wrap.style.gap='12px'; wrap.style.margin='8px 0 0';
          summary.parentNode.insertBefore(wrap, summary.nextSibling);
        }
        wrap.appendChild(el);
      }
      return el;
    };
    sortByLeagueBtn=moveOut(sortByLeagueBtn);
    sortByTimeBtn  =moveOut(sortByTimeBtn);
  }

  const collapseBtn=document.getElementById('market-collapse-btn');

  if(sortByLeagueBtn){
    sortByLeagueBtn.addEventListener('click', (e)=>{
      e.preventDefault(); e.stopPropagation();
      sortMode='league';
      sortByLeagueBtn.classList.add('active');
      sortByTimeBtn && sortByTimeBtn.classList.remove('active');
      renderMarketBoard();
    });
  }
  if(sortByTimeBtn){
    sortByTimeBtn.addEventListener('click', (e)=>{
      e.preventDefault(); e.stopPropagation();
      sortMode='time';
      sortByTimeBtn.classList.add('active');
      sortByLeagueBtn && sortByLeagueBtn.classList.remove('active');
      renderMarketBoard();
    });
  }

  if(collapseBtn && marketPanel){
    collapseBtn.addEventListener('click',(e)=>{ e.preventDefault(); e.stopPropagation(); marketPanel.open=!marketPanel.open; savePanelStates(); });
  }
}

/* 其它工具 */
function requestNotificationPermission(){
  if('Notification' in window && Notification.permission==='default'){
    Notification.requestPermission();
  }
}

function updateConnectionStatus(status){
  const badge=document.getElementById('statusBadge');
  const alert=document.getElementById('connectionError');
  if(!badge || !alert) return;
  badge.className=`status-badge ${status}`;
  if(status==='connected'){ badge.textContent='已连接'; alert.style.display='none'; }
  else if(status==='connecting'){ badge.textContent='连接中...'; alert.style.display='none'; }
  else { badge.textContent='重连中...'; alert.style.display='block'; }
}

function updateLastUpdateTime(){
  const el=document.getElementById('lastUpdateTime');
  if(el) el.textContent=formatTime();
}

/* ------------------ 启动入口 ------------------ */
document.addEventListener('DOMContentLoaded', ()=>{
  console.log('应用启动');
  const loaded=loadSettings();
  initUI(loaded);
  connectWS();
});

