import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Karaoke | Your song library",
  description: "A private mobile karaoke library for songs, timed lyrics, and singing sessions.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="blush" data-lyric-size="md" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
