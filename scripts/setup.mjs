import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function createNamespace(name) {
  const output = execSync(`npx wrangler kv namespace create ${name}`, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
  const id = output.match(/id\s*=\s*["']([a-f0-9]+)["']/i)?.[1]
    || output.match(/id\s+["']([a-f0-9]+)["']/i)?.[1]
    || output.match(/["']id["']\s*:\s*["']([a-f0-9]+)["']/i)?.[1];
  if (!id) throw new Error(`Could not parse KV namespace ID for ${name}. Wrangler output:\n${output}`);
  return id;
}

const file = "wrangler.toml";
let config = readFileSync(file, "utf8");
for (const name of ["SESSIONS"]) {
  const marker = `REPLACE_WITH_${name}_KV_ID`;
  if (!config.includes(marker)) continue;
  const id = createNamespace(name);
  config = config.replace(marker, id);
  writeFileSync(file, config);
  console.log(`${name} namespace created and bound: ${id}`);
}
console.log("KV setup complete. Next set ORIGIN_URL and SHARED_SECRET, then deploy.");
