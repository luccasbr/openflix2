// client-agent.js
// Roda no A (Cliente). Expõe HTTP CONNECT (127.0.0.1:8080) e SOCKS5 (127.0.0.1:1080)
// e manda cada conexão por um DataChannel até o Host, com buffer anti-race.
// Env vars: ROOM, TOKEN, SIGNAL, SIGNAL_TOKEN, RELAY_ONLY
const net   = require('net');
const dgram = require('dgram');
const http  = require('http');
const { pcFactory } = require('./lib/webrtc');

const ROOM   = process.env.ROOM   || 'demo1';
const TOKEN  = process.env.TOKEN  || ''; // enviado no cabeçalho do canal
const SIGNAL = process.env.SIGNAL || 'wss://signal.loghub.shop/ws';

const ICE = [
  { urls: 'stun:turn.loghub.shop:3478' },
  { urls: 'turns:turn.loghub.shop:5349?transport=tcp', username: 'api', credential: 'senha-super-secreta' },
  { urls: 'turn:turn.loghub.shop:3478?transport=udp',  username: 'api', credential: 'senha-super-secreta' },
];

console.log('[client] START', { ROOM, SIGNAL, RELAY_ONLY: process.env.RELAY_ONLY === '1' });

const { pc, ensureOffer } = pcFactory(ICE, SIGNAL, 'client', ROOM, process.env.SIGNAL_TOKEN || null);

// ---- abrir DC TCP com buffer anti-race; cria DC ANTES de ofertar p/ incluir SCTP no SDP ----
function openTcpDC(host, port, timeoutMs = 15000) {
  return new Promise(async (res, rej) => {
    // cria o canal primeiro para disparar 'negotiationneeded' (se for a primeira vez)
    const dc = pc.createDataChannel(`tcp-${Date.now()}`, { ordered: true });
    let timer = setTimeout(() => { try { dc.close(); } catch {} ; rej(new Error('timeout-dc-open')); }, timeoutMs);
    dc.binaryType = 'arraybuffer';

    // infra de buffering (bytes que chegam logo após o ACK)
    dc._pending = [];
    dc._sink = null;

    // 1ª mensagem do host: 0x01 OK / 0x00 FAIL
    const onFirst = (e) => {
      const b = Buffer.from(e.data);
      if (b.length === 1 && b[0] === 1) {
        // ACK -> instala sink e volta
        dc.onmessage = (ev) => {
          const data = Buffer.from(ev.data);
          if (dc._sink) dc._sink(data); else dc._pending.push(data);
        };
        clearTimeout(timer);
        res(dc);
      } else if (b.length === 1 && b[0] === 0) {
        clearTimeout(timer);
        try { dc.close(); } catch {}
        rej(new Error('dial-fail'));
      } else {
        // dados chegaram junto do ACK (raro) -> bufferiza
        dc._pending.push(b);
      }
    };

    dc.onopen = () => {
      dc.onmessage = onFirst;
      dc.send(Buffer.from(JSON.stringify({ type: 'tcp-connect', host, port, token: TOKEN })));
    };
    dc.onerror = (err) => { clearTimeout(timer); rej(err); };

    // Se ainda não temos SCTP/remote, dispara oferta agora
    try { await ensureOffer(); } catch (e) { /* pode já haver negociação em curso via onnegotiationneeded */ }
  });
}

function openUdpAssocDC(timeoutMs = 15000) {
  return new Promise(async (res, rej) => {
    const dc = pc.createDataChannel(`udp-${Date.now()}`, { ordered: true });
    let timer = setTimeout(() => { try { dc.close(); } catch {} ; rej(new Error('timeout-udp-assoc')); }, timeoutMs);
    dc.binaryType = 'arraybuffer';

    const onFirst = (e) => {
      const b = Buffer.from(e.data);
      if (b.length === 1 && b[0] === 1) {
        clearTimeout(timer);
        res(dc);
      } else {
        clearTimeout(timer);
        try { dc.close(); } catch {}
        rej(new Error('udp-assoc-fail'));
      }
    };

    dc.onopen = () => {
      dc.onmessage = onFirst;
      dc.send(Buffer.from(JSON.stringify({ type: 'udp-assoc', token: TOKEN })));
    };
    dc.onerror = (err) => { clearTimeout(timer); rej(err); };

    try { await ensureOffer(); } catch (e) {}
  });
}

// ---------- HTTP CONNECT local ----------
const httpProxy = http.createServer();
httpProxy.on('connect', async (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':'); const port = Number(portStr || 443);
  try {
    const dc = await openTcpDC(host, port, 15000);

    // Instala sink E drena o buffer imediatamente
    dc._sink = (data) => { try { clientSocket.write(data); } catch {} };
    if (dc._pending && dc._pending.length) {
      for (const chunk of dc._pending) { try { clientSocket.write(chunk); } catch {} }
      dc._pending.length = 0;
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) dc.send(head);

    // Cliente -> Host
    clientSocket.on('data', chunk => { try { dc.send(chunk); } catch {} });
    clientSocket.on('end',  () => { try { dc.close(); } catch {} });
    clientSocket.on('error',() => { try { dc.close(); } catch {} });

    // Se o DC fechar, fechamos o socket
    dc.onclose = () => { try { clientSocket.end(); } catch {} };

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
    cliSock.write(Buffer.from([0x05, 0x00])); // NoAuth (MVP)

    cliSock.once('data', async (req1) => {
      const ver = req1[0], cmd = req1[1], atyp = req1[3];
      if (ver !== 0x05 || (cmd !== 0x01 && cmd !== 0x03)) {
        cliSock.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0,0,0,0, 0,0]));
        return;
      }

      if (cmd === 0x01) {
        // CONNECT (TCP)
        let host, port, p = 4;
        if (atyp === 0x01) { host = req1.slice(p, p+4).join('.'); p += 4; }
        else if (atyp === 0x03) { const len=req1[p]; p += 1; host = req1.slice(p, p+len).toString('utf8'); p += len; }
        else if (atyp === 0x04) { host = '['+req1.slice(p, p+16).toString('hex')+']'; p += 16; }
        port = (req1[p]<<8) | req1[p+1];

        try {
          const dc = await openTcpDC(host, port, 15000);

          // Sink e dreno de pendentes antes de liberar tráfego
          dc._sink = (data) => { try { cliSock.write(data); } catch {} };
          if (dc._pending && dc._pending.length) {
            for (const chunk of dc._pending) { try { cliSock.write(chunk); } catch {} }
            dc._pending.length = 0;
          }

          // success
          cliSock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0]));
          cliSock.on('data', chunk => { try { dc.send(chunk); } catch {} });
          cliSock.on('end',  () => { try { dc.close(); } catch {} });
          cliSock.on('error',() => { try { dc.close(); } catch {} });
          dc.onclose = () => { try { cliSock.end(); } catch {} };

        } catch (e) {
          cliSock.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0,0,0,0, 0,0])); // general failure
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

        } catch (e) {
          cliSock.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0,0,0,0, 0,0]));
        }
      }
    });
  });
});
socksServer.listen(1080, '127.0.0.1', () => console.log('[client] SOCKS5 em 127.0.0.1:1080'));

// proteção
process.on('uncaughtException', (e) => console.error('[client] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[client] unhandled', e));
