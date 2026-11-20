import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // crypto (HMAC) e chaves so existem no servidor: rotas rodam em Node
  serverExternalPackages: [],
};

export default nextConfig;
