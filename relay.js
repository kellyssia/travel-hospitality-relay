// relay.js — minimal WebSocket broadcast relay for the travel-hospitality demo
// Accepts WS connections on /ws, broadcasts every message to all connected
// clients (including the sender), enriches with serverTs for verifiability.

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      clients: wss.clients.size,
      uptime: Math.floor(process.uptime())
    }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Travel & Hospitality Relay — WebSocket endpoint at /ws');
});

const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[+] client connected (${ip}) — total: ${wss.clients.size}`);

  ws.on('message', (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch (e) {
      console.warn('[!] invalid JSON, ignoring');
      return;
    }

    const enriched = Object.assign({}, parsed, { serverTs: new Date().toISOString() });
    const out = JSON.stringify(enriched);

    let count = 0;
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(out);
        count++;
      }
    });

    console.log(`[>>] ${parsed.eventType || parsed.type || '?'} demoKey=${parsed.demoKey || '?'} → ${count} clients`);
  });

  ws.on('close', () => {
    console.log(`[-] client disconnected — total: ${wss.clients.size}`);
  });

  ws.on('error', (e) => {
    console.warn('[!] ws error:', e.message);
  });
});

server.listen(PORT, () => {
  console.log(`Relay listening on port ${PORT}`);
});
