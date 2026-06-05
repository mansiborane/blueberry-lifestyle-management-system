import express from "express";
import http from "http";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createAiRouter } from "./serverAi";

// Load secrets for the server process (Gemini key etc.). .env.local wins over .env.
dotenv.config({ path: ".env.local" });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify([]));
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json());

  // Auth Routes
  app.post("/api/auth/register", (req, res) => {
    const { name, email, password } = req.body;
    const users = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));

    if (users.find((u: any) => u.email === email)) {
      return res.status(400).json({ message: "User already exists" });
    }

    const newUser = { id: Date.now().toString(), name, email, password };
    users.push(newUser);
    fs.writeFileSync(USERS_FILE, JSON.stringify(users));

    const { password: _, ...userWithoutPassword } = newUser;
    res.json(userWithoutPassword);
  });

  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body;
    const users = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
    const user = users.find((u: any) => u.email === email && u.password === password);

    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const { password: _, ...userWithoutPassword } = user;
    res.json(userWithoutPassword);
  });

  // Data Routes
  app.get("/api/data/:userId/:module", (req, res) => {
    const { userId, module } = req.params;
    const moduleFile = path.join(DATA_DIR, `${userId}_${module}.json`);

    if (!fs.existsSync(moduleFile)) {
      return res.json([]);
    }

    const data = JSON.parse(fs.readFileSync(moduleFile, "utf-8"));
    res.json(data);
  });

  app.post("/api/data/:userId/:module", (req, res) => {
    const { userId, module } = req.params;
    const moduleFile = path.join(DATA_DIR, `${userId}_${module}.json`);
    const data = req.body;

    fs.writeFileSync(moduleFile, JSON.stringify(data));
    res.json({ success: true });
  });

  // AI Routes — served directly by this server via Google Gemini.
  app.use("/api/ai", createAiRouter());

  const httpServer = http.createServer(app);

  // Vite middleware for development — bind HMR to this server so no extra port (e.g. 24678)
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
        // The server writes user data into ./data at runtime. Without this,
        // Vite's file watcher sees those writes and triggers a full page
        // reload (kicking you back to the dashboard mid-action).
        watch: {
          ignored: ["**/data/**", "**/.env.local"],
        },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\nPort ${PORT} is already in use. Close the other dev server or run:\n` +
          `  set PORT=3001 && npm run dev\n`,
      );
      process.exit(1);
    }
    throw err;
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
