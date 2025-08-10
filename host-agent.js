// host-agent.js
// Roda na casa do B (Host). Mantém UM DataChannel "mux" e multiplica TCP dentro dele.
// Env: ROOM, TOKEN, SIGNAL, SIGNAL_TOKEN, RELAY_ONLY
const net = require('net');
const { pcFactory } = require('./lib/webrtc');

const ROOM   = process.env.ROOM   || 'demo1';
const TOKEN  = process.env.TOKEN  || ''; // token esperado do cliente
const SIGNAL = process.env.SIGNAL || 'wss://signal.loghub.shop/ws';

const ICE = [
  { urls: 'stun:turn.loghub.shop:3478' },
  { urls: 'turns:turn.loghub.shop:5349?transport=tcp', username: 'api', credential: 'senha-super-secreta' },
  { urls: 'turn:turn.loghub.shop:3478?transport=udp',  username: 'api', credential: 'senha-super-secreta' },
];

console.log('[host] START', { ROOM, SIGNAL, RELAY_ONLY: process.env.RELAY_ONLY === '1' });
const { pc } = pcFactory(ICE, SIGNAL, 'host', ROOM, process.env.SIGNAL_TOKEN || null);

// sockets ativos por stream id
const streams = new Map(); // id -> {socket}

function safeSend(dc, obj) {
  try { dc.send(Buffer.from(JSON.stringify(obj))); } catch {}
}

pc.ondatachannel = (ev) => {
  const dc = ev.channel;
  if (dc.label !== 'mux') {
    // ignorar antigos
    dc.close();
    return;
  }
  console.log('[host] mux aberto');
  dc.binaryType = 'arraybuffer';

  dc.onmessage = (e) => {
    let msg; try { msg = JSON.parse(Buffer.from(e.data).toString('utf8')); } catch { return; }

    if (TOKEN && msg.token && msg.token !== TOKEN) {
      // rejeita comandos com token errado
      return;
    }

    switch (msg.op) {
      case 'open': {
        // {op:'open', id, host, port, token}
        const id = msg.id;
        if (!id || streams.has(id)) return;
        const sock = net.connect({ host: msg.host, port: Number(msg.port) }, () => {
          safeSend(dc, { op:'ack', id, ok:1 });
        });
        // timeout de conexão/ocioso
        sock.setTimeout(30000, () => {
          safeSend(dc, { op:'rst', id, reason:'timeout' });
          try { sock.destroy(); } catch {}
          streams.delete(id);
        });
        sock.on('data', (chunk) => safeSend(dc, { op:'sdata', id, data: chunk.toString('base64') }));
        sock.on('error', (err) => { safeSend(dc, { op:'rst', id, reason: err.message || 'error' }); streams.delete(id); });
        sock.on('close', () => { safeSend(dc, { op:'send', id }); streams.delete(id); });
        streams.set(id, { socket: sock });
        break;
      }
      case 'cdata': {
        const s = streams.get(msg.id);
        if (s && s.socket) { try { s.socket.write(Buffer.from(msg.data, 'base64')); } catch {} }
        break;
      }
      case 'cend': {
        const s = streams.get(msg.id);
        if (s && s.socket) { try { s.socket.end(); } catch {} }
        break;
      }
      default:
        break;
    }
  };

  dc.onclose = () => {
    console.log('[host] mux fechado, limpando', streams.size, 'streams');
    // fecha tudo
    for (const [, s] of streams) { try { s.socket.destroy(); } catch {} }
    streams.clear();
  };

  dc.onerror = (e) => console.warn('[host] mux error:', e && e.message);
};

// proteção
process.on('uncaughtException', (e) => console.error('[host] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[host] unhandled', e));
