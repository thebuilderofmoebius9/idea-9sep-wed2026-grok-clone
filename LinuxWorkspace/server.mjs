import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const types = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript" };
const port = Number(process.env.PORT ?? 4173);

createServer(async (request, response) => {
  const requested = request.url === "/" ? "index.html" : request.url.slice(1);
  const file = normalize(join(root, requested));
  if (!file.startsWith(root)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": `${types[extname(file)] ?? "application/octet-stream"}; charset=utf-8` }).end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`BotWorkspace Linux: http://127.0.0.1:${port}`);
});
