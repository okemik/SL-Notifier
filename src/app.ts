import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import type { Notifier } from "./notifier.js";

export function createApp(notifier: Pick<Notifier, "check" | "status">, checkApiKey?: string) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/", (_req, res) => res.type("text").send("SL Telegram notifier is running."));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/ready", (_req, res) => {
    const status = notifier.status();
    res.setHeader("Cache-Control", "no-store");
    res.status(status.ready ? 200 : 503).json({ ok: status.ready, ...status });
  });
  app.all("/check", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!checkApiKey) { res.status(404).json({ ok: false, error: "Manual checks are disabled" }); return; }
    if (req.method !== "POST" && req.method !== "GET") {
      res.setHeader("Allow", "POST, GET");
      res.status(405).json({ ok: false, error: "Method not allowed" }); return;
    }
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!timingSafeEqual(digest(req.get("authorization") ?? ""), digest(`Bearer ${checkApiKey}`))) {
      res.status(401).json({ ok: false, error: "Unauthorized" }); return;
    }
    try {
      const result = await notifier.check();
      if (result.skipped === "interval") {
        if (result.nextCheckAt) res.setHeader("Retry-After", Math.max(1, Math.ceil((Date.parse(result.nextCheckAt) - Date.now()) / 1000)));
        res.status(429).json(result);
      } else if (result.skipped === "running") res.status(409).json(result);
      else res.status(result.ok ? 200 : 503).json(result);
    } catch {
      res.status(503).json({ ok: false, error: "Notification check failed" });
    }
  });
  return app;
}
