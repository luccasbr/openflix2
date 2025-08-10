// host.js — recebe DataChannels e disca TCP via internet do Host.
// Execução: ROOM=demo1 SIGNAL=wss://signal.loghub.shop/ws node host.js
const net = require('net');
const WebSocket = require('ws');
const wrtc = require('wrtc');

const ROOM   = process.env.ROOM   || 'demo1';
const SIGNAL = process.env.SIGNAL || 'wss://signal.loghub.shop/ws';

// Ajuste seus ICE servers (sem auth p/ simplificar; use os seus)
const ICE = {
  iceServers: [
    { urls: 'stun:turn.loghub.shop:3478' },
    { urls: 'turn:turn.loghub.shop:3478?transport=udp' },
    { urls: 'turns:turn.loghub.shop:5349?transport=tcp' },
  ],
};

function makePC(ws) {
  const pc = new wrtc.RTCPeerConnection(ICE);

  pc.oniceconnectionstatechange = () => console.log('[host] ICE:', pc.iceConnectionState);
  pc.onconnectionstatechange   = () => console.log('[host] PC :', pc.connectionState);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) ws.send(JSON.stringify({ type: 'signal', data: { candidate } }));
  };

  pc.ondatachannel = (ev) => {
    const dc = ev.channel;
    dc.binaryType = 'arraybuffer';

    let stage = 'header';
    let tcp = null;

    const cleanup = () => { try { dc.close(); } catch {} try { tcp && tcp.destroy(); } catch {} };

    dc.onmessage = (e) => {
      const buf = Buffer.from(e.data);
      if (stage === 'header') {
        try {
          const h = JSON.parse(buf.toString('utf8'));
          if (h.type !== 'tcp-connect') throw new Error('bad header');
          console.log('[host] tcp-connect =>', h.host, h.port);

          tcp = net.connect({ host: h.host, port: Number(h.port) }, () => {
            try { dc.send(Buffer.from([1])); } catch {}
          });
          tcp.setTimeout(20000, () => { try { dc.send(Buffer.from([0])); } catch {}; cleanup(); });
          tcp.on('data',   (chunk) => { try { dc.send(chunk); } catch {} });
          tcp.on('error',  () => { try { dc.send(Buffer.from([0])); } catch {}; cleanup(); });
          tcp.on('close',  () => cleanup());

          stage = 'pipe';
        } catch {
          try { dc.send(Buffer.from([0])); } catch {}
          cleanup();
        }
        return;
      }

      if (stage === 'pipe' && tcp) {
        tcp.write(buf);
      }
    };

    dc.onclose = cleanup;
    dc.onerror = () => cleanup;
  };

  return pc;
}

function main() {
  console.log('[host] START', { ROOM, SIGNAL });
  const ws = new WebSocket(SIGNAL);

  let pc = makePC(ws);

  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', role: 'host', room: ROOM })));
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type !== 'signal') return;

    try {
      const data = m.data || {};
      if (data.sdp) {
        await pc.setRemoteDescription(new wrtc.RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          ws.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));
        }
      }
      if (data.candidate) {
        await pc.addIceCandidate(new wrtc.RTCIceCandidate(data.candidate));
      }
    } catch (e) {
      console.error('[host] sinalização erro:', e.message);
    }
  });

  ws.on('close', () => process.exit(0));
  ws.on('error', (e) => console.error('[host] WS erro:', e.message));
}

main();
