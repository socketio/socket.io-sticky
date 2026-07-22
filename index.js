const cluster = require("cluster");
const { randomBytes } = require("crypto");
const { Duplex } = require("stream");
const debug = require("debug")("socket.io-sticky");

const randomId = () => randomBytes(8).toString("hex");

function destroySocket() {
  this.destroy();
}

const setupMaster = (httpServer, opts) => {
  if (!cluster.isPrimary) {
    throw new Error("not primary");
  }

  const options = Object.assign(
    {
      loadBalancingMethod: "least-connection", // either "random", "round-robin" or "least-connection"
    },
    opts
  );

  debug("setting up primary with options %o", options);

  const sessionIdToWorker = new Map();
  const sockets = new Map();
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
        const workerId = workerIds[currentIndex % workerIds.length];
        currentIndex = (currentIndex + 1) % workerIds.length;
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

    socket.removeAllListeners("data");

    socket.on("data", (chunk) => {
      if (Object.keys(cluster.workers).length === 0) {
        debug("no workers available, destroying socket");
        if (workerId) {
          // the socket was already assigned to a worker, so we destroy it directly
          socket.destroy();
        } else {
          socket.on("error", destroySocket);
          socket.once("finish", destroySocket);

          socket.end(
            "HTTP/1.1 503 Service Unavailable\r\n" +
              "Connection: close\r\n" +
              "Content-Length: 0\r\n" +
              "\r\n"
          );
        }
        return;
      }
      if (workerId && cluster.workers[workerId] && connectionId) {
        debug(
          "forwarding chunk (chunk length: %d) to worker %s (connectionId: %s)",
          chunk.byteLength,
          workerId,
          connectionId
        );
        cluster.workers[workerId].send(
          { type: "sticky:http-chunk", data: chunk, connectionId },
          sendCallback
        );
        return;
      }

      const header = chunk
        .subarray(0, chunk.indexOf(Buffer.from("\r\n\r\n")))
        .toString();

      workerId = computeWorkerId(header);

      const lowHeader = header.toLowerCase();
      const mayHaveMultipleChunks =
        lowHeader.includes("content-length:") ||
        lowHeader.includes("transfer-encoding:");

      // If the full request is not contained in the first chunk, the primary must
      // keep ownership of the real socket and forward next chunks over IPC.
      // Sending the socket handle to the worker in that case would let both the
      // primary and the worker read from the same stream, so request bytes could be
      // split unpredictably between the two processes. Instead, the worker receives
      // a FakeSocket whose readable side is fed explicitly by IPC chunks.
      if (!mayHaveMultipleChunks) {
        debug(
          "forwarding connection (chunk length: %d) to worker %s",
          chunk.byteLength,
          workerId
        );

        cluster.workers[workerId].send(
          {
            type: "sticky:connection",
            data: chunk,
          },
          socket,
          sendCallback
        );
        return;
      }

      connectionId = randomId();
      sockets.set(connectionId, socket);
      debug(
        "forwarding connection (chunk length: %d) to worker %s (connectionId: %s)",
        chunk.byteLength,
        workerId,
        connectionId
      );
      cluster.workers[workerId].send(
        {
          type: "sticky:http-chunk-start",
          data: chunk,
          connectionId,
          socketInfo: {
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort,
            localAddress: socket.localAddress,
            localPort: socket.localPort,
          },
        },
        sendCallback
      );
    });

    socket.on("close", () => {
      if (connectionId && sockets.has(connectionId)) {
        sockets.delete(connectionId);

        if (workerId && cluster.workers[workerId]) {
          cluster.workers[workerId].send({
            type: "sticky:abort",
            connectionId,
          });
        }
      }
    });
  });

  cluster.on("message", (worker, message) => {
    const { type, data } = message;
    switch (type) {
      case "sticky:http-response": {
        const { connectionId } = message;
        const socket = sockets.get(connectionId);
        if (socket && !socket.destroyed) {
          socket.write(data);
        }
        break;
      }
      case "sticky:http-response-end": {
        const { connectionId } = message;
        const socket = sockets.get(connectionId);
        if (socket && !socket.destroyed) {
          socket.end();
        }
        sockets.delete(connectionId);
        break;
      }
      case "sticky:http-response-destroy": {
        const { connectionId, error } = message;
        const socket = sockets.get(connectionId);
        if (socket && !socket.destroyed) {
          socket.destroy(error ? new Error(error) : undefined);
        }
        sockets.delete(connectionId);
        break;
      }
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

class FakeSocket extends Duplex {
  constructor(socketInfo, connectionId) {
    super({
      allowHalfOpen: true,
    });

    this.connectionId = connectionId;
    this.remoteAddress = socketInfo.remoteAddress;
    this.remotePort = socketInfo.remotePort;
    this.localAddress = socketInfo.localAddress;
    this.localPort = socketInfo.localPort;
  }

  _read(size) {}

  _write(chunk, encoding, callback) {
    if (!process.connected) {
      callback();
      return;
    }

    process.send(
      {
        type: "sticky:http-response",
        data: chunk,
        connectionId: this.connectionId,
      },
      callback
    );
  }

  _final(callback) {
    if (!process.connected) {
      callback();
      return;
    }

    process.send(
      {
        type: "sticky:http-response-end",
        connectionId: this.connectionId,
      },
      callback
    );
  }

  _destroy(err, callback) {
    if (this._aborted) {
      callback();
      return;
    }

    if (!process.connected) {
      callback(err);
      return;
    }

    process.send(
      {
        type: "sticky:http-response-destroy",
        connectionId: this.connectionId,
        error: err && err.message,
      },
      () => callback(err)
    );
  }

  addChunk(chunk) {
    if (this.destroyed || this.readableEnded) {
      return;
    }

    this.push(chunk);
  }

  abort() {
    this._aborted = true;
    this.destroy(new Error("client connection closed"));
  }

  destroySoon() {
    this.end();
  }

  cork() {
    return this;
  }

  uncork() {
    return this;
  }

  setTimeout(timeout, callback) {
    if (callback) {
      this.once("timeout", callback);
    }

    return this;
  }

  setNoDelay() {
    return this;
  }

  setKeepAlive() {
    return this;
  }

  address() {
    return {
      family: "IPv4",
      address: this.localAddress,
      port: this.localPort,
    };
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }
}

const setupWorker = (io) => {
  if (!cluster.isWorker) {
    throw new Error("not worker");
  }

  io.httpServer.prependListener("request", (req, res) => {
    // disable HTTP keep-alive to prevent connection reuse for another session
    res.setHeader("Connection", "close");
  });

  // store connections that may receive multiple chunks
  const sockets = new Map();

  process.on("message", (message, socket) => {
    const { type, data } = message;
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
        debug("received connection from primary");

        io.httpServer.emit("connection", socket); // inject connection
        socket.unshift(data); // republish first chunk
        break;

      case "sticky:http-chunk-start": {
        const { socketInfo, connectionId } = message;

        debug("received first chunk for connection %s", connectionId);
        const fakeSocket = new FakeSocket(socketInfo, connectionId);

        fakeSocket.once("close", () => {
          sockets.delete(connectionId);
        });

        io.httpServer.emit("connection", fakeSocket); // inject connection
        fakeSocket.addChunk(data); // republish first chunk
        sockets.set(connectionId, fakeSocket);
        break;
      }

      case "sticky:http-chunk": {
        const { connectionId } = message;
        const socket = sockets.get(connectionId);
        if (socket) {
          debug("received chunk for connection %s", connectionId);
          socket.addChunk(data);
        } else {
          debug("received chunk for unknown connection %s", connectionId);
        }
        break;
      }

      case "sticky:abort": {
        const { connectionId } = message;
        const socket = sockets.get(connectionId);
        if (socket) {
          socket.abort();
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
  setupPrimary: setupMaster,
  setupMaster, // kept for backward compatibility
  setupWorker,
};
