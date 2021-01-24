const { join } = require("path");
const { exec } = require("child_process");

const fixture = (filename) => {
  return (
    '"' + process.execPath + '" "' + join(__dirname, "fixtures", filename) + '"'
  );
};

describe("@socket.io/sticky", () => {
  it("should work with least-connection load-balancing", (done) => {
    exec(
      fixture("connection.js"),
      { env: { LB_METHOD: "least-connection" } },
      done
    );
  });

  it("should work with round-robin load-balancing", (done) => {
    exec(fixture("connection.js"), { env: { LB_METHOD: "round-robin" } }, done);
  });

  it("should work with random load-balancing", (done) => {
    exec(fixture("connection.js"), { env: { LB_METHOD: "random" } }, done);
  });
});
