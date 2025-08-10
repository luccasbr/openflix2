const net = require('net');
const dgram = require('dgram');
const { pcFactory } = require('./lib/webrtc');

const ROOM   = process.env.ROOM   || 'demo1';
const TOKEN  = process.env.TOKEN  || 'lucas12345';           // aceite apenas este token
const SIGNAL = process.env.SIGNAL || 'wss://signal.loghub.shop/ws';
const ICE = [
  { urls: 'stun:turn.loghub.shop:3478' },
  { urls: 'turns:turn.loghub.shop:5349?transport=tcp', username:'api', credential:'senha-super-secreta' },
  { urls: 'turn:turn.loghub.shop:3478?transport=udp',  username:'api', credential:'senha-super-secreta' }
];

const { pc } = pcFactory(ICE, SIGNAL, 'host', ROOM, process.env.SIGNAL_TOKEN || null);

pc.ondatachannel = (ev) => {
  const dc = ev.channel;
  dc.binaryType = 'arraybuffer';

  let mode = 'header';
  let tcp = null;
  let udpSock = null;

  dc.onmessage = (e) => {
    const buf = Buffer.from(e.data);
    if (mode === 'header') {
      try {
        const h = JSON.parse(buf.toString('utf8'));
        if (TOKEN && h.token !== TOKEN) { dc.send(Buffer.from([0])); return dc.close(); }

        if (h.type === 'tcp-connect') {
          tcp = net.connect({ host: h.host, port: Number(h.port) }, () => dc.send(Buffer.from([1])));
          tcp.on('data', chunk => { try { dc.send(chunk); } catch {} });
          tcp.on('error', () => { try{ dc.send(Buffer.from([0])); }catch{}; dc.close(); });
          tcp.on('close', () => { try{ dc.close(); }catch{} });
          mode = 'tcp';
        } else if (h.type === 'udp-assoc') {
          udpSock = dgram.createSocket('udp4'); // simples; pode usar dual-stack se preciso
          dc.send(Buffer.from([1]));
          mode = 'udp';
        } else {
          dc.send(Buffer.from([0])); dc.close();
        }
      } catch {
        dc.send(Buffer.from([0])); dc.close();
      }
      return;
    }

    if (mode === 'tcp' && tcp) {
      tcp.write(buf);
      return;
    }

    if (mode === 'udp' && udpSock) {
      // mensagem é JSON {rhost, rport, data(base64)}
      try {
        const m = JSON.parse(buf.toString('utf8'));
        const data = Buffer.from(m.data, 'base64');
        udpSock.send(data, Number(m.rport), m.rhost);
      } catch {}
    }
  };

  dc.onclose = () => { try { tcp && tcp.destroy(); udpSock && udpSock.close(); } catch {} };
};

console.log('Host pronto. ROOM=', ROOM);
