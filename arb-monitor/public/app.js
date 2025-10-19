/* =======================================================
   arb-monitor — public/app.js
   生产版（SSE 优先；强制港赔；半场/全场并存；兼容更多格式）
   ======================================================= */
'use strict';

/* ------------------ 调试计数 ------------------ */
const __norm = { raw:0, parsed:0, oppOk:0, books:0, lastType:'' };
window.__normStats = __norm;

/* ------------------ 全局变量 ------------------ */
let ws = null;          // WebSocket 句柄
let es = null;          // EventSource 句柄（SSE）
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let lastHeartbeat = 0;
let heartbeatTimer = null;

let settings = {};
/**
 * marketBoard: Map<eventKey, {
 *   league, home, away, score,
 *   books: Set<book>,              // 只记录书商集合，用于过滤与面板
 *   ouMap: Map<book|period, OU>,   // ✅ 关键：book + period(FT/HT) 作为键，避免互相覆盖
 *   ahMap: Map<book|period, AH>,   // ✅ 同上
 *   updatedAt, kickoffAt
 * }>
 *   OU: { book, period, line, over, under }
 *   AH: { book, period, line, home, away }
 */
let marketBoard = new Map();
let hasUserInteracted = false;
let discoveredBooks = new Set();   // 动态发现书商

// 声音 & Toast 管理
let pendingBeeps = 0;
let soundHintShown = false;
const alertMemory = new Map(); // sig -> { lastProfit, lastAt }
const ALERT_TTL_MS = 15000;    // 软去重窗口：15s

// 排序 & 稳定行序（用于行情总览，不影响套利表）
let sortMode = 'time'; // 'time' | 'league'
const rowOrder = new Map(); // key: eventKey|book|period -> stable index
let rowSeq = 0;

// —— 强制港赔开关（本版：始终按 hk→欧赔）
const FORCE_HK_ODDS = false;

/* >>>>>>>>>>>>>>>>>>>>>  本地模拟  <<<<<<<<<<<<<<<<<<<<<< */
let mockTimers = [];
function stopMock(){ try{ mockTimers.forEach(clearInterval);}catch(_){ } mockTimers=[]; }
function connectMock(){
  updateConnectionStatus('connected');
  lastHeartbeat = Date.now();
  // 心跳
  mockTimers.push(setInterval(()=>{ handleUnifiedMessage({type:'heartbeat', ts:Date.now()}); }, 3000));
  // 每 5s 推一份 snapshot（含 OU + AH）
  mockTimers.push(setInterval(()=>{
    const base = {
      league:'测试联赛',
      event_name:'Mock United vs Demo City',
      score:'0:0',
      kickoffAt: Date.now() + 60*60*1000
    };
    const ou = {
      ...base, market:'ou', line_text:'2.5', period:'FT',
      pickA:{ book:'pinnacle', selection:'over',  odds:0.93 },
      pickB:{ book:'188bet',   selection:'under', odds:0.93 }
    };
    const ah = {
      ...base, market:'ah', line_text:'-0.5', period:'HT',
      pickA:{ book:'pinnacle', selection:'home', odds:0.90 },
      pickB:{ book:'188bet',   selection:'away', odds:0.95 }
    };
    handleUnifiedMessage({ type:'snapshot', data:[ou,ah], ts:Date.now() });
  }, 5000));
}
/* >>>>>>>>>>>>>>>>>>>>>  本地模拟结束  <<<<<<<<<<<<<<<<<<<<<< */

/* ------------------ 常用函数 ------------------ */
function rowKey(eventKey, book, period) { return `${eventKey}|${(book||'').toLowerCase()}|${period||'FT'}`; }

/* 只把“像时间戳”的值当时间，避免把“第X分钟(40/77等)”误判 */
function guessKickoffTs(obj) {
  const cands = [obj.kickoffAt,obj.kickoff_at,obj.kickoff,obj.matchTime,obj.match_time,obj.start_time,obj.start_ts,obj.startTime];
  for (const v of cands) {
    if (v == null) continue;
    const n = typeof v === 'string' ? Date.parse(v) : Number(v);
    if (!Number.isNaN(n) && n > 0) {
      if (n < 1e7) return undefined;            // 40、77 等分钟数：忽略
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
function fmtOdd(o, digits = 2) { const n = Number(o); return Number.isFinite(n) ? n.toFixed(digits) : '-'; }

/* ------------------ 默认设置 ------------------ */
const DEFAULT_SETTINGS = {
  datasource: { wsMode:'custom', wsUrl:'https://www.youdatan.com/sse/opps', token:'', mockEnabled:false },
  books: {},
  rebates: {},
  rebateA: { book:'', rate:0 },
  rebateB: { book:'', rate:0 },
  stake:  { aBook:'', amountA:10000, minProfit:0 },
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
  if (!book && book!==0) return;
  const b = normBookKey(String(book));
  if (!discoveredBooks.has(b)) {
    discoveredBooks.add(b);
    __norm.books++;
    if (!(b in settings.books)) { settings.books[b] = true; saveSettings(); }
    renderBookList(); renderRebateSettings(); updateABookOptions();
  }
}
function clearDiscoveredBooks(){ discoveredBooks.clear(); renderBookList(); renderRebateSettings(); updateABookOptions(); }

/* ------------------ 工具函数 ------------------ */
function getEventKey(opp){
  const id = opp?.event_id ?? opp?.eventId ?? opp?.match_id ?? opp?.id;
  if (id != null && String(id).trim() !== '') return String(id);
  const h = (opp?.home || '').trim();
  const a = (opp?.away || '').trim();
  const name = (opp?.event_name && opp.event_name.trim())
    ? opp.event_name.trim()
    : (h && a ? `${h} vs ${a}` : '');
  return `${opp?.league || ''}|${name}`;
}

/* ------------------ 半场/全场识别 ------------------ */
function detectPeriod(raw, marketRaw){
  const bucket = [
    raw?.period, raw?.scope, raw?.market_scope, raw?.bet_scope,
    raw?.half, raw?.stage, raw?.time_type, raw?.period_type,
    marketRaw, raw?.market_type, raw?.mkt, raw?.category
  ].filter(Boolean).map(x=>String(x).toLowerCase()).join('|');

  if (/\b(1h|fh|first[-_\s]?half|1st|上半|半场)\b/.test(bucket)) return 'HT';
  if (/\b(full|ft|全场)\b/.test(bucket)) return 'FT';
  return 'FT';
}
function zhPeriod(p){ return p==='HT' ? '上半' : '全场'; }

/* ------------------ 构造流地址（SSE/WS 共用） ------------------ */
function buildStreamUrl() {
  let base = (settings.datasource?.wsMode === 'custom' && (settings.datasource?.wsUrl || '').trim())
    ? settings.datasource.wsUrl.trim()
    : (location.protocol === 'https:' ? 'https://' : 'http://') + location.host + '/sse/opps';
  const url = new URL(base);
  const token = (settings.datasource?.token || '').trim();
  if (token) url.searchParams.set('token', token); // SSE 无 header，这里用 query 透传
  return url.toString();
}

/* ------------------ 统一连接入口 ------------------ */
function connectStream(){
  try {
    const url = buildStreamUrl();
    if (isHttpUrl(url)) return connectSSE(url);
    if (isWsUrl(url))   return connectWS();
    if (url && url.startsWith('/sse/')) {
      connectSSE(`${location.origin}${url}`);
    } else if (url && url.startsWith('/ws/')) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      connectWS(`${proto}://${location.host}${url}`);
    } else {
      connectSSE(`${location.origin}/sse/opps`);
    }
  } catch (e){
    console.error('connectStream error:', e);
    updateConnectionStatus('reconnecting');
  }
}

/* ------------------ WebSocket ------------------ */
function isHttpUrl(u){ return /^https?:\/\//i.test(String(u||'')); }
function isWsUrl(u){  return /^wss?:\/\//i.test(String(u||'')); }

function connectWS(){
  if (settings.datasource?.mockEnabled){ stopMock(); connectMock(); return; }
  stopMock();

  const isAliveWS = ws && (ws.readyState===WebSocket.CONNECTING || ws.readyState===WebSocket.OPEN);
  if (isAliveWS) return;
  if (es){ try{ es.close(); }catch(_){} es=null; }

  let url;
  if (settings.datasource?.wsMode==='custom'){
    url = (settings.datasource.wsUrl||'').trim();
    if (!url){ updateConnectionStatus('connecting'); return; }
  }else{
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    url = `${protocol}://${location.host}/ws/opps`;
  }

  if (isHttpUrl(url)) return connectSSE(url);
  if (!isWsUrl(url)){
    if (url.startsWith('/sse/')) return connectSSE(`${location.origin}${url}`);
    const proto = (location.protocol==='https:'?'wss':'ws');
    url = url.startsWith('/ws/') ? `${proto}://${location.host}${url}` : url;
  }

  updateConnectionStatus('connecting');
  try{
    ws = new WebSocket(url);
    ws.onopen = () => {
      wsReconnectAttempts = 0;
      updateConnectionStatus('connected');
      startHeartbeatMonitor();
    };
    ws.onmessage = async (ev) => {
      __norm.raw++;
      try{
        let text;
        if (typeof ev.data === 'string') text = ev.data;
        else if (ev.data instanceof Blob && typeof ev.data.text === 'function') text = await ev.data.text();
        else text = String(ev.data);
        const obj = JSON.parse(text);
        __norm.parsed++;
        handleUnifiedMessage(obj);
      }catch(e){ console.error('解析消息失败:', e); }
    };
    ws.onclose = () => {
      updateConnectionStatus('reconnecting');
      stopHeartbeatMonitor();
      scheduleReconnect();
    };
    ws.onerror = (err) => { console.error('WS 错误:', err); };
  }catch(err){
    console.error('创建 WS 失败:', err);
    updateConnectionStatus('reconnecting');
    scheduleReconnect();
  }
}

/* ------------------ SSE 连接（EventSource） ------------------ */
function connectSSE(url){
  if (ws){ try{ ws.close(); }catch(_){} ws=null; }
  if (es){ try{ es.close(); }catch(_){} es=null; }

  updateConnectionStatus('connecting');
  try{
    es = new EventSource(url, { withCredentials:false });

    es.addEventListener('open', () => {
      wsReconnectAttempts = 0;
      updateConnectionStatus('connected');
      stopHeartbeatMonitor(); // SSE 无需浏览器心跳
    });

    const pass = (e) => { try { handleUnifiedMessage(JSON.parse(e.data)); } catch(_){} };
    es.addEventListener('message', pass);
    ['heartbeat','snapshot','opportunity'].forEach(evt=> es.addEventListener(evt, pass));

    es.addEventListener('error', (e) => {
      console.warn('SSE 错误/断开，准备重连', e);
      updateConnectionStatus('reconnecting');
      try{ es.close(); }catch(_){}
      es = null;
      scheduleReconnect();
    });
  }catch(err){
    console.error('创建 SSE 失败:', err);
    updateConnectionStatus('reconnecting');
    scheduleReconnect();
  }
}

/* ------------------ 重连与心跳 ------------------ */
function reconnectNow(){
  stopMock();
  if (ws){ try{ ws.close(); }catch(_){} ws=null; }
  if (es){ try{ es.close(); }catch(_){} es=null; }
  if (wsReconnectTimer){ clearTimeout(wsReconnectTimer); wsReconnectTimer=null; }
  wsReconnectAttempts = 0;
  setTimeout(connectStream, 120);
}
function scheduleReconnect(){
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectAttempts++;
  const d = Math.min(30000, Math.pow(2, wsReconnectAttempts-1)*1000);
  wsReconnectTimer = setTimeout(connectStream, d);
}
function startHeartbeatMonitor(){
  stopHeartbeatMonitor();
  heartbeatTimer = setInterval(()=>{
    if (lastHeartbeat && (Date.now() - lastHeartbeat > 30000)){
      try{ ws && ws.close(); }catch(_){}
    }
  }, 5000);
}
function stopHeartbeatMonitor(){
  if (heartbeatTimer){ clearInterval(heartbeatTimer); heartbeatTimer=null; }
}

/* ------------------ 消息处理（统一规范层） ------------------ */
function _num(v){ const n=(typeof v==='string')?parseFloat(v):Number(v); return Number.isFinite(n)?n:undefined; }
function _str(v){ if (v==null) return ''; return (typeof v==='string')?v:String(v); }
function _pick(obj, keys, fallback){ for (const k of keys){ if (obj && obj[k]!=null && obj[k]!=='') return obj[k]; } return fallback; }
const _OU_ALIASES=new Set(['ou','o/u','totals','total','大小','大小球','大/小','daxiao','first_half_totals']);
const _AH_ALIASES=new Set(['ah','hdp','handicap','让球','让盘','让分','亚洲盘','亚洲让球','first_half_asian_handicap']);
const _OVER_ALIASES=new Set(['over','o','大','大球','overline','overbet']);
const _UNDER_ALIASES=new Set(['under','u','小','小球','underline','underbet']);
const _HOME_ALIASES=new Set(['home','h','主','主队','1']);
const _AWAY_ALIASES=new Set(['away','a','客','客队','2']);
function _normSel(s){ const t=_str(s).trim().toLowerCase(); if(_OVER_ALIASES.has(t))return'over'; if(_UNDER_ALIASES.has(t))return'under'; if(_HOME_ALIASES.has(t))return'home'; if(_AWAY_ALIASES.has(t))return'away'; return t; }

/* —— 强制港赔：所有赔率一律按 HK→欧赔（n + 1） */
function _toDecimalOdds(o) {
  const n = Number(o);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (FORCE_HK_ODDS) return n + 1;
  return n <= 1 ? (n + 1) : (n < 1.5 ? (n + 1) : n);
}

/* 市场兜底（以选择名判断 OU/AH） */
function _normMarket(rawMkt, pickA, pickB){
  const t=String(rawMkt||'').toLowerCase();
  if (_OU_ALIASES.has(t)) return 'ou';
  if (_AH_ALIASES.has(t)) return 'ah';
  const sa=(pickA?.selection||'').toLowerCase();
  const sb=(pickB?.selection||'').toLowerCase();
  if (_OVER_ALIASES.has(sa) || _UNDER_ALIASES.has(sa) || _OVER_ALIASES.has(sb) || _UNDER_ALIASES.has(sb)) return 'ou';
  if (_HOME_ALIASES.has(sa) || _AWAY_ALIASES.has(sa) || _HOME_ALIASES.has(sb) || _AWAY_ALIASES.has(sb)) return 'ah';
  return 'ou';
}
function _marketFromType(t){
  const n = String(t||'').trim();
  if (n==='2' || n.toLowerCase()==='ou') return 'ou';
  if (n==='6' || n.toLowerCase()==='ah') return 'ah';
  return 'ou';
}

/** —— 规范化一条机会记录（更宽松 + 强制港赔 + 半场/全场） */
function _normalizeOpp(raw){
  if (!raw || typeof raw!=='object') return null;

  const league=_str(_pick(raw,['league','leagueName','league_name','league_cn','联赛','联赛名'],'')); 
  const home=_str(_pick(raw,['home','homeTeam','home_name','主队','team_a'],'')); 
  const away=_str(_pick(raw,['away','awayTeam','away_name','客队','team_b'],'')); 
  const eventName=_str(_pick(raw,['event_name','eventName','赛事','比赛','match_name'], (home&&away)?`${home} vs ${away}`:''));
  const lineText=_str(_pick(raw,['line_text','lineText','line','handicap','ah','ou','total','盘口','大小'],'')); 
  const lineNum=_num(_pick(raw,['line_numeric','lineNum','lineValue','total_points','handicap_value'],undefined));

  // —— pickA / pickB
  let pickA=_pick(raw,['pickA','a','A'],null);
  let pickB=_pick(raw,['pickB','b','B'],null);

  // —— 兼容 odds1/odds2 + company/companyId
  if (!pickA || !pickB){
    const company=_pick(raw,['book','company','companyName'], undefined);
    const companyId=_pick(raw,['companyId','company_id','cid'], undefined);
    const bookName = (company!=null?company:(companyId!=null?String(companyId):'book'));
    const odds1=_num(_pick(raw,['odds1','o1','oddsA','aOdds'],undefined));
    const odds2=_num(_pick(raw,['odds2','o2','oddsB','bOdds'],undefined));
    const selA=_normSel(_pick(raw,['selA','selectionA','aSel'],'')); 
    const selB=_normSel(_pick(raw,['selB','selectionB','bSel'],'')); 
    if (odds1!=null && odds2!=null){
      let mkt=_pick(raw,['market','market_type','mkt','type','玩法'],'');
      mkt = _OU_ALIASES.has(String(mkt).toLowerCase()) || _AH_ALIASES.has(String(mkt).toLowerCase())
        ? String(mkt).toLowerCase()
        : _marketFromType(mkt);
      if (mkt==='ou'){
        pickA = { book:bookName, selection: selA||'over',  odds: odds1 };
        pickB = { book:bookName, selection: selB||'under', odds: odds2 };
      }else{
        pickA = { book:bookName, selection: selA||'home', odds: odds1 };
        pickB = { book:bookName, selection: selB||'away', odds: odds2 };
      }
      raw.market = raw.market || mkt;
    }
  }

  // —— 再兜底：picks 数组
  if ((!pickA || !pickB) && Array.isArray(raw.picks)){
    const p1=raw.picks[0]||{}, p2=raw.picks[1]||{};
    pickA={book:_str(p1.book||p1.bk||'bookA').toLowerCase(), selection:_normSel(p1.selection||p1.sel), odds:_num(p1.odds)};
    pickB={book:_str(p2.book||p2.bk||'bookB').toLowerCase(), selection:_normSel(p2.selection||p2.sel), odds:_num(p2.odds)};
  }

  if (!pickA || !pickB) return null;

  // —— 港赔转欧赔（强制）
  if (pickA.odds != null) pickA.odds = _toDecimalOdds(pickA.odds);
  if (pickB.odds != null) pickB.odds = _toDecimalOdds(pickB.odds);
  if (!((pickA.odds||0) > 0 && (pickB.odds||0) > 0)) return null;

  // —— 市场 & 半场
  const marketRaw=_pick(raw,['market','market_type','mkt','type','玩法'],'');
  const market = _OU_ALIASES.has(String(marketRaw).toLowerCase()) || _AH_ALIASES.has(String(marketRaw).toLowerCase())
    ? (String(marketRaw).toLowerCase().includes('ah')?'ah':'ou')
    : _normMarket(marketRaw, pickA, pickB);

  const period = detectPeriod(raw, marketRaw); // 'HT' 上半；默认 'FT'
  const eventId=_pick(raw,['event_id','eventId','match_id','fid','mid','id'], `${home}-${away}-${lineText}`);

  return {
    event_id:eventId, event_name:eventName, league, period,
    score:_str(_pick(raw,['score','sc','比分'],'')),
    market, line_text: lineText || (lineNum!=null?String(lineNum):''), line_numeric:(lineNum!=null?lineNum:undefined),
    pickA:{ book:String(pickA.book||'bookA').toLowerCase(), selection:_normSel(pickA.selection), odds:+pickA.odds },
    pickB:{ book:String(pickB.book||'bookB').toLowerCase(), selection:_normSel(pickB.selection), odds:+pickB.odds },
    kickoffAt:_pick(raw,['kickoffAt','kickoff_at','kickoff','matchTime','match_time','start_time','start_ts','startTime'],undefined)
  };
}

/** —— 统一消息：snapshot/opportunity/heartbeat */
function _normalizeMessage(message){
  if (!message) return null;
  if (Array.isArray(message)) { __norm.lastType='array'; return { type:'snapshot', data:message.map(_normalizeOpp).filter(Boolean), ts:Date.now() }; }
  let type = _str(message.type).toLowerCase(); const ts=message.ts||Date.now();
  if (!type || type==='ping' || type==='hello') { __norm.lastType='heartbeat'; return { type:'heartbeat', ts }; }
  if (type==='heartbeat') { __norm.lastType='heartbeat'; return { type:'heartbeat', ts }; }
  if (['snapshot','full','list'].includes(type)){
    __norm.lastType='snapshot';
    const list=_pick(message,['data','opps','items','list'],[]);
    return { type:'snapshot', data:(Array.isArray(list)?list.map(_normalizeOpp).filter(Boolean):[]), ts };
  }
  if (['opportunity','delta','change','upd','update'].includes(type)){
    __norm.lastType='opportunity';
    const raw=_pick(message,['data','opp','item','record'],null);
    const opp=_normalizeOpp(raw); if (!opp) return { type:'heartbeat', ts };
    return { type:'opportunity', data:opp, ts };
  }
  const list=_pick(message,['data','opps','items','list'],null);
  if (Array.isArray(list)) { __norm.lastType='snapshot'; return { type:'snapshot', data:list.map(_normalizeOpp).filter(Boolean), ts }; }
  return null;
}
function handleUnifiedMessage(message){
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
  __norm.oppOk++;
  updateMarketBoard(opp);
  const result = calculateArbitrage(opp);
  if (result) addArbitrageOpportunity(result, shouldAlert);
}
function ensureEventContainer(key){
  const cur = marketBoard.get(key);
  if (cur) return cur;
  const obj = {
    league:'', home:'', away:'', score:'',
    books:new Set(),                    // 书商集合（只存 book，不带 period）
    ouMap:new Map(),                    // key: `${book}|${period}`  → { book, period, line, over, under }
    ahMap:new Map(),                    // key: `${book}|${period}`  → { book, period, line, home, away }
    updatedAt:0, kickoffAt:undefined
  };
  marketBoard.set(key, obj); return obj;
}
function setOUForBook(cur, book, line, selection, odds, period){
  if (book==null) return;
  const b = normBookKey(String(book));
  const pd = (period==='HT'?'HT':'FT');
  const key = `${b}|${pd}`;
  const entry = cur.ouMap.get(key) || { book:b, period:pd, line:'', over:null, under:null };
  entry.line = line || entry.line || '';
  const sel = (selection||'').toLowerCase();
  if (sel==='over')  entry.over  = odds;
  if (sel==='under') entry.under = odds;
  cur.ouMap.set(key, entry);
  cur.books.add(b); addDiscoveredBook(b);
}
function setAHForBook(cur, book, line, selection, odds, period){
  if (book==null) return;
  const b = normBookKey(String(book));
  const pd = (period==='HT'?'HT':'FT');
  const key = `${b}|${pd}`;
  const entry = cur.ahMap.get(key) || { book:b, period:pd, line:'', home:null, away:null };
  entry.line = line || entry.line || '';
  const sel = (selection||'').toLowerCase();
  if (sel==='home') entry.home = odds;
  if (sel==='away') entry.away = odds;
  cur.ahMap.set(key, entry);
  cur.books.add(b); addDiscoveredBook(b);
}
function updateMarketBoard(opp){
  const key = getEventKey(opp);
  const cur = ensureEventContainer(key);

  if (opp.league) cur.league = opp.league;
  {
    let h = (opp.home || '').trim();
    let a = (opp.away || '').trim();
    if ((!h || !a) && (opp.event_name || '').includes(' vs ')){
      const sp = (opp.event_name || '').split(' vs ').map(s => s.trim());
      if (!h && sp[0]) h = sp[0];
      if (!a && sp[1]) a = sp[1];
    }
    if (h) cur.home = h;
    if (a) cur.away = a;
  }
  if (opp.score != null) cur.score = opp.score;

  const k = guessKickoffTs(opp);
  if (k && (!cur.kickoffAt || Math.abs(k-(cur.kickoffAt||0))>1000)) cur.kickoffAt = k;

  cur.updatedAt = Date.now();

  const lineText = opp.line_text || (opp.line_numeric?.toString()||'');
  const pd = opp.period || 'FT';
  if (opp.market==='ou'){
    if (opp.pickA) setOUForBook(cur, opp.pickA.book, lineText, opp.pickA.selection, opp.pickA.odds, pd);
    if (opp.pickB) setOUForBook(cur, opp.pickB.book, lineText, opp.pickB.selection, opp.pickB.odds, pd);
  } else if (opp.market==='ah'){
    if (opp.pickA) setAHForBook(cur, opp.pickA.book, lineText, opp.pickA.selection, opp.pickA.odds, pd);
    if (opp.pickB) setAHForBook(cur, opp.pickB.book, lineText, opp.pickB.selection, opp.pickB.odds, pd);
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
  if (oA<=0 || oB<=0) return null;

  const rA=getRebateRateForBook(normBookKey(pickA.book));
  const rB=getRebateRateForBook(normBookKey(pickB.book));
  const sB=sA*oA/oB; if (sB<=0) return null;

  // 利润（欧赔）：A返利 + B返利 + A中奖 - 本金
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
  const base = `${getEventKey(opp)}_${opp.period||'FT'}_${opp.market}_${opp.line_text||opp.line_numeric||''}`;
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

  const tbody = findArbTbody();
  const sig=result.signature, minProfit=parseInt(settings.stake?.minProfit)||0;
  if (result.profit<minProfit) return;

  const existed=tbody.querySelector(`tr[data-signature="${CSS.escape(sig)}"]`);
  if (existed) existed.remove();

  const noData=tbody.querySelector('.no-data'); if (noData) noData.remove();

  const row=createArbitrageRow(result);
  tbody.insertBefore(row, tbody.firstChild);

  const hideS = parseInt(settings.notify?.autoHideRowS) || 0;
  if (hideS > 0) setTimeout(() => { try { row.remove(); ensureNoDataRow(); } catch(_) {} }, hideS * 1000);

  if (shouldAlert) sendAlert(result);
}
function ensureNoDataRow(){
  const tbody = findArbTbody();
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
  const periodText = zhPeriod(opp.period);

  row.innerHTML=`
    <td>${opp.event_name||''}</td>
    <td>${periodText} · ${marketText} ${lineText}</td>
    <td>${pickAText}</td>
    <td>${pickBText}</td>
    <td>${waterAForDisplay}</td>
    <td>${waterBForDisplay}</td>
    <td>${result.stakeB.toLocaleString()}</td>
    <td>${result.profit.toLocaleString()}</td>`;
  return row;
}

/* ------------------ 批量重算（保持不动，但限定同 period 配对） ------------------ */
function recalculateAllArbitrageOpportunities(){
  const tbody = findArbTbody(); if (!tbody) return;
  clearArbitrageTable();
  marketBoard.forEach((data,eventId)=>{
    const ouEntries=Array.from(data.ouMap.values());
    for (const eOver of ouEntries){
      for (const eUnder of ouEntries){
        if (eOver.book===eUnder.book) continue;
        if ((eOver?.over && eUnder?.under) && eOver.period===eUnder.period){
          const opp={ event_id:eventId, event_name:`${data.home} vs ${data.away}`, league:data.league, period:eOver.period||'FT', market:'ou',
            line_text:eOver.line||eUnder.line||'', line_numeric:parseFloat(eOver.line||eUnder.line)||0,
            pickA:{book:eOver.book,selection:'over',odds:eOver.over}, pickB:{book:eUnder.book,selection:'under',odds:eUnder.under}, score:data.score };
          const r=calculateArbitrage(opp); if (r) addArbitrageOpportunity(r,false);
        }
      }
    }
    const ahEntries=Array.from(data.ahMap.values());
    for (const eHome of ahEntries){
      for (const eAway of ahEntries){
        if (eHome.book===eAway.book) continue;
        if ((eHome?.home && eAway?.away) && eHome.period===eAway.period){
          const opp={ event_id:eventId, event_name:`${data.home} vs ${data.away}`, league:data.league, period:eHome.period||'FT', market:'ah',
            line_text:eHome.line||eAway.line||'', line_numeric:parseFloat(eHome.line||eAway.line)||0,
            pickA:{book:eHome.book,selection:'home',odds:eHome.home}, pickB:{book:eAway.book,selection:'away',odds:eAway.away}, score:data.score };
          const r=calculateArbitrage(opp); if (r) addArbitrageOpportunity(r,false);
        }
      }
    }
  });
}
function clearArbitrageTable(){ const tbody = findArbTbody(); if (tbody) tbody.innerHTML=`<tr class="no-data"><td colspan="8">暂无数据</td></tr>`; }

/* ------------------ 提醒（Toast/声音/系统通知） ------------------ */
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
    const periodText = zhPeriod(opp.period);

    const title=`套利机会 · ${opp.league||''} · ${opp.event_name||''}`;
    const msg=
      `盘口：${periodText} · ${marketText} ${lineText}<br>`+
      `选择A：${pickAStr}　水位：${(parseFloat(pickForA.odds)-1).toFixed(3)}（A固定 ${sA.toLocaleString()}）<br>`+
      `选择B：${pickBStr}　水位：${(parseFloat(pickForB.odds)-1).toFixed(3)}（应下 ${result.stakeB.toLocaleString()}）<br>`+
      `均衡盈利：${result.profit.toLocaleString()}`;

    if (settings.notify?.toastEnabled) showToast(title,msg,'success');

    if (settings.notify?.systemEnabled && 'Notification' in window && Notification.permission==='granted') {
      new Notification(title, { body:`${periodText}·${marketText}${lineText}  盈利 ${result.profit.toLocaleString()}`, icon:'/favicon.ico' });
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

/* ------------------ 自动探测“盘口总览表”的 tbody ------------------ */
let _marketTbodyCache = null;
function findMarketTbody(){
  if (_marketTbodyCache && document.body.contains(_marketTbodyCache)) return _marketTbodyCache;

  // 1) 优先已知 id
  let el = document.querySelector('#marketTable tbody')
        || document.querySelector('#market-board tbody')
        || document.querySelector('#board tbody')
        || document.querySelector('#panel-marketboard table tbody');
  if (el){ _marketTbodyCache = el; return el; }

  // 2) 在所有 table 中查找包含“书商/联赛/主队/客队”的头
  const tables = Array.from(document.querySelectorAll('table'));
  for (const t of tables){
    const thead = t.tHead || t.querySelector('thead');
    const headText = (thead?.innerText || '').replace(/\s+/g,'');
    if (headText && headText.includes('书商') && headText.includes('联赛') && headText.includes('主队') && headText.includes('客队')){
      const tb = t.tBodies?.[0] || t.querySelector('tbody');
      if (tb){ _marketTbodyCache = tb; return tb; }
    }
  }

  // 3) 退化：取页面上的第一个或第二个 tbody
  _marketTbodyCache = document.querySelector('#panel-marketboard tbody')
                      || document.querySelectorAll('tbody')[0]
                      || document.querySelectorAll('tbody')[1]
                      || document.querySelector('tbody');
  return _marketTbodyCache;
}

/* 套利表 tbody（保持旧 id，找不到就退化为第二个 tbody） */
function findArbTbody(){
  return document.querySelector('#arbitrageTable tbody') || document.querySelectorAll('tbody')[1] || findMarketTbody();
}

/* ------------------ 行情总览（按 book+period 分组渲染） ------------------ */
function renderMarketBoard(){
  const tbody = findMarketTbody(); if (!tbody) return;
  tbody.innerHTML='';
  if (marketBoard.size===0){ tbody.innerHTML='<tr class="no-data"><td colspan="8">暂无数据</td></tr>'; return; }

  const enabledList = Array.from(discoveredBooks).filter(b => settings.books[b] !== false).map(b => normBookKey(b));
  const enabled = new Set(enabledList);
  const useAll = enabled.size === 0;

  const rows=[];
  for (const [eventId, data] of marketBoard.entries()) {

    // 按 (book,period) 分组的合并视图：同一行包含同 period 的 OU 与 AH
    const groups = new Map(); // key: `${book}|${period}` -> { book, period, ou?, ah? }

    for (const e of data.ouMap.values()){
      if (!useAll && !enabled.has(e.book)) continue;
      const k = `${e.book}|${e.period}`;
      const g = groups.get(k) || { book:e.book, period:e.period, ou:null, ah:null };
      g.ou = e; groups.set(k,g);
    }
    for (const e of data.ahMap.values()){
      if (!useAll && !enabled.has(e.book)) continue;
      const k = `${e.book}|${e.period}`;
      const g = groups.get(k) || { book:e.book, period:e.period, ou:null, ah:null };
      g.ah = e; groups.set(k,g);
    }

    for (const g of groups.values()){
      const rk = rowKey(eventId, g.book, g.period);
      if (!rowOrder.has(rk)) rowOrder.set(rk, ++rowSeq);

      const ouTxt = g.ou ? `[${zhPeriod(g.period)}] ${g.ou.line || ''} (${fmtOdd(g.ou.over)} / ${fmtOdd(g.ou.under)})` : '-';
      const ahTxt = g.ah ? `[${zhPeriod(g.period)}] ${g.ah.line || ''} (${fmtOdd(g.ah.home)} / ${fmtOdd(g.ah.away)})` : '-';

      rows.push({
        rk, stable: rowOrder.get(rk),
        book: g.book, period: g.period,
        league: data.league || '', home: data.home || '', away: data.away || '', score: data.score || '',
        ouText: ouTxt, ahText: ahTxt, kickoffAt: data.kickoffAt || 0, updatedAt: data.updatedAt || 0
      });
    }
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

/* ------------------ 书商 UI 渲染、设置面板、通知等（与现版一致） ------------------ */
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

/* 数据源面板（含“测试连接”识别 SSE/WS） */
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

  const mockSwitch = document.querySelector('#use-mock, input[name="use-mock"], [data-mock], #mockSwitch, .mock-switch input[type="checkbox"]');
  if (mockSwitch){
    mockSwitch.disabled = false;
    mockSwitch.checked = !!(settings.datasource?.mockEnabled);
    mockSwitch.addEventListener('change', ()=>{
      settings.datasource.mockEnabled = !!mockSwitch.checked;
      saveSettings(); showReconnectButton();
    });
  }

  wsModeAuto && wsModeAuto.addEventListener('change', ()=>{ if (wsModeAuto.checked){ settings.datasource.wsMode='auto'; wsUrlInput && (wsUrlInput.disabled=true); saveSettings(); showReconnectButton(); }});
  wsModeCustom && wsModeCustom.addEventListener('change', ()=>{ if (wsModeCustom.checked){ settings.datasource.wsMode='custom'; wsUrlInput && (wsUrlInput.disabled=false); saveSettings(); showReconnectButton(); }});
  wsUrlInput && wsUrlInput.addEventListener('input', ()=>{ settings.datasource.wsUrl=wsUrlInput.value; saveSettings(); showReconnectButton(); });
  wsTokenInput && wsTokenInput.addEventListener('input', ()=>{ settings.datasource.token=wsTokenInput.value; saveSettings(); showReconnectButton(); });

  if (testBtn) testBtn.addEventListener('click', ()=>{
    testBtn.disabled=true; testBtn.textContent='测试中...';
    const url = buildStreamUrl();
    const finish=(ok,msg)=>{ testBtn.disabled=false; testBtn.textContent='测试连接'; showToast('连接测试',msg, ok?'success':'error'); };

    try{
      if (/^https?:/i.test(url)){
        const tmp = new EventSource(url);
        const to = setTimeout(()=>{ try{tmp.close();}catch(_){} finish(false,'连接超时'); },5000);
        tmp.addEventListener('open',()=>{ clearTimeout(to); try{tmp.close();}catch(_){} finish(true,'SSE 连接成功'); });
        tmp.addEventListener('error',()=>{ /* 交给超时处理 */ });
      }else{
        const t=new WebSocket(url);
        const to=setTimeout(()=>{ try{t.close();}catch(_){ } finish(false,'连接超时'); },5000);
        t.onopen=()=>{ clearTimeout(to); try{t.close();}catch(_){ } finish(true,'WS 连接成功'); };
        t.onerror=()=>{ clearTimeout(to); finish(false,'连接失败'); };
      }
    }catch(_){ finish(false,'地址不正确'); }
  });
  reconnectBtn && reconnectBtn.addEventListener('click', ()=>{ reconnectNow(); hideReconnectButton(); });
}
function showReconnectButton(){ const b=document.getElementById('reconnect-now'); if (b) b.style.display='block'; }
function hideReconnectButton(){ const b=document.getElementById('reconnect-now'); if (b) b.style.display='none'; }

/* 市场控制面板、汉堡、通知、状态…（保持原实现） */
function updateStakeInputs(){ const s=settings.stake||{}; const amountAInput=document.getElementById('amount-a'); const minProfitInput=document.getElementById('min-profit'); if (amountAInput) amountAInput.value=s.amountA||10000; if (minProfitInput) minProfitInput.value=s.minProfit||0; updateABookOptions(); }
function updateNotifyInputs(){
  const n=settings.notify||{}; const systemNotify=document.getElementById('system-notify'); const soundNotify=document.getElementById('sound-notify'); const toastNotify=document.getElementById('toast-notify'); const toastDuration=document.getElementById('toast-duration'); const autoHideRow=document.getElementById('auto-hide-row');
  if (systemNotify) systemNotify.checked=!!n.systemEnabled; if (soundNotify) soundNotify.checked=n.soundEnabled!==false; if (toastNotify) toastNotify.checked=n.toastEnabled!==false;
  if (toastDuration) toastDuration.value=n.toastDurationS||5; if (autoHideRow) autoHideRow.value=n.autoHideRowS||30;
}
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
function initMarketControls(){
  const sortByLeagueBtn=document.querySelector('#sortByLeague, [data-sort="league"]');
  const sortByTimeBtn=document.querySelector('#sortByTime, [data-sort="time"]');
  const collapseBtn=document.getElementById('market-collapse-btn');
  const marketPanel=document.getElementById('panel-marketboard');

  if (sortByLeagueBtn) sortByLeagueBtn.addEventListener('click', ()=>{ sortMode='league'; sortByLeagueBtn.classList.add('active'); sortByTimeBtn && sortByTimeBtn.classList.remove('active'); renderMarketBoard(); });
  if (sortByTimeBtn)   sortByTimeBtn.addEventListener('click', ()=>{ sortMode='time'; sortByTimeBtn.classList.add('active'); sortByLeagueBtn && sortByLeagueBtn.classList.remove('active'); renderMarketBoard(); });
  if (collapseBtn && marketPanel) collapseBtn.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); marketPanel.open=!marketPanel.open; savePanelStates(); });
}
function requestNotificationPermission(){ if ('Notification' in window && Notification.permission==='default') Notification.requestPermission(); }
function updateConnectionStatus(status){
  const badge=document.getElementById('statusBadge'); const alert=document.getElementById('connectionError'); if (!badge || !alert) return;
  badge.className = `status-badge ${status}`;
  if (status==='connected'){ badge.textContent='已连接'; alert.style.display='none'; }
  else if (status==='connecting'){ badge.textContent='连接中...'; alert.style.display='none'; }
  else { badge.textContent='重连中...'; alert.style.display='block'; }
}

/* ------------------ 启动入口 ------------------ */
document.addEventListener('DOMContentLoaded', ()=>{
  const loaded = loadSettings();
  initUI(loaded);
  connectStream();
});

/* 最近更新时间（被消息处理调用） */
function updateLastUpdateTime(){
  const el = document.getElementById('lastUpdateTime');
  if (el) el.textContent = formatTime(new Date());
}

/* 初始化 UI（不改版、不删组件） */
function initUI(loaded){
  try{
    settings = loaded || DEFAULT_SETTINGS;

    initHamburgerMenu();
    loadPanelStates();
    initDatasourcePanel();

    renderBookList();
    renderRebateSettings();

    updateStakeInputs();
    updateNotifyInputs();

    initMarketControls();

    ensureNoDataRow();
    requestNotificationPermission();
    updateConnectionStatus('connecting');

    const onceClick = () => {
      hasUserInteracted = true;
      if (pendingBeeps > 0){
        const n = Math.min(pendingBeeps, 2);
        pendingBeeps = 0;
        for (let i=0;i<n;i++) playNotificationSound();
      }
    };
    document.addEventListener('click', onceClick, { once:true, capture:true });

    window.addEventListener('focus', () => {
      try { if (!ws || ws.readyState !== WebSocket.OPEN) reconnectNow(); } catch(_){}
    });
  }catch(e){
    console.error('initUI 发生错误：', e);
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

