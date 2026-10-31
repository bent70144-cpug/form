#!/usr/bin/env node
/**
 * Dev SMTP sink — the decided Mailpit substitute for this environment
 * (docs/adr/0001-local-infra-substitutes.md). Zero dependencies.
 *
 * - SMTP server on SMTP_PORT (default 1025): accepts any mail and stores it.
 * - REST endpoint on SINK_HTTP_PORT (default 8025, Mailpit's native UI/API port):
 *     GET    /dev/mailbox  → { messages: [...] }
 *     DELETE /dev/mailbox  → clears the box
 *
 * docker-compose.yml still ships Mailpit for Docker-capable environments; the
 * default local path (supervisor dev mode) uses this sink so verification
 * emails (ticket 03+) can be inspected without Docker.
 */
import net from "node:net";
import http from "node:http";

export function createMailSink({ smtpPort = 1025, httpPort = 8025 } = {}) {
  const messages = [];
  let nextId = 1;

  const smtpServer = net.createServer((socket) => {
    let buffer = "";
    let mode = "command"; // command | data
    let envelope = { from: "", to: [] };
    let dataLines = [];
    let currentRecipient = "";

    const send = (line) => socket.write(`${line}\r\n`);
    send("220 form-dev-mail-sink SMTP");

    socket.on("error", () => {
      /* client vanished; nothing to do */
    });
    socket.on("close", () => {
      /* done */
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        // Split on CRLF (2 bytes) or bare LF (1 byte); slicing must consume
        // the whole separator or the next line gains a stray leading "\n".
        let idx = buffer.indexOf("\r\n");
        let sep = 2;
        if (idx < 0) {
          idx = buffer.indexOf("\n");
          sep = 1;
        }
        if (idx < 0) break;
        const rawLine = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + sep);
        if (mode === "data") {
          if (rawLine === ".") {
            messages.push({
              id: nextId++,
              from: envelope.from,
              to: envelope.to,
              receivedAt: new Date().toISOString(),
              raw: dataLines.join("\n"),
            });
            dataLines = [];
            envelope = { from: "", to: [] };
            mode = "command";
            send("250 OK message stored");
          } else {
            dataLines.push(rawLine);
          }
          continue;
        }
        const line = rawLine.toUpperCase();
        if (line.startsWith("EHLO") || line.startsWith("HELO")) {
          send("250 form-dev-mail-sink greets you");
        } else if (line.startsWith("MAIL FROM:")) {
          envelope.from = rawLine.slice("MAIL FROM:".length).trim();
          send("250 OK");
        } else if (line.startsWith("RCPT TO:")) {
          currentRecipient = rawLine.slice("RCPT TO:".length).trim();
          envelope.to.push(currentRecipient);
          send("250 OK");
        } else if (line.startsWith("DATA")) {
          mode = "data";
          send("354 End data with <CR><LF>.<CR><LF>");
        } else if (line.startsWith("RSET")) {
          envelope = { from: "", to: [] };
          dataLines = [];
          send("250 OK");
        } else if (line.startsWith("NOOP")) {
          send("250 OK");
        } else if (line.startsWith("QUIT")) {
          send("221 Bye");
          socket.end();
        } else {
          send("250 OK");
        }
      }
    });
  });

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/dev/mailbox") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages }));
      return;
    }
    if (req.method === "DELETE") {
      messages.length = 0;
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
  });

  let smtpAddress = null;
  let httpAddress = null;

  const api = {
    smtpPort,
    httpPort,
    messages: () => messages.map((m) => ({ ...m })),
    async start() {
      await new Promise((resolve, reject) => {
        smtpServer.once("error", reject);
        smtpServer.listen(smtpPort, "127.0.0.1", () => {
          smtpServer.off("error", reject);
          smtpAddress = smtpServer.address();
          resolve();
        });
      });
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(httpPort, "127.0.0.1", () => {
          httpServer.off("error", reject);
          httpAddress = httpServer.address();
          resolve();
        });
      });
      // Reflect the actually-bound ports (port 0 = ephemeral) on the handle.
      api.smtpPort = smtpAddress?.port ?? api.smtpPort;
      api.httpPort = httpAddress?.port ?? api.httpPort;
      return { smtpPort: api.smtpPort, httpPort: api.httpPort };
    },
    async stop() {
      await Promise.all([
        new Promise((resolve) => smtpServer.close(() => resolve())),
        new Promise((resolve) => httpServer.close(() => resolve())),
      ]);
    },
  };
  return api;
}

const isMain =
  process.argv[1] &&
  new URL(`file://${process.argv[1]}`).href === import.meta.url;
if (isMain) {
  const sink = createMailSink({
    smtpPort: Number(process.env.SMTP_PORT ?? 1025),
    httpPort: Number(process.env.SINK_HTTP_PORT ?? 8025),
  });
  sink
    .start()
    .then(() => {
      process.stdout.write(
        `[mail-sink] smtp on 127.0.0.1:${sink.smtpPort} http on 127.0.0.1:${sink.httpPort} (GET /dev/mailbox)\n`,
      );
    })
    .catch((err) => {
      process.stderr.write(`[mail-sink] ${err?.stack ?? err}\n`);
      process.exit(1);
    });
  const stop = () => sink.stop().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
