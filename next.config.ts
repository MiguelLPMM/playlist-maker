import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the dev server to be reached at 127.0.0.1 (Spotify rejects "localhost" redirect URIs).
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
