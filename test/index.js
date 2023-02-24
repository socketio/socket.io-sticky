const { join } = require("path");
const { exec } = require("child_process");
const { createServer } = require("http");
const { setupMaster } = require("../index");
const ioc = require("socket.io-client");

const fixture = (filename) => {
  return (
    '"' + process.execPath + '" "' + join(__dirname, "fixtures", filename) + '"'
  );
};

function waitFor(emitter, event) {
  return new Promise((resolve) => {
    emitter.once(event, resolve);
  });
}

function success(done, httpServer, socket) {
  httpServer.close();
  socket.disconnect();
  done();
}

describe("@socket.io/sticky", () => {
  it("should work with least-connection load-balancing", (done) => {
    exec(fixture("connection.js"), done);
  });

  it("should work with round-robin load-balancing", (done) => {
    exec(fixture("connection.js"), { env: { LB_METHOD: "round-robin" } }, done);
  });

  it("should work with random load-balancing", (done) => {
    exec(fixture("connection.js"), { env: { LB_METHOD: "random" } }, done);
  });

  it("should work with WebSocket only", (done) => {
    exec(fixture("connection.js"), { env: { TRANSPORT: "websocket" } }, done);
  });

  it("should work with HTTP long-polling only", (done) => {
    exec(fixture("connection.js"), { env: { TRANSPORT: "polling" } }, done);
  });

  it("should work with HTTP long-polling only", (done) => {
    exec(fixture("connection.js"), { env: { TRANSPORT: "polling" } }, done);
  });

  it("should return a 503 error when no worker is available (polling)", (done) => {
    const httpServer = createServer();

    setupMaster(httpServer, {
      loadBalancingMethod: "least-connection",
    });

    httpServer.listen(async () => {
      const { port } = httpServer.address();

      const socket = ioc(`http://localhost:${port}`, {
        transports: ["polling"],
      });

      await waitFor(socket, "connect_error");

      success(done, httpServer, socket);
    });
  });

  it("should return a 503 error when no worker is available (websocket)", (done) => {
    const httpServer = createServer();

    setupMaster(httpServer, {
      loadBalancingMethod: "least-connection",
    });

    httpServer.listen(async () => {
      const { port } = httpServer.address();

      const socket = ioc(`http://localhost:${port}`, {
        transports: ["websocket"],
      });

      await waitFor(socket, "connect_error");

      success(done, httpServer, socket);
    });
  });
});
