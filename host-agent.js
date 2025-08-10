// host-agent.js
// Roda na casa do B (Host). Recebe DataChannels e disca TCP/UDP pra internet local.
// Env vars: ROOM, TOKEN, SIGNAL, SIGNAL_TOKEN, RELAY_ONLY
const net   = require('net');
const dgram = require('dgram');
const { pcFactory } = require('./lib/webrtc');

const ROOM   = process.env.ROOM   || 'demo1';
const TOKEN  = process.env.TOKEN  || ''; // token que o Client deve enviar no cabeçalho do canal
const SIGNAL = process.env.SIGNAL || 'wss://signal.loghub.shop/ws';

const ICE = [
  { urls: 'stun:turn.loghub.shop:3478' },
  { urls: 'turns:turn.loghub.shop:5349?transport=tcp', username: 'api', credential: 'senha-super-secreta' },
  { urls: 'turn:turn.loghub.shop:3478?transport=udp',  username: 'api', credential: 'senha-super-secreta' },
];

console.log('[host] START', { ROOM, SIGNAL, RELAY_ONLY: process.env.RELAY_ONLY === '1' });

const { pc } = pcFactory(ICE, SIGNAL, 'host', ROOM, process.env.SIGNAL_TOKEN || null);

pc.ondatachannel = (ev) => {
  const dc = ev.channel;
  dc.binaryType = 'arraybuffer';

  let mode = 'header';
  let tcp = null;
  let udpSock = null;

  const closeAll = () => {
    try { dc.close(); } catch {}
    try { tcp && tcp.destroy(); } catch {}
    try { udpSock && udpSock.close(); } catch {}
  };

  dc.onmessage = (e) => {
    const buf = Buffer.from(e.data);

    if (mode === 'header') {
      try {
        const h = JSON.parse(buf.toString('utf8'));
        if (TOKEN && h.token !== TOKEN) {
          console.warn('[host] token inválido');
          try { dc.send(Buffer.from([0])); } catch {}
          return closeAll();
        }

        if (h.type === 'tcp-connect') {
          console.log('[host] tcp-connect =>', h.host, h.port);
          tcp = net.connect({ host: h.host, port: Number(h.port) }, () => {
            try { dc.send(Buffer.from([1])); } catch {}
          });
          tcp.setTimeout(15000, () => {
            console.warn('[host] tcp timeout');
            try { dc.send(Buffer.from([0])); } catch {}
            return closeAll();
          });
          tcp.on('data', chunk => { try { dc.send(chunk); } catch {} });
          tcp.on('error', err => { console.warn('[host] tcp error:', err.message); try { dc.send(Buffer.from([0])); } catch {} ; closeAll(); });
          tcp.on('close', () => { try { dc.close(); } catch {} });
          mode = 'tcp';

        } else if (h.type === 'udp-assoc') {
          console.log('[host] udp-assoc');
          udpSock = dgram.createSocket('udp4');
          udpSock.on('message', (msg, rinfo) => {
            const payload = JSON.stringify({ rhost: rinfo.address, rport: rinfo.port, data: msg.toString('base64') });
            try { dc.send(Buffer.from(payload)); } catch {}
          });
          try { dc.send(Buffer.from([1])); } catch {}
          mode = 'udp';

        } else {
          console.warn('[host] header desconhecido');
          try { dc.send(Buffer.from([0])); } catch {}
          return closeAll();
        }
      } catch {
        console.warn('[host] header inválido');
        try { dc.send(Buffer.from([0])); } catch {}
        return closeAll();
      }
      return;
    }

    if (mode === 'tcp' && tcp) {
      tcp.write(buf);
      return;
    }

    if (mode === 'udp' && udpSock) {
      try {
        const m = JSON.parse(buf.toString('utf8'));
        const data = Buffer.from(m.data, 'base64');
        udpSock.send(data, Number(m.rport), m.rhost);
      } catch {}
    }
  };

  dc.onclose = closeAll;
  dc.onerror = (e) => { console.warn('[host] dc error:', e && e.message); closeAll(); };
};

// proteção
process.on('uncaughtException', (e) => console.error('[host] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[host] unhandled', e));
