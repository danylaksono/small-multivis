import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const duckdbPath = path.dirname(require.resolve("@duckdb/duckdb-wasm"));
const publicPath = path.join(__dirname, "../public/duckdb");

// Create the directory if it doesn't exist
if (!fs.existsSync(publicPath)) {
  fs.mkdirSync(publicPath, { recursive: true });
}

// Copy the necessary files
[
  "duckdb-mvp.wasm",
  "duckdb-eh.wasm",
  "duckdb-browser-mvp.worker.js",
  "duckdb-browser-eh.worker.js",
].forEach((file) => {
  fs.copyFileSync(
    path.join(duckdbPath, "dist", file),
    path.join(publicPath, file)
  );
});

console.log("DuckDB files copied successfully to public/duckdb/");
