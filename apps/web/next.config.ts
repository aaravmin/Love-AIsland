import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @arena/shared is a workspace package shipped as TS source; Next must
  // transpile it itself. The dependency is wired up by a later task.
  transpilePackages: ["@arena/shared"],
  // Pin the workspace root explicitly so Next/Turbopack doesn't guess based
  // on stray lockfiles elsewhere on disk (e.g. in a parent home directory).
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
};

export default nextConfig;
