/* =======================================================
   arb-monitor — public/app.js
   生产版（无模拟数据；兼容实盘WS；修复港盘&时间戳）
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
let hasUserInteracted = false;
let discoveredBooks = new Set();   // 动态发现

// 声音 & Toast 管理
let pendingBeeps = 0;
let soundHintShown = false;
const alertMemory = new Map(); // sig -> { lastProfit, lastAt }
const ALERT_TTL_MS = 15000;    // 软去重窗口：15s

// 排序 & 稳定行序（用于行情总览，不影响套利表）
let sortMode = 'time'; // 'time' | 'league'
const rowOrder = new Map(); // key: eventKey|book -> stable index
let rowSeq = 0;

/* >>>>>>>>>>>>>>>>>>>>>  新增：本地模拟  <<<<<<<<<<<<<<<<<<<<<< */
let mockTimers = [];
function stopMock(){ try{ mockTimers.forEach(clearInterval);}catch(_){ } mockTimers=[]; }
function connectMock(){
  updateConnectionStatus('connected');
  lastHeartbeat = Date.now();
  // 心跳
  mockTimers.push(setInterval(()=>{ handleWebSocketMessage({type:'heartbeat', ts:Date.now()}); }, 3000));
  // 每 5s 推一份 snapshot（含 OU + AH）
  mockTimers.push(setInterval(()=>{
    const base = {
      league:'测试联赛',
      event_name:'Mock United vs Demo City',
      score:'0:0',
      kickoffAt: Date.now() + 60*60*1000
    };
    const ou = {
      ...base, market:'ou', line_text:'2.5',
      pickA:{ book:'pinnacle', selection:'over',  odds:1.93 },
      pickB:{ book:'188bet',   selection:'under', odds:1.93 }
    };
    const ah = {
      ...base, market:'ah', line_text:'-0.5',
      pickA:{ book:'pinnacle', selection:'home', odds:1.90 },
      pickB:{ book:'188bet',   selection:'away', odds:1.95 }
    };
    handleWebSocketMessage({ type:'snapshot', data:[ou,ah], ts:Date.now() });
  }, 5000));
}
/* >>>>>>>>>>>>>>>>>>>>>  本地模拟结束  <<<<<<<<<<<<<<<<<<<<<< */

/* ------------------ 常用函数 ------------------ */
function rowKey(eventKey, book) { return `${eventKey}|${(book||'').toLowerCase()}`; }
function guessKickoffTs(obj) {
  // 仅把“像时间戳”的值当时间，避免把“第X分钟(40/77等)”误判
  const cands = [obj.kickoffAt,obj.kickoff_at,obj.kickoff,obj.matchTime,obj.match_time,obj.start_time,obj.start_ts,obj.startTime];
  for (const v of cands) {
    if (v == null) continue;
    const n = typeof v === 'string' ? Date.parse(v) : Number(v);
    if (!Number.isNaN(n) && n > 0) {
      if (n < 1e7) return undefined;            // 40、77 这类分钟数：忽略
      return n < 1e12 ? n * 1000 : n;           // 秒 -> 毫秒
    }
  }
  return undefined;
}
function formatTime(date=new Date()) {
  return date.toLocaleTimeString('zh-CN', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
function prettyBook(b){ b = (b||'').toString(); return b.charAt(0).toUpperCase()+b.slice(1); }
function zhMarket(m){ return m==='ah' ? '让球' : '大小球'; }
function zhSel(sel){
  switch((sel||'').toString().toLowerCase()){
    case 'home': return '主';
    case 'away': return '客';
    case 'over': return '大';
    case 'under': return '小';
    default: return sel;
  }
}

/* ------------------ 默认设置 ------------------ */
const DEFAULT_SETTINGS = {
  datasource: { wsMode:'auto', wsUrl:'', token:'', mockEnabled:false }, // <<< 新增 mockEnabled
  books: {},
  rebates: {},                   // 旧字段保留
  rebateA: { book:'', rate:0 },  // A 平台（书商+返水）
  rebateB: { book:'', rate:0 },  // B 平台
  stake:  { aBook:'', amountA:10000, minProfit:0 }, // 投注设置里的 A 平台、固定额等
  notify: { systemEnabled:false, soundEnabled:true, toastEnabled:true, toastDurationS:5, autoHideRowS:30 }
};

/* ------------------ 设置存取 ------------------ */
function loadSettings() {
  try {
    const raw = localStorage.getItem('arb_settings_v1');
    const loaded = raw ? JSON.parse(raw) : {};
    return {
      ...DEFAULT_SETTINGS,
      ...loaded,
      datasource: { ...DEFAULT_SETTINGS.datasource, ...(loaded.datasource||{}) },
      books:      { ...DEFAULT_SETTINGS.books,      ...(loaded.books||{}) },
      rebates:    { ...DEFAULT_SETTINGS.rebates,    ...(loaded.rebates||{}) },
      rebateA:    { ...DEFAULT_SETTINGS.rebateA,    ...(loaded.rebateA||{}) },
      rebateB:    { ...DEFAULT_SETTINGS.rebateB,    ...(loaded.rebateB||{}) },
      stake:      { ...DEFAULT_SETTINGS.stake,      ...(loaded.stake||{}) },
      notify:     { ...DEFAULT_SETTINGS.notify,     ...(loaded.notify||{}) }
    };
  } catch(e) {
    console.error('加载设置失败:', e);
    return DEFAULT_SETTINGS;
  }
}
function saveSettings(){ try{ localStorage.setItem('arb_settings_v1', JSON.stringify(settings)); }catch(e){ console.error(e);} }
window.LoadSettings = loadSettings;
window.SaveSettings = saveSettings;

/* ------------------ 书商管理 ------------------ */
function normBookKey(book){ return (book||'').toLowerCase(); }
function addDiscoveredBook(book){
  if (!book) return;
  const b = normBookKey(book);
  if (!discoveredBooks.has(b)) {
    discoveredBooks.add(b);
    if (!(b in settings.books)) { settings.books[b] = true; saveSettings(); }
    renderBookList(); renderRebateSettings(); updateABookOptions();
  }
}
function clearDiscoveredBooks(){ discoveredBooks.clear(); renderBookList(); renderRebateSettings(); updateABookOptions(); }

/* ------------------ 工具函数 ------------------ */
function getEventKey(opp){ return `${opp.league || ''}|${opp.event_name || ''}`; }

/* ------------------ WebSocket ------------------ */
function connectWS() {
  // <<< 新增：若开启了模拟，走本地模拟，不连真实 WS
  if (settings.datasource?.mockEnabled) {
    stopMock();
    connectMock();
    return;
  }
  stopMock(); // 确保切回真实时停止 mock

  if (ws && (ws.readyState===WebSocket.CONNECTING || ws.readyState===WebSocket.OPEN)) return;
  if (settings.datasource?.wsMode==='custom' && !(settings.datasource?.wsUrl||'').trim()) {
    updateConnectionStatus('connecting'); return;
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
    ws.onopen = () => { wsReconnectAttempts=0; updateConnectionStatus('connected'); startHeartbeatMonitor(); };

    // 字符串/Blob 都解析为 JSON
    ws.onmessage = async (ev) => {
      try {
        let text;
        if (typeof ev.data === 'string') {
          text = ev.data;
        } else if (ev.data instanceof Blob && typeof ev.data.text === 'function') {
          text = await ev.data.text();
        } else {
          text = String(ev.data);
        }
        handleWebSocketMessage(JSON.parse(text));
      } catch(e) {
        console.error('解析消息失败:', e);
      }
    };

    ws.onclose = () => { updateConnectionStatus('reconnecting'); stopHeartbeatMonitor(); scheduleReconnect(); };
    ws.onerror = (err) => { console.error('WS 错误:', err); };
  } catch (err) {
    console.error('创建 WS 失败:', err);
    updateConnectionStatus('reconnecting'); scheduleReconnect();
  }
}
function reconnectNow(){ 
  stopMock(); // <<< 新增：手动重连前停掉 mock
  if (ws) ws.close(); 
  if (wsReconnectTimer){ clearTimeout(wsReconnectTimer); wsReconnectTimer=null; } 
  wsReconnectAttempts=0; 
  setTimeout(connectWS, 120); 
}
function scheduleReconnect(){ if (wsReconnectTimer) clearTimeout(wsReconnectTimer); wsReconnectAttempts++; const d=Math.min(30000, Math.pow(2, wsReconnectAttempts-1)*1000); wsReconnectTimer=setTimeout(connectWS, d); }
function startHeartbeatMonitor(){ stopHeartbeatMonitor(); heartbeatTimer=setInterval(()=>{ if (lastHeartbeat && (Date.now()-lastHeartbeat>30000)) { try{ ws && ws.close(); }catch(_){}} }, 5000); }
function stopHeartbeatMonitor(){ if (heartbeatTimer){ clearInterval(heartbeatTimer); heartbeatTimer=null; } }

/* ------------------ 消息处理（兼容层） ------------------ */
function _num(v){ const n=(typeof v==='string')?parseFloat(v):Number(v); return Number.isFinite(n)?n:undefined; }
function _str(v){ if (v==null) return ''; return (typeof v==='string')?v:String(v); }
function _pick(obj, keys, fallback){ for (const k of keys){ if (obj && obj[k]!=null && obj[k]!=='') return obj[k]; } return fallback; }
const _OU_ALIASES=new Set(['ou','o/u','totals','total','大小','大小球','大/小','daxiao']);
const _AH_ALIASES=new Set(['ah','hdp','handicap','让球','让盘','让分','亚洲盘','亚洲让球']);
const _OVER_ALIASES=new Set(['over','o','大','大球','overline','overbet']);
const _UNDER_ALIASES=new Set(['under','u','小','小球','underline','underbet']);
const _HOME_ALIASES=new Set(['home','h','主','主队','1']);
const _AWAY_ALIASES=new Set(['away','a','客','客队','2']);
function _normSel(s){ const t=_str(s).trim().toLowerCase(); if(_OVER_ALIASES.has(t))return'over'; if(_UNDER_ALIASES.has(t))return'under'; if(_HOME_ALIASES.has(t))return'home'; if(_AWAY_ALIASES.has(t))return'away'; return t; }

// —— 关键：把香港盘统一转欧赔；其他赔率保持原样
function _toDecimalOdds(o) {
  const x = Number(o);
  if (!Number.isFinite(x) || x <= 0) return undefined;
  return x < 1.5 ? (x + 1) : x;   // 0.93 => 1.93
}

function _normMarket(m,pA,pB){
  let t=_str(m).trim().toLowerCase();
  if(_OU_ALIASES.has(t))return'ou'; if(_AH_ALIASES.has(t))return'ah';
  const sa=_normSel(pA?.selection), sb=_normSel(pB?.selection);
  if((sa==='over'&&sb==='under')||(sa==='under'&&sb==='over'))return'ou';
  if((sa==='home'&&sb==='away')||(sa==='away'&&sb==='home'))return'ah';
  const ms=_str(m).toLowerCase(); if(ms.includes('handicap')||ms.includes('让'))return'ah'; if(ms.includes('total')||ms.includes('大小'))return'ou'; return'ou';
}

/** —— 规范化一条机会记录（兼容你后端当前WS的格式） */
function _normalizeOpp(raw){
  if (!raw || typeof raw!=='object') return null;

  const league=_str(_pick(raw,['league','leagueName','league_name','league_cn','联赛','联赛名'],'')); 
  const home=_str(_pick(raw,['home','homeTeam','home_name','主队','team_a'],'')); 
  const away=_str(_pick(raw,['away','awayTeam','away_name','客队','team_b'],'')); 
  const eventName=_str(_pick(raw,['event_name','eventName','赛事','比赛','match_name'], (home&&away)?`${home} vs ${away}`:''));
  const lineText=_str(_pick(raw,['line_text','lineText','line','handicap','ah','ou','total','盘口','大小'],'')); 
  const lineNum=_num(_pick(raw,['line_numeric','lineNum','lineValue','total_points','handicap_value'],undefined));
  const overOdds=_num(_pick(raw,['over_odds','o_odds','odds_over','overOdds'],undefined));
  const underOdds=_num(_pick(raw,['under_odds','u_odds','odds_under','underOdds'],undefined));
  const homeOdds=_num(_pick(raw,['home_odds','h_odds','odds_home','odds1','homeOdds'],undefined));
  const awayOdds=_num(_pick(raw,['away_odds','a_odds','odds_away','odds2','awayOdds'],undefined));
  const oddsA=_num(_pick(raw,['oddsA','odds_a','pickA_odds','aOdds'],undefined));
  const oddsB=_num(_pick(raw,['oddsB','odds_b','pickB_odds','bOdds'],undefined));

  let selA=_normSel(_pick(raw,['selA','selectionA','pickA_sel','pickA_selection','selection_a'],'')); 
  let selB=_normSel(_pick(raw,['selB','selectionB','pickB_sel','pickB_selection','selection_b'],'')); 
  let bookA=_str(_pick(raw,['bookA','book_a','pickA_book','bookNameA','a_book','aBook','book1'],'')); 
  let bookB=_str(_pick(raw,['bookB','book_b','pickB_book','bookNameB','b_book','bBook','book2'],'')); 
  bookA=bookA.toLowerCase(); bookB=bookB.toLowerCase();

  let pickA, pickB;
  if (overOdds != null && underOdds != null){
    if(!selA)selA='over'; if(!selB)selB='under';
    pickA={book:bookA||'bookA',selection:selA,odds:overOdds};
    pickB={book:bookB||'bookB',selection:selB,odds:underOdds};
  } else if (homeOdds != null && awayOdds != null){
    if(!selA)selA='home'; if(!selB)selB='away';
    pickA={book:bookA||'bookA',selection:selA,odds:homeOdds};
    pickB={book:bookB||'bookB',selection:selB,odds:awayOdds};
  } else if (oddsA != null && oddsB != null && selA && selB){
    pickA={book:bookA||'bookA',selection:selA,odds:oddsA};
    pickB={book:bookB||'bookB',selection:selB,odds:oddsB};
  } else {
    const picks=_pick(raw,['picks','quotes','markets','legs'],[]);
    if (Array.isArray(picks) && picks.length>=2){
      const p1=picks[0]||{}, p2=picks[1]||{};
      pickA={book:_str(p1.book||p1.bk||'bookA').toLowerCase(), selection:_normSel(p1.selection||p1.sel), odds:_num(p1.odds)};
      pickB={book:_str(p2.book||p2.bk||'bookB').toLowerCase(), selection:_normSel(p2.selection||p2.sel), odds:_num(p2.odds)};
    }
  }
  if (!pickA || !pickB) return null;

  // —— 关键：把港盘转成欧赔，避免被“>1”校验拦截
  if (pickA.odds != null) pickA.odds = _toDecimalOdds(pickA.odds);
  if (pickB.odds != null) pickB.odds = _toDecimalOdds(pickB.odds);

  // 仍保留“欧赔必须 >1”的校验（港盘已 +1，不会被丢弃）
  if (!(pickA.odds > 1 && pickB.odds > 1)) return null;

  const market=_normMarket(_pick(raw,['market','market_type','mkt','type','玩法'],''), pickA, pickB);
  const eventId=_pick(raw,['event_id','eventId','match_id','fid','mid','id'], `${home}-${away}-${lineText}`);

  return {
    event_id:eventId, event_name:eventName, league,
    score:_str(_pick(raw,['score','sc','比分'],'')),
    market, line_text: lineText || (lineNum!=null?String(lineNum):''), line_numeric:(lineNum!=null?lineNum:undefined),
    pickA, pickB,
    kickoffAt:_pick(raw,['kickoffAt','kickoff_at','kickoff','matchTime','match_time','start_time','start_ts','startTime'],undefined)
  };
}

/** —— 统一消息：snapshot/opportunity/heartbeat */
function _normalizeMessage(message){
  if (!message) return null;
  if (Array.isArray(message)) return { type:'snapshot', data:message.map(_normalizeOpp).filter(Boolean), ts:Date.now() };
  let type = _str(message.type).toLowerCase(); const ts=message.ts||Date.now();
  if (!type || type==='ping' || type==='hello') return { type:'heartbeat', ts };
  if (type==='heartbeat') return { type:'heartbeat', ts };
  if (['snapshot','full','list'].includes(type)){
    const list=_pick(message,['data','opps','items','list'],[]);
    return { type:'snapshot', data:(Array.isArray(list)?list.map(_normalizeOpp).filter(Boolean):[]), ts };
  }
  if (['opportunity','delta','change','upd','update'].includes(type)){
    const raw=_pick(message,['data','opp','item','record'],null);
    const opp=_normalizeOpp(raw); if (!opp) return { type:'heartbeat', ts };
    return { type:'opportunity', data:opp, ts };
  }
  const list=_pick(message,['data','opps','items','list'],null);
  if (Array.isArray(list)) return { type:'snapshot', data:list.map(_normalizeOpp).filter(Boolean), ts };
  return null;
}
function handleWebSocketMessage(message){
  const m=_normalizeMessage(message); if (!m) return;
  switch(m.type){
    case 'heartbeat': lastHeartbeat=m.ts||Date.now(); updateLastUpdateTime(); break;
    case 'snapshot':  handleSnapshot(m.data||[]); updateLastUpdateTime(); break;
    case 'opportunity': handleOpportunity(m.data); updateLastUpdateTime(); break;
    default: console.warn('未知消息（已规范化但不支持）:', m);
  }
}

/* ------------------ 快照/增量入口 ------------------ */
function handleSnapshot(opps){
  if (!Array.isArray(opps)) return;
  opps.forEach(o => processOpportunity(o, false));
  renderMarketBoard();
}
function handleOpportunity(opp){
  if (!opp) return;
  processOpportunity(opp, true);
  renderMarketBoard();
}

/* ------------------ 盘口 & 套利计算 ------------------ */
function processOpportunity(opp, shouldAlert){
  if (!opp?.event_id && !opp?.event_name) return;
  updateMarketBoard(opp);
  const result = calculateArbitrage(opp);
  if (result) addArbitrageOpportunity(result, shouldAlert);
}
function ensureEventContainer(key){
  const cur = marketBoard.get(key);
  if (cur) return cur;
  const obj = { league:'', home:'', away:'', score:'', books:new Set(), ouMap:new Map(), ahMap:new Map(), updatedAt:0, kickoffAt:undefined };
  marketBoard.set(key, obj); return obj;
}
function setOUForBook(cur, book, line, selection, odds){
  if (!book) return;
  const b = normBookKey(book);
  const entry = cur.ouMap.get(b) || { line:'', over:null, under:null };
  entry.line = line || entry.line || '';
  const sel = (selection||'').toLowerCase();
  if (sel==='over') entry.over = odds;
  if (sel==='under') entry.under = odds;
  cur.ouMap.set(b, entry); cur.books.add(b); addDiscoveredBook(b);
}
function setAHForBook(cur, book, line, selection, odds){
  if (!book) return;
  const b = normBookKey(book);
  const entry = cur.ahMap.get(b) || { line:'', home:null, away:null };
  entry.line = line || entry.line || '';
  const sel = (selection||'').toLowerCase();
  if (sel==='home') entry.home = odds;
  if (sel==='away') entry.away = odds;
  cur.ahMap.set(b, entry); cur.books.add(b); addDiscoveredBook(b);
}
function updateMarketBoard(opp){
  const key = getEventKey(opp);
  const cur = ensureEventContainer(key);

  if (opp.league) cur.league = opp.league;
  if (opp.event_name) {
    if (opp.home && opp.away){ cur.home=opp.home; cur.away=opp.away; }
    else {
      const [h,a]=(opp.event_name||'').split(' vs ').map(s=>s?.trim()||'');
      if (h) cur.home=h; if (a) cur.away=a;
    }
  }
  if (opp.score != null) cur.score = opp.score;

  const k = guessKickoffTs(opp);
  if (k && (!cur.kickoffAt || Math.abs(k-(cur.kickoffAt||0))>1000)) cur.kickoffAt = k;

  cur.updatedAt = Date.now();

  const lineText = opp.line_text || (opp.line_numeric?.toString()||'');
  if (opp.market==='ou'){
    if (opp.pickA) setOUForBook(cur, opp.pickA.book, lineText, opp.pickA.selection, opp.pickA.odds);
    if (opp.pickB) setOUForBook(cur, opp.pickB.book, lineText, opp.pickB.selection, opp.pickB.odds);
  } else if (opp.market==='ah'){
    if (opp.pickA) setAHForBook(cur, opp.pickA.book, lineText, opp.pickA.selection, opp.pickA.odds);
    if (opp.pickB) setAHForBook(cur, opp.pickB.book, lineText, opp.pickB.selection, opp.pickB.odds);
  }
}

/* === A/B 平台返水 === */
function getEnabledBooks(){ return Array.from(discoveredBooks).filter(b => settings.books[b] !== false).sort(); }
function normalizeRebateABSelections(){
  const enabled = new Set(getEnabledBooks());
  if (settings.rebateA?.book && !enabled.has(normBookKey(settings.rebateA.book))) settings.rebateA.book='';
  if (settings.rebateB?.book && !enabled.has(normBookKey(settings.rebateB.book))) settings.rebateB.book='';
  saveSettings();
}
function getRebateRateForBook(bookKey){
  const a=settings.rebateA||{}, b=settings.rebateB||{};
  if (a.book && normBookKey(a.book)===bookKey) return parseFloat(a.rate)||0;
  if (b.book && normBookKey(b.book)===bookKey) return parseFloat(b.rate)||0;
  return 0;
}

/* —— 是否“返水设置中的 A/B 平台互相对碰” —— */
function isABPairOpp(opp){
  const a = (settings.rebateA?.book || '').toLowerCase();
  const b = (settings.rebateB?.book || '').toLowerCase();
  if (!a || !b) return false;
  const x = (opp?.pickA?.book || '').toLowerCase();
  const y = (opp?.pickB?.book || '').toLowerCase();
  return (x===a && y===b) || (x===b && y===a);
}

/* 计算套利（提醒只在 A/B 对碰时触发；表格也仅显示 A/B 对碰） */
function calculateArbitrage(opp){
  if (!opp?.pickA || !opp?.pickB) return null;

  const bookA = normBookKey(opp.pickA.book);
  const bookB = normBookKey(opp.pickB.book);
  const aBook = normBookKey(settings.stake?.aBook||'');

  const rebateABook = normBookKey(settings.rebateA?.book||'');
  const rebateBBook = normBookKey(settings.rebateB?.book||'');
  const isABPair = rebateABook && rebateBBook &&
    ((bookA===rebateABook && bookB===rebateBBook) ||
     (bookA===rebateBBook && bookB===rebateABook));

  // 下注侧 A 的确定：沿用“投注设置”的 A 平台（固定金额）
  let pickA, pickB, sideA, sideB;
  if (bookA===aBook){ pickA=opp.pickA; pickB=opp.pickB; sideA='A'; sideB='B'; }
  else if (bookB===aBook){ pickA=opp.pickB; pickB=opp.pickA; sideA='B'; sideB='A'; }
  else { pickA=opp.pickA; pickB=opp.pickB; sideA='—'; sideB='B'; }

  const oA=parseFloat(pickA.odds)||0, oB=parseFloat(pickB.odds)||0;
  const sA=parseInt(settings.stake?.amountA)||10000;
  if (oA<=1 || oB<=1) return null;

  const rA=getRebateRateForBook(normBookKey(pickA.book));
  const rB=getRebateRateForBook(normBookKey(pickB.book));
  const sB=sA*oA/oB; if (sB<=0) return null;

  const profit = sA*oA - (sA+sB) + rA*sA + rB*sB;
  const minProfit = parseInt(settings.stake?.minProfit)||0;

  return {
    opportunity: opp, sideA, sideB, pickA, pickB,
    waterA:(oA-1).toFixed(3), waterB:(oB-1).toFixed(3),
    stakeB:Math.round(sB), profit:Math.round(profit),
    shouldAlert:(isABPair && profit>=minProfit),
    signature: generateSignature(opp, pickA, pickB, profit)
  };
}
function generateSignature(opp, pickA, pickB, profit){
  const a = `${normBookKey(pickA?.book||'')}_${pickA?.selection||''}_${Math.round((+pickA?.odds||0)*1000)}`;
  const b = `${normBookKey(pickB?.book||'')}_${pickB?.selection||''}_${Math.round((+pickB?.odds||0)*1000)}`;
  const base = `${getEventKey(opp)}_${opp.market}_${opp.line_text||opp.line_numeric||''}`;
  return `${base}__${[a,b].sort().join('__')}__p${profit}`;
}

/* ------- 显示上的 A/B 归位（优先返水 A/B；兜底“投注设置”的 A） ------- */
function picksForABDisplay(opp){
  const aRebate = normBookKey(settings.rebateA?.book||'');
  const bRebate = normBookKey(settings.rebateB?.book||'');
  const aStake  = normBookKey(settings.stake?.aBook||'');

  if (aRebate || bRebate){
    let pickForA=null, pickForB=null;
    if (aRebate){
      if (normBookKey(opp.pickA.book)===aRebate) pickForA=opp.pickA;
      else if (normBookKey(opp.pickB.book)===aRebate) pickForA=opp.pickB;
    }
    if (bRebate){
      if (normBookKey(opp.pickA.book)===bRebate) pickForB=opp.pickA;
      else if (normBookKey(opp.pickB.book)===bRebate) pickForB=opp.pickB;
    }
    if (!pickForA || !pickForB){
      const other = (pickForA && pickForA===opp.pickA) ? opp.pickB
                   : (pickForA && pickForA===opp.pickB) ? opp.pickA
                   : (pickForB && pickForB===opp.pickA) ? opp.pickB
                   : (pickForB && pickForB===opp.pickB) ? opp.pickA : null;
      if (!pickForA) pickForA = other || opp.pickA;
      if (!pickForB) pickForB = (other===opp.pickA?opp.pickB:opp.pickA);
    }
    return { pickForA, pickForB };
  }

  if (aStake){
    const pickForA = normBookKey(opp.pickA.book)===aStake ? opp.pickA
                    : normBookKey(opp.pickB.book)===aStake ? opp.pickB : opp.pickA;
    const pickForB = (pickForA===opp.pickA) ? opp.pickB : opp.pickA;
    return { pickForA, pickForB };
  }

  return { pickForA:opp.pickA, pickForB:opp.pickB };
}

/* ------------------ 套利表格 ------------------ */
function addArbitrageOpportunity(result, shouldAlert){
  if (!isABPairOpp(result.opportunity)) return;

  const tbody=document.querySelector('#arbitrageTable tbody');
  const sig=result.signature, minProfit=parseInt(settings.stake?.minProfit)||0;
  if (result.profit<minProfit) return;

  const existed=tbody.querySelector(`tr[data-signature="${CSS.escape(sig)}"]`);
  if (existed) existed.remove();

  const noData=tbody.querySelector('.no-data'); if (noData) noData.remove();

  const row=createArbitrageRow(result);
  tbody.insertBefore(row, tbody.firstChild);

  const hideS = parseInt(settings.notify?.autoHideRowS) || 0;
  if (hideS > 0) {
    setTimeout(() => {
      try { row.remove(); ensureNoDataRow(); } catch(_) {}
    }, hideS * 1000);
  }

  if (shouldAlert) sendAlert(result);
}
function ensureNoDataRow(){
  const tbody=document.querySelector('#arbitrageTable tbody');
  if (!tbody) return;
  if (!tbody.querySelector('tr')) {
    const nd=document.createElement('tr'); nd.className='no-data'; nd.innerHTML='<td colspan="8">暂无数据</td>'; tbody.appendChild(nd);
  }
}
function createArbitrageRow(result){
  const row=document.createElement('tr'); row.setAttribute('data-signature', result.signature);
  const opp=result.opportunity; const marketText=zhMarket(opp.market); const lineText=opp.line_text||(opp.line_numeric?.toString()||'');
  const { pickForA, pickForB } = picksForABDisplay(opp);
  const pickAText = `${prettyBook(pickForA.book)}（${zhSel(pickForA.selection)}）`;
  const pickBText = `${prettyBook(pickForB.book)}（${zhSel(pickForB.selection)}）`;
  const waterAForDisplay = (parseFloat(pickForA.odds)-1).toFixed(3);
  const waterBForDisplay = (parseFloat(pickForB.odds)-1).toFixed(3);

  row.innerHTML=`
    <td>${opp.event_name||''}</td>
    <td>${marketText} ${lineText}</td>
    <td>${pickAText}</td>
    <td>${pickBText}</td>
    <td>${waterAForDisplay}</td>
    <td>${waterBForDisplay}</td>
    <td>${result.stakeB.toLocaleString()}</td>
    <td>${result.profit.toLocaleString()}</td>`;
  return row;
}

/* ------------------ 批量重算 ------------------ */
function recalculateAllArbitrageOpportunities(){
  const tbody=document.querySelector('#arbitrageTable tbody'); if (!tbody) return;
  clearArbitrageTable();
  marketBoard.forEach((data,eventId)=>{
    const ouEntries=Array.from(data.ouMap.entries());
    for (const [bOver,eOver] of ouEntries){
      for (const [bUnder,eUnder] of ouEntries){
        if (bOver===bUnder) continue;
        if (eOver?.over && eUnder?.under){
          const opp={ event_id:eventId, event_name:`${data.home} vs ${data.away}`, league:data.league, market:'ou',
            line_text:eOver.line||eUnder.line||'', line_numeric:parseFloat(eOver.line||eUnder.line)||0,
            pickA:{book:bOver,selection:'over',odds:eOver.over}, pickB:{book:bUnder,selection:'under',odds:eUnder.under}, score:data.score };
          const r=calculateArbitrage(opp); if (r) addArbitrageOpportunity(r,false);
        }
      }
    }
    const ahEntries=Array.from(data.ahMap.entries());
    for (const [bHome,eHome] of ahEntries){
      for (const [bAway,eAway] of ahEntries){
        if (bHome===bAway) continue;
        if (eHome?.home && eAway?.away){
          const opp={ event_id:eventId, event_name:`${data.home} vs ${data.away}`, league:data.league, market:'ah',
            line_text:eHome.line||eAway.line||'', line_numeric:parseFloat(eHome.line||eAway.line)||0,
            pickA:{book:bHome,selection:'home',odds:eHome.home}, pickB:{book:bAway,selection:'away',odds:eAway.away}, score:data.score };
          const r=calculateArbitrage(opp); if (r) addArbitrageOpportunity(r,false);
        }
      }
    }
  });
}
function clearArbitrageTable(){ const tbody=document.querySelector('#arbitrageTable tbody'); if (tbody) tbody.innerHTML=`<tr class="no-data"><td colspan="8">暂无数据</td></tr>`; }

/* ------------------ 提醒（Toast） ------------------ */
function ensureAlertStyles(){
  if (document.getElementById('toast-style-inject')) return;
  const st = document.createElement('style');
  st.id = 'toast-style-inject';
  st.textContent = `
  #toast-stack{position:fixed;top:16px;right:16px;z-index:2147483647;display:flex;flex-direction:column;gap:10px;pointer-events:none}
  #toast-stack .toast{pointer-events:auto;min-width:260px;max-width:420px;background:rgba(28,30,36,.96);color:#fff;
    padding:12px 14px;border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.35);backdrop-filter:blur(6px)}
  #toast-stack .toast.success{border-left:3px solid #4ade80}
  #toast-stack .toast.error{border-left:3px solid #ef4444}
  .toast-title{font-weight:600;margin-bottom:4px}
  .toast.removing{opacity:.0;transition:opacity .2s ease}
  .hidden-row{display:none !important}
  `;
  document.head.appendChild(st);
}
function ensureToastStack(){
  let stack = document.getElementById('toast-stack');
  if (!stack){
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    document.body.appendChild(stack);
  }
  const s = stack.style;
  s.position = 'fixed'; s.top = '16px'; s.right = '16px';
  s.zIndex = '2147483647'; s.display = 'flex'; s.flexDirection = 'column'; s.gap = '10px'; s.pointerEvents='none';
  return stack;
}
function showToast(title, message, type='info'){
  ensureAlertStyles();
  const stack = ensureToastStack();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <div class="toast-title">${title}</div>
    <div class="toast-message">${message}</div>
  `;
  stack.prepend(el);
  const duration = (settings.notify?.toastDurationS||5)*1000;
  setTimeout(()=> { el.classList.add('removing'); setTimeout(()=> el.remove(), 200); }, duration);
}
function sendAlert(result){
  if (!isABPairOpp(result.opportunity)) return;

  const sig=result.signature;
  const now=Date.now();
  const mem=alertMemory.get(sig);
  if (mem && (now - mem.lastAt < ALERT_TTL_MS) && mem.lastProfit === result.profit) {
    // 15s 内且盈利未变：跳过
  } else {
    alertMemory.set(sig, { lastProfit: result.profit, lastAt: now });

    const opp=result.opportunity;
    const marketText=zhMarket(opp.market);
    const lineText=opp.line_text||(opp.line_numeric?.toString()||'');
    const { pickForA, pickForB } = picksForABDisplay(opp);
    const pickAStr = `${prettyBook(pickForA.book)}（${zhSel(pickForA.selection)}）`;
    const pickBStr = `${prettyBook(pickForB.book)}（${zhSel(pickForB.selection)}）`;
    const sA=settings.stake?.amountA||10000;

    const title=`套利机会 · ${opp.league||''} · ${opp.event_name||''}`;
    const msg=
      `盘口：${marketText} ${lineText}<br>`+
      `选择A：${pickAStr}　水位：${(parseFloat(pickForA.odds)-1).toFixed(3)}（A固定 ${sA.toLocaleString()}）<br>`+
      `选择B：${pickBStr}　水位：${(parseFloat(pickForB.odds)-1).toFixed(3)}（应下 ${result.stakeB.toLocaleString()}）<br>`+
      `均衡盈利：${result.profit.toLocaleString()}`;

    if (settings.notify?.toastEnabled) showToast(title,msg,'success');

    if (settings.notify?.systemEnabled && 'Notification' in window && Notification.permission==='granted') {
      new Notification(title, { body:`${marketText}${lineText}  盈利 ${result.profit.toLocaleString()}`, icon:'/favicon.ico' });
    }

    if (settings.notify?.soundEnabled) {
      if (hasUserInteracted) {
        playNotificationSound();
      } else {
        pendingBeeps++;
        if (!soundHintShown) {
          showToast('声音提醒未启用', '请点击页面任意位置以启用声音', 'error');
          soundHintShown = true;
        }
      }
    }
  }
}
function playNotificationSound(){
  try{
    const ac=new (window.AudioContext||window.webkitAudioContext)();
    const o=ac.createOscillator(); const g=ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.frequency.setValueAtTime(880,ac.currentTime);
    o.frequency.setValueAtTime(1040,ac.currentTime+0.1);
    o.frequency.setValueAtTime(880,ac.currentTime+0.2);
    g.gain.setValueAtTime(0.3,ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01,ac.currentTime+0.3);
    o.start(ac.currentTime); o.stop(ac.currentTime+0.3);
  }catch(_){}
}

/* ------------------ 行情总览 ------------------ */
function renderMarketBoard(){
  const tbody=document.querySelector('#marketTable tbody'); if (!tbody) return;
  tbody.innerHTML='';
  if (marketBoard.size===0){ tbody.innerHTML='<tr class="no-data"><td colspan="8">暂无数据</td></tr>'; return; }

  const enabled = new Set(Array.from(discoveredBooks).filter(b => settings.books[b] !== false).map(b=>normBookKey(b)));
  const rows=[];
  for (const [eventId,data] of marketBoard.entries()){
    const enabledBooks=[...data.books].filter(b => enabled.has(normBookKey(b)));
    if (enabledBooks.length===0) continue;
    enabledBooks.forEach(book=>{
      const rk=rowKey(eventId,book); if (!rowOrder.has(rk)) rowOrder.set(rk,++rowSeq);
      const ouE=data.ouMap.get(book), ahE=data.ahMap.get(book);
      rows.push({
        rk, stable:rowOrder.get(rk), book, league:data.league||'', home:data.home||'', away:data.away||'', score:data.score||'',
        ouText: ouE?`${ouE.line||''} (${ouE.over ?? '-'} / ${ouE.under ?? '-'})`:'-',
        ahText: ahE?`${ahE.line||''} (${ahE.home ?? '-'} / ${ahE.away ?? '-'})`:'-',
        kickoffAt:data.kickoffAt||0, updatedAt:data.updatedAt||0
      });
    });
  }
  if (rows.length===0){ tbody.innerHTML='<tr class="no-data"><td colspan="8">暂无数据</td></tr>'; return; }

  if (sortMode==='league'){
    rows.sort((a,b)=>{ const l=a.league.localeCompare(b.league); if(l)return l; const t=(a.kickoffAt||a.updatedAt)-(b.kickoffAt||b.updatedAt); if(t)return t; return a.stable-b.stable; });
  } else {
    rows.sort((a,b)=>{ const t=(a.kickoffAt||a.updatedAt)-(b.kickoffAt||b.updatedAt); if(t)return t; const l=a.league.localeCompare(b.league); if(l)return l; return a.stable-b.stable; });
  }

  const frag=document.createDocumentFragment();
  for (const r of rows){
    const tr=document.createElement('tr');
    const timeText=(r.kickoffAt||r.updatedAt)?formatTime(new Date(r.kickoffAt||r.updatedAt)):'-';
    tr.innerHTML=`<td>${r.book}</td><td>${r.league}</td><td>${r.home}</td><td>${r.away}</td><td>${r.score||'-'}</td><td>${r.ouText}</td><td>${r.ahText}</td><td>${timeText}</td>`;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

/* ------------------ UI 初始化 ------------------ */
function initUI(loaded){
  settings=loaded;
  initHamburgerMenu(); initSettingsPanels(); initMarketControls();
  ensureAlertStyles(); ensureToastStack();
  requestNotificationPermission();

  const enableSoundOnce = () => {
    hasUserInteracted = true;
    const n = pendingBeeps; pendingBeeps = 0;
    for (let i = 0; i < n; i++) playNotificationSound();
  };
  ['click','pointerdown','touchstart','keydown','wheel'].forEach(ev=>{
    document.addEventListener(ev, enableSoundOnce, { once:true, capture:true });
  });

  saveSettings();
  window.addEventListener('beforeunload', saveSettings);
}

/* --- 汉堡按钮 --- */
function initHamburgerMenu(){
  const btn=document.querySelector('#hamburgerBtn, #hamburger, .hamburger-btn, .hamburger, .menu-btn, [data-hamburger]');
  const drawer=document.querySelector('#drawer, [data-drawer], .drawer');
  let overlay=document.getElementById('drawerOverlay');
  if (!overlay){ overlay=document.createElement('div'); overlay.id='drawerOverlay'; overlay.className='drawer-overlay'; overlay.style.pointerEvents='none'; document.body.appendChild(overlay); }
  else { overlay.classList.remove('active'); overlay.style.pointerEvents='none'; }
  if (!btn || !drawer) return;

  function openDrawer(){ drawer.classList.add('active'); overlay.classList.add('active'); overlay.style.pointerEvents='auto'; document.body.style.overflow='hidden'; }
  function closeDrawer(){ drawer.classList.remove('active'); overlay.classList.remove('active'); overlay.style.pointerEvents='none'; document.body.style.overflow=''; }
  btn.addEventListener('click',(e)=>{ e.preventDefault(); e.stopPropagation(); openDrawer(); });
  overlay.addEventListener('click',(e)=>{ e.preventDefault(); closeDrawer(); });
  document.addEventListener('keydown',(e)=>{ if (e.key==='Escape') closeDrawer(); });
  closeDrawer();

  const expandAllBtn=document.getElementById('expandAllBtn');
  const collapseAllBtn=document.getElementById('collapseAllBtn');
  if (expandAllBtn) expandAllBtn.addEventListener('click', ()=>{ document.querySelectorAll('#drawer details').forEach(d=>d.open=true); savePanelStates(); });
  if (collapseAllBtn) collapseAllBtn.addEventListener('click', ()=>{ document.querySelectorAll('#drawer details').forEach(d=>d.open=false); savePanelStates(); });
}

/* --- 面板 & 设置 --- */
function initSettingsPanels(){
  loadPanelStates();
  document.querySelectorAll('#drawer details').forEach(d => d.addEventListener('toggle', savePanelStates));

  initDatasourcePanel();

  renderBookList();
  renderRebateSettings();

  updateStakeInputs();
  const aBookSelect=document.getElementById('a-book');
  const amountAInput=document.getElementById('amount-a');
  const minProfitInput=document.getElementById('min-profit');

  if (aBookSelect) aBookSelect.addEventListener('change', ()=>{ settings.stake=settings.stake||{}; settings.stake.aBook=aBookSelect.value; saveSettings(); });
  if (amountAInput) amountAInput.addEventListener('input', ()=>{ settings.stake=settings.stake||{}; settings.stake.amountA=parseInt(amountAInput.value)||0; saveSettings(); recalculateAllArbitrageOpportunities(); });
  if (minProfitInput) minProfitInput.addEventListener('input', ()=>{ settings.stake=settings.stake||{}; settings.stake.minProfit=parseInt(minProfitInput.value)||0; saveSettings(); recalculateAllArbitrageOpportunities(); });

  updateNotifyInputs();
  const systemNotify=document.getElementById('system-notify');
  const soundNotify=document.getElementById('sound-notify');
  const toastNotify=document.getElementById('toast-notify');
  const toastDuration=document.getElementById('toast-duration');
  const autoHideRow=document.getElementById('auto-hide-row');
  const clearAlerts=document.getElementById('clear-alerts');

  if (systemNotify) systemNotify.addEventListener('change', ()=>{ settings.notify=settings.notify||{}; settings.notify.systemEnabled=systemNotify.checked; saveSettings(); if (systemNotify.checked) requestNotificationPermission(); });
  if (soundNotify)  soundNotify .addEventListener('change', ()=>{ settings.notify=settings.notify||{}; settings.notify.soundEnabled=soundNotify.checked; saveSettings(); });
  if (toastNotify)  toastNotify .addEventListener('change', ()=>{ settings.notify=settings.notify||{}; settings.notify.toastEnabled=toastNotify.checked; saveSettings(); });
  if (toastDuration) toastDuration.addEventListener('input', ()=>{ settings.notify=settings.notify||{}; settings.notify.toastDurationS=parseInt(toastDuration.value)||5; saveSettings(); });
  if (autoHideRow)  autoHideRow .addEventListener('input', ()=>{ settings.notify=settings.notify||{}; settings.notify.autoHideRowS=parseInt(autoHideRow.value)||0; saveSettings(); });

  if (clearAlerts) clearAlerts.addEventListener('click', ()=>{
    alertMemory.clear();
    const stack = ensureToastStack(); stack.innerHTML='';
    const tbody=document.querySelector('#arbitrageTable tbody');
    if (tbody) {
      tbody.querySelectorAll('tr').forEach(tr=>{ if(!tr.classList.contains('no-data')) tr.remove(); });
      ensureNoDataRow();
    }
    showToast('系统','已清除提醒记录','success');
  });
}

/* 书商 UI 渲染 */
function renderBookList(){
  const container=document.getElementById('book-list'); if (!container) return;
  container.innerHTML='';
  if (discoveredBooks.size===0){ container.innerHTML=`<div class="no-books-message">暂无书商数据</div>`; return; }
  const sorted=Array.from(discoveredBooks).sort();
  sorted.forEach(book=>{
    const item=document.createElement('div'); item.className='book-item';
    const id=`chk-book-${book}`; const checked=settings.books[book] !== false;
    item.innerHTML=`<input type="checkbox" id="${id}" ${checked?'checked':''}><label for="${id}">${prettyBook(book)}</label>`;
    const chk=item.querySelector('input');
    chk.addEventListener('change', ()=>{
      settings.books[book]=chk.checked; saveSettings();
      const currentABook=normBookKey(settings.stake?.aBook||'');
      if (!chk.checked && currentABook===book){ const enabled=getEnabledBooks(); settings.stake.aBook=enabled[0]||''; updateABookOptions(); }
      normalizeRebateABSelections(); renderRebateSettings(); renderMarketBoard(); recalculateAllArbitrageOpportunities();
    });
    container.appendChild(item);
  });
}

/* A/B 返水设置（即时保存） */
function renderRebateSettings(){
  const container=document.querySelector('#panel-rebates .panel-content'); if (!container) return;
  container.innerHTML='';
  const enabled=getEnabledBooks();

  const grpA=document.createElement('div'); grpA.className='rebate-group';
  grpA.innerHTML=`
    <h4>A 平台</h4>
    <div class="form-row"><label>选择书商</label><select id="rebateA_book"></select></div>
    <div class="form-row"><label>返水（如 0.006）</label><input id="rebateA_rate" type="number" step="0.0001" min="0" placeholder="0.006"></div>`;
  container.appendChild(grpA);

  const grpB=document.createElement('div'); grpB.className='rebate-group';
  grpB.innerHTML=`
    <h4>B 平台</h4>
    <div class="form-row"><label>选择书商</label><select id="rebateB_book"></select></div>
    <div class="form-row"><label>返水（如 0.006）</label><input id="rebateB_rate" type="number" step="0.0001" min="0" placeholder="0.006"></div>`;
  container.appendChild(grpB);

  function fillOptions(sel,current){
    sel.innerHTML='';
    const opt0=document.createElement('option'); opt0.value=''; opt0.textContent = enabled.length ? '— 请选择 —' : '请先在书商面板勾选书商'; sel.appendChild(opt0);
    enabled.forEach(b=>{ const o=document.createElement('option'); o.value=b; o.textContent=prettyBook(b); sel.appendChild(o); });
    if (current && enabled.includes(normBookKey(current))) sel.value=normBookKey(current);
  }

  const selA=grpA.querySelector('#rebateA_book'), inpA=grpA.querySelector('#rebateA_rate');
  const selB=grpB.querySelector('#rebateB_book'), inpB=grpB.querySelector('#rebateB_rate');
  fillOptions(selA, settings.rebateA?.book||''); fillOptions(selB, settings.rebateB?.book||'');
  inpA.value=settings.rebateA?.rate ?? ''; inpB.value=settings.rebateB?.rate ?? '';

  selA.addEventListener('change', ()=>{ settings.rebateA={ book:selA.value||'', rate:parseFloat(inpA.value)||0 }; saveSettings(); recalculateAllArbitrageOpportunities(); });
  selB.addEventListener('change', ()=>{ settings.rebateB={ book:selB.value||'', rate:parseFloat(inpB.value)||0 }; saveSettings(); recalculateAllArbitrageOpportunities(); });
  inpA.addEventListener('input',  ()=>{ settings.rebateA={ book:selA.value||'', rate:parseFloat(inpA.value)||0 }; saveSettings(); recalculateAllArbitrageOpportunities(); });
  inpB.addEventListener('input',  ()=>{ settings.rebateB={ book:selB.value||'', rate:parseFloat(inpB.value)||0 }; saveSettings(); recalculateAllArbitrageOpportunities(); });
}
function updateABookOptions(){
  const sel=document.getElementById('a-book'); if (!sel) return;
  const prev=sel.value; sel.innerHTML='';
  const enabled=getEnabledBooks();
  if (enabled.length===0){ const opt=document.createElement('option'); opt.value=''; opt.textContent='请先选择书商'; opt.disabled=true; sel.appendChild(opt); return; }
  enabled.forEach(b=>{ const o=document.createElement('option'); o.value=b; o.textContent=prettyBook(b); sel.appendChild(o); });
  if (enabled.includes(prev)) sel.value=prev; else { sel.value=enabled[0]; settings.stake.aBook=enabled[0]; saveSettings(); }
}

/* 数据源面板 */
function initDatasourcePanel(){
  const wsModeAuto=document.getElementById('ws-mode-auto');
  const wsModeCustom=document.getElementById('ws-mode-custom');
  const wsUrlInput=document.getElementById('ws-url');
  const wsTokenInput=document.getElementById('ws-token');
  const testBtn=document.getElementById('test-connection');
  const reconnectBtn=document.getElementById('reconnect-now');

  const ds=settings.datasource||{};
  if (ds.wsMode==='custom'){ wsModeCustom && (wsModeCustom.checked=true); wsUrlInput && (wsUrlInput.disabled=false); }
  else { wsModeAuto && (wsModeAuto.checked=true); wsUrlInput && (wsUrlInput.disabled=true); }
  wsUrlInput && (wsUrlInput.value=ds.wsUrl||''); wsTokenInput && (wsTokenInput.value=ds.token||'');

  // >>> 新增：使用模拟数据开关（任一选择器能命中即可）
  const mockSwitch = document.querySelector('#use-mock, input[name="use-mock"], [data-mock]');
  if (mockSwitch){
    mockSwitch.disabled = false;
    mockSwitch.checked = !!(settings.datasource?.mockEnabled);
    mockSwitch.addEventListener('change', ()=>{
      settings.datasource.mockEnabled = !!mockSwitch.checked;
      saveSettings();
      showReconnectButton(); // 切换后提示重连
    });
  }

  wsModeAuto && wsModeAuto.addEventListener('change', ()=>{ if (wsModeAuto.checked){ settings.datasource.wsMode='auto'; wsUrlInput && (wsUrlInput.disabled=true); saveSettings(); showReconnectButton(); }});
  wsModeCustom && wsModeCustom.addEventListener('change', ()=>{ if (wsModeCustom.checked){ settings.datasource.wsMode='custom'; wsUrlInput && (wsUrlInput.disabled=false); saveSettings(); showReconnectButton(); }});
  wsUrlInput && wsUrlInput.addEventListener('input', ()=>{ settings.datasource.wsUrl=wsUrlInput.value; saveSettings(); showReconnectButton(); });
  wsTokenInput && wsTokenInput.addEventListener('input', ()=>{ settings.datasource.token=wsTokenInput.value; saveSettings(); showReconnectButton(); });

  if (testBtn) testBtn.addEventListener('click', ()=>{
    testBtn.disabled=true; testBtn.textContent='测试中...';
    let url;
    if (settings.datasource?.wsMode==='custom' && (settings.datasource?.wsUrl||'').trim()){ url=settings.datasource.wsUrl.trim(); }
    else { const protocol=location.protocol==='https:'?'wss':'ws'; url=`${protocol}://${location.host}/ws/opps`; }
    const t=new WebSocket(url);
    const timeout=setTimeout(()=>{ try{t.close();}catch(_){ } testBtn.disabled=false; testBtn.textContent='测试连接'; showToast('连接测试','连接超时','error'); },5000);
    t.onopen=()=>{ clearTimeout(timeout); try{t.close();}catch(_){ } testBtn.disabled=false; testBtn.textContent='测试连接'; showToast('连接测试','连接成功','success'); };
    t.onerror=()=>{ clearTimeout(timeout); testBtn.disabled=false; testBtn.textContent='测试连接'; showToast('连接测试','连接失败','error'); };
  });
  reconnectBtn && reconnectBtn.addEventListener('click', ()=>{ reconnectNow(); hideReconnectButton(); });
}
function showReconnectButton(){ const b=document.getElementById('reconnect-now'); if (b) b.style.display='block'; }
function hideReconnectButton(){ const b=document.getElementById('reconnect-now'); if (b) b.style.display='none'; }

function updateStakeInputs(){ const s=settings.stake||{}; const amountAInput=document.getElementById('amount-a'); const minProfitInput=document.getElementById('min-profit'); if (amountAInput) amountAInput.value=s.amountA||10000; if (minProfitInput) minProfitInput.value=s.minProfit||0; updateABookOptions(); }
function updateNotifyInputs(){
  const n=settings.notify||{}; const systemNotify=document.getElementById('system-notify'); const soundNotify=document.getElementById('sound-notify'); const toastNotify=document.getElementById('toast-notify'); const toastDuration=document.getElementById('toast-duration'); const autoHideRow=document.getElementById('auto-hide-row');
  if (systemNotify) systemNotify.checked=!!n.systemEnabled; if (soundNotify) soundNotify.checked=n.soundEnabled!==false; if (toastNotify) toastNotify.checked=n.toastEnabled!==false;
  if (toastDuration) toastDuration.value=n.toastDurationS||5; if (autoHideRow) autoHideRow.value=n.autoHideRowS||30;
}

/* 面板状态 */
function loadPanelStates(){
  try{ const raw=localStorage.getItem('panel_state_v1'); const s=raw?JSON.parse(raw):{};
    ['panel-datasource','panel-books','panel-rebates','panel-stake','panel-notify','panel-marketboard'].forEach(id=>{
      const el=document.getElementById(id); if (!el) return; if (id==='panel-marketboard') el.open=s[id]===true; else el.open=s[id]!==false;
    });
  }catch(_){}
}
function savePanelStates(){
  try{ const s={}; ['panel-datasource','panel-books','panel-rebates','panel-stake','panel-notify','panel-marketboard'].forEach(id=>{ const el=document.getElementById(id); if (el) s[id]=!!el.open; }); localStorage.setItem('panel_state_v1', JSON.stringify(s)); }catch(_){}
}

/* 市场控制面板 */
function initMarketControls(){
  const sortByLeagueBtn=document.querySelector('#sortByLeague, [data-sort="league"]');
  const sortByTimeBtn=document.querySelector('#sortByTime, [data-sort="time"]');
  const collapseBtn=document.getElementById('market-collapse-btn');
  const marketPanel=document.getElementById('panel-marketboard');

  if (sortByLeagueBtn) sortByLeagueBtn.addEventListener('click', ()=>{ sortMode='league'; sortByLeagueBtn.classList.add('active'); sortByTimeBtn && sortByTimeBtn.classList.remove('active'); renderMarketBoard(); });
  if (sortByTimeBtn)   sortByTimeBtn.addEventListener('click', ()=>{ sortMode='time'; sortByTimeBtn.classList.add('active'); sortByLeagueBtn && sortByLeagueBtn.classList.remove('active'); renderMarketBoard(); });
  if (collapseBtn && marketPanel) collapseBtn.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); marketPanel.open=!marketPanel.open; savePanelStates(); });
}

/* 其它工具 */
function requestNotificationPermission(){ if ('Notification' in window && Notification.permission==='default') Notification.requestPermission(); }
function updateConnectionStatus(status){
  const badge=document.getElementById('statusBadge'); const alert=document.getElementById('connectionError'); if (!badge || !alert) return;
  badge.className = `status-badge ${status}`;
  if (status==='connected'){ badge.textContent='已连接'; alert.style.display='none'; }
  else if (status==='connecting'){ badge.textContent='连接中...'; alert.style.display='none'; }
  else { badge.textContent='重连中...'; alert.style.display='block'; }
}
function updateLastUpdateTime(){ const el=document.getElementById('lastUpdateTime'); if (el) el.textContent = formatTime(); }

/* ------------------ 启动入口 ------------------ */
document.addEventListener('DOMContentLoaded', ()=>{
  const loaded = loadSettings();
  initUI(loaded);
  connectWS();
});

/* 最近更新时间（被消息处理调用） */
function updateLastUpdateTime(){
  const el = document.getElementById('lastUpdateTime');
  if (el) el.textContent = formatTime(new Date());
}

/* 初始化 UI（基于你现有结构，不改版、不删组件） */
function initUI(loaded){
  try{
    settings = loaded || DEFAULT_SETTINGS;

    // 侧边栏/抽屉
    initHamburgerMenu();

    // 面板开关状态
    loadPanelStates();

    // 数据源设置（含“使用模拟数据”开关，已适配多种选择器）
    initDatasourcePanel();

    // 书商 & 返水
    renderBookList();
    renderRebateSettings();

    // 投注与提醒设置
    updateStakeInputs();
    updateNotifyInputs();

    // 行情面板交互（时间/联赛排序、折叠）
    initMarketControls();

    // 表格兜底占位
    ensureNoDataRow();

    // 声音权限提示（系统通知可选）
    requestNotificationPermission();

    // 首次状态
    updateConnectionStatus('connecting');

    // 第一次进入时，激活一次点击以允许声音播放
    const onceClick = () => {
      hasUserInteracted = true;
      // 如果之前有待播放的提示音，这里补一次
      if (pendingBeeps > 0){
        const n = Math.min(pendingBeeps, 2);
        pendingBeeps = 0;
        for (let i=0;i<n;i++) playNotificationSound();
      }
    };
    document.addEventListener('click', onceClick, { once:true, capture:true });

    // 窗口重新获得焦点时，若断线则立即重连
    window.addEventListener('focus', () => {
      try { if (!ws || ws.readyState !== WebSocket.OPEN) reconnectNow(); } catch(_){}
    });
  }catch(e){
    console.error('initUI 发生错误：', e);
    // 出错时至少把连接状态展示出来，便于排查
    try { updateConnectionStatus('reconnecting'); }catch(_){}
  }
}

/* 便于排查用的全局调试对象（不影响页面） */
window.__ARB_DEBUG__ = {
  reconnectNow,
  recalc: recalculateAllArbitrageOpportunities,
  stats: __norm,
  board: marketBoard,
  books: discoveredBooks
};

/* ------------------ HOTFIX: 赔率显示(长小数/港盘) ------------------ */
/* 仅影响“显示”，不改内存中的真实赔率，不动任何业务逻辑 */
(function(){
  window.fmtOdd = function(o){
    const n = Number(o);
    if (!Number.isFinite(n)) return '-';
    // ≤1 视为港盘，显示时转欧赔 +1；再做两位小数四舍五入
    const dec = n <= 1 ? n + 1 : n;
    const rounded = Math.round(dec * 100) / 100; // 消除 1.83999999999 这类尾差
    return rounded.toFixed(2);
  };
})();
JSFIX
