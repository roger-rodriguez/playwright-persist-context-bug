import http from "http";
import fs from "fs-extra";
import { Socket } from "net";

// Interface for the server instance and sockets set
export interface ServerControl {
  server: http.Server;
  sockets: Set<Socket>;
}

/**
 * Starts the HTTP server to serve the specified HTML file.
 * @param htmlFilePath Path to the HTML file to serve.
 * @param port Port number to listen on.
 * @returns A promise that resolves with the server instance and sockets set, or rejects on error.
 */
export function startServer(
  htmlFilePath: string,
  port: number
): Promise<ServerControl> {
  const sockets = new Set<Socket>();
  const server = http.createServer(async (req, res) => {
    if (req.url === "/") {
      try {
        const content = await fs.readFile(htmlFilePath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(content);
      } catch (err) {
        console.error("Error reading HTML file for server:", err);
        res.writeHead(500);
        res.end("Server Error: Could not read HTML file.");
      }
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  // Track connections
  server.on("connection", (socket) => {
    sockets.add(socket);
    console.log(`Socket connected. Total sockets: ${sockets.size}`);
    socket.on("close", () => {
      sockets.delete(socket);
      console.log(`Socket closed. Total sockets: ${sockets.size}`);
    });
  });

  return new Promise<ServerControl>((resolve, reject) => {
    server
      .listen(port, () => {
        console.log(`HTTP server listening on http://localhost:${port}/`);
        resolve({ server, sockets }); // Resolve with server and sockets
      })
      .on("error", (err) => {
        console.error("Server failed to start:", err);
        reject(err);
      });
  });
}

/**
 * Stops the HTTP server and destroys any lingering connections.
 * @param serverControl The object containing the server instance and sockets set.
 * @returns A promise that resolves when the server is closed, or rejects on error.
 */
export function stopServer(serverControl: ServerControl | null): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!serverControl) {
      console.log("Server instance not available to stop.");
      return resolve();
    }

    const { server, sockets } = serverControl;

    console.log("Closing HTTP server...");

    // Destroy all open sockets first
    for (const socket of sockets) {
      console.log("Destroying lingering socket...");
      socket.destroy();
      sockets.delete(socket);
    }

    // Now close the server
    server.close((err) => {
      if (err) {
        console.error("Error closing server:", err);
        return reject(err);
      }
      console.log("HTTP server closed.");
      resolve();
    });
  });
}
