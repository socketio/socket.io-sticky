const cluster = require("cluster");
const { createServer, Agent } = require("http");
const { Server } = require("socket.io");
const { setupMaster, setupWorker } = require("../..");
const assert = require("assert").strict;
const { sendRequest } = require("./util");

if (cluster.isWorker) {
  const httpServer = createServer();
  const io = new Server(httpServer);
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

httpServer.listen(async () => {
  const port = httpServer.address().port;

  const agent1 = new Agent({ keepAlive: true });
  const agent2 = new Agent({ keepAlive: true });

  // Engine.IO handshake on connection 1
  const res1 = await sendRequest({
    agent: agent1,
    port,
    method: "get",
    path: "/socket.io/?EIO=4&transport=polling",
  });

  assert.equal(res1.statusCode, 200);

  const sid = JSON.parse(res1.body.toString().substring(1)).sid;

  // Engine.IO handshake on connection 2
  const res2 = await sendRequest({
    agent: agent2,
    port,
    method: "get",
    path: "/socket.io/?EIO=4&transport=polling",
  });

  assert.equal(res2.statusCode, 200);

  // Socket.IO handshake on connection 2
  const res3 = await sendRequest(
    {
      agent: agent2,
      port,
      method: "post",
      path: `/socket.io/?EIO=4&transport=polling&sid=${sid}`,
    },
    "40"
  );

  // FIXME "session ID unknown"
  assert.equal(res3.statusCode, 400);

  // cleanup
  for (const id in cluster.workers) {
    cluster.workers[id].kill();
  }
  httpServer.close();
});
