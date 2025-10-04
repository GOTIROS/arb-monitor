// 全局变量和状态
let ws = null;
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let lastHeartbeat = 0;
let heartbeatTimer = null;
let settings = {};
let marketBoard = new Map();
let alertedSignatures = new Set();
let hasUserInteracted = false;
let discoveredBooks = new Set(['parimatch', 'singbet']); // 默认书商，避免空状态
let activeToasts = new Map(); // key -> { toast, timer }

// 默认设置
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

// 设置管理函数
function loadSettings() {
    try {
        const saved = localStorage.getItem('arb_settings_v1');
        const loaded = saved ? JSON.parse(saved) : {};
        
        // 合并默认设置
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
    } catch (error) {
        console.error('加载设置失败:', error);
        return DEFAULT_SETTINGS;
    }
}

function saveSettings() {
    try {
        localStorage.setItem('arb_settings_v1', JSON.stringify(settings));
    } catch (error) {
        console.error('保存设置失败:', error);
    }
}

// 兼容大写别名
window.LoadSettings = loadSettings;
window.SaveSettings = saveSettings;

// 动态书商管理
function addDiscoveredBook(bookName) {
    if (!bookName) return;
    
    const normalizedBook = normBookKey(bookName);
    if (!discoveredBooks.has(normalizedBook)) {
        discoveredBooks.add(normalizedBook);
        
        // 新书商默认启用
        if (!(normalizedBook in settings.books)) {
            settings.books[normalizedBook] = true;
            saveSettings();
        }
        
        renderBookList();
        renderRebateSettings();
        updateABookOptions();
    }
}

function clearDiscoveredBooks() {
    discoveredBooks.clear();
    // 如果使用模拟数据，保留默认书商
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
            
            // 检查A平台是否还有效
            const currentABook = normBookKey(settings.stake?.aBook || '');
            if (!checkbox.checked && currentABook === book) {
                // 找到其他已勾选的书商
                const enabledBooks = Object.entries(settings.books)
                    .filter(([_, enabled]) => enabled)
                    .map(([bookName, _]) => bookName);
                
                if (enabledBooks.length > 0) {
                    settings.stake.aBook = enabledBooks[0];
                } else {
                    settings.stake.aBook = '';
                }
                updateABookOptions();
            }
            
            saveSettings();
            renderRebateSettings(); // 更新返水设置
            renderMarketBoard();
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
    
    const enabledBooks = Array.from(discoveredBooks)
        .filter(book => settings.books[book])
        .sort();
    
    if (enabledBooks.length === 0) {
        container.innerHTML = '<div class="no-books-message">请先选择书商</div>';
        return;
    }
    
    enabledBooks.forEach(book => {
        const rebateGroup = document.createElement('div');
        rebateGroup.className = 'rebate-group';
        
        const bookTitle = book.charAt(0).toUpperCase() + book.slice(1);
        const currentRebate = settings.rebates[book] || { type: 'turnover', rate: 0.006 };
        
        rebateGroup.innerHTML = `
            <h4>${bookTitle}</h4>
            <div class="form-row">
                <label>类型：</label>
                <select id="${book}-type">
                    <option value="turnover" ${currentRebate.type === 'turnover' ? 'selected' : ''}>Turnover</option>
                    <option value="net_loss" ${currentRebate.type === 'net_loss' ? 'selected' : ''}>Net Loss</option>
                </select>
            </div>
            <div class="form-row">
                <label>比例：</label>
                <input type="number" id="${book}-rate" step="0.001" min="0" max="1" value="${currentRebate.rate}" placeholder="0.006">
            </div>
        `;
        
        container.appendChild(rebateGroup);
        
        // 添加事件监听器
        const typeSelect = rebateGroup.querySelector(`#${book}-type`);
        const rateInput = rebateGroup.querySelector(`#${book}-rate`);
        
        console.log(`为书商 ${book} 添加返水事件监听器`);
        
        typeSelect.addEventListener('change', () => {
            console.log(`${book} 返水类型变更为: ${typeSelect.value}`);
            if (!settings.rebates[book]) settings.rebates[book] = {};
            settings.rebates[book].type = typeSelect.value;
            saveSettings();
            console.log('触发返水类型变更重新计算');
            // 返水类型变化时重新计算套利机会
            recalculateAllArbitrageOpportunities();
        });
        
        rateInput.addEventListener('input', () => {
            const newRate = parseFloat(rateInput.value) || 0;
            console.log(`${book} 返水比例变更为: ${newRate}`);
            if (!settings.rebates[book]) settings.rebates[book] = {};
            settings.rebates[book].rate = newRate;
            saveSettings();
            console.log('触发返水比例变更重新计算');
            // 返水比例变化时重新计算套利机会
            recalculateAllArbitrageOpportunities();
        });
    });
}
function updateABookOptions() {
    const select = document.getElementById('a-book');
    if (!select) return;
    
    const currentValue = select.value;
    select.innerHTML = '';
    
    // 获取已启用的书商（在书商选择中勾选的）
    const enabledBooks = Array.from(discoveredBooks)
        .filter(book => settings.books[book] === true)
        .sort();
    
    if (enabledBooks.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '请先选择书商';
        option.disabled = true;
        select.appendChild(option);
        return;
    }
    
    enabledBooks.forEach(book => {
        const option = document.createElement('option');
        option.value = book;
        option.textContent = book.charAt(0).toUpperCase() + book.slice(1);
        select.appendChild(option);
    });
    
    // 恢复选中值
    if (enabledBooks.includes(currentValue)) {
        select.value = currentValue;
    } else if (enabledBooks.length > 0) {
        select.value = enabledBooks[0];
        settings.stake.aBook = enabledBooks[0];
        saveSettings();
    } else {
        settings.stake.aBook = '';
        saveSettings();
    }
}
// 书商名称标准化
function normBookKey(book) {
    return book ? book.toLowerCase() : '';
}

function getEventKey(opp) {
    return `${opp.league || ''}|${opp.event_name || ''}`;
}

// 时间格式化
function formatTime(date = new Date()) {
    return date.toLocaleTimeString('zh-CN', { 
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

// WebSocket 连接管理
function connectWS() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return;
    }

    // ★ mock 关闭 + 选了自定义 + 但没填 URL -> 不连接任何源
    if (!settings.datasource?.useMock
        && settings.datasource?.wsMode === 'custom'
        && !((settings.datasource?.wsUrl || '').trim())) {
        updateConnectionStatus('connecting'); // 显示待配置
        return;
    }

    let wsUrl;
    
    if (!settings.datasource?.useMock && settings.datasource?.wsMode === 'custom') {
        wsUrl = settings.datasource.wsUrl; // 这里已保证非空
    } else {
        const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
        wsUrl = `${protocol}://${location.host}/ws/opps`;
    }
    
    updateConnectionStatus('connecting');
    
    try {
        ws = new WebSocket(wsUrl);
        
        ws.onopen = function() {
            console.log('WebSocket 连接成功');
            wsReconnectAttempts = 0;
            updateConnectionStatus('connected');
            startHeartbeatMonitor();
        };
        
        ws.onmessage = function(event) {
            try {
                const message = JSON.parse(event.data);
                handleWebSocketMessage(message);
            } catch (error) {
                console.error('解析 WebSocket 消息失败:', error);
            }
        };
        
        ws.onclose = function(event) {
            console.log('WebSocket 连接关闭:', event.code, event.reason);
            updateConnectionStatus('reconnecting');
            stopHeartbeatMonitor();
            if (!(!settings.datasource?.useMock && settings.datasource?.wsMode !== 'custom')) {
                scheduleReconnect();
            }
        };
        
        ws.onerror = function(error) {
            console.error('WebSocket 错误:', error);
        };
        
    } catch (error) {
        console.error('创建 WebSocket 连接失败:', error);
        updateConnectionStatus('reconnecting');
        scheduleReconnect();
    }
}
function reconnectNow() {
    console.log('手动重新连接');
    
    if (ws) {
        ws.close();
    }
    
    wsReconnectAttempts = 0;
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
    }
    
    setTimeout(connectWS, 100);
}

function testConnection() {
    const testBtn = document.getElementById('test-connection');
    if (!testBtn) return;
    
    testBtn.disabled = true;
    testBtn.textContent = '测试中...';
    
    let testWsUrl;
    if (settings.datasource?.wsMode === 'custom' && settings.datasource?.wsUrl) {
        testWsUrl = settings.datasource.wsUrl;
    } else {
        const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
        testWsUrl = `${protocol}://${location.host}/ws/opps`;
    }
    
    const testWs = new WebSocket(testWsUrl);
    
    const timeout = setTimeout(() => {
        testWs.close();
        testBtn.disabled = false;
        testBtn.textContent = '测试连接';
        showToast('连接测试', '连接超时', 'error');
    }, 5000);
    
    testWs.onopen = function() {
        clearTimeout(timeout);
        testWs.close();
        testBtn.disabled = false;
        testBtn.textContent = '测试连接';
        showToast('连接测试', '连接成功', 'success');
    };
    
    testWs.onerror = function(error) {
        clearTimeout(timeout);
        testBtn.disabled = false;
        testBtn.textContent = '测试连接';
        showToast('连接测试', '连接失败：' + (error.message || '未知错误'), 'error');
    };
}

function scheduleReconnect() {
    const hasReal = settings.datasource?.wsMode === 'custom' && !!(settings.datasource?.wsUrl || '').trim();
    if (!settings.datasource?.useMock && !hasReal) return;
    
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
    }
    
    wsReconnectAttempts++;
    const delay = Math.min(30000, Math.pow(2, wsReconnectAttempts - 1) * 1000);
    wsReconnectTimer = setTimeout(connectWS, delay);
}

function startHeartbeatMonitor() {
    stopHeartbeatMonitor();
    heartbeatTimer = setInterval(() => {
        const now = Date.now();
        if (lastHeartbeat && (now - lastHeartbeat > 30000)) {
            console.log('心跳超时，关闭连接');
            ws.close();
        }
    }, 5000);
}

function stopHeartbeatMonitor() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

// WebSocket 消息处理
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
            
        case 'snapshot': {
            // ★ 新增：兼容 { data: [...] } 和 { rows: [...] }
            const rowsOrOpps = message.data || message.rows || [];
            handleSnapshotCompat(rowsOrOpps);
            updateLastUpdateTime();
            break;
        }
            
        case 'opportunity':
            handleOpportunity(message.data);
            updateLastUpdateTime();
            break;
            
        default:
            console.warn('未知消息类型:', message.type);
    }
}

// === 兼容 mock 行情行的快照处理（rows 格式）========================
function handleSnapshotCompat(rows) {
    // rows 可能是“机会对象数组”或“盘口行数组”
    if (!Array.isArray(rows)) return;

    // 先清空
    marketBoard.clear();
    clearArbitrageTable();

    // 模拟数据模式下重置默认书商
    if (settings.datasource?.useMock) {
        clearDiscoveredBooks();
    }

    // 逐行累加到 marketBoard
    rows.forEach(row => {
        // 如果是“机会对象”（带 pickA/pickB），走你原来的处理
        if (row && (row.pickA || row.pickB)) {
            if (row.pickA?.book) addDiscoveredBook(row.pickA.book);
            if (row.pickB?.book) addDiscoveredBook(row.pickB.book);
            processOpportunity(row, false);
            return;
        }

        // 否则当成“盘口行”来处理（兼容字段：league_zh/home_zh/away_zh、row.ou/row.ah、row.books）
        const book = normBookKey(row.book || (Array.isArray(row.books) ? row.books[0] : ''));
        if (book) addDiscoveredBook(book);
        upsertRowIntoMarketBoard(row, book);
    });

    // 渲染盘口列表
    renderMarketBoard();
    // 基于累加结果重新计算套利机会
    recalculateAllArbitrageOpportunities();
}

// 把一行盘口（含 ou/ah）累加到 marketBoard
function upsertRowIntoMarketBoard(row, book) {
    // 取联盟/队名，兼容 *_zh / *_en
    const league = row.league || row.league_zh || row.league_en || '';
    const home   = row.home   || row.home_zh   || row.home_en   || '';
    const away   = row.away   || row.away_zh   || row.away_en   || '';
    const score  = row.score  || row.score_text || '';

    const event_name = row.event_name || ((home && away) ? `${home} vs ${away}` : '');
    const base = { league, event_name };

    const eventId = getEventKey(base);
    const existing = marketBoard.get(eventId) || {
        league: league || '',
        home: home || '',
        away: away || '',
        score: score || '',
        books: new Set(),
        ou: { line: '', over: null, under: null },
        ah: { line: '', home: null, away: null },
        updatedAt: 0
    };

    // 基础信息更新
    if (league) existing.league = league;
    if (home)   existing.home   = home;
    if (away)   existing.away   = away;
    if (score)  existing.score  = score;
    existing.updatedAt = Date.now();
    if (book) existing.books.add(book);

    // OU：{ line, over, under }
    if (row.ou) {
        const lineOu = row.ou.line ?? row.ou_line ?? row.ou.line_text;
        if (lineOu !== undefined) existing.ou.line = String(lineOu);
        if (row.ou.over  !== undefined) existing.ou.over  = { book, odds: Number(row.ou.over)  };
        if (row.ou.under !== undefined) existing.ou.under = { book, odds: Number(row.ou.under) };
    }

    // AH：{ line, home, away }
    if (row.ah) {
        const lineAh = row.ah.line ?? row.ah_line ?? row.ah.line_text;
        if (lineAh !== undefined) existing.ah.line = String(lineAh);
        if (row.ah.home !== undefined) existing.ah.home = { book, odds: Number(row.ah.home) };
        if (row.ah.away !== undefined) existing.ah.away = { book, odds: Number(row.ah.away) };
    }

    marketBoard.set(eventId, existing);
}
// === 兼容处理 END ===================================================


// 机会处理逻辑
function handleSnapshot(opportunities) {
    console.log('收到快照数据:', opportunities.length, '条');
    
    // 清空现有数据
    marketBoard.clear();
    clearArbitrageTable();
    
    // 重置书商发现列表（仅在模拟数据模式下）
    if (settings.datasource?.useMock) {
        clearDiscoveredBooks();
    }
    
    // 处理每个机会
    opportunities.forEach(opp => {
        // 收集书商信息
        if (opp.pickA?.book) addDiscoveredBook(opp.pickA.book);
        if (opp.pickB?.book) addDiscoveredBook(opp.pickB.book);
        
        processOpportunity(opp, false);
    });
    
    renderMarketBoard();
}

function handleOpportunity(opportunity) {
    if (!opportunity) return;
    
    console.log('收到新机会:', opportunity);
    
    // 收集书商信息
    if (opportunity.pickA?.book) addDiscoveredBook(opportunity.pickA.book);
    if (opportunity.pickB?.book) addDiscoveredBook(opportunity.pickB.book);
    
    processOpportunity(opportunity, true);
    renderMarketBoard();
}

// 机会处理逻辑
function processOpportunity(opp, shouldAlert = false) {
    if (!opp || !opp.event_id) return;
    
    // 更新盘口行情
    updateMarketBoard(opp);
    
    // 检查是否符合套利条件
    const arbitrageResult = calculateArbitrage(opp);
    if (arbitrageResult) {
        addArbitrageOpportunity(arbitrageResult, shouldAlert);
    }
}

// 盘口行情更新
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
    
    // 更新基础信息
    if (opp.league) existing.league = opp.league;
    if (opp.event_name) {
        const parts = opp.event_name.split(' vs ');
        if (parts.length >= 2) {
            existing.home = parts[0].trim();
            existing.away = parts[1].trim();
        }
    }
    if (opp.score) existing.score = opp.score;
    existing.updatedAt = Date.now();
    
    // 更新书商信息
    if (opp.pickA && opp.pickA.book) existing.books.add(opp.pickA.book);
    if (opp.pickB && opp.pickB.book) existing.books.add(opp.pickB.book);
    
    // 更新盘口信息
    if (opp.market === 'ou') {
        existing.ou.line = opp.line_text || opp.line_numeric?.toString() || '';
        if (opp.pickA && opp.pickA.selection === 'over') {
            existing.ou.over = { book: opp.pickA.book, odds: opp.pickA.odds };
        }
        if (opp.pickB && opp.pickB.selection === 'under') {
            existing.ou.under = { book: opp.pickB.book, odds: opp.pickB.odds };
        }
    } else if (opp.market === 'ah') {
        existing.ah.line = opp.line_text || opp.line_numeric?.toString() || '';
        if (opp.pickA && opp.pickA.selection === 'home') {
            existing.ah.home = { book: opp.pickA.book, odds: opp.pickA.odds };
        }
        if (opp.pickB && opp.pickB.selection === 'away') {
            existing.ah.away = { book: opp.pickB.book, odds: opp.pickB.odds };
        }
    }
    
    marketBoard.set(eventId, existing);
}

// 套利计算
function calculateArbitrage(opp) {
    if (!opp.pickA || !opp.pickB || !settings) return null;
    
    console.log(`计算套利机会: ${opp.event_name} ${opp.market}`);
    
    const bookA = normBookKey(opp.pickA.book);
    const bookB = normBookKey(opp.pickB.book);
    const aBook = normBookKey(settings.stake?.aBook || '');
    
    // 只计算已勾选的书商
    if (!settings.books[bookA] || !settings.books[bookB]) return null;
    
    console.log(`书商信息: A=${bookA}, B=${bookB}, 设定A平台=${aBook}`);
    
    // 检查是否包含 A 平台
    let isABookInvolved = false;
    let pickA, pickB, sideA, sideB;
    
    if (bookA === aBook) {
        isABookInvolved = true;
        pickA = opp.pickA;
        pickB = opp.pickB;
        sideA = 'A';
        sideB = 'B';
    } else if (bookB === aBook) {
        isABookInvolved = true;
        pickA = opp.pickB;
        pickB = opp.pickA;
        sideA = 'B';
        sideB = 'A';
    } else {
        // 不包含 A 平台，可显示但不提醒
        pickA = opp.pickA;
        pickB = opp.pickB;
        sideA = '—';
        sideB = 'B';
    }
    
    const oA = parseFloat(pickA.odds) || 0;
    const oB = parseFloat(pickB.odds) || 0;
    const sA = parseInt(settings.stake?.amountA) || 10000;
    
    console.log(`赔率和下注额: oA=${oA}, oB=${oB}, sA=${sA}`);
    
    if (oA <= 1 || oB <= 1) return null;
    
    // 获取返水设置
    const rebateA = settings.rebates?.[normBookKey(pickA.book)] || { type: 'turnover', rate: 0 };
    const rebateB = settings.rebates?.[normBookKey(pickB.book)] || { type: 'turnover', rate: 0 };
    const rA = rebateA.rate || 0;
    const rB = rebateB.rate || 0;
    const tA = rebateA.type || 'turnover';
    const tB = rebateB.type || 'turnover';
    
    console.log(`返水设置: ${pickA.book}(${tA}, ${rA}), ${pickB.book}(${tB}, ${rB})`);
    
    // 计算应下注金额 B
    let sB;
    if (tA === 'turnover' && tB === 'turnover') {
        sB = sA * oA / oB;
    } else if (tA === 'net_loss' && tB === 'net_loss') {
        const denominator = oB - rB;
        if (denominator <= 0) return null;
        sB = sA * (oA - rA) / denominator;
    } else if (tA === 'turnover' && tB === 'net_loss') {
        const denominator = oB - rB;
        if (denominator <= 0) return null;
        sB = sA * oA / denominator;
    } else if (tA === 'net_loss' && tB === 'turnover') {
        sB = sA * (oA - rA) / oB;
    } else {
        return null;
    }
    
    if (sB <= 0) return null;
    
    // 计算均衡盈利（假设 A 赢）
    const profit = sA * oA - (sA + sB) + 
                   (tA === 'turnover' ? rA * sA : 0) + rB * sB;
    
    console.log(`计算结果: sB=${sB}, profit=${profit}`);
    
    // 检查是否达到最小盈利阈值
    const minProfit = parseInt(settings.stake?.minProfit) || 0;
    const shouldAlert = isABookInvolved && profit >= minProfit;
    
    return {
        opportunity: opp,
        sideA,
        sideB,
        pickA,
        pickB,
        waterA: (oA - 1).toFixed(3),
        waterB: (oB - 1).toFixed(3),
        stakeB: Math.round(sB),
        profit: Math.round(profit),
        shouldAlert,
        signature: generateSignature(opp)
    };
}

// 生成去重签名
function generateSignature(opp) {
    const books = [
        `${opp.pickA?.book || ''}_${opp.pickA?.selection || ''}`,
        `${opp.pickB?.book || ''}_${opp.pickB?.selection || ''}`
    ].sort();
    
    return `${getEventKey(opp)}_${opp.market}_${opp.line_text || opp.line_numeric || ''}_${books.join('_')}`;
}

// 套利机会管理
function addArbitrageOpportunity(result, shouldAlert) {
    const tbody = document.querySelector('#arbitrageTable tbody');
    const signature = result.signature;
    
    // 统一取阈值（只声明一次）
    const minProfit = parseInt(settings.stake?.minProfit) || 0;
    
    // 已存在的行：利润跌破阈值 -> 删除行并清掉提醒签名；否则更新即可
    const existingRow = tbody.querySelector(`tr[data-signature="${signature}"]`);
    if (existingRow) {
        if (result.profit < minProfit) {
            existingRow.remove();
            alertedSignatures.delete(signature); // 允许后续再次达到阈值时再提醒
            return;
        }
        updateArbitrageRow(existingRow, result);
        if (shouldAlert) highlightRow(existingRow);
        return;
    }
    
    // 新机会：利润未达阈值就不展示
    if (result.profit < minProfit) return;
    
    // 移除"暂无数据"行
    const noDataRow = tbody.querySelector('.no-data');
    if (noDataRow) {
        noDataRow.remove();
    }
    
    // 创建新行
    const row = createArbitrageRow(result);
    tbody.appendChild(row);
    
    // 处理提醒
    if (result.shouldAlert && shouldAlert) {
        highlightRow(row);
        sendAlert(result);
        
        // 设置自动隐藏
        if (settings.notify?.autoHideRowS > 0) {
            setTimeout(() => {
                row.classList.add('hidden-row');
            }, settings.notify.autoHideRowS * 1000);
        }
    }
}

function createArbitrageRow(result) {
    const row = document.createElement('tr');
    row.setAttribute('data-signature', result.signature);
    
    const opp = result.opportunity;
    const marketText = opp.market === 'ah' ? '让球' : '大小球';
    const lineText = opp.line_text || opp.line_numeric?.toString() || '';
    
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
    if (cells.length >= 8) {
        cells[4].textContent = result.waterA;
        cells[5].textContent = result.waterB;
        cells[6].textContent = result.sideA === '—' ? '—' : result.stakeB.toLocaleString();
        cells[7].textContent = result.profit.toLocaleString();
    }
}

function highlightRow(row) {
    row.classList.add('highlighted');
    setTimeout(() => {
        row.classList.remove('highlighted');
    }, 1800);
}

function clearArbitrageTable() {
    const tbody = document.querySelector('#arbitrageTable tbody');
    tbody.innerHTML = '<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
}

// 重新计算所有套利机会
function recalculateAllArbitrageOpportunities() {
    console.log('=== 开始重新计算套利机会 ===');
    console.log('当前设置:', {
        aBook: settings.stake?.aBook,
        amountA: settings.stake?.amountA,
        minProfit: settings.stake?.minProfit,
        rebates: settings.rebates
    });
    
    // 清空当前套利表格
    clearArbitrageTable();
    
    let processedCount = 0;
    let addedCount = 0;
    
    // 重新处理所有盘口数据
    marketBoard.forEach((data, eventId) => {
        // 处理大小球机会
        if (data.ou.line && data.ou.over && data.ou.under) {
            const ouOpp = {
                event_id: eventId,
                event_name: `${data.home} vs ${data.away}`,
                league: data.league,
                market: 'ou',
                line_text: data.ou.line,
                line_numeric: parseFloat(data.ou.line) || 0,
                pickA: { book: data.ou.over.book, selection: 'over', odds: data.ou.over.odds },
                pickB: { book: data.ou.under.book, selection: 'under', odds: data.ou.under.odds },
                score: data.score
            };
            
            processedCount++;
            const arbitrageResult = calculateArbitrage(ouOpp);
            if (arbitrageResult) {
                console.log(`大小球套利机会: ${ouOpp.event_name}, 盈利: ${arbitrageResult.profit}`);
                addArbitrageOpportunity(arbitrageResult, false);
                addedCount++;
            }
        }
        
        // 处理让球机会
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
            
            processedCount++;
            const arbitrageResult = calculateArbitrage(ahOpp);
            if (arbitrageResult) {
                console.log(`让球套利机会: ${ahOpp.event_name}, 盈利: ${arbitrageResult.profit}`);
                addArbitrageOpportunity(arbitrageResult, false);
                addedCount++;
            }
        }
    });
    
    console.log(`=== 重新计算完成 ===`);
    console.log(`处理了 ${processedCount} 个机会，添加了 ${addedCount} 个套利机会`);
}
// 提醒功能
function sendAlert(result) {
    const signature = result.signature;
    
    // 关闭模拟且未配置/未连接真实后端时，任何提醒都直接短路
    const realBackendReady = !settings.datasource?.useMock
      && settings.datasource?.wsMode === 'custom'
      && !!(settings.datasource?.wsUrl || '').trim();
    if (!settings.datasource?.useMock && !realBackendReady) return;
    
    if (alertedSignatures.has(signature)) {
        return;
    }
    alertedSignatures.add(signature);
    
    const opp = result.opportunity;
    const marketText = opp.market === 'ah' ? '让球' : '大小球';
    const lineText = opp.line_text || opp.line_numeric?.toString() || '';
    const sA = settings.stake?.amountA || 10000;
    
    const message = `提醒：A平台${marketText}${lineText}水位${result.waterA}固定下注${sA.toLocaleString()}，B平台${marketText}${lineText}水位${result.waterB}应下注金额${result.stakeB.toLocaleString()}，均衡盈利${result.profit.toLocaleString()}`;
    
    // Toast 提醒
    if (settings.notify?.toastEnabled) {
        showToast('套利机会', message, 'success');
    }
    
    // 系统通知
    if (settings.notify?.systemEnabled && Notification.permission === 'granted') {
        new Notification('套利机会', {
            body: message,
            icon: '/favicon.ico'
        });
    }
    
    // 声音提醒
    if (settings.notify?.soundEnabled && hasUserInteracted) {
        playNotificationSound();
    }
}

function showToast(title, message, type = 'info') {
    const container = document.getElementById('toast-stack');
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
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 200);
    }, duration);
}

function showToastKeyed(key, title, message, type = 'info') {
  const container = document.getElementById('toast-stack');
  const duration = (settings.notify?.toastDurationS || 5) * 1000;

  // 已存在：覆盖内容并重置计时器
  if (activeToasts.has(key)) {
    const rec = activeToasts.get(key);
    rec.toast.querySelector('.toast-title').textContent = title;
    rec.toast.querySelector('.toast-message').textContent = message;
    rec.toast.classList.remove('removing');
    clearTimeout(rec.timer);
    rec.timer = setTimeout(remove, duration);
    activeToasts.set(key, rec);
    return;
  }

  // 不存在：创建新的
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-title">${title}</div>
    <div class="toast-message">${message}</div>
  `;
  container.appendChild(toast);

  const timer = setTimeout(remove, duration);
  activeToasts.set(key, { toast, timer });

  function remove() {
    const rec = activeToasts.get(key);
    if (!rec) return;
    rec.toast.classList.add('removing');
    setTimeout(() => {
      rec.toast.remove();
      activeToasts.delete(key);
    }, 200);
  }
}

function playNotificationSound() {
    try {
        // 创建一个简单的通知音
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
        oscillator.frequency.setValueAtTime(1000, audioContext.currentTime + 0.1);
        oscillator.frequency.setValueAtTime(800, audioContext.currentTime + 0.2);
        
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.3);
    } catch (error) {
        console.warn('无法播放通知音:', error);
    }
}

// 盘口行情渲染
function renderMarketBoard() {
    const tbody = document.querySelector('#marketTable tbody');
    tbody.innerHTML = '';
    
    if (marketBoard.size === 0) {
        tbody.innerHTML = '<tr class="no-data"><td colspan="8">暂无数据</td></tr>';
        return;
    }
    
    const entries = Array.from(marketBoard.entries());
    const sortByTime = document.getElementById('sortByTime').classList.contains('active');
    
    if (sortByTime) {
        entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    } else {
        entries.sort((a, b) => a[1].league.localeCompare(b[1].league));
    }
    
    entries.forEach(([eventId, data]) => {
        const row = document.createElement('tr');
        const booksText = Array.from(data.books).join(', ');
        const ouText = data.ou.line ? `${data.ou.line} (${data.ou.over ? data.ou.over.odds : '-'}/${data.ou.under ? data.ou.under.odds : '-'})` : '-';
        const ahText = data.ah.line ? `${data.ah.line} (${data.ah.home ? data.ah.home.odds : '-'}/${data.ah.away ? data.ah.away.odds : '-'})` : '-';
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

// UI 初始化
function initUI(loadedSettings) {
    settings = loadedSettings;
    
    // 初始化汉堡菜单
    initHamburgerMenu();
    
    // 初始化设置面板
    initSettingsPanels();
    
    // 初始化市场控制
    initMarketControls();
    
    // 请求通知权限
    requestNotificationPermission();
    
    // 监听用户交互
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
    
    hamburgerBtn.addEventListener('click', openDrawer);
    drawerOverlay.addEventListener('click', closeDrawer);
    
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && drawer.classList.contains('active')) {
            closeDrawer();
        }
    });
    
    // 展开/折叠控制
    const expandAllBtn = document.getElementById('expandAllBtn');
    const collapseAllBtn = document.getElementById('collapseAllBtn');
    
    expandAllBtn.addEventListener('click', () => {
        document.querySelectorAll('#drawer details').forEach(details => {
            details.open = true;
        });
        savePanelStates();
    });
    
    collapseAllBtn.addEventListener('click', () => {
        document.querySelectorAll('#drawer details').forEach(details => {
            details.open = false;
        });
        savePanelStates();
    });
}

function initSettingsPanels() {
    // 加载面板状态
    loadPanelStates();
    
    // 监听面板状态变化
    document.querySelectorAll('#drawer details').forEach(details => {
        details.addEventListener('toggle', savePanelStates);
    });
    
    // 数据源配置
    initDatasourcePanel();
    
    // 书商选择（动态生成）
    renderBookList();
    renderRebateSettings();
    
    // 投注设置
    updateStakeInputs();
    const aBookSelect = document.getElementById('a-book');
    const amountAInput = document.getElementById('amount-a');
    const minProfitInput = document.getElementById('min-profit');
    
    aBookSelect.addEventListener('change', () => {
        settings.stake = settings.stake || {};
        settings.stake.aBook = aBookSelect.value;
        saveSettings();
    });
    
    amountAInput.addEventListener('input', () => {
        settings.stake = settings.stake || {};
        settings.stake.amountA = parseInt(amountAInput.value) || 0;
        saveSettings();
        
        // 重新计算所有套利机会
        recalculateAllArbitrageOpportunities();
    });
    
    minProfitInput.addEventListener('input', () => {
        settings.stake = settings.stake || {};
        settings.stake.minProfit = parseInt(minProfitInput.value) || 0;
        saveSettings();
        
        // 重新计算和过滤套利机会
        recalculateAllArbitrageOpportunities();
    });
    
    // 通知设置
    updateNotifyInputs();
    const systemNotify = document.getElementById('system-notify');
    const soundNotify = document.getElementById('sound-notify');
    const toastNotify = document.getElementById('toast-notify');
    const toastDuration = document.getElementById('toast-duration');
    const autoHideRow = document.getElementById('auto-hide-row');
    const clearAlerts = document.getElementById('clear-alerts');
    
    systemNotify.addEventListener('change', () => {
        settings.notify = settings.notify || {};
        settings.notify.systemEnabled = systemNotify.checked;
        saveSettings();
        if (systemNotify.checked) {
            requestNotificationPermission();
        }
    });
    
    soundNotify.addEventListener('change', () => {
        settings.notify = settings.notify || {};
        settings.notify.soundEnabled = soundNotify.checked;
        saveSettings();
    });
    
    toastNotify.addEventListener('change', () => {
        settings.notify = settings.notify || {};
        settings.notify.toastEnabled = toastNotify.checked;
        saveSettings();
    });
    
    toastDuration.addEventListener('input', () => {
        settings.notify = settings.notify || {};
        settings.notify.toastDurationS = parseInt(toastDuration.value) || 5;
        saveSettings();
    });
    
    autoHideRow.addEventListener('input', () => {
        settings.notify = settings.notify || {};
        settings.notify.autoHideRowS = parseInt(autoHideRow.value) || 0;
        saveSettings();
    });
    
    clearAlerts.addEventListener('click', () => {
        alertedSignatures.clear();
        document.querySelectorAll('#arbitrageTable tbody tr.hidden-row').forEach(row => {
            row.classList.remove('hidden-row');
        });
        showToast('系统', '已清除提醒记录', 'success');
    });
}

function initDatasourcePanel() {
    const wsModeAuto = document.getElementById('ws-mode-auto');
    const wsModeCustom = document.getElementById('ws-mode-custom');
    const wsUrlInput = document.getElementById('ws-url');
    const wsTokenInput = document.getElementById('ws-token');
    const useMockCheckbox = document.getElementById('use-mock');
    const testBtn = document.getElementById('test-connection');
    const reconnectBtn = document.getElementById('reconnect-now');
    
    // 调试：检查元素是否存在
    console.log('useMockCheckbox element:', useMockCheckbox);
    
    // 加载设置
    const datasource = settings.datasource || {};
    if (datasource.wsMode === 'custom') {
        wsModeCustom.checked = true;
        wsUrlInput.disabled = false;
    } else {
        wsModeAuto.checked = true;
        wsUrlInput.disabled = true;
    }
    
    wsUrlInput.value = datasource.wsUrl || '';
    wsTokenInput.value = datasource.token || '';
    // 确保开关状态正确初始化
    useMockCheckbox.checked = datasource.useMock !== false;
    console.log('初始化模拟数据开关状态:', useMockCheckbox?.checked, '设置值:', datasource.useMock);
    
    // 事件监听
    wsModeAuto.addEventListener('change', () => {
        if (wsModeAuto.checked) {
            settings.datasource.wsMode = 'auto';
            wsUrlInput.disabled = true;
            saveSettings();
            showReconnectButton();
        }
    });
    
    wsModeCustom.addEventListener('change', () => {
        if (wsModeCustom.checked) {
            settings.datasource.wsMode = 'custom';
            wsUrlInput.disabled = false;
            saveSettings();
            showReconnectButton();
        }
    });
    
    wsUrlInput.addEventListener('input', () => {
        settings.datasource.wsUrl = wsUrlInput.value;
        saveSettings();
        showReconnectButton();
    });
    
    wsTokenInput.addEventListener('input', () => {
        settings.datasource.token = wsTokenInput.value;
        saveSettings();
        showReconnectButton();
    });
    
    // 修复开关事件监听
    if (useMockCheckbox) {
        // 添加多种事件监听确保能捕获到点击
        useMockCheckbox.addEventListener('change', handleMockToggle);
        useMockCheckbox.addEventListener('click', handleMockToggle);
        
        // 也为父容器添加点击事件
        const toggleContainer = useMockCheckbox.closest('.toggle-item');
        if (toggleContainer) {
            toggleContainer.addEventListener('click', (e) => {
                // 如果点击的不是input本身，则手动切换
                if (e.target !== useMockCheckbox) {
                    e.preventDefault();
                    useMockCheckbox.checked = !useMockCheckbox.checked;
                    handleMockToggle();
                }
            });
        }
    } else {
        console.error('找不到模拟数据开关元素');
    }
    
    function handleMockToggle() {
        console.log('开关状态变化:', useMockCheckbox.checked);
        settings.datasource.useMock = useMockCheckbox.checked;
        saveSettings();
        
        // 如果关闭模拟数据，清空所有显示的数据
        if (!useMockCheckbox.checked) {
            marketBoard.clear();
            clearArbitrageTable();
            clearDiscoveredBooks();
            renderMarketBoard();
            alertedSignatures.clear();                           // 清掉已提醒签名
            document.getElementById('toast-stack').innerHTML = '';// 清掉已弹出的 toast
            if (ws) ws.close();                                  // 断开当前 WS
            if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
            console.log('已关闭模拟数据，清空所有显示数据');
        } else {
            // 重新启用模拟数据时，恢复默认书商
            discoveredBooks.add('parimatch');
            discoveredBooks.add('singbet');
            renderBookList();
            renderRebateSettings();
            updateABookOptions();
            console.log('已开启模拟数据');
        }
        
        // 自动重连WebSocket以应用新的模拟数据设置
        console.log('模拟数据设置变更，自动重连WebSocket');
        alertedSignatures.clear(); // 清旧提醒
        reconnectNow();            // 立刻切到目标源（mock 关了就不会连本地）
    }
    
    testBtn.addEventListener('click', testConnection);
    reconnectBtn.addEventListener('click', () => {
        reconnectNow();
        hideReconnectButton();
    });
}

function showReconnectButton() {
    const btn = document.getElementById('reconnect-now');
    if (btn) {
        btn.style.display = 'block';
    }
}

function hideReconnectButton() {
    const btn = document.getElementById('reconnect-now');
    if (btn) {
        btn.style.display = 'none';
    }
}


function updateStakeInputs() {
    const stake = settings.stake || {};
    
    const amountAInput = document.getElementById('amount-a');
    const minProfitInput = document.getElementById('min-profit');
    
    if (amountAInput) amountAInput.value = stake.amountA || 10000;
    if (minProfitInput) minProfitInput.value = stake.minProfit || 0;
    
    updateABookOptions();
}

function updateNotifyInputs() {
    const notify = settings.notify || {};
    
    const systemNotify = document.getElementById('system-notify');
    const soundNotify = document.getElementById('sound-notify');
    const toastNotify = document.getElementById('toast-notify');
    const toastDuration = document.getElementById('toast-duration');
    const autoHideRow = document.getElementById('auto-hide-row');
    
    if (systemNotify) systemNotify.checked = notify.systemEnabled || false;
    if (soundNotify) soundNotify.checked = notify.soundEnabled !== false;
    if (toastNotify) toastNotify.checked = notify.toastEnabled !== false;
    if (toastDuration) toastDuration.value = notify.toastDurationS || 5;
    if (autoHideRow) autoHideRow.value = notify.autoHideRowS || 30;
}

function loadPanelStates() {
    try {
        const saved = localStorage.getItem('panel_state_v1');
        const states = saved ? JSON.parse(saved) : {};
        
        ['panel-datasource', 'panel-books', 'panel-rebates', 'panel-stake', 'panel-notify', 'panel-marketboard'].forEach(id => {
            const panel = document.getElementById(id);
            if (panel) {
                if (id === 'panel-marketboard') {
                    panel.open = states[id] === true; // 默认折叠
                } else {
                    panel.open = states[id] !== false;
                }
            }
        });
    } catch (error) {
        console.error('加载面板状态失败:', error);
    }
}

function savePanelStates() {
    try {
        const states = {};
        ['panel-datasource', 'panel-books', 'panel-rebates', 'panel-stake', 'panel-notify', 'panel-marketboard'].forEach(id => {
            const panel = document.getElementById(id);
            if (panel) {
                states[id] = panel.open;
            }
        });
        localStorage.setItem('panel_state_v1', JSON.stringify(states));
    } catch (error) {
        console.error('保存面板状态失败:', error);
    }
}

function initMarketControls() {
    const sortByLeague = document.getElementById('sortByLeague');
    const sortByTime = document.getElementById('sortByTime');
    const collapseBtn = document.getElementById('market-collapse-btn');
    const marketPanel = document.getElementById('panel-marketboard');
    
    sortByLeague.addEventListener('click', () => {
        sortByLeague.classList.add('active');
        sortByTime.classList.remove('active');
        renderMarketBoard();
    });
    
    sortByTime.addEventListener('click', () => {
        sortByTime.classList.add('active');
        sortByLeague.classList.remove('active');
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

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function updateConnectionStatus(status) {
    const badge = document.getElementById('statusBadge');
    const errorAlert = document.getElementById('connectionError');
    
    badge.className = `status-badge ${status}`;
    
    switch (status) {
        case 'connected':
            badge.textContent = '已连接';
            errorAlert.style.display = 'none';
            break;
        case 'connecting':
            badge.textContent = '连接中...';
            errorAlert.style.display = 'none';
            break;
        case 'reconnecting':
            badge.textContent = '重连中...';
            errorAlert.style.display = 'block';
            break;
    }
}

function updateLastUpdateTime() {
    const element = document.getElementById('lastUpdateTime');
    element.textContent = formatTime();
}

// 应用启动
document.addEventListener('DOMContentLoaded', () => {
    console.log('应用启动');
    
    // 唯一启动入口
    const loadedSettings = loadSettings();
    initUI(loadedSettings);
    connectWS();
});
