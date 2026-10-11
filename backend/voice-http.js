import { Agent, fetch } from "undici";

// Reuse TLS connections, and avoid the deployment's slow dual-stack DNS lookup.
const agent = new Agent({ connect: { family: 4 }, connections: 4 });
export const providerFetch = (url, options = {}) => fetch(url, { ...options, dispatcher: agent });
