import http from "node:http";

/**
 * Starts a minimal HTTP health endpoint when a port is configured
 * (useful on free hosts that expect a listening PORT or for UptimeRobot checks).
 *
 * @param {number | null} port
 * @param {() => Record<string, unknown>} getStatus
 * @returns {Promise<{ server: http.Server | null, close: () => Promise<void> }>}
 */
export function startHealthServer(port, getStatus) {
  if (!port) {
    return Promise.resolve({
      server: null,
      close: async () => {},
    });
  }

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || "/").split("?")[0];
      if (urlPath === "/" || urlPath === "/health") {
        const payload = {
          status: "ok",
          uptimeSeconds: Math.floor(process.uptime()),
          ...getStatus(),
        };
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Not Found" }));
    });

    server.on("error", (err) => {
      console.warn(`[Health] Could not bind HTTP health server on port ${port}: ${err.message}`);
      resolve({ server: null, close: async () => {} });
    });

    server.listen(port, "0.0.0.0", () => {
      console.log(`[Health] Listening on http://0.0.0.0:${port}/health`);
      resolve({
        server,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
