const cluster = require("cluster");
const http = require("http");
const { Server } = require("socket.io");
const ioc = require("socket.io-client");
const { setupMaster, setupWorker } = require("../..");

if (cluster.isWorker) {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  setupWorker(io);
  return;
}

const WORKER_COUNT = 3;

for (let i = 0; i < WORKER_COUNT; i++) {
  cluster.fork();
}

const httpServer = http.createServer();

setupMaster(httpServer, {
  loadBalancingMethod: process.env.LB_METHOD,
});

const waitFor = (emitter, event) => {
  return new Promise((resolve) => {
    emitter.once(event, resolve);
  });
};

httpServer.listen(async () => {
  const port = httpServer.address().port;
  const socket = ioc(`http://localhost:${port}`);
  await waitFor(socket, "connect");

  socket.disconnect().connect();
  await waitFor(socket, "connect");

  socket.disconnect().connect();
  await waitFor(socket, "connect");

  // cleanup
  for (const id in cluster.workers) {
    cluster.workers[id].kill();
  }
  httpServer.close();
  socket.disconnect();
});
