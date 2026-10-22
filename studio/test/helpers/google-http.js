import { createServer } from "node:http";
export async function googleHttp(t, reply) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const call = {
      method: req.method,
      url: req.url,
      key: req.headers["x-goog-api-key"],
      body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null,
    };
    calls.push(call);
    const result = await reply(call, calls.length);
    if (result === null) {
      req.socket.destroy();
      return;
    }
    res.writeHead(typeof result.status === "number" ? result.status : 200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(result.body ?? result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1beta`, calls };
}
export const interaction = (content, extra = {}) => ({
  id: "v1_fixture",
  object: "interaction",
  model: "gemini-nano-banana-2.1",
  status: "completed",
  steps: [{ type: "model_output", content }],
  ...extra,
});
