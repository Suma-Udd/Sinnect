// Entry point. Starts a local WebSocket server the UI connects to.
//   MURMUR_PORT   port to listen on (default 4317)
//   MURMUR_TOKEN  shared secret the UI must send first (default "dev")
//   MURMUR_DATA   folder for settings and workspaces
//   MURMUR_MOCK=1 demo mode, fake sessions that cost nothing
//   MURMUR_UI     folder with a built UI to serve over http (optional)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Engine } from './engine.js';
import type { ClientMsg, EngineMsg } from './protocol.js';

const port = Number(process.env.MURMUR_PORT || 4317);
const token = process.env.MURMUR_TOKEN || 'dev';
const mock = process.env.MURMUR_MOCK === '1';
const dataDir =
  process.env.MURMUR_DATA ||
  (process.platform === 'win32'
    ? path.join(process.env.APPDATA || os.homedir(), 'Murmur')
    : path.join(os.homedir(), '.murmur'));
const uiDir = process.env.MURMUR_UI;

const clients = new Set<WebSocket>();
const engine = new Engine({
  dataDir,
  mock,
  broadcast(msg: EngineMsg) {
    const raw = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(raw);
  },
});

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mock }));
    return;
  }
  if (!uiDir) {
    res.writeHead(404).end();
    return;
  }
  const url = new URL(req.url || '/', 'http://x');
  let file = path.normalize(path.join(uiDir, decodeURIComponent(url.pathname)));
  if (!file.startsWith(path.normalize(uiDir))) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(uiDir, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 });

wss.on('connection', (ws) => {
  let authed = false;
  const timer = setTimeout(() => !authed && ws.close(4001, 'no hello'), 5000);
  ws.on('message', async (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!authed) {
      if (msg.t === 'hello' && msg.token === token) {
        authed = true;
        clearTimeout(timer);
        clients.add(ws);
        ws.send(JSON.stringify({ t: 'ready', snapshot: engine.snapshot() } satisfies EngineMsg));
      } else ws.close(4003, 'bad token');
      return;
    }
    try {
      await engine.handle(msg);
    } catch (err) {
      ws.send(JSON.stringify({ t: 'toast', level: 'error', text: String(err instanceof Error ? err.message : err) } satisfies EngineMsg));
    }
  });
  ws.on('close', () => clients.delete(ws));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[murmur] engine listening on 127.0.0.1:${port}${mock ? ' (demo mode)' : ''}, data in ${dataDir}`);
});

async function exit() {
  await engine.shutdown().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', exit);
process.on('SIGTERM', exit);
// When the desktop shell dies, stdin closes: shut down with it.
if (process.env.MURMUR_PARENT_STDIN === '1') process.stdin.on('end', exit).resume();
