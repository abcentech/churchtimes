import { withPayload } from '@payloadcms/next/withPayload'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Payload recommends keeping these external for the server bundle.
  serverExternalPackages: ['embedded-postgres'],
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
