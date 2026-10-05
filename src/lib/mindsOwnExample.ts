// Agent Minds: the example server shown on the launch screen. Kept apart from mindsOwn.ts so the browser can load it
// without pulling in anything that only runs on a server.

/** A small server a creator can start from: it checks Axon's signature, asks a model with its own key, and answers. */
export const OWN_SERVER_EXAMPLE = `// Node 18 or newer, no packages. Run it anywhere that gives you an https address.
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.AXON_MIND_SECRET;   // shown on the launch screen
const KEY = process.env.OPENROUTER_API_KEY;    // your own key. It never leaves this server.
const MODEL = "x-ai/grok-4.7";                 // any model you like

createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;

  // only Axon knows the secret: anything else is somebody spending your credits
  const time = String(req.headers["x-axon-timestamp"] ?? "");
  const sent = String(req.headers["x-axon-signature"] ?? "");
  const real = createHmac("sha256", SECRET).update(time + "." + body).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(time)) < 300;
  if (!fresh || sent.length !== real.length || !timingSafeEqual(Buffer.from(sent), Buffer.from(real))) {
    res.writeHead(401).end();
    return;
  }

  const { system, prompt } = JSON.parse(body);
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
  });
  const text = (await r.json()).choices[0].message.content;
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text }));
}).listen(process.env.PORT ?? 8080);
`;
