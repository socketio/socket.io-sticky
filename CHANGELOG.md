# Changelog

| Version                  | Release date  |
|--------------------------|---------------|
| [2.0.1](#201-2026-07-22) | July 2026     |
| [2.0.0](#200-2026-07-17) | July 2026     |
| [1.0.4](#104-2023-08-12) | August 2023   |
| [1.0.3](#103-2023-02-24) | February 2023 |
| [1.0.2](#102-2022-11-01) | November 2022 |
| [1.0.1](#101-2021-07-01) | July 2021     |
| [1.0.0](#100-2021-01-25) | January 2021  |

## [2.0.1](https://github.com/socketio/socket.io-sticky/compare/2.0.0...2.0.1) (2026-07-22)


### Bug Fixes

* prevent upload body corruption ([714ed80](https://github.com/socketio/socket.io-sticky/commit/714ed8048fb2a1e44971bb33f67045ab8461693d))


## [2.0.0](https://github.com/socketio/socket.io-sticky/compare/1.0.4...2.0.0) (2026-07-17)


### Bug Fixes

* correct round-robin worker selection ([7443e1d](https://github.com/socketio/socket.io-sticky/commit/7443e1d8f2dc0c8bd1d3c6e8abca8f226c7a7b51))
* disable HTTP keep-alive for sticky workers ([efd3445](https://github.com/socketio/socket.io-sticky/commit/efd34457f84077848e951c96cd62c3e3553c7646))
* handle worker exit while forwarding upload chunks ([1ee559f](https://github.com/socketio/socket.io-sticky/commit/1ee559f13f5df3df3cf007e5044d6b793d9de3df))
* preserve binary chunks when forwarding requests to workers ([05bff84](https://github.com/socketio/socket.io-sticky/commit/05bff84b7f89b6741502f1e7c6c35ad7481ae4a5))


### BREAKING CHANGES

* cluster IPC must use advanced serialization, so Buffers are preserved across
  processes. Applications should configure the cluster primary with serialization: "advanced" before
  forking workers.

```js
// must run before cluster.fork()

cluster.setupPrimary({
  serialization: "advanced", // prevents conversion of Node.js Buffer to string over IPC
});
```

Reference: https://nodejs.org/docs/latest/api/child_process.html#advanced-serialization



## [1.0.4](https://github.com/socketio/socket.io-sticky/compare/1.0.3...1.0.4) (2023-08-12)


### Bug Fixes

* cleanup sid to worker map on worker exit ([4b430e7](https://github.com/socketio/socket.io-sticky/commit/4b430e7e9383006e4641e40e8a5082156ed862a4))
* properly detect requests without body ([ac7bb8e](https://github.com/socketio/socket.io-sticky/commit/ac7bb8e851d6a458736281568ed6946c512e4251))



## [1.0.3](https://github.com/socketio/socket.io-sticky/compare/1.0.2...1.0.3) (2023-02-24)


### Bug Fixes

* handle case with no available worker ([e8b4203](https://github.com/socketio/socket.io-sticky/commit/e8b4203d18fc9601e05af3457baba49fafdb15f0))



## [1.0.2](https://github.com/socketio/socket.io-sticky/compare/1.0.1...1.0.2) (2022-11-01)


### Bug Fixes

* properly handle large request body ([a124d0b](https://github.com/socketio/socket.io-sticky/commit/a124d0beb5c1b78be5b75f10153859a9e4672862))



## [1.0.1](https://github.com/socketio/socket.io-sticky/compare/1.0.0...1.0.1) (2021-07-01)


### Bug Fixes

* check if the socket exists in the worker ([7069fbc](https://github.com/socketio/socket.io-sticky/commit/7069fbc5bfbc845556f4a5cb8fd8240a1ef24b0e))


## 1.0.0 (2021-01-25)

Initial release

