import { defineRailway, github, image, preserve, project, service, volume } from "railway/iac";

// Pulled from live 2026-10-03. Every cron runs node:22-alpine (no Axon code, no GitHub, no healthcheck) with one shared
// caller: a network blip or a busy proxy (fetch error, 429, 502, 503, 504) is tried again a few times, and a run that
// still cannot reach the site logs "not done this run" and exits 0, because the next scheduled run tries again. Only an
// answer retrying cannot fix (401, 403, 404) exits 1. A timeout or a 500 may have reached the app, so it is not resent.
// Generator: scripts/cron-command.mjs. Change a command with serviceInstanceUpdate +
// serviceInstanceDeployV2 (railway api), never `railway up` on a cron.
export default defineRailway(() => {
  const Axon = github("SeierkDeveloper/Axon", { checkSuites: false });

  const axonVolume = volume("axon-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "europe-west4-drams3a", sizeMB: 5000 });
  const cronReproducibility = service("cron-reproducibility", {
    source: image("node:22-alpine"),
    start: "node -e \"const u='https://axon-agents.com/api/cron/reproducibility',T=5,G=30000,W=ms=>new Promise(r=>setTimeout(r,ms));const go=async n=>{try{const r=await fetch(u,{method:'POST',headers:{Authorization:'Bearer '+process.env.CRON_SECRET},signal:AbortSignal.timeout(600000)});console.log(r.status,(await r.text()).slice(0,300));if(r.ok)return 0;if([429,502,503,504].includes(r.status)&&n>1){await W(G);return go(n-1)}return r.status<500?1:2}catch(e){console.error(e.name+': '+e.message);if(e.name!=='TimeoutError'&&n>1){await W(G);return go(n-1)}return 2}};go(T).then(c=>{if(c===2)console.error('not done this run (tried '+T+' times); the next scheduled run tries again');process.exit(c===1?1:0)})\"",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "0 9,21 * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const cronBurn = service("cron-burn", {
    source: image("node:22-alpine"),
    start: "node -e \"const u='https://axon-agents.com/api/cron/burn',T=5,G=30000,W=ms=>new Promise(r=>setTimeout(r,ms));const go=async n=>{try{const r=await fetch(u,{method:'POST',headers:{Authorization:'Bearer '+process.env.CRON_SECRET},signal:AbortSignal.timeout(300000)});console.log(r.status,(await r.text()).slice(0,300));if(r.ok)return 0;if([429,502,503,504].includes(r.status)&&n>1){await W(G);return go(n-1)}return r.status<500?1:2}catch(e){console.error(e.name+': '+e.message);if(e.name!=='TimeoutError'&&n>1){await W(G);return go(n-1)}return 2}};go(T).then(c=>{if(c===2)console.error('not done this run (tried '+T+' times); the next scheduled run tries again');process.exit(c===1?1:0)})\"",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "0 0 * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const cronBurnEngine = service("cron-burn-engine", {
    source: image("node:22-alpine"),
    start: "node -e \"const u='https://axon-agents.com/api/cron/burn-engine',T=3,G=10000,W=ms=>new Promise(r=>setTimeout(r,ms));const go=async n=>{try{const r=await fetch(u,{method:'POST',headers:{Authorization:'Bearer '+process.env.CRON_SECRET},signal:AbortSignal.timeout(30000)});console.log(r.status,(await r.text()).slice(0,300));if(r.ok)return 0;if([429,502,503,504].includes(r.status)&&n>1){await W(G);return go(n-1)}return r.status<500?1:2}catch(e){console.error(e.name+': '+e.message);if(e.name!=='TimeoutError'&&n>1){await W(G);return go(n-1)}return 2}};go(T).then(c=>{if(c===2)console.error('not done this run (tried '+T+' times); the next scheduled run tries again');process.exit(c===1?1:0)})\"",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "* * * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const axonPresence = service("axon-presence", {
    source: Axon,
    replicas: { "europe-west4-drams3a": 1 },
    env: { PRESENCE_ALLOWED_ORIGINS: preserve() },
  });
  const Axon2 = service("Axon", {
    source: Axon,
    build: "npm run build",
    replicas: { "europe-west4-drams3a": 1 },
    domains: ["axon-agents.com"],
    networking: { privateNetworkEndpoint: "axon" },
    volumeMounts: { "/data": axonVolume },
    env: { ANTHROPIC_API_KEY: preserve(), AXON_ALLOWANCE_ADDRESS: preserve(), AXON_ALLOWANCE_OPERATOR_KEY: preserve(), AXON_BURN_POT_ADDRESS: preserve(), AXON_RPC_URL: preserve(), AXON_SETTLEMENT_TOKEN_ADDRESS: preserve(), AXON_SPLITTER_ADDRESS: preserve(), AXON_SUCCESS_RATE_WINDOW_HOURS: preserve(), AXON_TOKEN_ADDRESS: preserve(), BOT_PRIVATE_KEY: preserve(), CORS_ORIGIN: preserve(), CRON_SECRET: preserve(), DATABASE_PATH: preserve(), DEV_WALLET: preserve(), GROW_AGENT_ID: preserve(), GROW_AGENT_KEY: preserve(), GROW_AGENT_SECRET: preserve(), GROW_SECRET: preserve(), LOG_LEVEL: preserve(), NEXT_PUBLIC_AGENT_LAUNCH_FACTORY: preserve(), NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS: preserve(), NEXT_PUBLIC_PRESENCE_URL: preserve(), NEXT_PUBLIC_RPC_URL: preserve(), NODE_ENV: preserve(), NODE_OPTIONS: preserve(), OPENAI_API_KEY: preserve(), PASSPORT_SIGNING_KEY: preserve(), REFUND_SIGNER_PRIVATE_KEY: preserve(), REPRODUCE_SECRET: preserve(), SEED_SECRET: preserve(), TELEGRAM_BOT_TOKEN: preserve(), TELEGRAM_CHANNEL_ID: preserve(), TRUST_PROXY_HEADERS: preserve(), UCP_AGENT_PRIVATE_KEY: preserve(), XAI_API_KEY: preserve() },
  });
  const cronRetention = service("cron-retention", {
    source: image("node:22-alpine"),
    start: "node -e \"const u='https://axon-agents.com/api/cron/retention',T=5,G=30000,W=ms=>new Promise(r=>setTimeout(r,ms));const go=async n=>{try{const r=await fetch(u,{method:'POST',headers:{Authorization:'Bearer '+process.env.CRON_SECRET},signal:AbortSignal.timeout(300000)});console.log(r.status,(await r.text()).slice(0,300));if(r.ok)return 0;if([429,502,503,504].includes(r.status)&&n>1){await W(G);return go(n-1)}return r.status<500?1:2}catch(e){console.error(e.name+': '+e.message);if(e.name!=='TimeoutError'&&n>1){await W(G);return go(n-1)}return 2}};go(T).then(c=>{if(c===2)console.error('not done this run (tried '+T+' times); the next scheduled run tries again');process.exit(c===1?1:0)})\"",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "0 2 * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const cronAutonomy = service("cron-autonomy", {
    source: image("node:22-alpine"),
    start: "node -e \"const u='https://axon-agents.com/api/cron/autonomy',T=5,G=15000,W=ms=>new Promise(r=>setTimeout(r,ms));const go=async n=>{try{const r=await fetch(u,{method:'POST',headers:{Authorization:'Bearer '+process.env.CRON_SECRET},signal:AbortSignal.timeout(120000)});console.log(r.status,(await r.text()).slice(0,300));if(r.ok)return 0;if([429,502,503,504].includes(r.status)&&n>1){await W(G);return go(n-1)}return r.status<500?1:2}catch(e){console.error(e.name+': '+e.message);if(e.name!=='TimeoutError'&&n>1){await W(G);return go(n-1)}return 2}};go(T).then(c=>{if(c===2)console.error('not done this run (tried '+T+' times); the next scheduled run tries again');process.exit(c===1?1:0)})\"",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "30 * * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const cronAgents = service("cron-agents", {
    source: image("node:22-alpine"),
    start: "node -e \"const u='https://axon-agents.com/api/cron/agents',T=5,G=30000,W=ms=>new Promise(r=>setTimeout(r,ms));const go=async n=>{try{const r=await fetch(u,{method:'POST',headers:{Authorization:'Bearer '+process.env.CRON_SECRET},signal:AbortSignal.timeout(300000)});console.log(r.status,(await r.text()).slice(0,300));if(r.ok)return 0;if([429,502,503,504].includes(r.status)&&n>1){await W(G);return go(n-1)}return r.status<500?1:2}catch(e){console.error(e.name+': '+e.message);if(e.name!=='TimeoutError'&&n>1){await W(G);return go(n-1)}return 2}};go(T).then(c=>{if(c===2)console.error('not done this run (tried '+T+' times); the next scheduled run tries again');process.exit(c===1?1:0)})\"",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "0 6 * * *", restartPolicyType: "NEVER" },
    networking: { privateNetworkEndpoint: "demo-agents" },
    env: { CRON_SECRET: preserve() },
  });
  const cronDemo = service("cron-demo", {
    source: image("node:22-alpine"),
    start: "node -e \"const u='https://axon-agents.com/api/cron/demo-activity',T=5,G=15000,W=ms=>new Promise(r=>setTimeout(r,ms));const go=async n=>{try{const r=await fetch(u,{method:'POST',headers:{Authorization:'Bearer '+process.env.CRON_SECRET},signal:AbortSignal.timeout(240000)});console.log(r.status,(await r.text()).slice(0,300));if(r.ok)return 0;if([429,502,503,504].includes(r.status)&&n>1){await W(G);return go(n-1)}return r.status<500?1:2}catch(e){console.error(e.name+': '+e.message);if(e.name!=='TimeoutError'&&n>1){await W(G);return go(n-1)}return 2}};go(T).then(c=>{if(c===2)console.error('not done this run (tried '+T+' times); the next scheduled run tries again');process.exit(c===1?1:0)})\"",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "0 * * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const cronHealth = service("cron-health", {
    source: image("node:22-alpine"),
    start: "node -e \"const u='https://axon-agents.com/api/cron/health',T=4,G=15000,W=ms=>new Promise(r=>setTimeout(r,ms));const go=async n=>{try{const r=await fetch(u,{method:'POST',headers:{Authorization:'Bearer '+process.env.CRON_SECRET},signal:AbortSignal.timeout(60000)});console.log(r.status,(await r.text()).slice(0,300));if(r.ok)return 0;if([429,502,503,504].includes(r.status)&&n>1){await W(G);return go(n-1)}return r.status<500?1:2}catch(e){console.error(e.name+': '+e.message);if(e.name!=='TimeoutError'&&n>1){await W(G);return go(n-1)}return 2}};go(T).then(c=>{if(c===2)console.error('not done this run (tried '+T+' times); the next scheduled run tries again');process.exit(c===1?1:0)})\"",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "*/5 * * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const cronTelegram = service("cron-telegram", {
    source: Axon,
    start: "sh -c 'curl -s -X POST https://axon-agents.com/api/cron/telegram-feed -H \"Authorization: Bearer $CRON_SECRET\"'",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "5 * * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });
  const cronWebhooks = service("cron-webhooks", {
    source: image("node:22-alpine"),
    start: "node -e \"const u='https://axon-agents.com/api/cron/webhooks',T=4,G=15000,W=ms=>new Promise(r=>setTimeout(r,ms));const go=async n=>{try{const r=await fetch(u,{method:'POST',headers:{Authorization:'Bearer '+process.env.CRON_SECRET},signal:AbortSignal.timeout(60000)});console.log(r.status,(await r.text()).slice(0,300));if(r.ok)return 0;if([429,502,503,504].includes(r.status)&&n>1){await W(G);return go(n-1)}return r.status<500?1:2}catch(e){console.error(e.name+': '+e.message);if(e.name!=='TimeoutError'&&n>1){await W(G);return go(n-1)}return 2}};go(T).then(c=>{if(c===2)console.error('not done this run (tried '+T+' times); the next scheduled run tries again');process.exit(c===1?1:0)})\"",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { cronSchedule: "*/5 * * * *", restartPolicyType: "NEVER" },
    env: { CRON_SECRET: preserve() },
  });

  return project("Axon", {
    resources: [cronReproducibility, cronBurn, cronBurnEngine, axonPresence, Axon2, cronRetention, cronAutonomy, cronAgents, cronDemo, cronHealth, cronTelegram, cronWebhooks, axonVolume],
  });
});
