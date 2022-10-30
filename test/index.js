const { join } = require("path");
const { exec } = require("child_process");
const assert = require("assert");

const fixture = (filename) => {
  return (
    '"' + process.execPath + '" "' + join(__dirname, "fixtures", filename) + '"'
  );
};
const handler = (done) => {
  return (error, stdOut, stdErr) => {
    if (error) {
      console.log(`${stdOut}\n${stdErr}`);
    }
    assert.strictEqual(error, null);
    done();
  };
};
describe("@socket.io/sticky", () => {
  it("should work with least-connection load-balancing", (done) => {
    exec(fixture("connection.js"), handler(done));
  });

  it("should work with round-robin load-balancing", (done) => {
    exec(
      fixture("connection.js"),
      { env: { LB_METHOD: "round-robin" } },
      handler(done)
    );
  });

  it("should work with random load-balancing", (done) => {
    exec(
      fixture("connection.js"),
      { env: { LB_METHOD: "random" } },
      handler(done)
    );
  });

  it("should work with WebSocket only", (done) => {
    exec(
      fixture("connection.js"),
      { env: { TRANSPORT: "websocket" } },
      handler(done)
    );
  });

  it("should work with HTTP long-polling only", (done) => {
    exec(
      fixture("connection.js"),
      { env: { TRANSPORT: "polling" } },
      handler(done)
    );
  });

  it("should work with WebSocket only", (done) => {
    exec(fixture("connection.js"), { env: { TRANSPORT: "websocket" } }, done);
  });

  it.skip("should work with HTTP long-polling only", (done) => {
    exec(fixture("connection.js"), { env: { TRANSPORT: "polling" } }, done);
  });
});
