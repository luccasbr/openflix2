const net = require('net');
const dgram = require('dgram');
const http = require('http');
const { pcFactory } = require('./lib/webrtc');

const ROOM   = process.env.ROOM   || 'demo1';
const TOKEN  = process.env.TOKEN  || 'lucas12345'; // enviado no header do canal
const SIGNAL = process.env.SIGNAL || 'wss://signal.loghub.shop/ws';
const ICE = [
  { urls: 'stun:turn.loghub.shop:3478' },
  { urls: 'turns:turn.loghub.shop:5349?transport=tcp', username:'api', credential:'senha-super-secreta' },
  { urls: 'turn:turn.loghub.shop:3478?transport=udp',  username:'api', credential:'senha-super-secreta' }
];

const { pc, ensureOffer } = pcFactory(ICE, SIGNAL, 'client', ROOM, process.env.SIGNAL_TOKEN || null);

pc.oniceconnectionstatechange = () => console.log('ICE:', pc.iceConnectionState);
pc.onconnectionstatechange = () => console.log('PC :', pc.connectionState);

// -------- util ----------
function openTcpDC(host, port){
  return new Promise(async (res, rej) => {
    const dc = pc.createDataChannel(`tcp-${Date.now()}`, { ordered:true });
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      dc.send(Buffer.from(JSON.stringify({type:'tcp-connect', host, port, token:TOKEN})));
    };
    const onFirst = (e) => {
      const b = Buffer.from(e.data);
      if (b.length===1 && b[0]===1){ dc.removeEventListener('message', onFirst); res(dc); }
      else { dc.close(); rej(new Error('dial falhou no host')); }
    };
    dc.onmessage = onFirst;
    dc.onerror = (err) => rej(err);
    await ensureOffer();
  });
}

function openUdpAssocDC(){
  return new Promise(async (res, rej) => {
    const dc = pc.createDataChannel(`udp-${Date.now()}`, { ordered:true });
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      dc.send(Buffer.from(JSON.stringify({type:'udp-assoc', token:TOKEN})));
    };
    const onFirst = (e) => {
      const b = Buffer.from(e.data);
      if (b.length===1 && b[0]===1){ dc.removeEventListener('message', onFirst); res(dc); }
      else { dc.close(); rej(new Error('udp-assoc falhou')); }
    };
    dc.onmessage = onFirst;
    dc.onerror = rej;
    await ensureOffer();
  });
}

// -------- HTTP CONNECT local (127.0.0.1:8080) ----------
const httpProxy = http.createServer();
httpProxy.on('connect', async (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':'); const port = Number(portStr||443);
  try {
    const dc = await openTcpDC(host, port);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) dc.send(head);
    clientSocket.on('data', chunk => { try{ dc.send(chunk); }catch{} });
    clientSocket.on('end', () => { try{ dc.close(); }catch{} });
    clientSocket.on('error', () => { try{ dc.close(); }catch{} });
    dc.onmessage = (e)=>{ try{ clientSocket.write(Buffer.from(e.data)); }catch{} };
    dc.onclose   = ()=>{ try{ clientSocket.end(); }catch{} };
  } catch (e) {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); clientSocket.end();
  }
});
httpProxy.listen(8080, '127.0.0.1', ()=>console.log('HTTP CONNECT em 127.0.0.1:8080'));

// -------- SOCKS5 local (127.0.0.1:1080) ----------
const socksServer = net.createServer(async (cliSock) => {
  // RFC 1928 handshake
  cliSock.once('data', async (hello) => {
    // VER=0x05, NMETHODS, METHODS...
    if (hello[0] !== 0x05) { cliSock.destroy(); return; }
    // resposta: VER=5, METHOD=0 (no auth)  (implemente username/password se quiser)
    cliSock.write(Buffer.from([0x05, 0x00]));

    cliSock.once('data', async (req1) => {
      // VER CMD RSV ATYP ...
      const ver = req1[0], cmd = req1[1], atyp = req1[3];
      if (ver !== 0x05 || (cmd !== 0x01 && cmd !== 0x03)) { // 0x01 CONNECT, 0x03 UDP ASSOC
        cliSock.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0,0,0,0, 0,0])); return;
      }

      if (cmd === 0x01) {
        // CONNECT
        let host, port, p = 4;
        if (atyp === 0x01) { host = req1.slice(p,p+4).join('.'); p+=4; }
        else if (atyp === 0x03) { const len=req1[p]; p+=1; host = req1.slice(p,p+len).toString('utf8'); p+=len; }
        else if (atyp === 0x04) { host='['+req1.slice(p,p+16).toString('hex')+']'; p+=16; }
        port = (req1[p]<<8) | req1[p+1];

        try {
          const dc = await openTcpDC(host, port);
          // reply success
          cliSock.write(Buffer.from([0x05,0x00,0x00,0x01,0,0,0,0, 0,0]));
          cliSock.on('data', chunk => { try{ dc.send(chunk); }catch{} });
          cliSock.on('end', ()=>{ try{ dc.close(); }catch{} });
          cliSock.on('error', ()=>{ try{ dc.close(); }catch{} });
          dc.onmessage = (e)=>{ try{ cliSock.write(Buffer.from(e.data)); }catch{} };
          dc.onclose   = ()=>{ try{ cliSock.end(); }catch{} };
        } catch {
          cliSock.end(Buffer.from([0x05,0x01,0x00,0x01,0,0,0,0, 0,0])); // general failure
        }
      } else if (cmd === 0x03) {
        // UDP ASSOC: criamos um socket UDP local e um DC de assoc para enviar/receber
        const dc = await openUdpAssocDC();
        const udpLocal = dgram.createSocket('udp4');
        let clientAddr=null, clientPort=null;

        udpLocal.on('message', (msg, rinfo) => {
          clientAddr = rinfo.address; clientPort = rinfo.port;
          // decodificar cabeçalho SOCKS5 UDP e enviar via DC
          // RFC1928: RSV(2) FRAG(1) ATYP(1) DST.ADDR DST.PORT DATA
          let p=0; const atyp=msg[3];
          if (msg[2]!==0x00) return; // sem fragmentação
          if (atyp===0x01){ // IPv4
            const host = msg.slice(4,8).join('.');
            const port = (msg[8]<<8)|msg[9];
            const data = msg.slice(10);
            dc.send(Buffer.from(JSON.stringify({rhost: host, rport: port, data: data.toString('base64')})));
          } else if (atyp===0x03){
            const len=msg[4]; const host=msg.slice(5,5+len).toString('utf8');
            const port=(msg[5+len]<<8)|msg[6+len]; const data=msg.slice(7+len);
            dc.send(Buffer.from(JSON.stringify({rhost: host, rport: port, data: data.toString('base64')})));
          } else if (atyp===0x04){
            // simplificação: não implementado no MVP
          }
        });

        dc.onmessage = (e) => {
          // resposta do host: {rhost,rport,data}
          try {
            const m = JSON.parse(Buffer.from(e.data).toString('utf8'));
            if (!clientAddr) return;
            // montar pacote SOCKS5-UDP de volta
            const addrBuf = Buffer.from([0x00,0x00,0x00,0x03, m.rhost.length, ...Buffer.from(m.rhost)]);
            const portBuf = Buffer.from([ (m.rport>>8)&0xff, m.rport&0xff ]);
            const dataBuf = Buffer.from(m.data, 'base64');
            const pkt = Buffer.concat([addrBuf, portBuf, dataBuf]);
            udpLocal.send(pkt, clientPort, clientAddr);
          } catch {}
        };

        udpLocal.bind(0, '127.0.0.1', () => {
          const addr = udpLocal.address();
          // resposta do SOCKS: success + bound addr/port do UDP local
          const rep = Buffer.from([0x05,0x00,0x00,0x01, 127,0,0,1, (addr.port>>8)&0xff, addr.port&0xff ]);
          cliSock.write(rep);
          cliSock.on('close', ()=>udpLocal.close());
        });
      }
    });
  });
});
socksServer.listen(1080, '127.0.0.1', ()=>console.log('SOCKS5 em 127.0.0.1:1080'));

console.log('Cliente pronto. ROOM=', ROOM);
