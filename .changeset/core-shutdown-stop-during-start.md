---
"@connectum/core": minor
---

fix: a termination request that arrives while `start()` is still in progress is no longer dropped. `server.stop()` called while the server is starting used to reject with `Cannot stop server: current state is "starting"`, and the server then finished starting and ran until it was killed. Now `stop()` waits for the start to settle and stops the server (the event bus and the shutdown hooks run as usual); if the start fails, `stop()` resolves because the server is already stopped. With `shutdown.autoShutdown`, the signal handlers are installed when `start()` begins instead of after the port is bound, so a `SIGTERM` during a slow startup (an event bus connecting to a broker) triggers a graceful shutdown after the start instead of ending the process abruptly with exit code 143 and no hooks. `stop()` on a server that was never started still rejects. A `start()` that never settles also keeps a pending stop waiting.
