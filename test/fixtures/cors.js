const cluster = require("cluster");
const { createServer, request } = require("http");
const { Server } = require("socket.io");
const { setupMaster, setupWorker } = require("../..");
const assert = require("assert").strict;
const { sendRequest } = require("./util");

if (cluster.isWorker) {
  const httpServer = createServer();
  const io = new Server(httpServer, {
    cors: {
      origin: true,
    },
  });
  setupWorker(io);

  io.on("connection", (socket) => {
    socket.on("foo", (val) => {
      socket.emit("bar", val);
    });
  });

  return;
}

const WORKER_COUNT = 3;

for (let i = 0; i < WORKER_COUNT; i++) {
  cluster.fork();
}

const httpServer = createServer();

setupMaster(httpServer, {
  loadBalancingMethod: process.env.LB_METHOD || "least-connection",
});

const waitFor = (emitter, event) => {
  return new Promise((resolve) => {
    emitter.once(event, resolve);
  });
};

httpServer.listen(async () => {
  const port = httpServer.address().port;

  const res = await sendRequest({
    port,
    method: "options",
    path: "/socket.io/",
    headers: {
      origin: "https://example.com",
    },
  });

  assert.equal(res.statusCode, 204);

  assert.equal(
    res.headers["access-control-allow-origin"],
    "https://example.com"
  );

  // cleanup
  for (const id in cluster.workers) {
    cluster.workers[id].kill();
  }
  httpServer.close();
});
