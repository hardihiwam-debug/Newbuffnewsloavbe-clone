// Regenerate src/routeTree.gen.ts from the route files on disk.
//   node scripts/_gen_routes.mjs
import { Generator, getConfig } from "@tanstack/router-generator";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = process.cwd();

// The plugin resolves its config the same way; pull defaults from the
// installed router-generator so we don't invent flags.
const config = getConfig({ root });

const generator = new Generator({ config, root });
await generator.run();

console.log("routeTree.gen.ts regenerated");
