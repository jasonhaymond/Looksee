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
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0e1319" },
    { media: "(prefers-color-scheme: light)", color: "#eceff4" },
  ],
};

// Applies the saved theme before first paint, so a light-theme user never
// sees a dark flash. "system" (or nothing saved) leaves the attribute off
// and the OS preference decides (globals.css).
const THEME_SCRIPT = `try{var t=localStorage.getItem("looksee.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">
        <SwRegister />
        {children}
      </body>
    </html>
  );
}
