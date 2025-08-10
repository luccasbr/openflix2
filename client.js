// client.js — expõe HTTP CONNECT e (opcional) SOCKS5 locais e usa 1 PeerConnection persistente.
// Execução: ROOM=demo1 SIGNAL=wss://signal.loghub.shop/ws node client.js
const http = require('http');
const net = require('net');
const WebSocket = require('ws');
const wrtc = require('wrtc');

const ROOM   = process.env.ROOM   || 'demo1';
const SIGNAL = process.env.SIGNAL || 'wss://signal.loghub.shop/ws';
const RELAY  = process.env.RELAY_ONLY === '1'; // se quiser forçar TURN

// Ajuste seus ICE servers
const ICE = {
  iceServers: [
    { urls: 'stun:turn.loghub.shop:3478' },
    { urls: 'turn:turn.loghub.shop:3478?transport=udp' },
    { urls: 'turns:turn.loghub.shop:5349?transport=tcp' },
  ],
  iceTransportPolicy: RELAY ? 'relay' : 'all',
};

let pc;
let ws;
let linkReady = false;

function resetPC() {
  if (pc) { try { pc.close(); } catch {} }
  pc = new wrtc.RTCPeerConnection(ICE);
  pc.oniceconnectionstatechange = () => console.log('[client] ICE:', pc.iceConnectionState);
  pc.onconnectionstatechange   = () => {
    console.log('[client] PC :', pc.connectionState);
    linkReady = (pc.connectionState === 'connected');
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) ws && ws.send(JSON.stringify({ type: 'signal', data: { candidate } }));
  };
}

async function ensureLinked() {
  if (linkReady) return;
  if (!ws || ws.readyState !== 1) throw new Error('signaling not ready');
  if (pc.signalingState !== 'stable') return; // já ofereceu; aguarde

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));
}

async function waitConnected(timeoutMs = 15000) {
  if (linkReady) return;
  await ensureLinked();
  const t0 = Date.now();
  while (!linkReady && Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (!linkReady) throw new Error('webrtc not connected');
}

function makeTcpDC(host, port, timeoutMs = 15000) {
  return new Promise(async (resolve, reject) => {
    try { await waitConnected(timeoutMs); } catch (e) { return reject(e); }

    const dc = pc.createDataChannel(`tcp-${Date.now()}`, { ordered: true });
    let timer = setTimeout(() => { try { dc.close(); } catch {}; reject(new Error('dc-timeout')); }, timeoutMs);

    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      const hdr = Buffer.from(JSON.stringify({ type: 'tcp-connect', host, port }));
      dc.send(hdr);
    };
    dc.onmessage = (e) => {
      const b = Buffer.from(e.data);
      if (b.length === 1 && b[0] === 1) { clearTimeout(timer); dc.onmessage = null; return resolve(dc); } // ACK
      if (b.length === 1 && b[0] === 0) { clearTimeout(timer); try { dc.close(); } catch {}; return reject(new Error('dial-fail')); }
      // Qualquer outro payload antes de ACK é inesperado; ignore.
    };
    dc.onerror = (err) => { clearTimeout(timer); reject(err); };
  });
}

function wireSignaling() {
  ws = new WebSocket(SIGNAL);
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'join', role: 'client', room: ROOM }));
    resetPC(); // cria o PC e se prepara para oferecer
  });

  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'peer-ready') {
      // Host entrou depois — faça a offer
      try { await ensureLinked(); } catch (e) { console.error('[client] ensureLinked:', e.message); }
    }
    if (m.type === 'signal') {
      try {
        const data = m.data || {};
        if (data.sdp) {
          await pc.setRemoteDescription(new wrtc.RTCSessionDescription(data.sdp));
          // Se recebemos ANSWER, beleza; se recebêssemos OFFER (improvável do lado client), criaríamos ANSWER — mas nosso servidor só envia offer->host.
        }
        if (data.candidate) {
          await pc.addIceCandidate(new wrtc.RTCIceCandidate(data.candidate));
        }
      } catch (e) {
        console.error('[client] sinalização erro:', e.message);
      }
    }
  });

  ws.on('close', () => process.exit(0));
  ws.on('error', (e) => console.error('[client] WS erro:', e.message));
}

// ---------- HTTP CONNECT local (HTTPS) ----------
const httpProxy = http.createServer();
httpProxy.on('connect', async (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':'); const port = Number(portStr || 443);
  try {
    const dc = await makeTcpDC(host, port, 20000);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) dc.send(head);

    clientSocket.on('data',  (chunk) => { try { dc.send(chunk); } catch {} });
    clientSocket.on('end',   () => { try { dc.close(); } catch {} });
    clientSocket.on('error', () => { try { dc.close(); } catch {} });

    dc.onmessage = (e) => { try { clientSocket.write(Buffer.from(e.data)); } catch {} };
    dc.onclose   = () => { try { clientSocket.end(); } catch {} };
  } catch (e) {
    try { clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n'); } catch {}
    try { clientSocket.end(); } catch {}
  }
});
httpProxy.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
httpProxy.listen(8080, '127.0.0.1', () => console.log('[client] HTTP CONNECT em 127.0.0.1:8080'));

// ---------- (Opcional) SOCKS5 local para DNS remoto ----------
const socksServer = net.createServer((cliSock) => {
  cliSock.once('data', async (hello) => {
    if (hello[0] !== 0x05) { cliSock.destroy(); return; }              // VER=5
    cliSock.write(Buffer.from([0x05, 0x00]));                          // METHOD: no auth

    cliSock.once('data', async (req1) => {
      const ver=req1[0], cmd=req1[1], atyp=req1[3];
      if (ver!==0x05 || cmd!==0x01) { // CONNECT only (sem UDP no simplificado)
        cliSock.end(Buffer.from([0x05,0x07,0x00,0x01,0,0,0,0,0,0]));
        return;
      }

      let host, port, p=4;
      if (atyp===0x01){ host=req1.slice(p,p+4).join('.'); p+=4; }
      else if (atyp===0x03){ const len=req1[p]; p+=1; host=req1.slice(p,p+len).toString('utf8'); p+=len; }
      else if (atyp===0x04){ host='['+req1.slice(p,p+16).toString('hex')+']'; p+=16; }
      port = (req1[p]<<8) | req1[p+1];

      try {
        const dc = await makeTcpDC(host, port, 20000);
        cliSock.write(Buffer.from([0x05,0x00,0x00,0x01,0,0,0,0,0,0])); // success
        cliSock.on('data',  (chunk)=>{ try{ dc.send(chunk); }catch{} });
        cliSock.on('end',   ()=>{ try{ dc.close(); }catch{} });
        cliSock.on('error', ()=>{ try{ dc.close(); }catch{} });
        dc.onmessage = (e)=>{ try{ cliSock.write(Buffer.from(e.data)); }catch{} };
        dc.onclose   = ()=>{ try{ cliSock.end(); }catch{} };
      } catch {
        cliSock.end(Buffer.from([0x05,0x01,0x00,0x01,0,0,0,0,0,0]));   // general failure
      }
    });
  });
});
socksServer.listen(1080, '127.0.0.1', () => console.log('[client] SOCKS5 em 127.0.0.1:1080'));

wireSignaling();

// Evitar derrubar o processo
process.on('uncaughtException', (e) => console.error('[client] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[client] unhandled', e));
