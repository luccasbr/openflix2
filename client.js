// client.js — Proxy HTTP CONNECT (127.0.0.1:8080) sobre um único DataChannel "mux".
// Execução: ROOM=demo1 SIGNAL=wss://signal.loghub.shop/ws node client.js
const http = require('http');
const WebSocket = require('ws');
const wrtc = require('wrtc');

const ROOM   = process.env.ROOM   || 'demo1';
const SIGNAL = process.env.SIGNAL || 'wss://signal.loghub.shop/ws';
const RELAY  = process.env.RELAY_ONLY === '1'; // opcional p/ testar só via TURN

const ICE = {
  iceServers: [
    { urls: 'stun:turn.loghub.shop:3478' },
    { urls: 'turn:turn.loghub.shop:3478?transport=udp',  username: 'api', credential: 'senha-super-secreta' },
    { urls: 'turns:turn.loghub.shop:5349?transport=tcp', username: 'api', credential: 'senha-super-secreta' },
  ],
  iceTransportPolicy: RELAY ? 'relay' : 'all',
};

// Tipos de quadro
const T_OPEN  = 0x01;
const T_DATA  = 0x02;
const T_CLOSE = 0x03;
const T_ACK   = 0x04;

function u32(n){ const b=Buffer.alloc(4); b.writeUInt32BE(n>>>0,0); return b; }
function rU32(b,off){ return b.readUInt32BE(off); }

let ws, pc, mux, linkReady=false, nextId=1;
// id -> { socket, acked, timer }
const streams = new Map();

function makePC() {
  const pc = new wrtc.RTCPeerConnection(ICE);
  pc.oniceconnectionstatechange = () => console.log('[client] ICE:', pc.iceConnectionState);
  pc.onconnectionstatechange   = () => { 
    console.log('[client] PC :', pc.connectionState);
    linkReady = (pc.connectionState === 'connected');
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'signal', data: { candidate } }));
  };

  // único canal multiplexador
  mux = pc.createDataChannel('mux', { ordered: true });
  mux.binaryType = 'arraybuffer';

  mux.onopen = () => { console.log('[client] mux open'); };
  mux.onclose = () => {
    console.log('[client] mux closed');
    // derruba qualquer fluxo pendente
    for (const [id, st] of streams) { try{ st.socket.end(); }catch{} }
    streams.clear();
  };
  mux.onerror = () => {};

  mux.onmessage = (e) => {
    const msg = Buffer.from(e.data);
    const t = msg[0];
    const id = rU32(msg, 1);

    const st = streams.get(id);
    if (!st && t !== T_ACK) return;

    if (t === T_ACK) {
      const ok = !!msg[5];
      const st2 = streams.get(id);
      if (!st2) return;
      if (st2.timer) { clearTimeout(st2.timer); st2.timer=null; }
      if (ok) {
        st2.acked = true;
        try { st2.socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch {}
        if (st2.head && st2.head.length) mux.send(Buffer.concat([Buffer.from([T_DATA]), u32(id), st2.head]));
      } else {
        try { st2.socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
        try { st2.socket.end(); } catch {}
        streams.delete(id);
      }
      return;
    }

    if (t === T_DATA) {
      try { st.socket.write(msg.slice(5)); } catch {}
      return;
    }

    if (t === T_CLOSE) {
      try { st.socket.end(); } catch {}
      streams.delete(id);
      return;
    }
  };

  return pc;
}

async function offer() {
  if (pc.signalingState !== 'stable') return;
  const off = await pc.createOffer();
  await pc.setLocalDescription(off);
  ws.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));
}

async function waitConnected(ms=20000){
  const t0 = Date.now();
  while (!linkReady && Date.now()-t0 < ms) await new Promise(r=>setTimeout(r,50));
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
    if (m.type === 'peer-ready'){ offer().catch(()=>{}); return; }
    if (m.type !== 'signal') return;
    const d = m.data || {};
    try {
      if (d.sdp) await pc.setRemoteDescription(new wrtc.RTCSessionDescription(d.sdp));
      if (d.candidate) await pc.addIceCandidate(new wrtc.RTCIceCandidate(d.candidate));
    } catch (e) {
      console.error('[client] signaling err:', e.message);
    }
  });

  ws.on('close', () => process.exit(0));
  ws.on('error', (e) => console.error('[client] WS err:', e.message));
}

// ---------- Proxy HTTP CONNECT (127.0.0.1:8080) ----------
const httpProxy = http.createServer();
httpProxy.on('connect', async (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':'); const port = Number(portStr || 443);
  let id = (nextId = (nextId+1) >>> 0) || (nextId=1);

  try {
    await waitConnected(20000);
    if (!mux || mux.readyState !== 'open') throw new Error('mux not open');

    // registra stream
    const st = { socket: clientSocket, acked: false, head, timer: null };
    streams.set(id, st);

    // timeout de abertura
    st.timer = setTimeout(() => {
      if (!st.acked) {
        try { clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n'); } catch {}
        try { clientSocket.end(); } catch {}
        streams.delete(id);
        try { mux.send(Buffer.concat([Buffer.from([T_CLOSE]), u32(id)])); } catch {}
      }
    }, 20000);

    // envia OPEN
    const hdr = Buffer.from(JSON.stringify({ host, port }));
    mux.send(Buffer.concat([Buffer.from([T_OPEN]), u32(id), hdr]));

    // pipe cliente -> host
    clientSocket.on('data', (chunk) => {
      if (!streams.has(id)) return;
      try { mux.send(Buffer.concat([Buffer.from([T_DATA]), u32(id), chunk])); } catch {}
    });
    clientSocket.on('end',  () => {
      try { mux.send(Buffer.concat([Buffer.from([T_CLOSE]), u32(id)])); } catch {}
      streams.delete(id);
    });
    clientSocket.on('error', () => {
      try { mux.send(Buffer.concat([Buffer.from([T_CLOSE]), u32(id)])); } catch {}
      streams.delete(id);
    });

  } catch (e) {
    try { clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n'); } catch {}
    try { clientSocket.end(); } catch {}
    streams.delete(id);
  }
});

httpProxy.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
httpProxy.listen(8080, '127.0.0.1', () => console.log('[client] HTTP CONNECT em 127.0.0.1:8080'));

wireSignal();

// Evitar quedas
process.on('uncaughtException', (e) => console.error('[client] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[client] unhandled', e));
