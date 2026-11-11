import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "SilentLink · Research workspace",
  description:
    "A real-data workspace for headphone motion and silent articulation research.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
