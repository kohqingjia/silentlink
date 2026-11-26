import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "SilentLink · Give your silence a voice",
  description:
    "Webcam lip-reading research: teach words, test accuracy, and turn silent speech into a voice.",
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
