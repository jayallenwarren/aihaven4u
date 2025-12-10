/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",           // ✅ makes Next generate frontend/out
  images: { unoptimized: true },
};

export default nextConfig;
