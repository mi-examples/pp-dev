import { createServer } from "http";
import { parse } from "url";
import next from "next";
import type { Socket } from "net";

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = 3000;

// Simple configuration without pp-dev
const templateName = "test-nextjs";
const basePath = "/p/test-nextjs"; // Simple base path

const projectRoot = __dirname;

// Initialize Next.js app
async function startServer() {
  let app: any = null;
  let server: any = null;
  const openSockets = new Set<Socket>();

  console.log(projectRoot);

  try {
    // Create Next.js app with basic configuration
    app = next({
      dev,
      hostname,
      port,
      dir: projectRoot,
      conf: {
        basePath: basePath,
        assetPrefix: basePath,
      },
    });

    await app.prepare();

    // Get the request handler
    const handle = app.getRequestHandler();

    console.log("✅ Next.js app prepared successfully");
    console.log(`🔧 Template: ${templateName}`);
    console.log(`🔧 Base path: ${basePath}`);

    // Create HTTP server
    server = createServer(async (req, res) => {
      try {
        const originalUrl = req.url || "/";
        const originalPathname = originalUrl;
        let parsedUrl = parse(originalUrl, true);

        console.log(`[DEBUG] Request: ${req.method} ${originalPathname}`);

        // Handle base path requests
        if (originalPathname.startsWith(basePath)) {
          // Strip the base path for Next.js
          const nextPath = originalPathname.substring(basePath.length);

          req.url = nextPath || "/";
          parsedUrl = parse(nextPath, true);

          console.log(
            `[DEBUG] Base path request - Original: ${originalPathname}, Stripped: ${req.url}`
          );
        } else if (originalPathname === basePath.replace(/\/$/, "")) {
          // Handle base path without trailing slash
          req.url = "/";
          parsedUrl = parse("/", true);
          console.log(
            `[DEBUG] Base path without slash - Redirected to: ${req.url}`
          );
        } else if (
          originalPathname.startsWith("/_next/") ||
          originalPathname === "/favicon.ico" ||
          originalPathname.startsWith("/__nextjs_")
        ) {
          // Next.js internal routes - pass through as-is
          console.log(`[DEBUG] Next.js internal route: ${originalPathname}`);
        } else if (originalPathname === "/") {
          // Root path - this should redirect to base path
          console.log(`[DEBUG] Root path - redirecting to base path`);
          res.writeHead(302, { Location: basePath });
          res.end();

          return;
        } else {
          // Other requests - pass through as-is
          console.log(`[DEBUG] Other request: ${originalPathname}`);
        }

        console.log(`[DEBUG] Final URL for Next.js: ${req.method} ${req.url}`);
        await handle(req, res, parsedUrl);
      } catch (error) {
        console.error(`[DEBUG] Error:`, error);
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    });

    // Track open sockets for proper cleanup
    server.on("connection", (socket: Socket) => {
      openSockets.add(socket);
      socket.on("close", () => openSockets.delete(socket));
    });

    // Start the server
    server.listen(port, hostname, () => {
      console.log(
        `✅ Custom Next.js server running at http://${hostname}:${port}`
      );
      console.log(`📱 App accessible at http://${hostname}:${port}${basePath}`);
      console.log(`🔧 Base path: ${basePath}`);
    });

    // Graceful shutdown function
    const gracefulShutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);

      // Set a timeout to force exit if shutdown hangs
      const shutdownTimeout = setTimeout(() => {
        console.log("⏰ Shutdown timeout reached, forcing exit");
        process.exit(0);
      }, 5000);

      try {
        // Close all open sockets first
        for (const socket of Array.from(openSockets)) {
          socket.destroy();
        }
        openSockets.clear();

        // Stop accepting new connections and wait for server to close
        await new Promise<void>((resolve) => {
          server.close(() => {
            console.log("🛑 HTTP server closed");
            resolve();
          });
        });

        // Close the Next.js app properly
        if (app && typeof app.close === "function") {
          await app.close();
          console.log("🛑 Next.js app closed");
        }

        clearTimeout(shutdownTimeout);
        console.log("✅ Graceful shutdown completed");
        process.exit(0);
      } catch (error) {
        clearTimeout(shutdownTimeout);
        console.error("❌ Error during graceful shutdown:", error);
        process.exit(1);
      }
    };

    // Handle process signals
    process.on("SIGINT", gracefulShutdown);
    process.on("SIGTERM", gracefulShutdown);

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      console.error("❌ Uncaught Exception:", error);
      gracefulShutdown("uncaughtException");
    });

    process.on("unhandledRejection", (reason, promise) => {
      console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
      gracefulShutdown("unhandledRejection");
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Start the server
startServer();
