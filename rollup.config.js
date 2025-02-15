import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import terser from "@rollup/plugin-terser";
import babel from "@rollup/plugin-babel";
import serve from "rollup-plugin-serve";
import livereload from "rollup-plugin-livereload";
import url from "@rollup/plugin-url";

const dev = process.env.ROLLUP_WATCH;

export default {
  input: "src/index.js",
  output: [
    {
      file: "dist/small-multivis.js",
      format: "es",
      sourcemap: true,
      inlineDynamicImports: true,
    },
    {
      file: "dist/small-multivis.min.js",
      format: "es",
      sourcemap: true,
      inlineDynamicImports: true,
      plugins: [!dev && terser()].filter(Boolean),
    },
  ],
  plugins: [
    url({
      include: ["**/*.wasm", "**/*.worker.js"],
      limit: 0, // Copy all files
    }),
    resolve({
      browser: true,
      preferBuiltins: false,
    }),
    commonjs(),
    babel({
      babelHelpers: "bundled",
      exclude: "node_modules/**",
    }),
    dev &&
      serve({
        open: true,
        // contentBase: ["dist", "examples"],
        contentBase: ".",
        port: 3000,
      }),
    dev && livereload("dist"),
  ].filter(Boolean),
};
