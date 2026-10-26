import { Router } from "express";
import { z } from "zod";
import { requireSession } from "../auth.js";
import { callTool, type Caller } from "../gateway.js";
import { upstreams } from "../upstreams.js";

export const geoRouter = Router();
geoRouter.use(requireSession);

const querySchema = z.object({
  search: z.string().trim().max(100).optional(),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
});

geoRouter.get("/", async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query", details: parsed.error.issues.map((i) => i.message) });
    const toolName = "woo__list_products_geo_readiness";
    if (!upstreams.resolve(toolName)) {
      return res.status(503).json({ error: "The WooCommerce GEO assessment tool is unavailable. Check that the WooCommerce server is connected and updated." });
    }
    const caller: Caller = { user: req.user!, apiKeyId: null, source: "dashboard" };
    const result = await callTool(caller, toolName, parsed.data);
    if (result.isError) {
      const message = result.content?.find((item) => item.type === "text")?.text ?? "GEO assessment failed";
      return res.status(502).json({ error: message });
    }
    const content = result.content?.find((item) => item.type === "text");
    if (!content || content.type !== "text") return res.status(502).json({ error: "WooCommerce returned no GEO assessment" });
    res.json(JSON.parse(content.text));
  } catch (e) {
    if (e instanceof SyntaxError) return res.status(502).json({ error: "WooCommerce returned an unreadable GEO assessment" });
    next(e);
  }
});
