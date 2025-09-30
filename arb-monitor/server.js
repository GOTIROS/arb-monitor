const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);

// 托管静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 根路由返回 index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket 服务器，支持 permessage-deflate
const wss = new WebSocket.Server({
  server,
  path: '/ws/opps',
  perMessageDeflate: true
});

// 模拟套利机会数据
const sampleOpportunities = [
  {
    event_id: "E001",
    event_name: "Arsenal vs Chelsea",
    league: "英超",
    market: "ah",
    line_text: "-0/0.5",
    line_numeric: -0.25,
    pickA: { book: "parimatch", selection: "home", odds: 2.02 },
    pickB: { book: "singbet", selection: "away", odds: 1.98 },
    score: "1-0"
  },
  {
    event_id: "E002",
    event_name: "Manchester United vs Liverpool",
    league: "英超",
    market: "ou",
    line_text: "2.5",
    line_numeric: 2.5,
    pickA: { book: "parimatch", selection: "over", odds: 1.95 },
    pickB: { book: "singbet", selection: "under", odds: 2.05 },
    score: "0-0"
  },
  {
    event_id: "E003",
    event_name: "Barcelona vs Real Madrid",
    league: "西甲",
    market: "ah",
    line_text: "0",
    line_numeric: 0,
    pickA: { book: "singbet", selection: "home", odds: 2.10 },
    pickB: { book: "parimatch", selection: "away", odds: 1.90 },
    score: "2-1"
  }
];

let opportunityIndex = 0;

wss.on('connection', (ws) => {
  console.log('新的WebSocket连接');

  // 发送初始快照
  ws.send(JSON.stringify({
    type: 'snapshot',
    data: sampleOpportunities.slice(0, Math.min(20, sampleOpportunities.length))
  }));

  // 心跳机制
  const heartbeatInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'heartbeat',
        ts: Date.now()
      }));
    }
  }, 15000);

  // 定期发送新机会
  const opportunityInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      const opportunity = {
        ...sampleOpportunities[opportunityIndex % sampleOpportunities.length],
        event_id: `E${Date.now()}_${opportunityIndex}`,
        pickA: {
          ...sampleOpportunities[opportunityIndex % sampleOpportunities.length].pickA,
          odds: (1.8 + Math.random() * 0.4).toFixed(2)
        },
        pickB: {
          ...sampleOpportunities[opportunityIndex % sampleOpportunities.length].pickB,
          odds: (1.8 + Math.random() * 0.4).toFixed(2)
        }
      };
      
      ws.send(JSON.stringify({
        type: 'opportunity',
        data: opportunity
      }));
      
      opportunityIndex++;
    }
  }, 3000 + Math.random() * 2000);

  ws.on('close', () => {
    console.log('WebSocket连接关闭');
    clearInterval(heartbeatInterval);
    clearInterval(opportunityInterval);
  });

  ws.on('error', (error) => {
    console.error('WebSocket错误:', error);
    clearInterval(heartbeatInterval);
    clearInterval(opportunityInterval);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`服务器运行在 http://0.0.0.0:${port}`);
});