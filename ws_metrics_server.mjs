/**
 * WebSocket metrics server used by the rt-ui for real-time analysis streaming.
 *
 * Protocol (JSON messages over WS):
 *
 * Client -> Server (subscribe)
 * ```json
 * {
 *   "type": "subscribe",
 *   "include_scope": true,
 *   "include_spectrum": false,
 *   "per_channel": false,
 *   "scope_fps": 8,
 *   "spectrum_fps": 2,
 *   "probe_fps": 2,
 *   "probe_id": 3,
 *   "fft_size": 1024,
 *   "smoothing": 0.8,
 *   "min_db": -90,
 *   "max_db": 0,
 *   "edge_threshold": 0.09,
 *   "log_bins": 32
 * }
 * ```
 *
 * Fields:
 * - `include_scope` / `include_spectrum`: toggles for analysis payloads.
 * - `per_channel`: include `channels[]` arrays in scope/spectrum payloads.
 * - `scope_fps` / `spectrum_fps` / `probe_fps`: requested frame rates (server clamps).
 * - `probe_id`: optional probe id filter; if omitted, all probes are sent.
 * - analyser tuning: `fft_size`, `smoothing`, `min_db`, `max_db`, `edge_threshold`, `log_bins`.
 *
 * Client -> Server (ping)
 * ```json
 * { "type": "ping" }
 * ```
 *
 * Server -> Client (metrics)
 * ```json
 * {
 *   "type": "metrics",
 *   "schema_version": "faust-mcp-rt/1",
 *   "timestamp_ms": 1735860123456,
 *   "payload": { ...getAudioMetrics(...) }
 * }
 * ```
 *
 * Server -> Client (error)
 * ```json
 * { "type": "error", "timestamp_ms": 1735860123456, "error": "message" }
 * ```
 *
 * Server -> Client (pong)
 * ```json
 * { "type": "pong", "timestamp_ms": 1735860123456 }
 * ```
 *
 * Notes:
 * - Payload format mirrors `/audio-metrics`.
 * - Server decides actual cadence; frames may be dropped if not due.
 */
import crypto from 'node:crypto';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * WebSocket metrics server for streaming getAudioMetrics payloads.
 */
export class WebSocketMetricsServer {
  /**
   * @param {object} params
   * @param {object} params.runtime
   * @param {string} params.schema_version
   */
  constructor({ runtime, schema_version: schemaVersion }) {
    this.runtime = runtime;
    this.schemaVersion = schemaVersion;
    this.clients = new Set();
    this.interval = null;
    this.defaults = {
      include_scope: false,
      include_spectrum: false,
      per_channel: false,
      scope_fps: 0,
      spectrum_fps: 0,
      probe_fps: 0,
      fft_size: 1024,
      smoothing: 0.8,
      min_db: -90,
      max_db: 0,
      edge_threshold: 0.09,
      log_bins: 32,
      probe_id: null,
    };
  }

  /**
   * Attach upgrade handling to an HTTP server.
   * @param {import('node:http').Server} server
   */
  attach(server) {
    if (!server) return;
    server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket));
  }

  /**
   * Stop all clients and the broadcast loop.
   */
  stop() {
    for (const client of this.clients) {
      try {
        client.socket.end();
      } catch (_) {}
    }
    this.clients.clear();
    this.stopLoop();
  }

  /**
   * Handle WebSocket upgrade requests.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   */
  handleUpgrade(req, socket) {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = this.makeAccept(String(key));
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    const params = Object.fromEntries(url.searchParams.entries());
    const config = this.normalizeConfig(params);
    const now = Date.now();
    const client = {
      socket,
      buffer: Buffer.alloc(0),
      config,
      nextScopeAt: now,
      nextSpectrumAt: now,
      nextProbeAt: now,
    };
    this.clients.add(client);
    this.startLoop();
    socket.on('data', (chunk) => this.handleData(client, chunk));
    socket.on('close', () => this.dropClient(client));
    socket.on('error', () => this.dropClient(client));
  }

  /**
   * Handle incoming WebSocket data.
   * @param {object} client
   * @param {Buffer} chunk
   */
  handleData(client, chunk) {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    const { frames, remaining } = this.decodeFrames(client.buffer);
    client.buffer = remaining;
    frames.forEach((frame) => {
      if (frame.opcode === 0x8) {
        client.socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        client.socket.write(this.encodeFrame(0xA, frame.payload));
        return;
      }
      if (frame.opcode !== 0x1) return;
      this.handleMessage(client, frame.payload.toString('utf8'));
    });
  }

  /**
   * Apply a JSON message to a client config.
   * @param {object} client
   * @param {string} message
   */
  handleMessage(client, message) {
    let data = null;
    try {
      data = JSON.parse(message);
    } catch (_) {
      return;
    }
    if (!data || typeof data !== 'object') return;
    if (data.type === 'ping') {
      const payload = JSON.stringify({ type: 'pong', timestamp_ms: Date.now() });
      client.socket.write(this.encodeText(payload));
      return;
    }
    const isSubscribe = data.type === 'subscribe'
      || data.include_scope !== undefined
      || data.include_spectrum !== undefined
      || data.scope_fps !== undefined
      || data.spectrum_fps !== undefined
      || data.probe_fps !== undefined
      || data.probe_id !== undefined;
    if (!isSubscribe) return;
    client.config = {
      ...client.config,
      ...this.normalizeConfig(data),
    };
    const now = Date.now();
    client.nextScopeAt = now;
    client.nextSpectrumAt = now;
    client.nextProbeAt = now;
  }

  /**
   * Remove a client and stop the loop if empty.
   * @param {object} client
   */
  dropClient(client) {
    if (this.clients.has(client)) {
      this.clients.delete(client);
    }
    if (!this.clients.size) {
      this.stopLoop();
    }
  }

  /**
   * Start the broadcast loop.
   */
  startLoop() {
    if (this.interval) return;
    this.interval = setInterval(() => this.broadcast(), 100);
  }

  /**
   * Stop the broadcast loop.
   */
  stopLoop() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  /**
   * Broadcast metrics to connected clients.
   */
  broadcast() {
    if (!this.clients.size) return;
    const now = Date.now();
    for (const client of this.clients) {
      if (!client?.socket || client.socket.destroyed) continue;
      const cfg = client.config || this.defaults;
      const dueScope = cfg.include_scope && cfg.scope_fps > 0 && now >= client.nextScopeAt;
      const dueSpectrum = cfg.include_spectrum && cfg.spectrum_fps > 0 && now >= client.nextSpectrumAt;
      const dueProbe = cfg.probe_fps > 0 && now >= client.nextProbeAt;
      if (!dueScope && !dueSpectrum && !dueProbe) continue;
      const opts = {
        include_scope: dueScope,
        include_spectrum: dueSpectrum,
        per_channel: cfg.per_channel,
        fft_size: cfg.fft_size,
        smoothing: cfg.smoothing,
        min_db: cfg.min_db,
        max_db: cfg.max_db,
        edge_threshold: cfg.edge_threshold,
        log_bins: cfg.log_bins,
      };
      try {
        const payload = this.runtime.getAudioMetrics(opts);
        const frame = JSON.stringify({
          type: 'metrics',
          schema_version: this.schemaVersion,
          timestamp_ms: now,
          payload,
        });
        client.socket.write(this.encodeText(frame));
      } catch (err) {
        const frame = JSON.stringify({
          type: 'error',
          timestamp_ms: now,
          error: err instanceof Error ? err.message : String(err),
        });
        client.socket.write(this.encodeText(frame));
      }
      if (dueScope && cfg.scope_fps > 0) {
        client.nextScopeAt = now + Math.round(1000 / cfg.scope_fps);
      }
      if (dueSpectrum && cfg.spectrum_fps > 0) {
        client.nextSpectrumAt = now + Math.round(1000 / cfg.spectrum_fps);
      }
      if (dueProbe && cfg.probe_fps > 0) {
        client.nextProbeAt = now + Math.round(1000 / cfg.probe_fps);
      }
    }
  }

  /**
   * Build a WebSocket accept key.
   * @param {string} key
   * @returns {string}
   */
  makeAccept(key) {
    return crypto.createHash('sha1').update(`${key}${WS_MAGIC}`).digest('base64');
  }

  /**
   * Encode a websocket frame.
   * @param {number} opcode
   * @param {Buffer} payload
   * @returns {Buffer}
   */
  encodeFrame(opcode, payload) {
    const len = payload.length;
    if (len < 126) {
      const header = Buffer.from([0x80 | (opcode & 0x0f), len]);
      return Buffer.concat([header, payload]);
    }
    if (len < 65536) {
      const header = Buffer.alloc(4);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
      return Buffer.concat([header, payload]);
    }
    const header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    return Buffer.concat([header, payload]);
  }

  /**
   * Encode a websocket text frame.
   * @param {string} data
   * @returns {Buffer}
   */
  encodeText(data) {
    return this.encodeFrame(0x1, Buffer.from(data));
  }

  /**
   * Decode incoming websocket frames.
   * @param {Buffer} buffer
   * @returns {{frames: Array<{opcode: number, payload: Buffer}>, remaining: Buffer}}
   */
  decodeFrames(buffer) {
    const frames = [];
    let offset = 0;
    while (offset + 2 <= buffer.length) {
      const byte1 = buffer[offset];
      const byte2 = buffer[offset + 1];
      const opcode = byte1 & 0x0f;
      const masked = (byte2 & 0x80) === 0x80;
      let length = byte2 & 0x7f;
      let headerLength = 2;
      if (length === 126) {
        if (offset + 4 > buffer.length) break;
        length = buffer.readUInt16BE(offset + 2);
        headerLength = 4;
      } else if (length === 127) {
        if (offset + 10 > buffer.length) break;
        const bigLen = buffer.readBigUInt64BE(offset + 2);
        if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) break;
        length = Number(bigLen);
        headerLength = 10;
      }
      const maskLength = masked ? 4 : 0;
      const frameLength = headerLength + maskLength + length;
      if (offset + frameLength > buffer.length) break;
      let payload = buffer.slice(offset + headerLength + maskLength, offset + frameLength);
      if (masked) {
        const mask = buffer.slice(offset + headerLength, offset + headerLength + 4);
        payload = Buffer.from(payload.map((byte, idx) => byte ^ mask[idx % 4]));
      }
      frames.push({ opcode, payload });
      offset += frameLength;
    }
    return { frames, remaining: buffer.slice(offset) };
  }

  /**
   * Normalize boolean values in a subscription.
   * @param {unknown} value
   * @param {boolean} fallback
   * @returns {boolean}
   */
  parseBool(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return fallback;
  }

  /**
   * Clamp numeric values for subscriptions.
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @param {number} fallback
   * @returns {number}
   */
  clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  /**
   * Normalize WebSocket subscription parameters.
   * @param {object} params
   * @returns {object}
   */
  normalizeConfig(params = {}) {
    const probeValue = params.probe_id;
    let probeId = null;
    if (probeValue !== undefined && probeValue !== null && probeValue !== '') {
      const parsed = Number(probeValue);
      probeId = Number.isFinite(parsed) ? parsed : null;
    }
    return {
      include_scope: this.parseBool(params.include_scope, this.defaults.include_scope),
      include_spectrum: this.parseBool(params.include_spectrum, this.defaults.include_spectrum),
      per_channel: this.parseBool(params.per_channel, this.defaults.per_channel),
      scope_fps: this.clampNumber(params.scope_fps, 0, 30, this.defaults.scope_fps),
      spectrum_fps: this.clampNumber(params.spectrum_fps, 0, 20, this.defaults.spectrum_fps),
      probe_fps: this.clampNumber(params.probe_fps, 0, 20, this.defaults.probe_fps),
      fft_size: this.clampNumber(params.fft_size, 128, 8192, this.defaults.fft_size),
      smoothing: this.clampNumber(params.smoothing, 0, 1, this.defaults.smoothing),
      min_db: this.clampNumber(params.min_db, -160, 0, this.defaults.min_db),
      max_db: this.clampNumber(params.max_db, -60, 40, this.defaults.max_db),
      edge_threshold: this.clampNumber(params.edge_threshold, 0, 1, this.defaults.edge_threshold),
      log_bins: this.clampNumber(params.log_bins, 8, 256, this.defaults.log_bins),
      probe_id: probeId,
    };
  }
}
