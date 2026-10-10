import net from 'node:net';
import tls from 'node:tls';

// Match cloudflare:sockets while retaining certificate and hostname checking.
// Do not use Readable.toWeb here: STARTTLS must detach the original listeners
// without canceling (and therefore destroying) the underlying TCP connection.
function wrapSocket(socket, host, secure) {
  let controller;
  let ended = false;
  const onData = (data) => {
    if (ended) return;
    controller.enqueue(new Uint8Array(data));
    // Keep an unsolicited or very large reply from filling an unbounded queue
    // while the SMTP client is waiting for a write or processing another step.
    if (controller.desiredSize <= 0) socket.pause();
  };
  const onEnd = () => { if (!ended) { ended = true; controller.close(); } };
  const onError = (error) => { if (!ended) { ended = true; controller.error(error); } };
  const readable = new ReadableStream({
    start(value) {
      controller = value;
      socket.on('data', onData);
      socket.on('end', onEnd);
      socket.on('error', onError);
      socket.on('close', onEnd);
    },
    pull() { if (!ended) socket.resume(); },
    cancel() { ended = true; socket.destroy(); },
  });
  const writable = new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        socket.write(chunk, (error) => error ? reject(error) : resolve());
      });
    },
    close() { socket.end(); },
    abort() { socket.destroy(); },
  });
  const opened = new Promise((resolve, reject) => {
    const event = secure ? 'secureConnect' : 'connect';
    const cleanup = () => {
      socket.removeListener(event, onOpen);
      socket.removeListener('error', onFailure);
      socket.removeListener('close', onClosed);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onFailure = (error) => { cleanup(); reject(error); };
    const onClosed = () => onFailure(new Error('SMTP connection closed before opening'));
    socket.once(event, onOpen);
    socket.once('error', onFailure);
    socket.once('close', onClosed);
  });
  // Cancellation may happen before a caller starts awaiting the handshake.
  void opened.catch(() => {});
  const closed = new Promise((resolve) => socket.once('close', resolve));
  return {
    readable, writable, opened, closed,
    async close() { socket.destroy(); },
    startTls() {
      if (secure) throw new Error('socket already secured');
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
      socket.removeListener('close', onEnd);
      onEnd();
      return wrapSocket(tls.connect({ socket, servername: host, rejectUnauthorized: true, minVersion: 'TLSv1.2' }), host, true);
    },
  };
}

export function connectSMTP(config) {
  const secure = config.security === 'tls';
  const socket = secure
    ? tls.connect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' })
    : net.connect({ host: config.host, port: config.port });
  return wrapSocket(socket, config.host, secure);
}
