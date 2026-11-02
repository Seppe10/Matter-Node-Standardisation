import path from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryPaths } from "../packages/contracts/src/repository-paths.ts";
import { generateDht11Workspace } from "../packages/firmware-builder/src/workspace.ts";

async function main(): Promise<void> {
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] ?? path.join(repositoryPaths(repoRoot).firmwareRoot, "out", "dht11-node");
const gpio = process.env.IOTEDU_DHT11_PIN ? Number(process.env.IOTEDU_DHT11_PIN) : 4;

const generated = await generateDht11Workspace({
  repoRoot,
  outDir,
  softwareVersion: 1,
  softwareVersionString: "1.0",
  dht11Gpio: gpio,
});

console.log(`workspace=${generated.outDir}`);
console.log(`dht11_gpio=${generated.dht11Gpio}`);
console.log(`software_version=${generated.softwareVersion}`);
console.log(`software_version_string=${generated.softwareVersionString}`);
console.log(`partition_layout=${generated.partitionLayoutId}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
