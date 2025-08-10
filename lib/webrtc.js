// lib/webrtc.js
const wrtc = require('wrtc');
const WebSocket = require('ws');

/**
 * Sinalização WebSocket + WebRTC (node-webrtc).
 * - Negocia só quando necessário (primeira vez ou reconexão).
 * - Suporta RELAY_ONLY=1 para forçar TURN.
 */
function pcFactory(iceServers, signalUrl, role, room, token) {
  const forceRelay = process.env.RELAY_ONLY === '1';

  const pc = new wrtc.RTCPeerConnection({
    iceServers,
    iceTransportPolicy: forceRelay ? 'relay' : 'all',
  });

  // Flags de negociação
  let offeredOnce = false;     // já fizemos offer inicial?
  let makingOffer = false;     // estamos fazendo offer agora?
  let ignoreOffer = false;     // glare handling (perfect negotiation pattern)

  // DEBUG úteis
  pc.oniceconnectionstatechange = () => console.log(`[${role}] ICE:`, pc.iceConnectionState);
  pc.onconnectionstatechange   = () => {
    console.log(`[${role}] PC :`, pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      offeredOnce = false; // deixa negociar de novo numa futura recuperação
    }
  };
  pc.onsignalingstatechange    = () => console.log(`[${role}] SIG:`, pc.signalingState);

  let ws;
  const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: 'signal', data: { candidate } });
  };

  // Disparar negociação só quando necessário
  pc.onnegotiationneeded = async () => {
    if (role !== 'client') return;        // only caller faz offer
    if (offeredOnce) return;              // já negociado
    await ensureOffer();                  // primeira vez
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
        // se o host chegou e ainda não ofertamos, ofertar
        if (!offeredOnce) ensureOffer();
      }
      if (m.type === 'signal') {
        const desc = m.data && m.data.sdp ? new wrtc.RTCSessionDescription(m.data.sdp) : null;
        try {
          if (desc) {
            const readyForOffer = pc.signalingState === 'stable' || (pc.signalingState === 'have-local-offer' && !makingOffer);
            const offerCollision = desc.type === 'offer' && !readyForOffer;
            ignoreOffer = offerCollision;
            if (ignoreOffer) {
              console.warn(`[${role}] Ignorando offer (glare)`);
              return;
            }
            if (desc.type === 'offer') {
              await pc.setRemoteDescription(desc);
              const ans = await pc.createAnswer();
              await pc.setLocalDescription(ans);
              send({ type: 'signal', data: { sdp: pc.localDescription } });
              offeredOnce = true; // já temos caminho negociado
              return;
            } else {
              // answer
              await pc.setRemoteDescription(desc);
              offeredOnce = true;
              return;
            }
          }
          if (m.data && m.data.candidate) {
            await pc.addIceCandidate(new wrtc.RTCIceCandidate(m.data.candidate));
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
    if (offeredOnce) return;
    if (pc.signalingState !== 'stable') return;
    try {
      makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: 'signal', data: { sdp: pc.localDescription } });
      // Não marcamos offeredOnce aqui ainda; só após receber a answer
    } finally {
      makingOffer = false;
    }
  }

  return { pc, ensureOffer, get offeredOnce() { return offeredOnce; } };
}

module.exports = { pcFactory };
