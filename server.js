// Breachpoint game server: serves the page and relays multiplayer rooms over WebSocket.
// The room host's browser runs the AI defenders and round logic; this server only
// manages rooms and forwards messages between players.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DEPLOYED_AT = new Date().toISOString();
const MAX_PLAYERS = 10;
const TEAM_MAX = 5;

// index.html is written as page content only; wrap it in a proper document for phones and browsers.
function buildPage() {
  const body = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('__DEPLOYED_AT__', DEPLOYED_AT);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#07090c">
<meta name="author" content="Zain">
<meta name="apple-mobile-web-app-title" content="Breachpoint">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/icon-180.png">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">
<title>Breachpoint</title>
<style>html,body{margin:0;height:100%;background:#07090c;overscroll-behavior:none;-webkit-text-size-adjust:100%}</style>
</head>
<body>
${body}
</body>
</html>`;
}
let page = buildPage();

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(JSON.stringify({
      name: 'Breachpoint', short_name: 'Breachpoint', description: 'Tactical breach-and-defuse shooter. Created by Zain.',
      start_url: '/', display: 'fullscreen', orientation: 'landscape', background_color: '#07090c', theme_color: '#07090c',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
    return;
  }
  const icon = url.match(/^\/icons\/([a-z0-9-]+\.png)$/);
  if (icon) {
    const f = path.join(__dirname, 'icons', icon[1]);
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }); res.end(fs.readFileSync(f)); return; }
  }
  if (url === '/' || url === '/index.html') {
    if (process.env.NODE_ENV !== 'production') page = buildPage();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(page);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const rooms = new Map();
let nextId = 1;
const OPS = ['breaker', 'spectre', 'havoc', 'lumen', 'shroud', 'relay', 'raze'];

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms.has(c));
  return c;
}
const cleanName = s => (String(s || '').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').trim().slice(0, 16)) || 'OPERATOR';
const roster = room => [...room.clients.values()].map(c => ({ id: c.id, name: c.name, team: c.team, op: c.op }));
function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function broadcast(room, o, except) {
  const s = JSON.stringify(o);
  for (const c of room.clients.values()) if (c.ws !== except && c.ws.readyState === 1) c.ws.send(s);
}
const sendRoster = room => broadcast(room, { t: 'roster', list: roster(room), host: room.host, started: room.started });
const teamCount = (room, team) => [...room.clients.values()].filter(c => c.team === team).length;

wss.on('connection', ws => {
  const me = { id: nextId++, ws, name: 'OPERATOR', team: 'atk', op: 'breaker', room: null };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'create' || m.t === 'join') {
      if (me.room) return;
      let room;
      if (m.t === 'create') {
        room = { code: makeCode(), host: me.id, clients: new Map(), started: false };
        rooms.set(room.code, room);
      } else {
        room = rooms.get(String(m.code || '').toUpperCase());
        if (!room) { send(ws, { t: 'err', msg: 'Room not found. Check the code and try again.' }); return; }
        if (room.clients.size >= MAX_PLAYERS) { send(ws, { t: 'err', msg: `That room is full (${MAX_PLAYERS} players).` }); return; }
        if (room.started) { send(ws, { t: 'err', msg: 'That match has already started. Ask the host to return to the lobby.' }); return; }
      }
      me.name = cleanName(m.name);
      me.op = OPS.includes(m.op) ? m.op : 'breaker';
      me.team = room.clients.size === 0 ? 'atk' : (teamCount(room, 'atk') <= teamCount(room, 'def') && teamCount(room, 'atk') < TEAM_MAX ? 'atk' : 'def');
      if (teamCount(room, me.team) >= TEAM_MAX) me.team = me.team === 'atk' ? 'def' : 'atk';
      me.room = room;
      room.clients.set(me.id, me);
      send(ws, { t: 'joined', id: me.id, code: room.code, host: room.host });
      sendRoster(room);
      return;
    }

    const room = me.room;
    if (!room) return;
    switch (m.t) {
      case 'team':
        if (room.started || (m.team !== 'atk' && m.team !== 'def')) return;
        if (teamCount(room, m.team) >= TEAM_MAX) return;
        me.team = m.team; sendRoster(room); return;
      case 'op':
        if (!OPS.includes(m.op)) return;
        me.op = m.op; sendRoster(room); return;
      case 'start':
        if (me.id !== room.host || room.started || teamCount(room, 'atk') === 0) return;
        room.started = true;
        broadcast(room, { t: 'start', roster: roster(room), host: room.host });
        return;
      case 'lobby':
        if (me.id !== room.host) return;
        room.started = false;
        broadcast(room, { t: 'lobby' }); sendRoster(room);
        return;
    }
    // everything else is game traffic: relay to one player or to the rest of the room
    m.from = me.id;
    if (m.to !== undefined) { const c = room.clients.get(m.to); if (c) send(c.ws, m); }
    else broadcast(room, m, ws);
  });

  ws.on('close', () => {
    const room = me.room;
    if (!room) return;
    room.clients.delete(me.id);
    if (room.clients.size === 0) { rooms.delete(room.code); return; }
    broadcast(room, { t: 'left', id: me.id });
    if (room.host === me.id) {
      room.host = room.clients.keys().next().value;
      if (room.started) { room.started = false; broadcast(room, { t: 'hostleft' }); }
    }
    sendRoster(room);
  });
});

// keep connections alive through proxies and drop dead ones
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch (e) { }
  }
}, 25000);

server.listen(PORT, '0.0.0.0', () => console.log(`Breachpoint listening on ${PORT} (deployed ${DEPLOYED_AT})`));
