import { createHmac } from "node:crypto";
import http from "node:http";

const secret = process.env.PRODUCTION_ENGINEER_ALERTMANAGER_WEBHOOK_SECRET;
const destination = process.env.OPENBOT_ALERT_WEBHOOK_URL;
if (!secret || !destination) throw new Error("Alert relay secret and destination are required.");

http
  .createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/alertmanager") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const body = Buffer.concat(chunks);
      try {
        const upstream = await fetch(destination, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-openbot-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
          },
          body,
        });
        response.writeHead(upstream.status, { "content-type": "application/json" });
        response.end(await upstream.text());
      } catch (error) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
  })
  .listen(4600, "0.0.0.0");
