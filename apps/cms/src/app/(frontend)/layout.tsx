import React from 'react'

export const metadata = {
  title: 'Church Times CMS',
  description: 'Newsroom backend',
}

export default function FrontendLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
