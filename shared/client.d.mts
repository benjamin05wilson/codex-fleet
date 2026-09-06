import type { LocalClient } from "./contracts.js";
export function createClient(options?: {
  base?: string;
  clientId?: string;
  fetchImpl?: typeof fetch;
}): LocalClient;
