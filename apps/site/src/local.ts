import { handleFetch, envPort } from "./server";

const server = Bun.serve({ port: envPort(process.env.PORT, 8787), fetch: handleFetch });
console.log(`Eden local ${server.url}`);
