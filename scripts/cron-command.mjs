// The one way every Axon cron calls the site: a dropped connection or a busy proxy is tried again, a few times, and a
// network blip never ends as a crash. Only an answer that retrying cannot change (401, 403, 404: a wrong secret or path)
// exits non-zero, because that needs a person. A request that may have reached the app (a timeout, a 500) is not
// sent twice.
export function cronCommand(url, { tries, gapS, timeoutS }) {
  const js = `const u='${url}',T=${tries},G=${gapS * 1000},W=ms=>new Promise(r=>setTimeout(r,ms));` +
    `const go=async n=>{try{const r=await fetch(u,{method:'POST',headers:{Authorization:'Bearer '+process.env.CRON_SECRET},signal:AbortSignal.timeout(${timeoutS * 1000})});` +
    `console.log(r.status,(await r.text()).slice(0,300));if(r.ok)return 0;` +
    `if([429,502,503,504].includes(r.status)&&n>1){await W(G);return go(n-1)}return r.status<500?1:2}` +
    `catch(e){console.error(e.name+': '+e.message);if(e.name!=='TimeoutError'&&n>1){await W(G);return go(n-1)}return 2}};` +
    `go(T).then(c=>{if(c===2)console.error('not done this run (tried '+T+' times); the next scheduled run tries again');process.exit(c===1?1:0)})`;
  return `node -e "${js}"`;
}
