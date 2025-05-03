import express, { type Request, Response, NextFunction } from "express";
import fs from 'fs';
import path from 'path';
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Enhanced static file serving for uploads
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Set correct MIME types and cache settings for image files
app.use('/uploads', express.static(uploadsDir, {
  setHeaders: (res, path) => {
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) {
      res.setHeader('Content-Type', 'image/jpeg');
    } else if (path.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
    }
    // Set cache control headers to ensure images are properly cached
    res.setHeader('Cache-Control', 'public, max-age=31536000');
  },
  fallthrough: true, // Continue to next middleware if file not found
}));

// Log all requests to the uploads directory for debugging
app.use('/uploads', (req, res, next) => {
  console.log(`Requesting image: ${req.path}`);
  
  // Check if file exists
  const filePath = path.join(uploadsDir, req.path);
  if (fs.existsSync(filePath)) {
    console.log(`Image file exists: ${filePath}`);
  } else {
    console.log(`Image file NOT found: ${filePath}`);
  }
  
  next();
});

// Alternative path for backward compatibility
const oldUploadsDir = path.join(process.cwd(), 'dist', 'public', 'uploads');
if (fs.existsSync(oldUploadsDir)) {
  app.use('/uploads', express.static(oldUploadsDir));
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on port 5000
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = 5000;
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
})();
