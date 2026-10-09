'use strict';

// Tiny Server-Sent Events hub: the browser keeps one stream open and refreshes
// whatever view an event touches (new message, contact change, campaign progress).
const clients = new Set();

function handleStream(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

function publish(type, payload = {}) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(frame);
}

module.exports = { handleStream, publish };
