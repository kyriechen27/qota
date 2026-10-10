import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import net from 'node:net';
import { sendMail } from '../src/lib/smtp.ts';
import { connectSMTP } from '../node/smtp-socket.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const config = { host: 'smtp.example.test', port: 465, security: 'tls', username: 'sender@example.test', password: 'test-password', fromEmail: 'sender@example.test', fromName: '固件公告' };
const message = { to: 'recipient@example.test', subject: '固件版本更新 '.repeat(12), text: '版本 V2.0\n修复升级问题\n.\n已完成。' };

function fixture(options = {}) {
  const commands = [];
  let payload = '';
  let upgraded = false;
  let closed = 0;
  let authStep = 0;
  function connection(secure = options.security !== 'starttls') {
    let controller;
    let expectingData = false;
    let done = false;
    const reply = (text) => {
      if (options.bareReplies && !text.includes('AUTH') && !text.includes('STARTTLS')) {
        text = text.replace(/^(\d{3}) [^\r\n]*\r\n/gm, '$1\r\n');
      }
      const bytes = new TextEncoder().encode(text);
      // Exercise fragmented CRLFs and multiline SMTP responses.
      if (options.fragmentEveryByte) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      } else {
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4));
      }
    };
    const socket = {
      readable: new ReadableStream({ start(value) { controller = value; } }),
      writable: new WritableStream({ write(bytes) {
        const value = new TextDecoder().decode(bytes);
        if (expectingData) {
          payload = value;
          reply(options.rejectData ? '554 denied sensitive-diagnostics\r\n' : '250 accepted\r\n');
          return;
        }
        commands.push(value.trim());
        if (value.startsWith('EHLO')) {
          reply(secure ? `250-server\r\n250 AUTH ${options.login ? 'LOGIN' : 'PLAIN'}\r\n` :
            options.noStarttls ? '250 server\r\n' : '250-server\r\n250 STARTTLS\r\n');
        } else if (value === 'STARTTLS\r\n') {
          reply('220 Ready\r\n');
        } else if (value.startsWith('AUTH')) {
          assert.equal(secure, true, 'never authenticate before TLS');
          if (options.rejectAuth) reply('535 private account diagnostic\r\n');
          else if (options.login || options.challengePlain || value === 'AUTH PLAIN\r\n') { authStep = 1; reply('334 challenge\r\n'); }
          else reply('235 \r\n'); // Empty success text must not be treated as another challenge.
        } else if (authStep > 0) {
          if (options.login && authStep === 1) { authStep = 2; reply('334 password\r\n'); }
          else { authStep = 0; reply('235 accepted\r\n'); }
        } else if (value.startsWith('MAIL FROM')) reply('250 sender accepted\r\n');
        else if (value.startsWith('RCPT TO')) reply(options.rejectRecipient ? '550 no such user secret\r\n' : '250 recipient accepted\r\n');
        else if (value === 'DATA\r\n') { expectingData = true; reply('354 send content\r\n'); }
        else throw new Error('unexpected SMTP command');
      } }),
      opened: Promise.resolve(), closed: Promise.resolve(),
      close: async () => { closed++; if (!done) { done = true; controller.close(); } },
      startTls: () => { upgraded = true; return connection(true); },
    };
    if (!upgraded) reply('220 example smtp\r\n');
    return socket;
  }
  return {
    env: { SMTP_CONNECT: () => connection() }, commands,
    get payload() { return payload; }, get upgraded() { return upgraded; }, get closed() { return closed; },
  };
}

test('SMTP accepts TLS/PLAIN, encodes Chinese headers/body and keeps recipients private', async () => {
  const f = fixture();
  await sendMail(f.env, config, message);
  assert.ok(f.commands.includes(`RCPT TO:<${message.to}>`));
  assert.ok(!f.commands.some((command) => command.includes('\n')));
  assert.match(f.payload, /To: <recipient@example.test>/);
  const [headers, body] = f.payload.split('\r\n\r\n');
  const subject = headers.match(/Subject: ([\s\S]*?)\r\nMIME-Version/)[1];
  const decoded = [...subject.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
    .map((match) => Buffer.from(match[1], 'base64').toString('utf8')).join('');
  assert.equal(decoded, message.subject);
  assert.ok(headers.split('\r\n').every((line) => line.length < 100));
  assert.equal(Buffer.from(body.slice(0, -5).replace(/\r\n/g, ''), 'base64').toString('utf8'), message.text.replace(/\n/g, '\r\n'));
  assert.equal(f.closed, 1);
});

test('SMTP requires STARTTLS before LOGIN and sends EHLO again after upgrade', async () => {
  const f = fixture({ security: 'starttls', login: true });
  await sendMail(f.env, { ...config, security: 'starttls', port: 587 }, message);
  assert.equal(f.upgraded, true);
  assert.equal(f.commands.filter((command) => command.startsWith('EHLO')).length, 2);
  assert.deepEqual(f.commands.slice(0, 4), ['EHLO qota.local', 'STARTTLS', 'EHLO qota.local', 'AUTH LOGIN']);
});

test('SMTP handles servers challenging an initial AUTH PLAIN response', async () => {
  const f = fixture({ challengePlain: true });
  await sendMail(f.env, config, message);
  assert.equal(f.commands[2], Buffer.from(`\0${config.username}\0${config.password}`).toString('base64'));
});

test('SMTP accepts bare reply codes and responses split at every byte', async () => {
  const f = fixture({ bareReplies: true, fragmentEveryByte: true, challengePlain: true });
  await sendMail(f.env, config, message);
  assert.ok(f.payload.includes('Content-Transfer-Encoding: base64'));
  assert.equal(f.closed, 1);
});

test('SMTP uses a PLAIN challenge instead of an oversized initial AUTH command', async () => {
  const f = fixture();
  const longConfig = { ...config, password: 'long-credential-'.repeat(50) };
  await sendMail(f.env, longConfig, message);
  assert.equal(f.commands[1], 'AUTH PLAIN');
  assert.equal(f.commands[2], Buffer.from(`\0${longConfig.username}\0${longConfig.password}`).toString('base64'));
});

for (const [option, code] of [['rejectAuth', 'smtp_auth'], ['rejectRecipient', 'smtp_recipient'], ['rejectData', 'smtp_send'], ['noStarttls', 'smtp_tls']]) {
  test(`SMTP fails safely for ${option} and closes the connection`, async () => {
    const f = fixture({ [option]: true, ...(option === 'noStarttls' ? { security: 'starttls' } : {}) });
    await assert.rejects(sendMail(f.env, { ...config, ...(option === 'noStarttls' ? { security: 'starttls' } : {}) }, message),
      (error) => error.code === code && error.message === code);
    assert.equal(f.closed, 1);
    if (option === 'noStarttls') assert.equal(f.commands.length, 1);
  });
}

test('SMTP blocks envelope command injection before opening a connection', async () => {
  let connects = 0;
  await assert.rejects(sendMail({ SMTP_CONNECT() { connects++; } }, config, { ...message, to: 'x@example.test>\r\nRCPT TO:<other@example.test' }), /smtp_send/);
  assert.equal(connects, 0);
});

test('SMTP closes a connector acquired after the deadline and observes handshake rejection', async (t) => {
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => realTimeout(callback, delay === 15_000 ? 5 : delay, ...args));
  let closes = 0;
  let rejectHandshake;
  const env = { SMTP_CONNECT: () => new Promise((resolve) => realTimeout(() => resolve({
    opened: new Promise((_, reject) => { rejectHandshake = reject; }),
    closed: Promise.resolve(),
    async close() { closes++; rejectHandshake(new Error('closed handshake')); },
  }), 20)) };
  await assert.rejects(sendMail(env, config, message), (error) => error.code === 'smtp_timeout');
  await new Promise((resolve) => realTimeout(resolve, 30));
  assert.equal(closes, 1);
});

test('Node SMTP adapter settles a handshake closed before opening', { timeout: 2_000 }, async (t) => {
  const server = net.createServer((socket) => { socket.on('error', () => {}); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const socket = connectSMTP({ ...config, host: '127.0.0.1', port: server.address().port, security: 'starttls' });
  const rejected = assert.rejects(socket.opened, /closed before opening/);
  await socket.close();
  await rejected;
  await socket.closed;
});

test('Node SMTP adapter allows cancelling its readable without closing it twice', { timeout: 2_000 }, async (t) => {
  const server = net.createServer((socket) => { socket.on('error', () => {}); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const socket = connectSMTP({ ...config, host: '127.0.0.1', port: server.address().port, security: 'starttls' });
  await socket.opened;
  await socket.readable.cancel();
  await socket.closed;
});
