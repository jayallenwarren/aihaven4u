/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",          // <-- tells Next to generate /out
  images: { unoptimized: true }, // needed for static export if using next/image
};

module.exports = nextConfig;
