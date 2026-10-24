// POST /api/chat: the dashboard's chat. Authenticated by the session cookie, so every
// tool call the agent makes is attributed to the logged-in user in the audit log.
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { requireSession } from "../auth.js";
import { ah, parseBody } from "../http.js";
import { runChat } from "../chat.js";
import { chatLimiter } from "../ratelimit.js";

export const chatRouter = Router();
chatRouter.use(requireSession);

const body = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(8000),
  })).min(1).max(40),
});

chatRouter.get("/config", (_req, res) => {
  res.json({ enabled: !!config.llm.baseUrl, model: config.llm.model });
});

chatRouter.post("/", chatLimiter, ah(async (req, res) => {
  if (!config.llm.baseUrl) return res.status(503).json({ error: "Chat is not configured (LLM_BASE_URL is empty)" });
  const b = parseBody(body, req, res);
  if (!b) return;
  try {
    const result = await runChat({ user: req.user!, apiKeyId: null, source: "chat" }, b.messages);
    res.json(result);
  } catch (e) {
    console.error("[chat] failed:", (e as Error).message);
    res.status(502).json({ error: `The language model could not be reached: ${(e as Error).message}` });
  }
}));
