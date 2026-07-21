const cluster = require("cluster");
const http = require("http");
const { Server } = require("socket.io");
const { setupPrimary, setupWorker } = require("../..");
const assert = require("assert").strict;
const crypto = require("crypto");

function computeChecksum(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

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
          checksum: computeChecksum(data),
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

  await testUpload(port, 1e4);
  await testUpload(port, 1e6);

  await testUpload(port, 1e4, true);
  await testUpload(port, 1e6, true);

  // cleanup
  for (const id in cluster.workers) {
    cluster.workers[id].kill();
  }

  httpServer.close();
});

async function testUpload(port, payloadSize, chunked = false) {
  const uploadData = crypto.randomBytes(payloadSize);

  const res = await new Promise((resolve) => {
    const headers = {};

    if (!chunked) {
      headers["content-length"] = payloadSize;
    }

    const req = http.request(
      {
        hostname: "localhost",
        port: port,
        path: "/",
        method: "POST",
        headers,
      },
      (res) => {
        const chunks = [];

        res.on("data", (chunk) => {
          chunks.push(chunk);
        });

        res.on("end", () => {
          res.body = Buffer.concat(chunks);
          resolve(res);
        });
      }
    );

    const firstChunkSize = 100000;

    if (payloadSize > firstChunkSize) {
      req.write(uploadData.subarray(0, firstChunkSize));

      setTimeout(() => {
        req.write(uploadData.subarray(firstChunkSize));
        req.end();
      }, 50);
    } else {
      req.write(uploadData);
      req.end();
    }
  });

  assert.equal(res.statusCode, 200);

  const body = JSON.parse(res.body.toString());

  if (!chunked) {
    assert.equal(body.contentLength, String(payloadSize));
  }
  assert.equal(body.actualContentLength, payloadSize);
  assert.equal(body.checksum, computeChecksum(uploadData));
}
