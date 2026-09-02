import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { checkNavigationTarget } from "../computer/target";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

const MAX_DOWNLOAD_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "fetch_web_page",
    description:
      "Fetch a public web page directly, without Monid or another data broker. Returns readable text, final URL, status, and content type. Internal networks, cloud metadata, oversized responses, and unsafe redirects are refused.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http or https URL." },
      },
      required: ["url"],
    },
  },
  {
    name: "extract_links",
    description:
      "Fetch a public HTML page and extract its absolute links and link text. Useful for discovery and crawling without a scraping vendor.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public HTML page URL." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      required: ["url"],
    },
  },
  {
    name: "get_json",
    description:
      "Read a public JSON endpoint directly with an optional flat set of query parameters. Sends no credentials and refuses internal destinations.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public JSON URL." },
        query: {
          type: "object",
          additionalProperties: { type: ["string", "number", "boolean"] },
        },
      },
      required: ["url"],
    },
  },
  {
    name: "read_feed",
    description:
      "Read items from a public RSS or Atom feed directly. Returns titles, links, dates, and summaries without a monitoring subscription.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public RSS or Atom feed URL." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      required: ["url"],
    },
  },
  {
    name: "check_robots_txt",
    description:
      "Fetch the robots.txt rules for a public site before crawling it. This reports the published rules; it does not grant permission to ignore them.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Any public URL on the site." },
      },
      required: ["url"],
    },
  },
]);

export const listNeedsCredential = false;
export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

const failure = (text: string): McpCallResult => ({
  text,
  isError: true,
  truncated: false,
});
function success(value: unknown): McpCallResult {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length <= MAX_RESULT_CHARS
    ? { text, isError: false, truncated: false }
    : {
        text: `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${text.length} characters]`,
        isError: false,
        truncated: true,
      };
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export type ResolvedTarget = { url: URL; address: string; family: number };

async function assertPublicUrl(
  raw: string,
  resolve: typeof lookup = lookup,
): Promise<ResolvedTarget> {
  const verdict = checkNavigationTarget(raw);
  if (!verdict.allowed) throw new Error(verdict.reason);
  const url = new URL(verdict.url);
  if (url.username || url.password)
    throw new Error("Web addresses containing credentials are refused.");

  const addresses = await resolve(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0)
    throw new Error("That host has no network address.");
  for (const { address } of addresses) {
    const addressVerdict = checkNavigationTarget(
      `http://${address.includes(":") ? `[${address}]` : address}`,
    );
    if (!addressVerdict.allowed) {
      throw new Error(
        "That hostname resolves inside this deployment's network, so it is refused.",
      );
    }
  }
  const chosen = addresses[0];
  if (!chosen) throw new Error("That host has no network address.");
  return { url, address: chosen.address, family: chosen.family };
}

type PinnedResponse = {
  status: number;
  headers: Headers;
  body: string;
};

type PinnedRequest = (target: ResolvedTarget) => Promise<PinnedResponse>;

/** Connect to the address that passed policy, while retaining the hostname for HTTP and TLS. */
export async function requestPinned(
  target: ResolvedTarget,
): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const secure = target.url.protocol === "https:";
    const request = (secure ? requestHttps : requestHttp)(
      {
        protocol: target.url.protocol,
        hostname: target.address,
        family: target.family,
        port: target.url.port || (secure ? 443 : 80),
        path: `${target.url.pathname}${target.url.search}`,
        method: "GET",
        servername: secure ? target.url.hostname : undefined,
        headers: {
          host: target.url.host,
          accept:
            "text/html, application/json, application/xml, text/xml, text/plain;q=0.9",
          "user-agent": "OpenBot-WebTools/1.0",
        },
      },
      (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value))
            for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, value);
        }
        const declared = Number(headers.get("content-length") ?? "0");
        if (declared > MAX_DOWNLOAD_BYTES) {
          response.destroy();
          reject(new Error("The response is larger than the 2 MB tool limit."));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_DOWNLOAD_BYTES) {
            response.destroy(
              new Error("The response is larger than the 2 MB tool limit."),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.setTimeout(TIMEOUT_MS, () =>
      request.destroy(new Error("The public server took too long to answer.")),
    );
    request.on("error", reject);
    request.end();
  });
}

export function createSafeFetcher(
  dependencies: { resolve?: typeof lookup; request?: PinnedRequest } = {},
) {
  const resolve = dependencies.resolve ?? lookup;
  const request = dependencies.request ?? requestPinned;
  return async (
    raw: string,
  ): Promise<{ response: PinnedResponse; body: string; finalUrl: string }> => {
    let target = await assertPublicUrl(raw, resolve);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const response = await request(target);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location)
          throw new Error(
            "The server returned a redirect without a destination.",
          );
        if (redirect === MAX_REDIRECTS)
          throw new Error("The page redirected too many times.");
        target = await assertPublicUrl(
          new URL(location, target.url).toString(),
          resolve,
        );
        continue;
      }
      if (response.status < 200 || response.status >= 300)
        throw new Error(`The public server returned HTTP ${response.status}.`);
      return { response, body: response.body, finalUrl: target.url.toString() };
    }
    throw new Error("The page redirected too many times.");
  };
}

const safeFetch = createSafeFetcher();

function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, value: string) =>
      String.fromCodePoint(Number(value)),
    )
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export function textFromHtml(html: string): string {
  /*
   * Prefer the semantic document body over global navigation and footer chrome. A live OpenAI docs
   * fetch returned more than 20,000 capped characters, most of them product navigation, before the
   * actual authentication page. Feeding that into every later turn wastes context and makes the
   * relevant evidence harder for the model to find. Article is narrower than main, so prefer it.
   */
  const documentBody =
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html;
  return decode(
    documentBody
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(
        /<(?:nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/(?:nav|header|footer|aside)>/gi,
        " ",
      )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function feedItems(xml: string, base: string, limit: number) {
  const blocks = [
    ...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi),
  ].slice(0, limit);
  const field = (block: string, name: string) => {
    const match = block.match(
      new RegExp(
        `<${name}\\b[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`,
        "i",
      ),
    );
    return match ? textFromHtml(match[1] ?? "") : null;
  };
  return blocks.map(([, , block = ""]) => {
    const href =
      block.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] ??
      field(block, "link");
    return {
      title: field(block, "title"),
      link: href ? new URL(decode(href), base).toString() : null,
      date:
        field(block, "pubDate") ??
        field(block, "published") ??
        field(block, "updated"),
      summary:
        field(block, "description") ??
        field(block, "summary") ??
        field(block, "content"),
    };
  });
}

export async function callTool(
  _connection: {
    url: string;
    token?: string;
    actorId?: string;
    botId?: string;
  },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  try {
    const rawUrl = stringArg(args, "url");
    if (!rawUrl) return failure("A public URL is required.");
    if (toolName === "check_robots_txt") {
      const target = new URL(rawUrl);
      return success(
        (await safeFetch(new URL("/robots.txt", target.origin).toString()))
          .body,
      );
    }
    if (toolName === "get_json") {
      const target = new URL(rawUrl);
      const query = args.query;
      if (query && typeof query === "object" && !Array.isArray(query)) {
        for (const [key, value] of Object.entries(query)) {
          if (["string", "number", "boolean"].includes(typeof value))
            target.searchParams.set(key, String(value));
        }
      }
      const result = await safeFetch(target.toString());
      return success(JSON.parse(result.body));
    }
    const result = await safeFetch(rawUrl);
    if (toolName === "fetch_web_page") {
      const contentType =
        result.response.headers.get("content-type") ?? "unknown";
      return success({
        finalUrl: result.finalUrl,
        status: result.response.status,
        contentType,
        text: contentType.includes("html")
          ? textFromHtml(result.body)
          : result.body,
      });
    }
    const limit = Math.min(
      Math.max(Number(args.limit) || (toolName === "read_feed" ? 20 : 50), 1),
      toolName === "read_feed" ? 100 : 200,
    );
    if (toolName === "read_feed")
      return success({
        finalUrl: result.finalUrl,
        items: feedItems(result.body, result.finalUrl, limit),
      });
    if (toolName === "extract_links") {
      const links = [
        ...result.body.matchAll(
          /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        ),
      ]
        .map((match) => ({
          url: new URL(decode(match[1] ?? ""), result.finalUrl).toString(),
          text: textFromHtml(match[2] ?? ""),
        }))
        .filter(
          (item) =>
            item.url.startsWith("http://") || item.url.startsWith("https://"),
        )
        .slice(0, limit);
      return success({ finalUrl: result.finalUrl, links });
    }
    return failure(`Unknown Open Web tool: ${toolName}`);
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "The web tool failed.",
    );
  }
}
