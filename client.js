// client.js — expõe HTTP CONNECT em 127.0.0.1:8080 -> WebRTC -> Host.
// Execução: ROOM=demo1 SIGNAL=wss://signal.loghub.shop/ws node client.js
const http = require('http');
const WebSocket = require('ws');
const wrtc = require('wrtc');

const ROOM   = process.env.ROOM   || 'demo1';
const SIGNAL = process.env.SIGNAL || 'wss://signal.loghub.shop/ws';
const RELAY  = process.env.RELAY_ONLY === '1'; // opcional, para testar só via TURN

const ICE = {
  iceServers: [
    { urls: 'stun:turn.loghub.shop:3478' },
    { urls: 'turn:turn.loghub.shop:3478?transport=udp',  username: 'api', credential: 'senha-super-secreta' },
    { urls: 'turns:turn.loghub.shop:5349?transport=tcp', username: 'api', credential: 'senha-super-secreta' },
  ],
  iceTransportPolicy: RELAY ? 'relay' : 'all',
};

let ws, pc, ctrl;
let linkReady = false;

function makePC() {
  const pc = new wrtc.RTCPeerConnection(ICE);

  pc.oniceconnectionstatechange = () => console.log('[client] ICE:', pc.iceConnectionState);
  pc.onconnectionstatechange   = () => {
    console.log('[client] PC :', pc.connectionState);
    linkReady = (pc.connectionState === 'connected');
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'signal', data: { candidate } }));
    }
  };

  // Canal de controle para manter a sessão quente
  ctrl = pc.createDataChannel('ctrl', { ordered: true });
  ctrl.onopen = () => {
    console.log('[client] ctrl open');
    ctrl._ka = setInterval(() => { try { ctrl.send('ping'); } catch {} }, 10000);
  };
  ctrl.onclose = () => { if (ctrl && ctrl._ka) clearInterval(ctrl._ka); };

  return pc;
}

async function offer() {
  if (pc.signalingState !== 'stable') return;
  const off = await pc.createOffer();
  await pc.setLocalDescription(off);
  ws.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));
}

async function waitConnected(ms = 20000) {
  const t0 = Date.now();
  while (!linkReady && Date.now() - t0 < ms) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (!linkReady) throw new Error('webrtc not connected');
}

function wireSignal() {
  ws = new WebSocket(SIGNAL);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'join', role: 'client', room: ROOM }));
    pc = makePC();
    offer().catch(()=>{});
  });

  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'peer-ready') {
      // Host conectou depois? re-oferece (se não deu certo ainda)
      offer().catch(()=>{});
      return;
    }
    if (m.type !== 'signal') return;

    const data = m.data || {};
    try {
      if (data.sdp) {
        // se recebemos algo de outro ciclo, zera e reoferece
        if (pc.signalingState !== 'stable' && data.sdp.type === 'offer') {
          try { pc.close(); } catch {}
          pc = makePC();
        }
        await pc.setRemoteDescription(new wrtc.RTCSessionDescription(data.sdp));
        // (client só envia OFFER neste desenho; não precisa send answer)
      }
      if (data.candidate) await pc.addIceCandidate(new wrtc.RTCIceCandidate(data.candidate));
    } catch (e) {
      console.error('[client] sinalização erro:', e.message);
    }
  });

  ws.on('close', () => process.exit(0));
  ws.on('error', (e) => console.error('[client] WS erro:', e.message));
}

// ---------- HTTP CONNECT local ----------
const httpProxy = http.createServer();
httpProxy.on('connect', async (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':'); const port = Number(portStr || 443);

  try {
    await waitConnected(20000);

    // Um DataChannel por conexão TCP
    const dc = pc.createDataChannel(`tcp-${Date.now()}`, { ordered: true });
    let acked = false;
    let timer = setTimeout(() => {
      if (!acked) { try { dc.close(); } catch {}; try { clientSocket.end(); } catch {} }
    }, 20000);

    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      dc.send(Buffer.from(JSON.stringify({ type: 'tcp-connect', host, port })));
    };
    dc.onmessage = (e) => {
      const b = Buffer.from(e.data);
      if (!acked) {
        if (b.length === 1 && b[0] === 1) {
          acked = true; clearTimeout(timer);
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length) dc.send(head);
          return;
        }
        if (b.length === 1 && b[0] === 0) {
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
    dc.onclose = () => { try { clientSocket.end(); } catch {} };
    dc.onerror = () => { try { clientSocket.end(); } catch {} };

    clientSocket.on('data',  (chunk) => { try { dc.send(chunk); } catch {} });
    clientSocket.on('end',   () => { try { dc.close(); } catch {} });
    clientSocket.on('error', () => { try { dc.close(); } catch {} });

  } catch (e) {
    try { clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n'); } catch {}
    try { clientSocket.end(); } catch {}
  }
});
httpProxy.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
httpProxy.listen(8080, '127.0.0.1', () => console.log('[client] HTTP CONNECT em 127.0.0.1:8080'));

wireSignal();

// Evitar quedas
process.on('uncaughtException', (e) => console.error('[client] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[client] unhandled', e));
