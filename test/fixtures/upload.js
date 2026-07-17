const cluster = require("cluster");
const http = require("http");
const { Server } = require("socket.io");
const { setupPrimary, setupWorker } = require("../..");
const assert = require("assert").strict;

if (cluster.isWorker) {
  const httpServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const data = Buffer.concat(chunks);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          contentLength: req.headers["content-length"],
          actualContentLength: data.length,
        })
      );
    });
  });

  const io = new Server(httpServer, {
    maxHttpBufferSize: 1.4 * 1e6, // to account for the base64 encoding of the binary payload
  });
  setupWorker(io);

  return;
}

cluster.setupPrimary({
  serialization: "advanced", // prevents conversion of Node.js Buffer to string over IPC
});

const WORKER_COUNT = 3;

for (let i = 0; i < WORKER_COUNT; i++) {
  cluster.fork();
}

const httpServer = http.createServer();

setupPrimary(httpServer, {
  loadBalancingMethod: process.env.LB_METHOD || "least-connection",
});

httpServer.listen(async () => {
  const port = httpServer.address().port;

  const res = await fetch(`http://localhost:${port}/`, {
    method: "POST",
    body: Buffer.allocUnsafe(1e6),
  });

  assert.equal(res.status, 200);

  const body = await res.json();

  assert.equal(body.contentLength, "1000000");
  assert.equal(body.actualContentLength, 1_000_000);

  // cleanup
  for (const id in cluster.workers) {
    cluster.workers[id].kill();
  }

  httpServer.close();
});
