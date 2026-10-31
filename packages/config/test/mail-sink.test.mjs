import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { createMailSink } from "../../scripts/mail-sink.mjs";

let sink;

beforeAll(async () => {
  sink = createMailSink({ smtpPort: 0, httpPort: 0 });
  await sink.start();
});

afterAll(async () => {
  await sink.stop();
});

/** Minimal SMTP client used to drive one message through the sink. */
function sendMail(port, { from, to, body }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const steps = [
      { expect: "220", send: `HELO test` },
      { expect: "250", send: `MAIL FROM:<${from}>` },
      { expect: "250", send: `RCPT TO:<${to}>` },
      { expect: "250", send: `DATA` },
      { expect: "354", send: body },
      { expect: "250", send: `QUIT` },
      { expect: "221", send: null },
    ];
    let buffer = "";
    let stepIndex = 0;
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const step = steps[stepIndex];
        if (!step) continue;
        expect(line.startsWith(step.expect)).toBe(true);
        if (step.send !== null) socket.write(`${step.send}\r\n`);
        stepIndex += 1;
        if (stepIndex >= steps.length) {
          socket.end();
          resolve();
        }
      }
    });
  });
}

describe("dev SMTP sink (Mailpit substitute)", () => {
  it("stores a submitted message and lists it over REST", async () => {
    await sendMail(sink.smtpPort, {
      from: "noreply@form.test",
      to: "user@example.com",
      body: "Subject: Verify your email\r\n\r\ntoken: abc123",
    });
    const res = await fetch(`http://127.0.0.1:${sink.httpPort}/dev/mailbox`);
    expect(res.status).toBe(200);
    const body = (await res.json());
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].from).toBe("noreply@form.test");
    expect(body.messages[0].to).toContain("<user@example.com>");
    expect(body.messages[0].raw).toContain("Verify your email");
  });

  it("clears the mailbox on DELETE", async () => {
    const res = await fetch(`http://127.0.0.1:${sink.httpPort}/dev/mailbox`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    const res2 = await fetch(`http://127.0.0.1:${sink.httpPort}/dev/mailbox`);
    const body = await res2.json();
    expect(body.messages).toHaveLength(0);
  });
});
