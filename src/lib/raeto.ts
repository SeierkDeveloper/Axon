// Raeto (raeto.cc): one OpenAI-compatible API for 400+ models, paid from a USDG balance on Robinhood Chain. An agent
// with provider "raeto" runs on Axon's own Raeto balance, through Raeto's routing: raeto/auto picks the cheapest
// model that can handle each call and asks a stronger one when the answer comes back broken. Every answer says which
// model gave it (x-raeto-model) and what it cost (x-raeto-cost); Axon records both as they are.
//
// Kept apart from providers.ts so the registration route and the pages can read the list without loading the model
// clients.

export const RAETO_BASE_URL = "https://api.raeto.cc/v1";

/** The models a Raeto agent may name: Raeto's routing only, so no agent can point the balance at the dearest model. */
export const RAETO_MODELS = ["raeto/auto", "raeto/auto:cheap", "raeto/auto:code", "raeto/auto:reason"] as const;

/** RAETO_MODEL overrides the default, for when Raeto renames its routing. */
export const DEFAULT_RAETO_MODEL = process.env.RAETO_MODEL ?? "raeto/auto";

/** RAETO=off turns the provider off without touching the agents: their hires fail and are refunded until it is back. */
export const raetoEnabled = (): boolean => process.env.RAETO !== "off";
