import { describe, expect, test } from "bun:test";
import {
  callTool,
  createSafeFetcher,
  listTools,
  requestPinned,
  textFromHtml,
} from "../src/plugins/builtin-web";

describe("builtin Open Web tools", () => {
  test("extracts the article instead of site navigation chrome", () => {
    const html = `
      <html><body>
        <nav>${"Unrelated product link ".repeat(100)}</nav>
        <main><article><h1>Authentication</h1><p>Run <code>codex login</code>.</p></article></main>
        <footer>Unrelated legal links</footer>
      </body></html>`;

    expect(textFromHtml(html)).toBe("Authentication Run codex login .");
  });

  test("advertises the direct, credential-free tool set", async () => {
    expect((await listTools()).map((tool) => tool.name)).toEqual([
      "fetch_web_page",
      "extract_links",
      "get_json",
      "read_feed",
      "check_robots_txt",
    ]);
  });

  test.each([
    "http://127.0.0.1:5432",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/secret",
    "file:///etc/passwd",
  ])("refuses non-public target %s before fetching", async (url) => {
    const result = await callTool(
      { url: "builtin://open-web" },
      "fetch_web_page",
      { url },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(
      /not allowed|inside|cloud credentials|web address/i,
    );
  });

  test("does not accept a model-supplied credential as part of a URL", async () => {
    const result = await callTool({ url: "builtin://open-web" }, "get_json", {
      url: "https://user:password@example.com/data.json",
    });
    expect(result).toMatchObject({
      isError: true,
      text: "Web addresses containing credentials are refused.",
    });
  });

  test("connects to the address that passed DNS policy instead of resolving twice", async () => {
    let resolutions = 0;
    const fetchSafe = createSafeFetcher({
      resolve: (async () => {
        resolutions += 1;
        return resolutions === 1
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }];
      }) as never,
      request: async (target) => {
        expect(target.address).toBe("93.184.216.34");
        return {
          status: 200,
          headers: new Headers({ "content-type": "text/plain" }),
          body: "public response",
        };
      },
    });

    await expect(
      fetchSafe("https://rebind.example/data"),
    ).resolves.toMatchObject({
      body: "public response",
    });
    expect(resolutions).toBe(1);
  });

  test("the real socket dials the pinned IP while HTTP retains the checked hostname", async () => {
    let seenHost = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seenHost = request.headers.get("host") ?? "";
        return new Response("socket reached");
      },
    });
    try {
      const response = await requestPinned({
        url: new URL(`http://rebind.example:${server.port}/proof`),
        address: "127.0.0.1",
        family: 4,
      });
      expect(response.body).toBe("socket reached");
      expect(seenHost).toBe(`rebind.example:${server.port}`);
    } finally {
      server.stop(true);
    }
  });

  test("refuses a redirect to an internal address before opening its socket", async () => {
    let requests = 0;
    const fetchSafe = createSafeFetcher({
      resolve: (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
      request: async () => {
        requests += 1;
        return {
          status: 302,
          headers: new Headers({
            location: "http://169.254.169.254/latest/meta-data/",
          }),
          body: "",
        };
      },
    });

    await expect(fetchSafe("https://public.example/redirect")).rejects.toThrow(
      /cloud credentials|not allowed|inside/i,
    );
    expect(requests).toBe(1);
  });
});
