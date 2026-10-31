import net from "node:net";

/**
 * Minimal SMTP client (zero-dependency) — enough for the dev mail sink and
 * any RFC 5321-ish relay in local development. Used ONLY by the dev
 * adapter (`MailSinkEmailProvider`); deployed environments use the HTTPS
 * provider. Not a general-purpose mailer.
 *
 * The conversation is strictly sequential: one command, one (possibly
 * multi-line) reply. Replies are matched by their final line's status code.
 */

export interface SendMailOptions {
  host: string;
  port: number;
  from: string;
  to: string;
  subject: string;
  text: string;
  connectTimeoutMs?: number;
}

class SmtpSession {
  private buffer = "";
  private waiters: Array<{ test: (reply: string) => boolean; resolve: (reply: string) => void; reject: (err: Error) => void }> = [];

  constructor(private readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.flush();
    });
    socket.on("error", (err) => this.failAll(err));
    socket.on("close", () => this.failAll(new Error("SMTP connection closed")));
  }

  private flush() {
    // A reply is complete when a line is "<code> <text>" (space, not dash).
    // Everything up to and including that line is one reply (EHLO can be
    // multi-line with "<code>-<text>" continuation lines before it).
    const lines = this.buffer.split(/\r?\n/);
    let end = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (/^\d{3} /.test(line)) {
        end = i;
        break;
      }
    }
    if (end === -1) return;
    const reply = lines.slice(0, end + 1).join("\n").trim();
    this.buffer = lines.slice(end + 1).join("\n");
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.test(reply)) waiter.resolve(reply);
      else waiter.reject(new Error(`Unexpected SMTP reply: ${reply.split("\n").pop()}`));
    }
  }

  private failAll(err: Error) {
    while (this.waiters.length > 0) this.waiters.shift()?.reject(err);
  }

  /** Waits for a reply whose status starts with `code`. */
  expect(code: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiters.push({
        test: (reply) => reply.startsWith(code),
        resolve,
        reject,
      });
      this.flush();
    });
  }

  send(command: string) {
    this.socket.write(`${command}\r\n`);
  }
}

function connect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`SMTP connect timeout after ${timeoutMs}ms (${host}:${port})`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Sends one plain-text mail. Resolves after the server accepts the DATA. */
export async function sendMailViaSmtp(options: SendMailOptions): Promise<void> {
  const socket = await connect(options.host, options.port, options.connectTimeoutMs ?? 5_000);
  const session = new SmtpSession(socket);
  try {
    await session.expect("220");
    session.send("EHLO form-auth");
    await session.expect("250");
    session.send(`MAIL FROM:${options.from}`);
    await session.expect("250");
    session.send(`RCPT TO:${options.to}`);
    await session.expect("250");
    session.send("DATA");
    await session.expect("354");
    // Header injection guard: strip CR/LF from header values.
    const header = (v: string) => v.replace(/[\r\n]+/g, " ");
    const body = [
      `From: ${header(options.from)}`,
      `To: ${header(options.to)}`,
      `Subject: ${header(options.subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      options.text,
      "",
    ].join("\r\n");
    // Dot-stuffing per RFC 5321 so a leading "." in the body cannot end DATA.
    const stuffed = body.replace(/(^|\r\n)\./g, "$1..");
    session.send(stuffed);
    session.send(".");
    await session.expect("250");
    session.send("QUIT");
  } finally {
    socket.destroy();
  }
}
