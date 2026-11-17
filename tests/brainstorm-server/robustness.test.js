/**
 * Regression tests: percent-encoded /files/ names, and the server surviving
 * a removed state dir or a file that vanishes mid-request. Uses only core
 * Node modules (no `ws` needed).
 */
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SERVER = path.join(__dirname, '../../skills/brainstorming/scripts/server.cjs');
const PORT = 3341;
const TOKEN = 'robust-token-0123456789abcdef0123';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-robust-'));
const CONTENT = path.join(DIR, 'content');
const STATE = path.join(DIR, 'state');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p,
      headers: { Cookie: `brainstorm-key-${PORT}=${TOKEN}` } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

function sendWsText(text) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      Cookie: `brainstorm-key-${PORT}=${TOKEN}` } });
    req.on('upgrade', (res, socket) => {
      const payload = Buffer.from(text);
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
      setTimeout(() => { socket.destroy(); resolve(); }, 200);
    });
    req.on('error', reject);
    req.end();
  });
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  PASS: ' + name); passed++; }
  catch (e) { console.log('  FAIL: ' + name + '\n    ' + e.message); failed++; }
}

(async () => {
  fs.mkdirSync(CONTENT, { recursive: true });
  const srv = spawn('node', [SERVER], { env: { ...process.env, BRAINSTORM_DIR: DIR,
    BRAINSTORM_PORT: String(PORT), BRAINSTORM_TOKEN: TOKEN }, stdio: 'ignore' });
  let exited = false; srv.on('exit', () => { exited = true; });
  try {
    for (let i = 0; i < 50; i++) {
      try { await get('/'); break; } catch (e) { await sleep(100); }
    }
    await test('serves a /files/ name containing a space when percent-encoded', async () => {
      fs.writeFileSync(path.join(CONTENT, 'my image.svg'), '<svg>ok</svg>');
      const r = await get('/files/my%20image.svg');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body, '<svg>ok</svg>');
    });
    await test('malformed percent-encoding returns 404, not a crash', async () => {
      const r = await get('/files/%E0%A4%A');
      assert.strictEqual(r.status, 404);
      assert.strictEqual((await get('/')).status, 200);
    });
    await test('encoded traversal and encoded dotfile names stay blocked', async () => {
      fs.writeFileSync(path.join(DIR, 'secret.txt'), 'SECRET');
      fs.writeFileSync(path.join(CONTENT, '.hidden'), 'HIDDEN');
      for (const p of ['/files/..%2Fsecret.txt', '/files/%2e%2e%2fsecret.txt', '/files/%2ehidden']) {
        const r = await get(p);
        assert(!/SECRET|HIDDEN/.test(r.body), p + ' leaked content');
      }
      assert.strictEqual((await get('/files/%2ehidden')).status, 404);
    });
    await test('choice event with state dir removed does not crash the server', async () => {
      fs.rmSync(STATE, { recursive: true, force: true });
      await sendWsText(JSON.stringify({ choice: 'a' }));
      await sleep(200);
      assert(!exited, 'server process exited');
      assert.strictEqual((await get('/')).status, 200);
    });
  } finally {
    srv.kill();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
})();
