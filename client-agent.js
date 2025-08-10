// client-agent.js
// Expõe HTTP CONNECT (127.0.0.1:8080) e SOCKS5 (127.0.0.1:1080) e
// encaminha via DataChannels. Apenas o CLIENTE negocia.
const net   = require('net');
const dgram = require('dgram');
const http  = require('http');
const { pcFactory } = require('./lib/webrtc');

const ROOM   = process.env.ROOM   || 'demo1';
const TOKEN  = process.env.TOKEN  || 'lucas12345';
const SIGNAL = process.env.SIGNAL || 'wss://signal.loghub.shop/ws';

const ICE = [
  { urls: 'stun:turn.loghub.shop:3478' },
  { urls: 'turns:turn.loghub.shop:5349?transport=tcp', username: 'api', credential: 'senha-super-secreta' },
  { urls: 'turn:turn.loghub.shop:3478?transport=udp',  username: 'api', credential: 'senha-super-secreta' },
];

console.log('[client] START', { ROOM, SIGNAL, RELAY_ONLY: process.env.RELAY_ONLY === '1' });

const { pc } = pcFactory(ICE, SIGNAL, 'client', ROOM, 'lucas12345');

// Canal de controle criado uma única vez (garante m-line data no SDP)
const control = pc.createDataChannel('control', { ordered: true });
control.onopen  = () => console.log('[client] control: open');
control.onclose = () => console.log('[client] control: close');

// ---------- util: abrir DataChannel TCP ----------
function openTcpDC(host, port, timeoutMs = 15000) {
  return new Promise((res, rej) => {
    const dc = pc.createDataChannel(`tcp-${Date.now()}`, { ordered: true });
    let timer = setTimeout(() => { try { dc.close(); } catch {} ; rej(new Error('timeout-dc-open')); }, timeoutMs);
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      dc.send(Buffer.from(JSON.stringify({ type: 'tcp-connect', host, port, token: TOKEN })));
    };
    const first = (e) => {
      const b = Buffer.from(e.data);
      if (b.length === 1 && b[0] === 1) { clearTimeout(timer); dc.removeEventListener('message', first); res(dc); }
      else if (b.length === 1 && b[0] === 0) { clearTimeout(timer); try { dc.close(); } catch {} ; rej(new Error('dial-fail')); }
    };
    dc.onmessage = first;
    dc.onerror = (err) => { clearTimeout(timer); rej(err); };
  });
}

function openUdpAssocDC(timeoutMs = 15000) {
  return new Promise((res, rej) => {
    const dc = pc.createDataChannel(`udp-${Date.now()}`, { ordered: true });
    let timer = setTimeout(() => { try { dc.close(); } catch {} ; rej(new Error('timeout-udp-assoc')); }, timeoutMs);
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => { dc.send(Buffer.from(JSON.stringify({ type: 'udp-assoc', token: TOKEN }))); };
    const first = (e) => {
      const b = Buffer.from(e.data);
      if (b.length === 1 && b[0] === 1) { clearTimeout(timer); dc.removeEventListener('message', first); res(dc); }
      else if (b.length === 1 && b[0] === 0) { clearTimeout(timer); try { dc.close(); } catch {} ; rej(new Error('udp-assoc-fail')); }
    };
    dc.onmessage = first;
    dc.onerror = (err) => { clearTimeout(timer); rej(err); };
  });
}

// ---------- HTTP CONNECT local ----------
const httpProxy = http.createServer();
httpProxy.on('connect', async (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':'); const port = Number(portStr || 443);
  try {
    const dc = await openTcpDC(host, port, 15000);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) dc.send(head);
    clientSocket.on('data', (chunk) => { try { dc.send(chunk); } catch {} });
    clientSocket.on('end',  () => { try { dc.close(); } catch {} });
    clientSocket.on('error',() => { try { dc.close(); } catch {} });
    dc.onmessage = (e) => { try { clientSocket.write(Buffer.from(e.data)); } catch {} };
    dc.onclose   = () => { try { clientSocket.end(); } catch {} };
  } catch (e) {
    try { clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n'); } catch {}
    try { clientSocket.end(); } catch {}
  }
});
httpProxy.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
});
httpProxy.listen(8080, '127.0.0.1', () => console.log('[client] HTTP CONNECT em 127.0.0.1:8080'));

// ---------- SOCKS5 local ----------
const socksServer = net.createServer(async (cliSock) => {
  cliSock.once('data', async (hello) => {
    if (hello[0] !== 0x05) { cliSock.destroy(); return; }
    cliSock.write(Buffer.from([0x05, 0x00])); // NoAuth

    cliSock.once('data', async (req1) => {
      const ver = req1[0], cmd = req1[1], atyp = req1[3];
      if (ver !== 0x05 || (cmd !== 0x01 && cmd !== 0x03)) {
        cliSock.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0,0,0,0, 0,0])); return;
      }

      if (cmd === 0x01) {
        // CONNECT
        let host, port, p = 4;
        if (atyp === 0x01) { host = req1.slice(p, p+4).join('.'); p += 4; }
        else if (atyp === 0x03) { const len=req1[p]; p += 1; host = req1.slice(p, p+len).toString('utf8'); p += len; }
        else if (atyp === 0x04) { host = '['+req1.slice(p, p+16).toString('hex')+']'; p += 16; }
        port = (req1[p]<<8) | req1[p+1];

        try {
          const dc = await openTcpDC(host, port, 15000);
          cliSock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0]));
          cliSock.on('data', chunk => { try { dc.send(chunk); } catch {} });
          cliSock.on('end',  () => { try { dc.close(); } catch {} });
          cliSock.on('error',() => { try { dc.close(); } catch {} });
          dc.onmessage = (e) => { try { cliSock.write(Buffer.from(e.data)); } catch {} };
          dc.onclose   = () => { try { cliSock.end(); } catch {} };
        } catch {
          cliSock.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0,0,0,0, 0,0]));
        }

      } else if (cmd === 0x03) {
        // UDP ASSOC
        try {
          const dc = await openUdpAssocDC(15000);
          const udpLocal = dgram.createSocket('udp4');
          let clientAddr = null, clientPort = null;

          udpLocal.on('message', (msg, rinfo) => {
            clientAddr = rinfo.address; clientPort = rinfo.port;
            if (msg[2] !== 0x00) return; // sem fragmentação
            const atyp = msg[3];
            if (atyp === 0x01) {
              const host = msg.slice(4, 8).join('.');
              const port = (msg[8]<<8) | msg[9];
              const data = msg.slice(10);
              dc.send(Buffer.from(JSON.stringify({ rhost: host, rport: port, data: data.toString('base64') })));
            } else if (atyp === 0x03) {
              const len  = msg[4];
              const host = msg.slice(5, 5+len).toString('utf8');
              const port = (msg[5+len]<<8) | msg[6+len];
              const data = msg.slice(7+len);
              dc.send(Buffer.from(JSON.stringify({ rhost: host, rport: port, data: data.toString('base64') })));
            }
          });

          dc.onmessage = (e) => {
            try {
              const m = JSON.parse(Buffer.from(e.data).toString('utf8'));
              if (!clientAddr) return;
              const hostBuf = Buffer.from(m.rhost, 'utf8');
              const hdr = Buffer.from([0x00,0x00,0x00, 0x03, hostBuf.length, ...hostBuf]);
              const portBuf = Buffer.from([ (m.rport>>8)&0xff, m.rport&0xff ]);
              const dataBuf = Buffer.from(m.data, 'base64');
              const pkt = Buffer.concat([hdr, portBuf, dataBuf]);
              udpLocal.send(pkt, clientPort, clientAddr);
            } catch {}
          };

          udpLocal.bind(0, '127.0.0.1', () => {
            const addr = udpLocal.address();
            const rep = Buffer.from([0x05,0x00,0x00,0x01, 127,0,0,1, (addr.port>>8)&0xff, addr.port&0xff ]);
            cliSock.write(rep);
            cliSock.on('close', () => { try { udpLocal.close(); } catch {} ; try { dc.close(); } catch {} });
          });

        } catch {
          cliSock.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0,0,0,0, 0,0]));
        }
      }
    });
  });
});
socksServer.listen(1080, '127.0.0.1', () => console.log('[client] SOCKS5 em 127.0.0.1:1080'));

process.on('uncaughtException', (e) => console.error('[client] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[client] unhandled', e));
