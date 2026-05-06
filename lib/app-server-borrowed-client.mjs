export function makeAppServerStreamClientFactory(stream) {
  if (!stream || typeof stream.request !== "function") {
    return null;
  }
  return () => ({
    connect: async () => {
      if (typeof stream.ensureConnected === "function") {
        await stream.ensureConnected();
      }
      return true;
    },
    request: (method, params, options) => stream.request(method, params, options),
    close: async () => {
      // The stream owns the app-server process. A borrowed send client must not
      // close it after `turn/start`, or stdio turns die with the child process.
    },
  });
}
