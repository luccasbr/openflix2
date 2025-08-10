// lib/webrtc.js
const wrtc = require('wrtc');
const WebSocket = require('ws');

/**
 * Sinalização WebSocket + WebRTC (node-webrtc).
 * - Apenas o CLIENTE gera offers.
 * - Trava contra ofertas simultâneas.
 * - Bufferiza ICE candidates até setRemoteDescription.
 */
function pcFactory(iceServers, signalUrl, role, room, token) {
  const forceRelay = process.env.RELAY_ONLY === '1';

  const pc = new wrtc.RTCPeerConnection({
    iceServers,
    iceTransportPolicy: forceRelay ? 'relay' : 'all',
  });

  // Estado da negociação
  let makingOffer = false;         // estamos produzindo um offer agora?
  let offeredOnce = false;         // já completamos a 1ª negociação?
  let ws;

  // Buffer de ICE candidates recebidos antes de setRemoteDescription
  const pendingRemoteCandidates = [];

  const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

  // DEBUG
  pc.oniceconnectionstatechange = () => console.log(`[${role}] ICE:`, pc.iceConnectionState);
  pc.onconnectionstatechange   = () => console.log(`[${role}] PC :`, pc.connectionState);
  pc.onsignalingstatechange    = () => console.log(`[${role}] SIG:`, pc.signalingState);

  // Local ICE → sinalização
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: 'signal', data: { candidate } });
  };

  // Negociação automática: só o CLIENTE oferta
  pc.onnegotiationneeded = async () => {
    if (role !== 'client') return;
    await ensureOffer();
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
        // Host está pronto. Se ainda não negociado, garanta a oferta.
        await ensureOffer();
        return;
      }

      if (m.type === 'signal') {
        try {
          const hasSdp = m.data && m.data.sdp;
          const hasCand = m.data && m.data.candidate;

          if (hasSdp) {
            const desc = new wrtc.RTCSessionDescription(m.data.sdp);
            if (desc.type === 'offer') {
              // Apenas o HOST deve receber offers
              await pc.setRemoteDescription(desc);
              const ans = await pc.createAnswer();
              await pc.setLocalDescription(ans);
              send({ type: 'signal', data: { sdp: pc.localDescription } });
              offeredOnce = true;
              // drenar candidates pendentes
              while (pendingRemoteCandidates.length) {
                await pc.addIceCandidate(pendingRemoteCandidates.shift());
              }
              return;
            } else if (desc.type === 'answer') {
              // Apenas o CLIENTE recebe answers
              await pc.setRemoteDescription(desc);
              offeredOnce = true;
              while (pendingRemoteCandidates.length) {
                await pc.addIceCandidate(pendingRemoteCandidates.shift());
              }
              return;
            }
          }

          if (hasCand) {
            if (pc.remoteDescription) {
              await pc.addIceCandidate(new wrtc.RTCIceCandidate(m.data.candidate));
            } else {
              pendingRemoteCandidates.push(new wrtc.RTCIceCandidate(m.data.candidate));
            }
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

  // Gera uma offer apenas quando:
  // - somos CLIENTE,
  // - ainda não negociamos,
  // - estado está STABLE,
  // - e não há outra oferta em andamento.
  async function ensureOffer() {
    if (role !== 'client') return;
    if (offeredOnce) return;
    if (makingOffer) return;
    if (pc.signalingState !== 'stable') return;

    makingOffer = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: 'signal', data: { sdp: pc.localDescription } });
      // marcamos offeredOnce apenas após receber a ANSWER
    } finally {
      makingOffer = false;
    }
  }

  return {
    pc,
    ensureOffer,
    get offeredOnce() { return offeredOnce; },
  };
}

module.exports = { pcFactory };
