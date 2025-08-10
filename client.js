// client.js – proxy HTTP CONNECT local -> DataChannels -> Host.
// Execução: ROOM=demo1 SIGNAL=wss://signal.loghub.shop/ws node client.js

const http = require('http');
const WebSocket = require('ws');
const wrtc = require('wrtc');

const ROOM   = process.env.ROOM   || 'demo1';
const SIGNAL = process.env.SIGNAL || 'wss://signal.loghub.shop/ws';
const RELAY  = process.env.RELAY_ONLY === '1';

const ICE = {
  iceServers: [
    { urls: 'stun:turn.loghub.shop:3478' },
    { urls: 'turn:turn.loghub.shop:3478?transport=udp',  username: 'api', credential: 'senha-super-secreta' },
    { urls: 'turns:turn.loghub.shop:5349?transport=tcp', username: 'api', credential: 'senha-super-secreta' },
  ],
  iceTransportPolicy: RELAY ? 'relay' : 'all',
};

let ws, pc, ctrl, linkReady = false;

function newPeerConnection() {
  const pc = new wrtc.RTCPeerConnection(ICE);

  pc.oniceconnectionstatechange = () => console.log('[client] ICE:', pc.iceConnectionState);
  pc.onconnectionstatechange   = () => {
    console.log('[client] PC :', pc.connectionState);
    linkReady = (pc.connectionState === 'connected');
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      // reconectar de forma simples
      setTimeout(() => { try { pc.close(); } catch {}; setupAndOffer(); }, 300);
    }
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'signal', data: { candidate } }));
    }
  };

  // Cria canal de controle para manter a sessão viva
  ctrl = pc.createDataChannel('ctrl', { ordered: true });
  ctrl.onopen = () => {
    console.log('[client] ctrl open');
    // keep-alive a cada 10s
    ctrl._ka = setInterval(() => { try { ctrl.send('ping'); } catch {} }, 10000);
  };
  ctrl.onclose = () => { if (ctrl && ctrl._ka) clearInterval(ctrl._ka); };

  return pc;
}

async function offerIfStable() {
  if (pc.signalingState !== 'stable') return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));
}

async function waitConnected(timeoutMs = 15000) {
  if (linkReady) return;
  const t0 = Date.now();
  while (!linkReady && Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (!linkReady) throw new Error('webrtc not connected');
}

function setupAndOffer() {
  pc = newPeerConnection();
  offerIfStable().catch(e => console.error('[client] offer err', e.message));
}

function wireSignaling() {
  ws = new WebSocket(SIGNAL);
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'join', role: 'client', room: ROOM }));
    setupAndOffer(); // oferece já; se o host ainda não entrou, faremos outra offer quando ele entrar
  });

  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'peer-ready') {
      // host entrou depois — ofereça de novo
      offerIfStable().catch(()=>{});
      return;
    }
    if (m.type !== 'signal') return;

    const data = m.data || {};
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(new wrtc.RTCSessionDescription(data.sdp));
        // depois de ANSWER, aguardamos ICE completar
      }
      if (data.candidate) {
        await pc.addIceCandidate(new wrtc.RTCIceCandidate(data.candidate));
      }
    } catch (e) {
      console.error('[client] sinalização erro:', e.message);
    }
  });

  ws.on('close', () => process.exit(0));
  ws.on('error', (e) => console.error('[client] WS erro:', e.message));
}

// ------- Proxy HTTP CONNECT (127.0.0.1:8080) -------
const httpProxy = http.createServer();
httpProxy.on('connect', async (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':'); const port = Number(portStr || 443);

  // abre um DC novo por conexão
  try {
    await waitConnected(20000);
    const dc = pc.createDataChannel(`tcp-${Date.now()}`, { ordered: true });
    let acked = false;
    let timer = setTimeout(() => { if (!acked) { try { dc.close(); } catch {} ; try { clientSocket.end(); } catch {} } }, 20000);

    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      const hdr = Buffer.from(JSON.stringify({ type: 'tcp-connect', host, port }));
      dc.send(hdr);
    };

    dc.onmessage = (e) => {
      const b = Buffer.from(e.data);
      if (!acked) {
        if (b.length === 1 && b[0] === 1) {
          acked = true; clearTimeout(timer);
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length) dc.send(head);
          return;
        } else if (b.length === 1 && b[0] === 0) {
          clearTimeout(timer);
          try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
          try { clientSocket.end(); } catch {}
          try { dc.close(); } catch {}
          return;
        }
      } else {
        try { clientSocket.write(b); } catch {}
      }
    };

    clientSocket.on('data',  (chunk) => { try { dc.send(chunk); } catch {} });
    clientSocket.on('end',   () => { try { dc.close(); } catch {} });
    clientSocket.on('error', () => { try { dc.close(); } catch {} });
    dc.onclose   = () => { try { clientSocket.end(); } catch {} };
    dc.onerror   = () => { try { clientSocket.end(); } catch {} };

  } catch (e) {
    try { clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n'); } catch {}
    try { clientSocket.end(); } catch {}
  }
});
httpProxy.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
httpProxy.listen(8080, '127.0.0.1', () => console.log('[client] HTTP CONNECT em 127.0.0.1:8080'));

wireSignaling();

// Evitar quedas
process.on('uncaughtException', (e) => console.error('[client] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[client] unhandled', e));
