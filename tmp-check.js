const cp = require("./src/crawler").canonicalizePath;
const data = JSON.parse(require("fs").readFileSync("/tmp/clinic-dedup/maps/clinic-dedup/graph-data.json", "utf8"));

const counts = {};
data.nodes.forEach(n => {
  const c = cp(n.urlPath);
  if (!counts[c]) counts[c] = [];
  counts[c].push(n.urlPath);
});

console.log("=== CANONICAL GROUPS WITH >1 INSTANCE ===");
Object.keys(counts)
  .filter(k => counts[k].length > 1)
  .sort()
  .forEach(k => {
    console.log(`${k} (${counts[k].length})`);
    counts[k].forEach(u => console.log(`  ${u}`));
  });

console.log("\n=== TOTAL: " + data.nodes.length + " nodes in " + Object.keys(counts).length + " canonical groups ===");
