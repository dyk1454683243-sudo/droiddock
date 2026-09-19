import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';

export const SYNTHETIC_DEVICE = 'Synthetic fixture (not a phone)';
export const SYNTHETIC_EVIDENCE = 'synthetic-fixture';
export const SYNTHETIC_DECODER_MARKER = 'SyntheticVideoDecoder';
export const SYNTHETIC_FRAME_LABEL = 'SYNTHETIC FIXTURE';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = join(root, 'droiddock/public');
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

// Served only by the smoke fixture. Replaces WebCodecs with a labeled fake
// frame so tests never claim Android video or H.264 decode compatibility.
export const SYNTHETIC_DECODER_PRELUDE = `'use strict';
(() => {
  class ${SYNTHETIC_DECODER_MARKER} {
    constructor({ output, error }) {
      this.output = output;
      this.error = error;
      this.state = 'unconfigured';
      this.decodeQueueSize = 0;
    }
    configure() { this.state = 'configured'; }
    close() { this.state = 'closed'; }
    decode() {
      if (this.state !== 'configured') return;
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 1280;
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#102040';
      context.fillRect(0, 0, 720, 1280);
      context.fillStyle = '#f4d35e';
      context.font = 'bold 36px sans-serif';
      context.fillText('${SYNTHETIC_FRAME_LABEL}', 36, 160);
      context.font = '28px sans-serif';
      context.fillText('Not Android video', 36, 220);
      context.fillText('Not H.264 evidence', 36, 270);
      this.output(new VideoFrame(canvas, { timestamp: 0, codedWidth: 720, codedHeight: 1280 }));
    }
  }
  globalThis.VideoDecoder = ${SYNTHETIC_DECODER_MARKER};
  globalThis.__DROIDDOCK_STREAM_EVIDENCE__ = '${SYNTHETIC_EVIDENCE}';
})();
`;

export function videoPacket({ config = false, keyframe = false, payload } = {}) {
  const data = payload ?? (config
    ? Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e])
    : Uint8Array.from([0, 0, 0, 1, 0x65, 0x88]));
  let flags = 0n;
  if (config) flags |= 1n << 63n;
  if (keyframe) flags |= 1n << 62n;
  const buffer = new ArrayBuffer(12 + data.length);
  const view = new DataView(buffer);
  view.setBigUint64(0, flags);
  view.setUint32(8, data.length);
  new Uint8Array(buffer, 12).set(data);
  return buffer;
}

function allowedRequest(req, expected) {
  return req.headers.host === expected && (!req.headers.origin || req.headers.origin === `http://${expected}`);
}

function reply(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

export async function startSmokeFixture({ initialStatus } = {}) {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  const authority = `127.0.0.1:${port}`;
  const origin = `http://${authority}`;
  let statusState = { state: initialStatus?.state ?? 'idle', message: initialStatus?.message ?? '' };
  const clients = [];
  let owner = null;

  const http = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!allowedRequest(req, authority)) {
        reply(res, 403, { error: 'Only the local DroidDock page can access this service.' });
        return;
      }
      const url = req.url ?? '';
      if (url === '/api/status' && req.method === 'GET') {
        reply(res, 200, {
          app: 'DroidDock',
          state: statusState.state,
          message: statusState.message,
          fixture: true,
          evidence: SYNTHETIC_EVIDENCE,
          device: SYNTHETIC_DEVICE,
        });
        return;
      }
      const asset = assets[url];
      if (req.method !== 'GET' || !asset) {
        reply(res, 404, { error: 'Not found.' });
        return;
      }
      let content = await readFile(join(publicDir, asset[0]));
      if (asset[0] === 'app.js') content = Buffer.from(`${SYNTHETIC_DECODER_PRELUDE}\n${content.toString('utf8')}`);
      res.writeHead(200, { 'Content-Type': asset[1] });
      res.end(content);
    } catch {
      if (!res.headersSent) reply(res, 500, { error: 'DroidDock could not complete this request.' });
    }
  });
  http.requestTimeout = 10000;
  http.headersTimeout = 10000;

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });
  http.on('upgrade', (req, socket, head) => {
    const takeover = req.url === '/stream?takeover=1';
    const ownerOpen = owner && owner.ws.readyState === owner.ws.OPEN;
    if ((req.url !== '/stream' && !takeover) || !allowedRequest(req, authority) || req.headers.origin !== origin || (!takeover && ownerOpen)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws));
  });
  sockets.on('connection', (ws) => {
    const previous = owner;
    const client = { ws, inbound: [], close: undefined };
    clients.push(client);
    if (previous) {
      owner = null;
      if (previous.ws.readyState === previous.ws.OPEN) {
        previous.ws.send(JSON.stringify({ type: 'moved', message: 'Phone opened elsewhere.' }));
      }
      previous.ws.close(4001, 'Phone opened elsewhere');
    }
    owner = client;
    ws.send(JSON.stringify({
      type: 'status',
      state: statusState.state,
      message: statusState.message,
      snapshot: true,
      fixture: true,
      evidence: SYNTHETIC_EVIDENCE,
    }));
    ws.on('message', (data, binary) => {
      if (binary || owner !== client) return;
      try { client.inbound.push(JSON.parse(data.toString())); } catch { /* ignore malformed fixture input */ }
      const latest = client.inbound.at(-1);
      if (latest?.type === 'connect') {
        statusState = { state: 'connecting', message: 'Synthetic stream. Not Android video.' };
        ws.send(JSON.stringify({
          type: 'status',
          state: 'connecting',
          device: SYNTHETIC_DEVICE,
          message: statusState.message,
          evidence: SYNTHETIC_EVIDENCE,
        }));
      }
    });
    ws.on('close', (code, reason) => {
      client.close = { code, reason: reason.toString() };
      if (owner === client) owner = null;
    });
  });

  await new Promise((resolve) => http.listen(port, '127.0.0.1', resolve));

  function requireOwner() {
    if (!owner || owner.ws.readyState !== owner.ws.OPEN) throw new Error('No synthetic fixture owner socket.');
    return owner;
  }

  return {
    origin,
    port,
    authority,
    evidence: SYNTHETIC_EVIDENCE,
    clients: () => clients,
    owner: () => owner,
    inbound: () => owner?.inbound ?? [],
    async waitForInbound(check, description, timeoutMs = 3000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const match = (owner?.inbound ?? []).find(check);
        if (match) return match;
        await delay(20);
      }
      throw new Error(`Timed out waiting for ${description}`);
    },
    emitStatus(message) {
      requireOwner().ws.send(JSON.stringify(message));
    },
    emitError(message) {
      statusState = { state: 'error', message };
      requireOwner().ws.send(JSON.stringify({ type: 'status', state: 'error', message }));
    },
    deliverSyntheticFrame() {
      const client = requireOwner();
      client.ws.send(videoPacket({ config: true }));
      client.ws.send(videoPacket({ keyframe: true }));
    },
    reset() {
      for (const client of clients) client.ws.terminate();
      clients.length = 0;
      owner = null;
      statusState = { state: initialStatus?.state ?? 'idle', message: initialStatus?.message ?? '' };
    },
    async close() {
      this.reset();
      sockets.close();
      if (typeof http.closeAllConnections === 'function') http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}
