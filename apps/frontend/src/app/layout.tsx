import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "WebRTC Streaming App",
  description: "Stream and watch live video.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistMono.className} bg-gray-900 text-white`}>
        <nav className="bg-gray-800 p-4">
          <div className="container mx-auto flex justify-between items-center">
            <a href="/" className="text-xl font-bold">StreamApp</a>
            <div>
              <a href="/stream" className="px-3 py-2 hover:bg-gray-700 rounded">Stream</a>
              <a href="/watch" className="px-3 py-2 hover:bg-gray-700 rounded">Watch</a>
            </div>
          </div>
        </nav>
        <main className="container mx-auto p-4">
          {children}
        </main>
      </body>
    </html>
  );
}
