#!/usr/bin/env node
/*
 * SoundStage PC — control a Monster SoundStage S3 (Qualcomm AllPlay) speaker from a PC.
 *
 * Zero-dependency local server: SSDP + mDNS discovery, UPnP/DLNA (SOAP) control,
 * stream casting, plus a network diagnostics toolbox. Serves the web UI in public/.
 *
 *   node server.js            -> http://localhost:8099
 *   node server.js --port 9000
 *
 * License: The Unlicense (public domain) — see LICENSE.
 */
'use strict';

const http = require('http');
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const FETCH_TIMEOUT_MS = 3000;

const SSDP_STS = [
  'ssdp:all',
  'upnp:rootdevice',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:service:AVTransport:1',
  'urn:schemas-upnp-org:service:RenderingControl:1',
  'urn:allplay-com:service:AllPlay:1',
  'urn:allplay-com:service:ZoneManager:1',
  'urn:spotify:service:connect:1',
];

const MDNS_TYPES = [
  '_services._dns-sd._udp.local',
  '_spotify-connect._tcp.local',
  '_googlecast._tcp.local',
  '_airplay._tcp.local',
  '_raop._tcp.local',
  '_dlna._tcp.local',
  '_allplay._tcp.local',
  '_soundstage._tcp.local',
  '_http._tcp.local',
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function firstTag(xml, tag) {
  const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(xml);
  return m ? m[1].trim() : null;
}
function allTags(xml, tag) {
  const out = [];
  const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function parseHeaders(text) {
  const h = {};
  text.split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  });
  return h;
}
async function fetchText(url, timeout = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function ipv4Interfaces() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Local media library (the PC serves files the speaker can pull via DLNA)
// ---------------------------------------------------------------------------
const MEDIA_DIR = path.join(__dirname, 'media');
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch {}

const MIME = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.wav': 'audio/wav',
  '.wma': 'audio/x-ms-wma', '.mp4': 'audio/mp4', '.m4b': 'audio/mp4',
};

function safeName(n) { return String(n).replace(/[^\w.\- ()]+/g, '_').slice(0, 180); }

function lanIP() {
  const ifs = ipv4Interfaces();
  const pick = ifs.find((i) => /^192\.168\./.test(i.address))
    || ifs.find((i) => /^10\./.test(i.address))
    || ifs.find((i) => /^172\.(1[6-9]|2\d|3[01])\./.test(i.address))
    || ifs.find((i) => i.name !== 'tailscale0')
    || ifs[0];
  return pick ? pick.address : '127.0.0.1';
}
function mediaUrl(name) { return `http://${lanIP()}:${PORT}/media/${encodeURIComponent(name)}`; }

const META_PATH = path.join(MEDIA_DIR, 'meta.json');
function loadMeta() { try { const m = JSON.parse(fs.readFileSync(META_PATH, 'utf8')); return { files: {}, order: [], ...(m || {}) }; } catch { return { files: {}, order: [] }; } }
function saveMeta(m) { try { fs.writeFileSync(META_PATH, JSON.stringify(m)); } catch {} }

// ---------------------------------------------------------------------------
// UPnP device description
// ---------------------------------------------------------------------------
function parseDescription(xml, location) {
  const base = new URL(location);
  const host = base.hostname;
  let name = null;
  const names = allTags(xml, 'friendlyName');
  if (names.length) name = names[names.length - 1];
  const services = [];
  for (const svc of allTags(xml, 'service')) {
    const type = firstTag(svc, 'serviceType');
    const controlURL = firstTag(svc, 'controlURL');
    if (!type || !controlURL) continue;
    let absolute;
    try { absolute = new URL(controlURL, base).toString(); }
    catch { absolute = `http://${host}/${controlURL.replace(/^\/+/, '')}`; }
    services.push({ type, controlURL: absolute });
  }
  return { name, host, location, services };
}

const DESC_PATHS = ['/device.xml', '/description.xml', '/', '/upnp/device.xml', '/rootDesc.xml'];
async function describe(ip, port = 80) {
  for (const p of DESC_PATHS) {
    const url = `http://${ip}:${port}${p}`;
    try {
      const xml = await fetchText(url);
      if (xml && /<service>/i.test(xml)) return parseDescription(xml, url);
    } catch { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SSDP discovery (multi-interface, multi-ST) + raw capture
// ---------------------------------------------------------------------------
function ssdpProbe({ timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    const responses = []; // { ip, raw, headers }
    const ifaces = ipv4Interfaces();
    const sockets = [];
    const targets = ifaces.length ? ifaces : [{ address: '0.0.0.0' }];

    for (const iface of targets) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('message', (msg, rinfo) => {
        const raw = msg.toString();
        responses.push({ from: rinfo.address, iface: iface.address, raw, headers: parseHeaders(raw) });
      });
      sock.on('error', () => {});
      try {
        sock.bind(0, iface.address, () => {
          try { sock.setMulticastTTL(2); } catch {}
          try { if (iface.address !== '0.0.0.0') sock.setMulticastInterface(iface.address); } catch {}
          sendSearch(sock);
        });
      } catch { /* ignore */ }
      sockets.push(sock);
    }

    function sendSearch(sock) {
      for (const st of SSDP_STS) {
        const m = Buffer.from(
          'M-SEARCH * HTTP/1.1\r\n' +
          `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
          'MAN: "ssdp:discover"\r\n' +
          'MX: 2\r\n' +
          `ST: ${st}\r\n\r\n`
        );
        try { sock.send(m, SSDP_PORT, SSDP_ADDR, () => {}); } catch {}
      }
    }

    setTimeout(async () => {
      for (const s of sockets) { try { s.close(); } catch {} }
      // dedupe by LOCATION/USN
      const byKey = new Map();
      for (const r of responses) {
        const key = r.headers.location || r.headers.usn || r.raw.slice(0, 40);
        if (!byKey.has(key)) byKey.set(key, r);
      }
      const devices = [];
      const seenHost = new Set();
      for (const r of byKey.values()) {
        const loc = r.headers.location;
        if (!loc) continue;
        let host;
        try { host = new URL(loc).hostname; } catch { host = r.from; }
        if (seenHost.has(host)) continue;
        seenHost.add(host);
        try {
          const desc = parseDescription(await fetchText(loc), loc);
          devices.push({ ip: host, name: desc.name || `Device ${host}`, location: loc, services: desc.services });
        } catch {
          devices.push({ ip: host, name: `Device ${host}`, location: loc, services: [] });
        }
      }
      resolve({ devices, raw: [...byKey.values()].map((r) => ({ from: r.from, raw: r.raw })) });
    }, timeout);
  });
}

const discover = () => ssdpProbe({ timeout: 4000 });

// ---------------------------------------------------------------------------
// mDNS discovery (minimal zero-dep resolver)
// ---------------------------------------------------------------------------
function readName(buf, off) {
  const labels = [];
  let jumped = false, next = off, safety = 0;
  while (safety++ < 128) {
    const len = buf[off];
    if (len === undefined) break;
    if (len === 0) { off++; if (!jumped) next = off; break; }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[off + 1];
      if (!jumped) next = off + 2;
      off = ptr; jumped = true; continue;
    }
    labels.push(buf.slice(off + 1, off + 1 + len).toString('latin1'));
    off += 1 + len;
    if (!jumped) next = off;
  }
  return { name: labels.join('.'), next };
}

function parseDns(buf) {
  const recs = [];
  if (buf.length < 12) return recs;
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6), ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) { const r = readName(buf, off); off = r.next + 4; }
  const total = an + ns + ar;
  for (let i = 0; i < total && off < buf.length; i++) {
    const r = readName(buf, off); off = r.next;
    if (off + 10 > buf.length) break;
    const type = buf.readUInt16BE(off), cls = buf.readUInt16BE(off + 2);
    const ttl = buf.readUInt32BE(off + 4), rdlen = buf.readUInt16BE(off + 8);
    off += 10;
    const rdStart = off;
    let data = null;
    try {
      if (type === 12) data = readName(buf, off).name;
      else if (type === 16) {
        const strs = []; let p = off; const end = off + rdlen;
        while (p < end) { const l = buf[p]; p++; strs.push(buf.slice(p, p + l).toString('latin1')); p += l; }
        data = strs;
      } else if (type === 33) {
        const port = buf.readUInt16BE(off + 4);
        const tgt = readName(buf, off + 6).name;
        data = { port, target: tgt };
      } else if (type === 1) data = Array.from(buf.slice(off, off + 4)).join('.');
      else data = buf.slice(off, off + rdlen).toString('base64');
    } catch { data = null; }
    recs.push({ name: r.name, type, class: cls & 0x7fff, ttl, data });
    off = rdStart + rdlen;
  }
  return recs;
}

function encodeName(name) {
  const labels = name.split('.').filter(Boolean);
  const bufs = [];
  for (const l of labels) { bufs.push(Buffer.from([l.length])); bufs.push(Buffer.from(l, 'latin1')); }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

function buildMdnsQuery(types) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); header.writeUInt16BE(0, 2);
  header.writeUInt16BE(types.length, 4);
  const parts = [header];
  for (const t of types) {
    parts.push(encodeName(t));
    const q = Buffer.alloc(4);
    q.writeUInt16BE(12, 0);      // PTR
    q.writeUInt16BE(1 | 0x8000, 2); // IN + QU (unicast response)
    parts.push(q);
  }
  return Buffer.concat(parts);
}

function mdnsProbe({ timeout = 3500 } = {}) {
  return new Promise((resolve) => {
    const records = [];
    const ifaces = ipv4Interfaces();
    const sockets = [];
    const targets = ifaces.length ? ifaces : [{ address: '0.0.0.0' }];
    const query = buildMdnsQuery(MDNS_TYPES);

    for (const iface of targets) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('message', (msg) => {
        try { records.push(...parseDns(msg)); } catch {}
      });
      sock.on('error', () => {});
      try {
        sock.bind(0, iface.address, () => {
          try { if (iface.address !== '0.0.0.0') sock.setMulticastInterface(iface.address); } catch {}
          try { sock.send(query, MDNS_PORT, MDNS_ADDR, () => {}); } catch {}
        });
      } catch {}
      sockets.push(sock);
    }

    setTimeout(() => {
      for (const s of sockets) { try { s.close(); } catch {} }
      // present: group PTR/SRV/TXT as best-effort list
      const services = records
        .filter((r) => r.type === 12)
        .map((r) => ({ type: r.name, instance: r.data }));
      resolve({ records, services });
    }, timeout);
  });
}

// ---------------------------------------------------------------------------
// Targeted probe: unicast SSDP + HTTP fingerprint of one IP
// ---------------------------------------------------------------------------
async function unicastSsdp(ip, timeout = 1600) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const res = [];
    sock.on('message', (m, ri) => res.push({ from: ri.address, raw: m.toString() }));
    sock.on('error', () => {});
    sock.bind(() => {
      const sts = SSDP_STS.concat([
        'urn:allplay-com:device:AllPlay:1',
        'urn:schemas-upnp-org:device:MediaServer:1',
      ]);
      for (const st of sts) {
        const msg = Buffer.from(
          'M-SEARCH * HTTP/1.1\r\n' +
          `HOST: ${ip}:1900\r\n` +
          'MAN: "ssdp:discover"\r\n' +
          'MX: 1\r\n' +
          `ST: ${st}\r\n\r\n`
        );
        try { sock.send(msg, 1900, ip, () => {}); } catch {}
      }
    });
    setTimeout(() => { try { sock.close(); } catch {}; resolve(res); }, timeout);
  });
}

function probeTargets() {
  return [
    [80, '/'], [80, '/device.xml'], [80, '/description.xml'], [80, '/BasicDeviceDescription.xml'],
    [80, '/rootDesc.xml'], [80, '/upnp/desc.xml'], [80, '/status'], [80, '/info'], [80, '/api'],
    [8080, '/'], [8080, '/zeroConf'], [8080, '/spConn'],
    [8080, '/zeroConf?action=getInfo'],
    [80, '/cgi-bin/luci'], [80, '/cgi-bin/luci/'], [80, '/cgi-bin/luci/admin'], [80, '/luci'], [80, '/ubus'],
    [9197, '/dmr'], [49152, '/'], [1400, '/'],
  ];
}

// Raw HTTP GET over a TCP socket: tolerant of broken Content-Length headers
// (the SoundStage port 80 sends HPE_UNEXPECTED_CONTENT_LENGTH which fetch rejects).
function rawHttpGet(ip, port, p, timeout = 2500) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const s = net.connect({ host: ip, port });
    const finish = () => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(buf.toString('utf8')); };
    s.setTimeout(timeout);
    s.on('connect', () => { try { s.write(`GET ${p} HTTP/1.1\r\nHost: ${ip}:${port}\r\nUser-Agent: MonsterPC/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`); } catch {} });
    s.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.length > 300000) finish(); });
    s.on('end', finish);
    s.on('timeout', finish);
    s.on('error', finish);
  });
}

function rawHttpPost(ip, port, p, body, contentType, timeout = 3000) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const s = net.connect({ host: ip, port });
    const finish = () => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(buf.toString('utf8')); };
    s.setTimeout(timeout);
    s.on('connect', () => {
      const b = Buffer.from(body, 'utf8');
      try {
        s.write(`POST ${p} HTTP/1.1\r\nHost: ${ip}:${port}\r\nUser-Agent: MonsterPC/1.0\r\nContent-Type: ${contentType}\r\nContent-Length: ${b.length}\r\nConnection: close\r\n\r\n`);
        s.write(b);
      } catch {}
    });
    s.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.length > 400000) finish(); });
    s.on('end', finish);
    s.on('timeout', finish);
    s.on('error', finish);
  });
}

function postProbes() {
  return [
    [80, '/ubus', 'application/json', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: ['00000000000000000000000000000000', 'session', 'login', { username: 'root', password: '' }] })],
    [80, '/ubus', 'application/json', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'list', params: ['00000000000000000000000000000000', '*'] })],
    [80, '/cgi-bin/luci', 'application/x-www-form-urlencoded', 'username=root&password='],
  ];
}

function parseRawResponse(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  const head = idx >= 0 ? raw.slice(0, idx) : raw;
  const body = idx >= 0 ? raw.slice(idx + 4) : '';
  const lines = head.split('\r\n');
  const statusMatch = /^HTTP\/\d\.\d\s+(\d+)/.exec(lines[0] || '');
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return {
    status: statusMatch ? Number(statusMatch[1]) : null,
    statusLine: lines[0] || '',
    contentType: headers['content-type'] || '',
    server: headers['server'] || '',
    headers,
    body,
  };
}

const COMMON_PORTS = [80, 443, 1900, 3689, 4070, 5000, 7000, 8008, 8080, 8081, 8082, 8888, 9000, 9197, 1400, 49152];

function tcpCheck(ip, port, timeout = 1200) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (open) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(open); };
    s.setTimeout(timeout);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    try { s.connect(port, ip); } catch { finish(false); }
  });
}

const PAGE_CANDIDATES = [
  '/cgi-bin/luci',
  '/cgi-bin/luci/audio', '/cgi-bin/luci/audio/equalizer', '/cgi-bin/luci/equalizer', '/cgi-bin/luci/eq',
  '/cgi-bin/luci/sound', '/cgi-bin/luci/audio_settings', '/cgi-bin/luci/settings', '/cgi-bin/luci/setting',
  '/cgi-bin/luci/sources', '/cgi-bin/luci/source', '/cgi-bin/luci/playback', '/cgi-bin/luci/media',
  '/cgi-bin/luci/network', '/cgi-bin/luci/wifi', '/cgi-bin/luci/airplay', '/cgi-bin/luci/bluetooth',
  '/cgi-bin/luci/device', '/cgi-bin/luci/system', '/cgi-bin/luci/status', '/cgi-bin/luci/info',
  '/cgi-bin/luci/advanced', '/cgi-bin/luci/dsp', '/cgi-bin/luci/multiroom', '/cgi-bin/luci/zone',
  '/cgi-bin/luci/group', '/cgi-bin/luci/config', '/cgi-bin/luci/config/select',
  '/cgi-bin/luci/system/upgrade', '/cgi-bin/luci/upgrade', '/cgi-bin/luci/language', '/cgi-bin/luci/help',
  '/cgi-bin/luci/about', '/cgi-bin/luci/room', '/cgi-bin/luci/rooms', '/cgi-bin/luci/link',
  '/cgi-bin/luci/allplay', '/cgi-bin/luci/control', '/cgi-bin/luci/tone', '/cgi-bin/luci/bass',
];

function extractTitle(html) {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].trim() : '';
}

async function enumeratePages(ip) {
  const out = [];
  let idx = 0;
  const worker = async () => {
    while (idx < PAGE_CANDIDATES.length) {
      const pth = PAGE_CANDIDATES[idx++];
      const raw = await rawHttpGet(ip, 80, pth, 3000);
      const r = parseRawResponse(raw);
      const isRedirect = /location\.replace\("\/cgi-bin\/luci"\)/.test(r.body);
      out.push({
        path: pth, status: r.status, contentType: r.contentType,
        title: extractTitle(r.body), redirect: isRedirect, len: r.body.length,
      });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

async function portScan(ip, from = 1, to = 10000, concurrency = 400, timeout = 250) {
  const open = [];
  let port = from;
  const worker = async () => {
    while (true) {
      const p = port++;
      if (p > to) return;
      if (await tcpCheck(ip, p, timeout)) open.push(p);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return open.sort((a, b) => a - b);
}

const RECON_URLS = [
  '/luci-static/sam/js/lang_menu.js',
  '/luci-static/sam/',
  '/luci-static/sam/js/',
  '/luci-static/sam/styles/',
  '/luci-static/resources/js/',
  '/cgi-bin/luci/system',
  '/cgi-bin/luci/system/upgrade',
  '/cgi-bin/luci/config',
];

const SERVICE_PORTS = [2870, 8080, 8086, 8087, 9955, 53];

function tcpGrab(ip, port, { sendHttp = false, timeout = 2000 } = {}) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const s = net.connect({ host: ip, port });
    const finish = () => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(buf.toString('latin1')); };
    s.setTimeout(timeout);
    s.on('connect', () => { if (sendHttp) { try { s.write(`GET / HTTP/1.0\r\nHost: ${ip}\r\nUser-Agent: MonsterPC/1.0\r\n\r\n`); } catch {} } });
    s.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.length > 16384) finish(); });
    s.on('end', finish);
    s.on('timeout', finish);
    s.on('error', () => finish());
  });
}

async function scanServices(ip) {
  const out = [];
  for (const port of SERVICE_PORTS) {
    const passive = await tcpGrab(ip, port, { sendHttp: false, timeout: 1500 });
    const httpGet = await tcpGrab(ip, port, { sendHttp: true, timeout: 2500 });
    out.push({
      port,
      passive: passive.slice(0, 2000),
      httpGet: httpGet.slice(0, 2000),
    });
  }
  return { ip, services: out };
}

const DESCRIBE_PATHS = [
  '/', '/rootDesc.xml', '/RootDesc.xml', '/description.xml', '/Description.xml', '/device.xml', '/Device.xml',
  '/BasicDeviceDescription.xml', '/upnp/desc.xml', '/upnp/desc', '/devdesc.xml', '/DeviceDescription.xml',
  '/dmr.xml', '/basic.xml', '/index.xml', '/desc.xml', '/xml/device.xml', '/upnp/device.xml',
  '/allplay', '/allplay/desc.xml', '/config.xml', '/setup.xml', '/topology.xml', '/AVTransport.xml',
  '/MediaRenderer.xml', '/scpd.xml', '/mediaplayer.xml',
];

async function describePort(ip, port) {
  const results = [];
  let idx = 0;
  const worker = async () => {
    while (idx < DESCRIBE_PATHS.length) {
      const pth = DESCRIBE_PATHS[idx++];
      const raw = await rawHttpGet(ip, port, pth, 2500);
      const r = parseRawResponse(raw);
      const looksXml = /<root|<device|<service|<specVersion|<scpd/i.test(r.body);
      results.push({ path: pth, status: r.status, contentType: r.contentType, looksXml, body: r.body.slice(0, 4000) });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  // keep only meaningful hits (XML or non-404)
  const hits = results.filter((r) => r.looksXml || (r.status && r.status !== 404));
  return { ip, port, hits, all: results };
}

const SCPD_2870 = ['/dmr_rcs.xml', '/dmr_avts.xml', '/dmr_cms.xml'];
const PATHS_8086 = ['/', '/allplay', '/api', '/status', '/info', '/device', '/zeroConf', '/control', '/config',
  '/eq', '/audio', '/settings', '/getInfo', '/system', '/xml', '/desc.xml', '/player', '/volume', '/zone'];

async function allplayHunt(ip) {
  const scpd = [];
  for (const pth of SCPD_2870) {
    const raw = await rawHttpGet(ip, 2870, pth, 2500);
    const r = parseRawResponse(raw);
    scpd.push({ path: pth, status: r.status, contentType: r.contentType, body: r.body.slice(0, 9000) });
  }
  const p8086 = [];
  let idx = 0;
  const w = async () => {
    while (idx < PATHS_8086.length) {
      const pth = PATHS_8086[idx++];
      const raw = await rawHttpGet(ip, 8086, pth, 2000);
      const r = parseRawResponse(raw);
      p8086.push({ path: pth, status: r.status, contentType: r.contentType, body: r.body.slice(0, 1200) });
    }
  };
  await Promise.all([w(), w(), w(), w()]);
  const bin = async (port) => ({
    port,
    passive: await tcpGrab(ip, port, { timeout: 1300 }),
    http: await tcpGrab(ip, port, { sendHttp: true, timeout: 1600 }),
    newline: await new Promise((resolve) => {
      let b = Buffer.alloc(0); let d = false;
      const s = net.connect({ host: ip, port });
      const fin = () => { if (d) return; d = true; try { s.destroy(); } catch {} resolve(b.toString('latin1')); };
      s.setTimeout(1300);
      s.on('connect', () => { try { s.write('\r\n'); } catch {} });
      s.on('data', (x) => { b = Buffer.concat([b, x]); if (b.length > 8192) fin(); });
      s.on('end', fin); s.on('timeout', fin); s.on('error', fin);
    }),
  });
  return { ip, scpd, port8086: p8086, port8087: await bin(8087), port9955: await bin(9955) };
}

async function recon(ip) {
  const openPorts = await portScan(ip);
  const fetches = [];
  for (const pth of RECON_URLS) {
    const raw = await rawHttpGet(ip, 80, pth, 4000);
    const r = parseRawResponse(raw);
    fetches.push({ path: pth, status: r.status, contentType: r.contentType, body: r.body.slice(0, 5000) });
  }
  return { ip, openPorts, fetches };
}

const DLNA_CTRL = {
  AVTransport: { path: '/AVTransport/control', type: 'urn:schemas-upnp-org:service:AVTransport:1' },
  RenderingControl: { path: '/RenderingControl/control', type: 'urn:schemas-upnp-org:service:RenderingControl:1' },
  ConnectionManager: { path: '/ConnectionManager/control', type: 'urn:schemas-upnp-org:service:ConnectionManager:1' },
};

async function dlnaCall(ip, port, service, action, argsXml) {
  const c = DLNA_CTRL[service];
  if (!c) throw new Error('unknown service: ' + service);
  const url = `http://${ip}:${port}${c.path}`;
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${c.type}">${argsXml || ''}</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${c.type}#${action}"` },
    body,
  });
  return await res.text();
}

async function probeDevice(ip) {
  const http = [];
  const targets = probeTargets();
  let idx = 0;
  const worker = async () => {
    while (idx < targets.length) {
      const [port, p] = targets[idx++];
      const u = `http://${ip}:${port}${p}`;
      const raw = await rawHttpGet(ip, port, p);
      if (!raw) {
        http.push({ url: u, error: 'timeout / no response' });
        continue;
      }
      const r = parseRawResponse(raw);
      if (!r.status) { http.push({ url: u, error: 'no HTTP status', snippet: raw.slice(0, 300) }); continue; }
      http.push({
        url: u, status: r.status, contentType: r.contentType, server: r.server,
        headers: r.headers, snippet: r.body.slice(0, 1500),
      });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);

  // POST probes (ubus JSON-RPC + LuCI login)
  for (const [port, p, ct, body] of postProbes()) {
    const u = `POST http://${ip}:${port}${p}`;
    const raw = await rawHttpPost(ip, port, p, body, ct);
    if (!raw) { http.push({ url: u, error: 'timeout / no response' }); continue; }
    const r = parseRawResponse(raw);
    http.push({
      url: u, status: r.status, contentType: r.contentType, server: r.server,
      headers: r.headers, snippet: r.body.slice(0, 1500),
    });
  }

  const ports = [];
  let pidx = 0;
  const pworker = async () => {
    while (pidx < COMMON_PORTS.length) {
      const port = COMMON_PORTS[pidx++];
      if (await tcpCheck(ip, port)) ports.push(port);
    }
  };
  await Promise.all([pworker(), pworker(), pworker(), pworker(), pworker(), pworker(), pworker(), pworker()]);

  const ssdp = await unicastSsdp(ip);
  return { ip, openPorts: ports.sort((a, b) => a - b), http, ssdp };
}

// --------------------------------------------------------------------------
// Subnet scan (unicast) - reliable from a wired PC even if multicast is bridged
// --------------------------------------------------------------------------
async function probeHost(ip, port, timeout = 700) {
  for (const p of ['/device.xml', '/', '/description.xml']) {
    try {
      const xml = await fetchText(`http://${ip}:${port}${p}`, timeout);
      if (xml && (/<service>/i.test(xml) || (/<root/i.test(xml) && /<device>/i.test(xml)))) return { ip, port, xml };
    } catch { /* next */ }
  }
  return null;
}

async function scanSubnet({ concurrency = 64 } = {}) {
  const found = [];
  const seen = new Set();
  for (const iface of ipv4Interfaces()) {
    const base = iface.address.split('.').slice(0, 3).join('.');
    const ips = [];
    for (let i = 1; i <= 254; i++) { const ip = `${base}.${i}`; if (ip !== iface.address) ips.push(ip); }
    let idx = 0;
    const worker = async () => {
      while (idx < ips.length) {
        const ip = ips[idx++];
        for (const port of [80, 9197]) {
          const hit = await probeHost(ip, port);
          if (hit) {
            const key = `${ip}:${port}`;
            if (seen.has(key)) break;
            seen.add(key);
            let name = null, services = [];
            try { const d = parseDescription(hit.xml, `http://${ip}:${port}/device.xml`); name = d.name; services = d.services; } catch {}
            found.push({ ip, name: name || `Appareil ${ip}`, location: `http://${ip}:${port}/device.xml`, services, port });
            break;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }
  return found;
}

// ---------------------------------------------------------------------------
// UPnP SOAP control
// ---------------------------------------------------------------------------
async function soap(controlURL, serviceType, action, argsXml = '') {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    `<u:${action} xmlns:u="${serviceType}">${argsXml}</u:${action}>` +
    '</s:Body></s:Envelope>';
  const res = await fetch(controlURL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${serviceType}#${action}"` },
    body,
  });
  return res.text();
}
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RCS = 'urn:schemas-upnp-org:service:RenderingControl:1';
const findService = (services, type) => services.find((s) => s.type.startsWith(type));
async function runAction({ services, service, action, args }) {
  const type = service === 'RenderingControl' ? RCS : AVT;
  const svc = findService(services, type);
  if (!svc) throw new Error(`service not found: ${type}`);
  return soap(svc.controlURL, svc.type, action, args || '');
}

// ---------------------------------------------------------------------------
// Auto-discovery: mDNS (AllPlay / Spotify-Connect / _http) + subnet scan for the DLNA renderer on :2870
// ---------------------------------------------------------------------------
async function findSpeakers({ scan = true } = {}) {
  const cand = new Map();
  const add = (ip, via, host) => {
    if (!ip) return;
    const c = cand.get(ip) || { ip, via: [] };
    if (!c.via.includes(via)) c.via.push(via);
    if (host && !c.host) c.host = host;
    cand.set(ip, c);
  };

  // 1) mDNS: the speaker advertises _spotify-connect._tcp and _http._tcp
  try {
    const m = await mdnsProbe({ timeout: 3000 });
    const A = m.records.filter((r) => r.type === 1);
    const SRV = m.records.filter((r) => r.type === 33);
    const looksSpeaker = (s) => /qualcomm|atheros|soundstage|monster|allplay|cus227/i.test(s || '');
    for (const a of A) if (typeof a.data === 'string' && looksSpeaker(a.name)) add(a.data, 'mdns', a.name);
    for (const s of SRV) {
      const svc = (s.name || '').toLowerCase();
      if (svc.includes('spotify-connect') || svc.includes('_http')) {
        const tgt = (s.data && s.data.target) || '';
        const a = A.find((r) => r.name === tgt);
        if (a && typeof a.data === 'string') add(a.data, 'mdns-srv', tgt);
      }
    }
  } catch { /* ignore */ }

  // 2) subnet scan on port 2870 (the DLNA renderer port)
  if (scan) {
    for (const iface of ipv4Interfaces()) {
      const base = iface.address.split('.').slice(0, 3).join('.');
      const ips = [];
      for (let i = 1; i <= 254; i++) { const ip = `${base}.${i}`; if (ip !== iface.address) ips.push(ip); }
      let idx = 0;
      const worker = async () => { while (idx < ips.length) { const ip = ips[idx++]; if (await tcpCheck(ip, 2870, 300)) add(ip, 'scan2870'); } };
      await Promise.all(Array.from({ length: 220 }, worker));
    }
  }

  // 3) verify each candidate is a DLNA renderer and read its friendly name
  const devices = [];
  for (const c of cand.values()) {
    try {
      const r = parseRawResponse(await rawHttpGet(c.ip, 2870, '/dmr.xml', 2500));
      if (/<root/i.test(r.body) && /<service>/i.test(r.body)) {
        const d = parseDescription(r.body, `http://${c.ip}:2870/dmr.xml`);
        devices.push({ ip: c.ip, name: d.name || c.host || `Enceinte ${c.ip}`, location: `http://${c.ip}:2870/dmr.xml`, services: d.services, via: c.via });
      }
    } catch { /* skip */ }
  }
  devices.sort((a, b) => (b.services.length ? 1 : 0) - (a.services.length ? 1 : 0));
  return devices;
}

// ---------------------------------------------------------------------------
// HTTP server + API
// ---------------------------------------------------------------------------
const PUBLIC = path.join(__dirname, 'public');
let devices = [];

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/api/host') return json(res, 200, { ip: lanIP(), port: PORT });

    if (p === '/api/order' && req.method === 'POST') {
      const b = await readBody(req);
      const m = loadMeta();
      if (Array.isArray(b.names)) m.order = b.names.filter((n) => typeof n === 'string');
      saveMeta(m);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/playlist') {
      let files = [];
      try { files = fs.readdirSync(MEDIA_DIR).filter((f) => !f.startsWith('.') && !f.startsWith('meta') && fs.statSync(path.join(MEDIA_DIR, f)).isFile()); } catch {}
      const m = loadMeta();
      const ordered = (m.order || []).filter((f) => files.includes(f));
      const rest = files.filter((f) => !ordered.includes(f));
      const names = [...ordered, ...rest];
      return json(res, 200, { items: names.map((f) => { const st = fs.statSync(path.join(MEDIA_DIR, f)); const meta = m.files[f] || {}; return { name: f, url: mediaUrl(f), size: st.size, dur: meta.dur || 0 }; }) });
    }

    if (p.startsWith('/api/media/') && req.method === 'DELETE') {
      const name = safeName(decodeURIComponent(p.slice('/api/media/'.length)));
      try { fs.unlinkSync(path.join(MEDIA_DIR, name)); } catch {}
      const m = loadMeta(); delete m.files[name]; m.order = (m.order || []).filter((n) => n !== name); saveMeta(m);
      return json(res, 200, { ok: true });
    }

    if (p.startsWith('/api/media/') && req.method === 'PUT') {
      const name = safeName(decodeURIComponent(p.slice('/api/media/'.length)));
      if (!name) { res.writeHead(400); return res.end('bad name'); }
      const dest = path.join(MEDIA_DIR, name);
      const ws = fs.createWriteStream(dest);
      req.pipe(ws);
      ws.on('finish', () => { const sz = fs.statSync(dest).size; const m = loadMeta(); m.files[name] = { size: sz, dur: Number(url.searchParams.get('dur')) || 0 }; saveMeta(m); json(res, 200, { ok: true, name, url: mediaUrl(name), size: sz, dur: m.files[name].dur }); });
      ws.on('error', () => json(res, 500, { error: 'write failed' }));
      return;
    }

    if (p.startsWith('/media/')) {
      const name = safeName(decodeURIComponent(p.slice('/media/'.length)));
      const full = path.join(MEDIA_DIR, name);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
      const st = fs.statSync(full);
      const ext = path.extname(full).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const off = parseInt(url.searchParams.get('off') || '0', 10);
      if (off > 0 && off < st.size) {
        res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size - off });
        return fs.createReadStream(full, { start: off }).pipe(res);
      }
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (isNaN(start) || start < 0) start = 0;
        if (isNaN(end) || end >= st.size) end = st.size - 1;
        if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
        res.writeHead(206, {
          'Content-Type': type, 'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1,
        });
        return fs.createReadStream(full, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
      return fs.createReadStream(full).pipe(res);
    }

    if (p === '/api/find') {
      const scan = url.searchParams.get('scan') !== '0';
      return json(res, 200, { devices: await findSpeakers({ scan }) });
    }

    if (p === '/api/discover') {
      const found = await discover();
      const map = new Map(devices.map((d) => [d.ip, d]));
      for (const d of found.devices) map.set(d.ip, d);
      devices = [...map.values()];
      return json(res, 200, { devices, raw: found.raw });
    }

    if (p === '/api/diagnose') {
      const [ssdp, mdns] = await Promise.all([ssdpProbe({ timeout: 4000 }), mdnsProbe({ timeout: 3500 })]);
      return json(res, 200, {
        interfaces: ipv4Interfaces(),
        ssdpRaw: ssdp.raw,
        ssdpDevices: ssdp.devices,
        mdnsRecords: mdns.records,
        mdnsServices: mdns.services,
      });
    }

    if (p === '/api/dlna' && req.method === 'POST') {
      const b = await readBody(req);
      const ip = b.ip; const port = Number(b.port || 2870);
      if (!ip || !b.service || !b.action) return json(res, 400, { error: 'ip, service, action required' });
      const out = await dlnaCall(ip, port, b.service, b.action, b.args);
      const vol = /<CurrentVolume>(\d+)<\/CurrentVolume>/.exec(out);
      const mute = /<CurrentMute>(\d+)<\/CurrentMute>/.exec(out);
      const state = /<CurrentTransportState>([^<]+)<\/CurrentTransportState>/.exec(out);
      return json(res, 200, {
        ok: true, raw: out.slice(0, 4000),
        volume: vol ? +vol[1] : undefined,
        mute: mute ? mute[1] === '1' : undefined,
        transportState: state ? state[1] : undefined,
      });
    }

    if (p === '/api/allplay') {
      const ip = url.searchParams.get('ip');
      if (!ip) return json(res, 400, { error: 'ip required' });
      return json(res, 200, await allplayHunt(ip));
    }

    if (p === '/api/describe') {
      const ip = url.searchParams.get('ip');
      const port = Number(url.searchParams.get('port') || 2870);
      if (!ip) return json(res, 400, { error: 'ip required' });
      return json(res, 200, await describePort(ip, port));
    }

    if (p === '/api/services') {
      const ip = url.searchParams.get('ip');
      if (!ip) return json(res, 400, { error: 'ip required' });
      return json(res, 200, await scanServices(ip));
    }

    if (p === '/api/recon') {
      const ip = url.searchParams.get('ip');
      if (!ip) return json(res, 400, { error: 'ip required' });
      return json(res, 200, await recon(ip));
    }

    if (p === '/api/enumerate') {
      const ip = url.searchParams.get('ip');
      if (!ip) return json(res, 400, { error: 'ip required' });
      return json(res, 200, { ip, pages: await enumeratePages(ip) });
    }

    if (p === '/api/fetch') {
      const ip = url.searchParams.get('ip');
      const port = Number(url.searchParams.get('port') || 80);
      const target = url.searchParams.get('path') || '/';
      if (!ip) return json(res, 400, { error: 'ip required' });
      const raw = await rawHttpGet(ip, port, target, 5000);
      const r = parseRawResponse(raw);
      return json(res, 200, {
        ip, port, path: target, status: r.status, statusLine: r.statusLine,
        contentType: r.contentType, headers: r.headers, body: r.body.slice(0, 80000),
      });
    }

    if (p === '/api/probe') {
      const ip = url.searchParams.get('ip');
      if (!ip) return json(res, 400, { error: 'ip required' });
      return json(res, 200, await probeDevice(ip));
    }

    if (p === '/api/scan') {
      const found = await scanSubnet();
      const map = new Map(devices.map((d) => [d.ip, d]));
      for (const d of found) map.set(d.ip, d);
      devices = [...map.values()];
      return json(res, 200, { devices: found });
    }

    if (p === '/api/add' && req.method === 'POST') {
      const { ip, port } = await readBody(req);
      if (!ip) return json(res, 400, { error: 'ip required' });
      const desc = await describe(ip, port ? Number(port) : 80);
      const dev = desc
        ? { ip, name: desc.name || `Device ${ip}`, location: desc.location, services: desc.services }
        : { ip, name: `Device ${ip}`, location: null, services: [] };
      const map = new Map(devices.map((d) => [d.ip, d]));
      map.set(ip, dev);
      devices = [...map.values()];
      return json(res, 200, { device: dev });
    }

    if (p === '/api/list') return json(res, 200, { devices });

    if (p === '/api/control' && req.method === 'POST') {
      const { ip, service, action, args } = await readBody(req);
      const dev = devices.find((d) => d.ip === ip);
      if (!dev) return json(res, 404, { error: 'unknown device (discover first)' });
      const out = await runAction({ services: dev.services, service, action, args });
      const volume = /<CurrentVolume>(\d+)<\/CurrentVolume>/.exec(out);
      return json(res, 200, { ok: true, raw: out, volume: volume ? +volume[1] : undefined });
    }

    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const ext = path.extname(full);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': (types[ext] || 'application/octet-stream') + '; charset=utf-8' });
      return fs.createReadStream(full).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    json(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

const portArg = process.argv.indexOf('--port');
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 8099;
const hostArg = process.argv.indexOf('--host');
const HOST = hostArg > -1 ? process.argv[hostArg + 1] : '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`\n  SoundStage PC -> http://localhost:${PORT}  (LAN: http://${lanIP()}:${PORT})\n`);
  console.log('  Interfaces:', ipv4Interfaces().map((i) => `${i.name}=${i.address}`).join(', ') || 'none');
});
