import type { Bindings } from '../env';

export interface SMTPConfig {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
}

export interface MailMessage { to: string; subject: string; text: string }

// The Node adapter supplies the same byte-stream contract as cloudflare:sockets.
export interface SMTPSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  closed: Promise<void>;
  close(): Promise<void>;
  startTls(): SMTPSocket;
}
export type SMTPConnector = (config: SMTPConfig) => SMTPSocket | Promise<SMTPSocket>;

// Only these fixed messages may reach the UI or persisted delivery log. SMTP
// replies can contain credentials, addresses or infrastructure details.
export class SMTPError extends Error {
  constructor(public readonly code: 'smtp_connect' | 'smtp_timeout' | 'smtp_tls' | 'smtp_auth' | 'smtp_recipient' | 'smtp_send') {
    super(code);
  }
}

function base64(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodedHeader(value: string): string {
  // Keep each encoded word below RFC 2047's 75-character limit, splitting at
  // Unicode codepoint boundaries so Chinese names and subjects remain intact.
  const chunks: string[] = [];
  let chunk = '';
  for (const char of value) {
    if (new TextEncoder().encode(chunk + char).length > 42) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => `=?UTF-8?B?${base64(part)}?=`).join('\r\n ');
}

function messageData(config: SMTPConfig, message: MailMessage): string {
  const body = base64(message.text.replace(/\r?\n/g, '\r\n')).match(/.{1,76}/g)?.join('\r\n') ?? '';
  return [
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${config.fromEmail.split('@')[1]}>`,
    `From: ${config.fromName ? encodedHeader(config.fromName) + ' ' : ''}<${config.fromEmail}>`,
    `To: <${message.to}>`,
    `Subject: ${encodedHeader(message.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', body, '.', '',
  ].join('\r\n');
}

class SMTPConversation {
  lastCode = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = '';
  private decoder = new TextDecoder();
  constructor(socket: SMTPSocket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }
  release() { this.reader.releaseLock(); this.writer.releaseLock(); }
  write(value: string) { return this.writer.write(new TextEncoder().encode(value)); }
  async reply(allowed: number[], failure: SMTPError['code'] = 'smtp_send'): Promise<string> {
    const lines: string[] = [];
    let code: string | undefined;
    let length = 0;
    while (true) {
      let end = this.buffer.indexOf('\r\n');
      while (end === -1) {
        const part = await this.reader.read();
        if (part.done) throw new SMTPError(failure);
        this.buffer += this.decoder.decode(part.value, { stream: true });
        if (this.buffer.length > 32_768) throw new SMTPError(failure);
        end = this.buffer.indexOf('\r\n');
      }
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      // SMTP permits a final reply containing only its three-digit code.
      const match = /^(\d{3})(?:([ -])(.*))?$/.exec(line);
      length += line.length;
      if (!match || length > 32_768 || (code && match[1] !== code)) throw new SMTPError(failure);
      code = match[1];
      lines.push(match[3] ?? '');
      if (match[2] !== '-') {
        this.lastCode = Number(code);
        if (!allowed.includes(Number(code))) throw new SMTPError(failure);
        return lines.join('\n');
      }
    }
  }
  async command(value: string, allowed: number[], failure?: SMTPError['code']) {
    await this.write(value + '\r\n');
    return this.reply(allowed, failure);
  }
}

async function cloudflareConnect(config: SMTPConfig): Promise<SMTPSocket> {
  const { connect } = await import('cloudflare:sockets');
  return connect({ hostname: config.host, port: config.port }, {
    secureTransport: config.security === 'tls' ? 'on' : 'starttls',
    allowHalfOpen: false,
  });
}

/** Submit one private message; success means the SMTP server accepted DATA. */
export async function sendMail(env: Bindings, config: SMTPConfig, message: MailMessage): Promise<void> {
  // Defense in depth: all callers, including future endpoints, must not inject
  // SMTP envelope commands. Body/header content is encoded, never interpreted.
  const mailbox = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
  if (![config.fromEmail, message.to].every((value) => value.length <= 254 && mailbox.test(value)) ||
      /[\r\n\0]/.test(config.username + config.password) || !['tls', 'starttls'].includes(config.security)) {
    throw new SMTPError('smtp_send');
  }
  if (env.MAILER) return env.MAILER.send(config, message);
  let socket: SMTPSocket | undefined;
  let timedOut = false;
  let stage: SMTPError['code'] = 'smtp_connect';
  const close = () => { void socket?.close().catch(() => {}); };
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; close(); reject(new SMTPError('smtp_timeout')); }, 15_000);
  });
  const run = async () => {
    socket = await (env.SMTP_CONNECT ?? cloudflareConnect)(config);
    socket.closed.catch(() => {});
    // A connector can finish after our deadline; observe both promises before
    // closing that late socket, including a handshake rejected by close().
    socket.opened.catch(() => {});
    if (timedOut) { close(); throw new SMTPError('smtp_timeout'); }
    await socket.opened;
    let smtp = new SMTPConversation(socket);
    await smtp.reply([220], 'smtp_connect');
    let capabilities = await smtp.command('EHLO qota.local', [250]);
    if (config.security === 'starttls') {
      stage = 'smtp_tls';
      if (!/^STARTTLS\b/im.test(capabilities)) throw new SMTPError('smtp_tls');
      await smtp.command('STARTTLS', [220], 'smtp_tls');
      smtp.release();
      socket = socket.startTls();
      socket.closed.catch(() => {});
      await socket.opened;
      smtp = new SMTPConversation(socket);
      capabilities = await smtp.command('EHLO qota.local', [250], 'smtp_tls');
    }
    stage = 'smtp_auth';
    const auth = capabilities.split('\n').find((line) => /^AUTH(?:[ =])/i.test(line)) ?? '';
    if (/\bPLAIN\b/i.test(auth)) {
      const token = base64(`\0${config.username}\0${config.password}`);
      // RFC 4954 requires challenge mode when an initial response would exceed
      // SMTP's 512-byte command limit (the token is ASCII, including CRLF).
      const command = `AUTH PLAIN ${token}`;
      await smtp.command(command.length + 2 <= 512 ? command : 'AUTH PLAIN', [235, 334], 'smtp_auth');
      // Most servers accept an initial response; some still issue a challenge.
      if (smtp.lastCode === 334) await smtp.command(token, [235], 'smtp_auth');
    } else if (/\bLOGIN\b/i.test(auth)) {
      await smtp.command('AUTH LOGIN', [334], 'smtp_auth');
      await smtp.command(base64(config.username), [334], 'smtp_auth');
      await smtp.command(base64(config.password), [235], 'smtp_auth');
    } else {
      throw new SMTPError('smtp_auth');
    }
    stage = 'smtp_send';
    await smtp.command(`MAIL FROM:<${config.fromEmail}>`, [250]);
    await smtp.command(`RCPT TO:<${message.to}>`, [250, 251], 'smtp_recipient');
    await smtp.command('DATA', [354]);
    await smtp.write(messageData(config, message));
    await smtp.reply([250]);
    // DATA was accepted; a failed QUIT must never make a delivered message
    // look retryable. Closing the socket is enough to finish this session.
  };
  try {
    await Promise.race([run(), timeout]);
  } catch (error) {
    throw error instanceof SMTPError ? error : new SMTPError(stage);
  } finally {
    clearTimeout(timer!);
    close();
  }
}
