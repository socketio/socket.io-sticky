const { request } = require("http");

module.exports.sendRequest = function sendRequest(options, data) {
  return new Promise((resolve) => {
    if (data) {
      options.headers = options.headers || {};
      options.headers["content-length"] = Buffer.byteLength(data);
    }

    const req = request(options, (res) => {
      const chunks = [];

      res.on("data", (chunk) => {
        chunks.push(chunk);
      });

      res.on("end", () => {
        res.body = Buffer.concat(chunks);
        resolve(res);
      });
    });

    if (data) {
      req.write(data);
    }

    req.end();
  });
};
