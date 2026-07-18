import type { Metadata, Viewport } from "next";
import { Fredoka, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { SocketBoot } from "@/components/socket-boot";
import { TopBar } from "@/components/top-bar";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Chunky rounded display face for the wordmark and headings; body copy
// stays on Geist. Variable font, so no weight axis to pin down.
const fredoka = Fredoka({
  variable: "--font-fredoka",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Love AIsland",
  description: "A live reality-TV survival sim with a Polymarket-style betting layer.",
};

// viewport-fit=cover lets the app draw into the notch/home-indicator areas;
// the chrome then pads itself back out with env(safe-area-inset-*) so nothing
// important sits under a notch (task 8.4).
export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: "#12121a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // The show runs on a dark, flat theme by default; there is no light
      // mode toggle in this shell.
      className={`dark ${geistSans.variable} ${geistMono.variable} ${fredoka.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <SocketBoot />
        <TopBar />
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        <Toaster theme="dark" />
      </body>
    </html>
  );
}
