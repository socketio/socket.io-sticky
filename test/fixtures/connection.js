const cluster = require("cluster");
const http = require("http");
const { Server } = require("socket.io");
const ioc = require("socket.io-client");
const { setupMaster, setupWorker } = require("../..");

if (cluster.isWorker) {
  const httpServer = http.createServer();
  const io = new Server(httpServer, {
    maxHttpBufferSize: 2 * 1e6,
  });
  setupWorker(io);

  io.on("connection", (socket) => {
    socket.on("foo", (val) => {
      socket.emit("bar", val);
    });
    socket.on("large", (val) => {
      socket.emit("large-bar", Buffer.allocUnsafe(1e6));
    });
  });
  return;
}

const WORKER_COUNT = 3;

for (let i = 0; i < WORKER_COUNT; i++) {
  cluster.fork();
}

const httpServer = http.createServer();

setupMaster(httpServer, {
  loadBalancingMethod: process.env.LB_METHOD || "least-connection",
});

const waitFor = (emitter, event) => {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error("timeout reached"));
    }, 3000);
    emitter.once(event, () => {
      clearTimeout(timeoutId);
      resolve();
    });
  });
};

httpServer.listen(async () => {
  let exitCode = 0;
  let socket;
  try {
    const port = httpServer.address().port;
    console.log(`Listening on port ${port}`);
    const socket = ioc(`http://localhost:${port}`, {
      transports: process.env.TRANSPORT
        ? [process.env.TRANSPORT]
        : ["polling", "websocket"],
    });

    await waitFor(socket, "connect");
    socket.disconnect().connect();
    await waitFor(socket, "connect");
    console.log("connected");
    socket.disconnect().connect();
    await waitFor(socket, "connect");
    console.log("reconnected");
    socket.emit("foo", "hello");
    await waitFor(socket, "bar");
    console.log("got hello");
    socket.emit("foo", Buffer.allocUnsafe(1e6));
    await waitFor(socket, "bar");
    console.log("sent large packet");
    socket.emit("large", "hello");
    await waitFor(socket, "large-bar");
    console.log("got large packet");
    // cleanup
    for (const id in cluster.workers) {
      cluster.workers[id].kill();
    }
    console.log("workes killed");
  } catch (e) {
    console.log(e);
    exitCode = 1;
  } finally {
    if (socket && socket.connected) socket.disconnect();
    httpServer.close(() => {
      process.exit(exitCode);
    });
  }
});
