// lib/webrtc.js
const wrtc = require('wrtc');
const WebSocket = require('ws');

/**
 * Fabrica um RTCPeerConnection e cuida da sinalização por WebSocket (WSS).
 * Env vars suportadas:
 *   RELAY_ONLY=1   -> força uso de TURN (iceTransportPolicy: 'relay')
 */
function pcFactory(iceServers, signalUrl, role, room, token) {
  const forceRelay = process.env.RELAY_ONLY === '1';

  const pc = new wrtc.RTCPeerConnection({
    iceServers,
    iceTransportPolicy: forceRelay ? 'relay' : 'all',
  });

  // DEBUG útil pra diagnosticar NAT/ICE
  pc.oniceconnectionstatechange = () => console.log(`[${role}] ICE:`, pc.iceConnectionState);
  pc.onconnectionstatechange   = () => console.log(`[${role}] PC :`, pc.connectionState);
  pc.onsignalingstatechange    = () => console.log(`[${role}] SIG:`, pc.signalingState);

  let ws;
  const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: 'signal', data: { candidate } });
  };

  function wireWS() {
    ws = new WebSocket(signalUrl, { rejectUnauthorized: true });
    ws.on('open', () => {
      if (token) send({ type: 'auth', token });
      send({ type: 'join', role, room });
    });

    ws.on('message', async (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'peer-ready' && role === 'client') {
        // dispara offer no cliente ao saber que há host
        ensureOffer();
      }
      if (m.type === 'signal') {
        try {
          if (m.data.sdp) await pc.setRemoteDescription(new wrtc.RTCSessionDescription(m.data.sdp));
          if (m.data.candidate) await pc.addIceCandidate(new wrtc.RTCIceCandidate(m.data.candidate));
          if (m.data.sdp && m.data.sdp.type === 'offer' && role === 'host') {
            const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
            send({ type: 'signal', data: { sdp: pc.localDescription } });
          }
        } catch (e) {
          console.error(`[${role}] sinalização erro:`, e.message);
        }
      }
    });

    ws.on('close', () => setTimeout(wireWS, 1000));
    ws.on('error', (e) => console.error(`[${role}] WS erro:`, e.message));
  }
  wireWS();

  async function ensureOffer() {
    // só cria offer quando está STABLE (cliente)
    if (pc.signalingState !== 'stable') return;
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    send({ type: 'signal', data: { sdp: pc.localDescription } });
  }

  return { pc, ensureOffer };
}

module.exports = { pcFactory };
