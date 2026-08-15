import { handleFetch } from "./server";

const PORT = Number(process.env.PORT || 8787);
const server = Bun.serve({ port: PORT, fetch: handleFetch });
console.log(`Eden local ${server.url}`);
