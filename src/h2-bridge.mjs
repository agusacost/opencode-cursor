#!/usr/bin/env node
/**
 * Dumb HTTP/2 bidirectional pipe for Cursor gRPC.
 *
 * Bun's node:http2 can be unreliable against Cursor's API. This Node script acts as a transparent
 * HTTP/2 proxy: it opens a single bidirectional stream and ferries raw bytes between the parent
 * process (via stdin/stdout) and Cursor.
 *
 * Protocol (length-prefixed framing over stdin/stdout):
 * [4 bytes big-endian length][payload]
 *
 * First message on stdin is JSON config:
 * { "accessToken": "...", "url": "...", "path": "...", "unary": false }
 *
 * When unary=true, the bridge uses application/proto (raw protobuf) instead
 * of application/connect+proto (Connect streaming). The single stdin message
 * is written as the request body and the stream is ended immediately.
 */
import http2 from "node:http2";
import crypto from "node:crypto";

const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";

function writeMessage(data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  process.stdout.write(lenBuf);
  process.stdout.write(data);
}

let stdinBuf = Buffer.alloc(0);
let stdinResolve = null;
let stdinEnded = false;

process.stdin.on("data", (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  if (stdinResolve) {
    const r = stdinResolve;
    stdinResolve = null;
    r();
  }
});

process.stdin.on("end", () => {
  stdinEnded = true;
  if (stdinResolve) {
    const r = stdinResolve;
    stdinResolve = null;
    r();
  }
});

function waitForData() {
  return new Promise((resolve) => {
    stdinResolve = resolve;
  });
}

async function readExact(n) {
  while (stdinBuf.length < n) {
    if (stdinEnded) return null;
    await waitForData();
  }
  const result = stdinBuf.subarray(0, n);
  stdinBuf = stdinBuf.subarray(n);
  return Buffer.from(result);
}

async function readMessage() {
  const lenBuf = await readExact(4);
  if (!lenBuf) return null;
  const len = lenBuf.readUInt32BE(0);
  if (len === 0) return Buffer.alloc(0);
  return readExact(len);
}

const configBuf = await readMessage();
if (!configBuf) process.exit(1);

const config = JSON.parse(configBuf.toString("utf8"));
const { accessToken, url, path: rpcPath, unary } = config;

const client = http2.connect(url || "https://api2.cursor.sh");

const MAX_LIFETIME_MS = 5 * 60 * 1000; // 5-minute hard cap regardless of activity
const bridgeStartTime = Date.now();

let timeout = setTimeout(killBridge, 30_000);
function resetTimeout() {
  if (Date.now() - bridgeStartTime >= MAX_LIFETIME_MS) {
    killBridge();
    return;
  }
  clearTimeout(timeout);
  timeout = setTimeout(killBridge, 120_000);
}

function killBridge() {
  clearTimeout(timeout);
  client.destroy();
  process.exit(1);
}

client.on("error", () => {
  clearTimeout(timeout);
  process.exit(1);
});

const headers = {
  ":method": "POST",
  ":path": rpcPath || "/agent.v1.AgentService/Run",
  "content-type": unary ? "application/proto" : "application/connect+proto",
  te: "trailers",
  authorization: `Bearer ${accessToken}`,
  "x-ghost-mode": "true",
  "x-cursor-client-version": CURSOR_CLIENT_VERSION,
  "x-cursor-client-type": "cli",
  "x-request-id": crypto.randomUUID(),
};
if (!unary) headers["connect-protocol-version"] = "1";

const h2Stream = client.request(headers);

h2Stream.on("data", (chunk) => {
  resetTimeout();
  writeMessage(chunk);
});

h2Stream.on("end", () => {
  clearTimeout(timeout);
  client.close();
  setTimeout(() => process.exit(0), 100);
});

h2Stream.on("error", () => {
  clearTimeout(timeout);
  client.close();
  process.exit(1);
});

if (unary) {
  const body = await readMessage();
  if (body && body.length > 0 && !h2Stream.closed && !h2Stream.destroyed) {
    h2Stream.end(body);
  } else {
    h2Stream.end();
  }
} else {
  (async () => {
    while (true) {
      const msg = await readMessage();
      if (!msg || msg.length === 0) break;
      if (!h2Stream.closed && !h2Stream.destroyed) {
        resetTimeout();
        h2Stream.write(msg);
      }
    }
    if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.end();
  })();
}

