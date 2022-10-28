const { join } = require("path");
const { exec } = require("child_process");

const fixture = (filename) => {
  return (
    '"' + process.execPath + '" "' + join(__dirname, "fixtures", filename) + '"'
  );
};

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

  // FIXME it fails when sending a packet whose size is over 65 kb
  it.skip("should work with HTTP long-polling only", (done) => {
    exec(fixture("connection.js"), { env: { TRANSPORT: "polling" } }, done);
  });
});
