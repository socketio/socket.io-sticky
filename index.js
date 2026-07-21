const cluster = require("cluster");
const debug = require("debug")("socket.io-sticky");

function destroySocket() {
  this.destroy();
}

function closeSocket(socket, httpStatus) {
  socket.on("error", destroySocket);
  socket.once("finish", destroySocket);

  socket.end(
    "HTTP/1.1 " +
      httpStatus +
      "\r\n" +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n"
  );
}

function getContentLength(header) {
  const match = /content-length:\s*(\d+)/i.exec(header);
  return match ? parseInt(match[1], 10) : 0;
}

function hasTransferEncoding(header) {
  return /transfer-encoding:/i.test(header);
}

const setupMaster = (httpServer, opts) => {
  if (!cluster.isPrimary) {
    throw new Error("not primary");
  }

  const options = Object.assign(
    {
      loadBalancingMethod: "least-connection", // either "random", "round-robin" or "least-connection"
      maxHttpBufferSize: 1e6,
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
    let workerId;
    let chunks = [];
    let totalLength = 0;
    let expectedLength;
    let buffering = false;
    let forwarded = false;

    const sendCallback = (err) => {
      if (err) {
        socket.destroy();
      }
    };

    const forward = (data) => {
      if (forwarded) {
        return;
      }

      const worker = cluster.workers[workerId];

      if (!worker) {
        debug("worker %s not available, destroying socket", workerId);
        closeSocket(socket, "503 Service Unavailable");
        return;
      }

      forwarded = true;
      socket.removeAllListeners("data");

      debug("forwarding connection to worker %s", workerId);

      worker.send({ type: "sticky:connection", data }, socket, sendCallback);
    };

    socket.on("data", (chunk) => {
      if (Object.keys(cluster.workers).length === 0) {
        debug("no workers available, destroying socket");
        if (workerId) {
          // the socket was already assigned to a worker, so we destroy it directly
          socket.destroy();
        } else {
          closeSocket(socket, "503 Service Unavailable");
        }
        return;
      }

      chunks.push(chunk);
      totalLength += chunk.byteLength;

      if (totalLength > options.maxHttpBufferSize) {
        closeSocket(socket, "413 Payload Too Large");
        return;
      }

      if (!workerId) {
        const buffer = Buffer.concat(chunks, totalLength);
        const i = buffer.indexOf("\r\n\r\n");

        if (i === -1) {
          return;
        }

        const headerLength = i + 4;
        const header = buffer.subarray(0, headerLength).toString();
        workerId = computeWorkerId(header);

        const contentLength = getContentLength(header);
        const mayHaveBody = contentLength > 0 || hasTransferEncoding(header);

        if (!mayHaveBody) {
          forward(buffer);
          return;
        }

        buffering = true;

        if (contentLength > 0) {
          expectedLength = headerLength + contentLength;
        }
      }

      if (buffering && expectedLength && totalLength >= expectedLength) {
        forward(Buffer.concat(chunks, totalLength));
      }

      if (buffering && !expectedLength) {
        // chunked trailer part is not supported
        const isLastChunk = chunk
          .subarray(chunk.byteLength - 5)
          .toString()
          .endsWith("0\r\n\r\n");

        if (isLastChunk) {
          forward(Buffer.concat(chunks, totalLength));
        }
      }

      if (!forwarded) {
        socket.resume();
      }
    });
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

  io.httpServer.prependListener("request", (req, res) => {
    // disable HTTP keep-alive to prevent connection reuse for another session
    res.setHeader("Connection", "close");
  });

  process.on("message", ({ type, data }, socket) => {
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
          "received connection from primary (byteLength: %d)",
          data.byteLength
        );
        socket.unshift(data); // republish complete buffer
        io.httpServer.emit("connection", socket); // inject connection

        break;
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
