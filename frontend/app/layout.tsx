import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-archivo",
});

// Reserved for cipher bytes, addresses and log lines — nothing else is mono.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-mono",
});

const description =
  "Private conditional orders on Flare. Your trigger is encrypted to a trusted enclave and never published, so it cannot be hunted.";

export const metadata: Metadata = {
  title: "Wraith — conditional orders that never announce themselves",
  description,
  applicationName: "Wraith",
  openGraph: {
    title: "Wraith",
    description,
    siteName: "Wraith",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Wraith",
    description,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${mono.variable}`}>
      <body>
        <a className="skip-link" href="#compose">
          Skip to order composer
        </a>
        {/* Fixed grain: breaks the digital flatness of large dark fields. */}
        <div className="grain" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
