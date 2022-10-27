const cluster = require("cluster");
const { PassThrough } = require("stream");

const isWebsocketRequest = (data) => {
    const marker = data.indexOf("\r\n\r\n");
    const headers = data.slice(0, marker).toString();
    if (/^Upgrade: websocket$/im.exec(headers)) {
        return true;
    }
    return false;
};

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

    const sessionIdToWorker = new Map();
    const sidRegex = /sid=([\w-]{20})/;
    let currentIndex = 0; // for round-robin load balancing

    const computeWorkerId = (data) => {
        const match = sidRegex.exec(data);
        if (match) {
            const sid = match[1];
            const workerId = sessionIdToWorker.get(sid);
            if (workerId && cluster.workers[workerId]) {
                return workerId;
            }
        }
        switch (options.loadBalancingMethod) {
            case "random": {
                const workerIds = Object.keys(cluster.workers);
                return workerIds[Math.floor(Math.random() * workerIds.length)];
            }
            case "round-robin": {
                const workerIds = Object.keys(cluster.workers);
                currentIndex++;
                if (currentIndex >= workerIds.length) {
                    currentIndex = 0;
                }
                return workerIds[currentIndex];
            }
            case "least-connection": {
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
                return leastActiveWorker.id;
            }
        }
    };

    httpServer.on("connection", (socket) => {
        let workerId;
        const connectionId = Math.floor((Math.random() * 10000000));
        socket.on("data", (buffer) => {
            let type;
            if (!workerId) {
                const data = buffer.toString();
                workerId = computeWorkerId(data);
                if (isWebsocketRequest(data)) {
                    type = "sticky:connection";
                    socket.pause();
                } else {
                    type = "first-chunk";
                }
            } else {
                type = "next-chunk";
            }
            cluster.workers[workerId].send(
                {
                    type,
                    data: buffer,
                    connectionId,
                },
                socket,
                (err) => {
                    if (err) {
                        socket.destroy();
                    }
                }
            );
        });
    });

    // we need this dummy handler to make socket.on("data") handler works more then one time
    httpServer.on("request", (req, _res) => {
        req.on("data", (_data) => {});
    });

    cluster.on("fork", (worker) => {
        worker.clientsCount = 0;
    });

    cluster.on("message", (worker, { type, data }) => {
        switch (type) {
            case "sticky:connection":
                sessionIdToWorker.set(data, worker.id);
                if (options.loadBalancingMethod === "least-connection") {
                    worker.clientsCount++;
                }
                break;
            case "sticky:disconnection":
                sessionIdToWorker.delete(data);
                if (options.loadBalancingMethod === "least-connection") {
                    worker.clientsCount--;
                }
                break;
            case "regularHttp:connection":
                if (options.loadBalancingMethod === "least-connection") {
                    worker.clientsCount++;
                }
                break;
            case "regularHttp:disconnection":
                if (options.loadBalancingMethod === "least-connection") {
                    worker.clientsCount--;
                }
                break;
        }
    });
};

const setupWorker = (io) => {
    if (!cluster.isWorker) {
        throw new Error("not worker");
    }
    const connections = {};
    const ignoreError = () => {}; // the next request will fail anyway
    process.on("message", ({ type, data, connectionId }, socket) => {
        if (!socket) {
            // might happen if the socket is closed during the transfer to the worker
            // see https://nodejs.org/api/child_process.html#child_process_example_sending_a_socket_object
            return;
        }
        switch (type) {
            case "sticky:connection": {
                io.httpServer.emit("connection", socket); // inject connection
                // republish first chunk
                if (socket._handle.onread.length === 1) {
                    socket._handle.onread(Buffer.from(data));
                } else {
                    // for Node.js < 12
                    socket._handle.onread(1, Buffer.from(data));
                }
                socket.resume();
                break;
            }
            case "first-chunk": {
                const request = data.toString();
                const m = /content-length: (\d+).*\r\n\r\n/im.exec(request);
                const tunnel = new PassThrough();
                tunnel.contentLength = m ? +m[1] : 0;
                tunnel.contentLengthReceived = data.length;
                connections[connectionId] = tunnel;
                io.httpServer.emit("connection", tunnel); // inject connection
                tunnel.write(data);
                process.send({ type: "regularHttp:connection", data: null }, ignoreError);
                tunnel.on("data", (d) => {
                    if (tunnel.contentLength > tunnel.contentLengthReceived) {
                        return;
                    }
                    // handle exception if client closed connection on his side
                    try {
                        socket?.write(d);
                    } catch (e) {
                        log.debug("Error on socket write", e);
                    }
                });
                tunnel.on("end", () => {
                    // handle exception if client closed connection on his side
                    try {
                        socket?.end();
                    } catch (e) {
                        log.debug("Error on socket close", e);
                    }
                    process.send({ type: "regularHttp:disconnection", data: null }, ignoreError);
                    delete connections[connectionId];
                });
                break;
            }
            case "next-chunk": {
                const tunnel = connections[connectionId];
                tunnel.write(data);
                tunnel.contentLengthReceived += data.length;
                break;
            }
        }
    });

    io.engine.on("connection", (socket) => {
        process.send({ type: "sticky:connection", data: socket.id }, ignoreError);
        socket.once("close", () => {
            process.send({ type: "sticky:disconnection", data: socket.id }, ignoreError);
        });
    });
};

module.exports = {
    setupMaster,
    setupWorker,
};
