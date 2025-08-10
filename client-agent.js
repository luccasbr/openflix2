// client-agent.js
// Roda no A (Cliente). UM DataChannel "mux" duradouro + multiplex de conexões.
// Expõe HTTP CONNECT (127.0.0.1:8080) e SOCKS5 (127.0.0.1:1080) usando o mux.
// Env: ROOM, TOKEN, SIGNAL, SIGNAL_TOKEN, RELAY_ONLY
const net   = require('net');
const http  = require('http');
const { pcFactory } = require('./lib/webrtc');

const ROOM   = process.env.ROOM   || 'demo1';
const TOKEN  = process.env.TOKEN  || '';
const SIGNAL = process.env.SIGNAL || 'wss://signal.loghub.shop/ws';

const ICE = [
  { urls: 'stun:turn.loghub.shop:3478' },
  { urls: 'turns:turn.loghub.shop:5349?transport=tcp', username: 'api', credential: 'senha-super-secreta' },
  { urls: 'turn:turn.loghub.shop:3478?transport=udp',  username: 'api', credential: 'senha-super-secreta' },
];

console.log('[client] START', { ROOM, SIGNAL, RELAY_ONLY: process.env.RELAY_ONLY === '1' });
const { pc, ensureOffer } = pcFactory(ICE, SIGNAL, 'client', ROOM, process.env.SIGNAL_TOKEN || null);

// cria o canal mux (uma vez) e mantém
let mux = null;
let muxOpened = false;
let muxReadyResolvers = [];
function onMuxReady() {
  return new Promise((resolve) => {
    if (mux && muxOpened) return resolve();
    muxReadyResolvers.push(resolve);
  });
}
function resolveMuxReady() {
  muxOpened = true;
  const arr = muxReadyResolvers; muxReadyResolvers = [];
  arr.forEach(fn => fn());
}

function ensureMux() {
  if (mux) return;
  mux = pc.createDataChannel('mux', { ordered: true });
  mux.binaryType = 'arraybuffer';
  mux._pendingMsgs = []; // msgs do host que cheguem antes de termos listeners por stream
  mux.onopen = () => {
    resolveMuxReady();
    console.log('[client] mux aberto');
  };
  mux.onclose = () => {
    console.log('[client] mux fechado');
    muxOpened = false;
  };
  mux.onerror = (e) => console.warn('[client] mux error:', e && e.message);

  // roteador de mensagens (JSON)
  mux.onmessage = (e) => {
    const txt = Buffer.from(e.data).toString('utf8');
    let msg; try { msg = JSON.parse(txt); } catch { return; }
    handleMuxMessage(msg);
  };

  // garantir que SCTP esteja negociado
  ensureOffer().catch(()=>{});
}
// instalar handler para mux vindo do host (fallback se host abrir)
pc.ondatachannel = (ev) => {
  if (ev.channel.label === 'mux' && !mux) {
    mux = ev.channel;
    mux.binaryType = 'arraybuffer';
    mux._pendingMsgs = [];
    mux.onopen = () => { resolveMuxReady(); console.log('[client] mux aberto'); };
    mux.onclose = () => { console.log('[client] mux fechado'); muxOpened = false; };
    mux.onerror = (e) => console.warn('[client] mux error:', e && e.message);
    mux.onmessage = (e) => {
      const txt = Buffer.from(e.data).toString('utf8');
      let msg; try { msg = JSON.parse(txt); } catch { return; }
      handleMuxMessage(msg);
    };
  }
};

// ---------- Multiplex ----------
let nextId = 1;
const streams = new Map(); // id -> {type:'http'|'socks', socket, state, onAck, onData, onEnd, pending[]}

function sendMux(obj) {
  try { mux.send(Buffer.from(JSON.stringify(obj))); } catch {}
}

function handleMuxMessage(msg) {
  const s = streams.get(msg.id);
  switch (msg.op) {
    case 'ack':
      if (s && s.state === 'opening') {
        s.state = msg.ok ? 'open' : 'failed';
        if (s.onAck) s.onAck(!!msg.ok);
      }
      break;
    case 'sdata':
      if (s && s.state === 'open') {
        const data = Buffer.from(msg.data, 'base64');
        if (s.onData) s.onData(data);
        else s.pending.push(data);
      }
      break;
    case 'send':
      if (s && s.state !== 'closed') {
        s.state = 'closed';
        if (s.onEnd) s.onEnd();
        streams.delete(msg.id);
      }
      break;
    case 'rst':
      if (s) {
        if (s.onEnd) s.onEnd(new Error(msg.reason || 'rst'));
        streams.delete(msg.id);
      }
      break;
    default:
      break;
  }
}

async function openStream(host, port, timeoutMs = 15000) {
  ensureMux();
  await onMuxReady();

  const id = nextId++;
  const s = {
    id,
    state: 'opening',
    pending: [],
    onAck: null,
    onData: null,
    onEnd: null,
  };
  streams.set(id, s);

  // envia OPEN
  sendMux({ op: 'open', id, host, port, token: TOKEN });

  // espera ACK ou timeout
  const ok = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    s.onAck = (accepted) => { clearTimeout(t); resolve(accepted); };
  });

  if (!ok) {
    streams.delete(id);
    throw new Error('open-timeout-or-fail');
  }

  // helpers de envio e fechamento
  s.send = (buf) => sendMux({ op:'cdata', id, data: Buffer.from(buf).toString('base64') });
  s.end  = () => sendMux({ op:'cend', id });

  return s;
}

// ---------- HTTP CONNECT local ----------
const httpProxy = http.createServer();
httpProxy.on('connect', async (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':'); const port = Number(portStr || 443);

  try {
    const s = await openStream(host, port, 15000);

    // plug sinks
    s.onData = (data) => { try { clientSocket.write(data); } catch {} };
    s.onEnd  = () => { try { clientSocket.end(); } catch {} };

    // drena pendentes só após responder 200 (protocolo CONNECT)
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (s.pending.length) {
      for (const ch of s.pending) { try { clientSocket.write(ch); } catch {} }
      s.pending.length = 0;
    }
    if (head && head.length) s.send(head);

    // cliente -> host
    clientSocket.on('data', (chunk) => { try { s.send(chunk); } catch {} });
    clientSocket.on('end',  ()    => { try { s.end(); } catch {} });
    clientSocket.on('error',()    => { try { s.end(); } catch {} });

  } catch (e) {
    try { clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n'); } catch {}
    try { clientSocket.end(); } catch {}
  }
});
httpProxy.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
httpProxy.listen(8080, '127.0.0.1', () => console.log('[client] HTTP CONNECT em 127.0.0.1:8080'));

// ---------- SOCKS5 (TCP) ----------
const socksServer = net.createServer(async (cliSock) => {
  cliSock.once('data', async (hello) => {
    if (hello[0] !== 0x05) { cliSock.destroy(); return; }
    // NoAuth (MVP)
    cliSock.write(Buffer.from([0x05, 0x00]));

    cliSock.once('data', async (req1) => {
      const ver = req1[0], cmd = req1[1], atyp = req1[3];
      if (ver !== 0x05 || cmd !== 0x01) {
        // apenas CONNECT (TCP) neste MVP do mux
        cliSock.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0,0,0,0, 0,0]));
        return;
      }

      // parse destino
      let host, port, p = 4;
      if (atyp === 0x01) { host = req1.slice(p, p+4).join('.'); p += 4; }
      else if (atyp === 0x03) { const len=req1[p]; p += 1; host = req1.slice(p, p+len).toString('utf8'); p += len; }
      else if (atyp === 0x04) { host = '['+req1.slice(p, p+16).toString('hex')+']'; p += 16; }
      port = (req1[p]<<8) | req1[p+1];

      try {
        const s = await openStream(host, port, 15000);

        // sucesso
        cliSock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0]));

        s.onData = (data) => { try { cliSock.write(data); } catch {} };
        s.onEnd  = ()     => { try { cliSock.end(); } catch {} };
        if (s.pending.length) {
          for (const ch of s.pending) { try { cliSock.write(ch); } catch {} }
          s.pending.length = 0;
        }

        cliSock.on('data', chunk => { try { s.send(chunk); } catch {} });
        cliSock.on('end',  ()    => { try { s.end(); } catch {} });
        cliSock.on('error',()    => { try { s.end(); } catch {} });

      } catch (e) {
        cliSock.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0,0,0,0, 0,0])); // failure
      }
    });
  });
});
socksServer.listen(1080, '127.0.0.1', () => console.log('[client] SOCKS5 em 127.0.0.1:1080'));

// cria mux no boot
ensureMux();

// proteção
process.on('uncaughtException', (e) => console.error('[client] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[client] unhandled', e));
