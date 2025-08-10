const wrtc = require('wrtc');
const WebSocket = require('ws');

function pcFactory(ice, signalUrl, role, room, token) {
  const pc = new wrtc.RTCPeerConnection({ iceServers: ice, iceTransportPolicy: 'all' });
  let ws;
  function send(m){ if(ws && ws.readyState===1) ws.send(JSON.stringify(m)); }

  pc.onicecandidate = ({candidate}) => { if(candidate) send({type:'signal', data:{candidate}}); };

  function wireWS(){
    ws = new WebSocket(signalUrl, {rejectUnauthorized:true});
    ws.on('open', () => {
      if (token) send({type:'auth', token});
      send({type:'join', role, room});
    });
    ws.on('message', async (raw) => {
      const m = JSON.parse(raw);
      if(m.type==='peer-ready' && role==='client') ensureOffer();
      if(m.type==='signal'){
        if(m.data.sdp) await pc.setRemoteDescription(new wrtc.RTCSessionDescription(m.data.sdp));
        if(m.data.candidate) await pc.addIceCandidate(new wrtc.RTCIceCandidate(m.data.candidate));
        if(m.data.sdp && m.data.sdp.type==='offer' && role==='host'){
          const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
          send({type:'signal', data:{sdp: pc.localDescription}});
        }
      }
    });
    ws.on('close', () => setTimeout(wireWS, 1000));
  }
  wireWS();

  async function ensureOffer(){
    if(pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer') return;
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    send({type:'signal', data:{sdp: pc.localDescription}});
  }

  return { pc, ensureOffer };
}

module.exports = { pcFactory };
