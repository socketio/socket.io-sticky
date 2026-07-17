const cluster = require("cluster");
const { randomBytes } = require("crypto");
const debug = require("debug")("socket.io-sticky");

const randomId = () => randomBytes(8).toString("hex");

function destroySocket() {
  this.destroy();
}

const setupMaster = (httpServer, opts) => {
  if (!cluster.isMaster) {
    throw new Error("not master");
  }

  const options = Object.assign(
    {
      loadBalancingMethod: "least-connection", // either "random", "round-robin" or "least-connection"
    },
    opts
  );

  debug("setting up primary with options %o", options);

  const sessionIdToWorker = new Map();
  const sidRegex = /sid=([\w\-]{20})/;
  let currentIndex = 0; // for round-robin load balancing

  const computeWorkerId = (data) => {
    const match = sidRegex.exec(data);
    if (match) {
      const sid = match[1];
      const workerId = sessionIdToWorker.get(sid);
      if (workerId && cluster.workers[workerId]) {
        debug("sid %s matched to worker %s", sid, workerId);
        return workerId;
      }
    }
    switch (options.loadBalancingMethod) {
      case "random": {
        const workerIds = Object.keys(cluster.workers);
        const workerId =
          workerIds[Math.floor(Math.random() * workerIds.length)];
        debug("randomly selected worker %s", workerId);
        return workerId;
      }
      case "round-robin": {
        const workerIds = Object.keys(cluster.workers);
        currentIndex++;
        if (currentIndex >= workerIds.length) {
          currentIndex = 0;
        }
        const workerId = workerIds[currentIndex];
        debug("round-robin selected worker %s", workerId);
        return workerId;
      }
      case "least-connection":
        let leastActiveWorker;
        for (const id in cluster.workers) {
          const worker = cluster.workers[id];
          if (leastActiveWorker === undefined) {
            leastActiveWorker = worker;
          } else {
            const c1 = worker.clientsCount || 0;
            const c2 = leastActiveWorker.clientsCount || 0;
            if (c1 < c2) {
              leastActiveWorker = worker;
            }
          }
        }
        debug("least-connection selected worker %s", leastActiveWorker.id);
        return leastActiveWorker.id;
    }
  };

  httpServer.on("connection", (socket) => {
    let workerId, connectionId;

    const sendCallback = (err) => {
      if (err) {
        socket.destroy();
      }
    };

    socket.on("data", (buffer) => {
      if (Object.keys(cluster.workers).length === 0) {
        debug("no workers available, destroying socket");
        if (workerId) {
          // the socket was already assigned to a worker, so we destroy it directly
          socket.destroy();
        } else {
          socket.on("error", destroySocket);
          socket.once("finish", destroySocket);

          socket.end(`HTTP/1.1 503 Service Unavailable\r\n
          Connection: 'close'\r\n
          Content-Length: 0\r\n
          \r\n`);
        }
        return;
      }
      const data = buffer.toString();
      if (workerId && connectionId) {
        debug(
          "forwarding chunk (length: %d) to worker %s (connectionId: %s)",
          data.length,
          workerId,
          connectionId
        );
        cluster.workers[workerId].send(
          { type: "sticky:http-chunk", data, connectionId },
          sendCallback
        );
        return;
      }
      workerId = computeWorkerId(data);

      const head = data.substring(0, data.indexOf("\r\n\r\n")).toLowerCase();
      const mayHaveMultipleChunks =
        head.includes("content-length:") || head.includes("transfer-encoding:");

      if (mayHaveMultipleChunks) {
        connectionId = randomId();
      }
      debug(
        "forwarding connection (chunk length: %d) to worker %s (connectionId: %s)",
        data.length,
        workerId,
        connectionId
      );
      cluster.workers[workerId].send(
        { type: "sticky:connection", data, connectionId },
        socket,
        {
          keepOpen: mayHaveMultipleChunks,
        },
        sendCallback
      );
    });
  });

  // this is needed to properly detect the end of the HTTP request body
  httpServer.on("request", (req) => {
    req.on("data", () => {});
  });

  cluster.on("message", (worker, { type, data }) => {
    switch (type) {
      case "sticky:connection":
        debug("session %s bound to worker %s", data, worker.id);
        sessionIdToWorker.set(data, worker.id);
        if (options.loadBalancingMethod === "least-connection") {
          worker.clientsCount = (worker.clientsCount || 0) + 1;
        }
        break;
      case "sticky:disconnection":
        debug("session %s unbound from worker %s", data, worker.id);
        sessionIdToWorker.delete(data);
        if (options.loadBalancingMethod === "least-connection") {
          worker.clientsCount--;
        }
        break;
    }
  });

  cluster.on("exit", (worker) => {
    debug("worker %s exited, cleaning up sessions", worker.id);
    sessionIdToWorker.forEach((value, key) => {
      if (value === worker.id) {
        sessionIdToWorker.delete(key);
      }
    });
  });
};

const setupWorker = (io) => {
  if (!cluster.isWorker) {
    throw new Error("not worker");
  }

  // store connections that may receive multiple chunks
  const sockets = new Map();

  process.on("message", ({ type, data, connectionId }, socket) => {
    switch (type) {
      case "sticky:connection":
        if (!socket) {
          debug(
            "ignoring connection from primary because the socket is closed"
          );
          // might happen if the socket is closed during the transfer to the worker
          // see https://nodejs.org/api/child_process.html#child_process_example_sending_a_socket_object
          return;
        }
        debug(
          "received connection from primary (connectionId: %s)",
          connectionId
        );
        io.httpServer.emit("connection", socket); // inject connection
        socket.emit("data", Buffer.from(data)); // republish first chunk
        socket.resume();

        if (connectionId) {
          sockets.set(connectionId, socket);

          socket.on("close", () => {
            sockets.delete(connectionId);
          });
        }

        break;

      case "sticky:http-chunk": {
        const socket = sockets.get(connectionId);
        if (socket) {
          debug("received chunk for connection %s", connectionId);
          socket.emit("data", Buffer.from(data));
        } else {
          debug("received chunk for unknown connection %s", connectionId);
        }
        break;
      }
    }
  });

  const ignoreError = () => {}; // the next request will fail anyway

  io.engine.on("connection", (socket) => {
    debug("new connection %s", socket.id);
    process.send({ type: "sticky:connection", data: socket.id }, ignoreError);

    socket.once("close", () => {
      debug("connection %s closed", socket.id);
      process.send(
        { type: "sticky:disconnection", data: socket.id },
        ignoreError
      );
    });
  });
};

module.exports = {
  setupMaster,
  setupWorker,
};
