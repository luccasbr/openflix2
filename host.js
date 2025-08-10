// host.js — saída residencial. Recebe um único DataChannel "mux" e multiplexa N conexões TCP.
// Execução: ROOM=demo1 SIGNAL=wss://signal.loghub.shop/ws node host.js
const net = require('net');
const WebSocket = require('ws');
const wrtc = require('wrtc');

const ROOM   = process.env.ROOM   || 'demo1';
const SIGNAL = process.env.SIGNAL || 'wss://signal.loghub.shop/ws';

// Ajuste conforme seu coturn:
const ICE = {
  iceServers: [
    { urls: 'stun:turn.loghub.shop:3478' },
    { urls: 'turn:turn.loghub.shop:3478?transport=udp',  username: 'api', credential: 'senha-super-secreta' },
    { urls: 'turns:turn.loghub.shop:5349?transport=tcp', username: 'api', credential: 'senha-super-secreta' },
  ],
};

let ws, pc, mux;

// Tipos de quadro (1 byte)
const T_OPEN  = 0x01; // client -> host: [type][id:4][json utf8]
const T_DATA  = 0x02; // client <-> host: [type][id:4][payload]
const T_CLOSE = 0x03; // client -> host: [type][id:4]
const T_ACK   = 0x04; // host -> client: [type][id:4][status:1]  (1 ok, 0 fail)

function u32(n){ const b=Buffer.alloc(4); b.writeUInt32BE(n>>>0,0); return b; }
function rU32(b,off){ return b.readUInt32BE(off); }

function makePC() {
  const pc = new wrtc.RTCPeerConnection(ICE);
  pc.oniceconnectionstatechange = () => console.log('[host] ICE:', pc.iceConnectionState);
  pc.onconnectionstatechange   = () => console.log('[host] PC :', pc.connectionState);
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'signal', data: { candidate } }));
  };

  pc.ondatachannel = (ev) => {
    const dc = ev.channel;
    dc.binaryType = 'arraybuffer';
    if (dc.label !== 'mux') { dc.close(); return; }
    console.log('[host] mux open');
    mux = dc;

    // id -> socket
    const conns = new Map();

    const sendAck = (id, ok) => { try { mux.send(Buffer.concat([Buffer.from([T_ACK]), u32(id), Buffer.from([ok?1:0]) ])); } catch {} };
    const sendData = (id, payload) => { try { mux.send(Buffer.concat([Buffer.from([T_DATA]), u32(id), payload])); } catch {} };

    mux.onmessage = (e) => {
      const msg = Buffer.from(e.data);
      const t = msg[0];
      const id = rU32(msg, 1);

      if (t === T_OPEN) {
        // payload é JSON utf8 {host, port}
        try {
          const h = JSON.parse(msg.slice(5).toString('utf8'));
          const s = net.connect({ host: h.host, port: Number(h.port) }, () => sendAck(id, true));
          s.setTimeout(20000, () => { sendAck(id, false); try{s.destroy();}catch{}; conns.delete(id); });
          s.on('data',  (chunk) => sendData(id, chunk));
          s.on('error', () => { sendAck(id, false); try{s.destroy();}catch{}; conns.delete(id); });
          s.on('close', () => { conns.delete(id); /* client decide fechar lado dele */ });
          conns.set(id, s);
        } catch {
          sendAck(id, false);
        }
        return;
      }

      if (t === T_DATA) {
        const s = conns.get(id);
        if (s) s.write(msg.slice(5));
        return;
      }

      if (t === T_CLOSE) {
        const s = conns.get(id);
        if (s) { try{s.destroy();}catch{}; conns.delete(id); }
        return;
      }
    };

    mux.onclose = () => { 
      console.log('[host] mux closed'); 
      for (const s of conns.values()) { try{s.destroy();}catch{} }
      conns.clear();
    };
    mux.onerror = () => { };
  };

  return pc;
}

function start() {
  console.log('[host] START', { ROOM, SIGNAL });
  ws = new WebSocket(SIGNAL);
  pc = makePC();

  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', role: 'host', room: ROOM })));

  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type !== 'signal') return;
    const d = m.data || {};
    try {
      if (d.sdp) {
        // se vier OFFER enquanto não está estável, recria PC (robusto)
        if (d.sdp.type === 'offer' && pc.signalingState !== 'stable') { try{pc.close();}catch{}; pc = makePC(); }
        await pc.setRemoteDescription(new wrtc.RTCSessionDescription(d.sdp));
        if (d.sdp.type === 'offer') {
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          ws.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));
        }
      }
      if (d.candidate) await pc.addIceCandidate(new wrtc.RTCIceCandidate(d.candidate));
    } catch (e) {
      console.error('[host] signaling err:', e.message);
    }
  });

  ws.on('close', () => process.exit(0));
  ws.on('error', (e) => console.error('[host] WS err:', e.message));
}

start();
