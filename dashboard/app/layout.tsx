import type { Metadata, Viewport } from "next";
import "./globals.css";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import "./grid-overrides.css";
import { SwRegister } from "./sw-register";

export const metadata: Metadata = {
  title: "Looksee",
  description: "Self-hosted monitoring dashboard",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#0b0f14",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <SwRegister />
        {children}
      </body>
    </html>
  );
}
