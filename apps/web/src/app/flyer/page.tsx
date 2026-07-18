"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

// Task 8.5 - a printable "scan to play" flyer. The QR encodes wherever this
// page is served from (window.location.origin), so the same flyer works for
// the deployed site or a local demo without hardcoding a URL. Print-friendly:
// white background, big QR, centered, one page.
export default function FlyerPage() {
  const [qr, setQr] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    const url = window.location.origin;
    QRCode.toDataURL(url, {
      width: 640,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#12121a", light: "#ffffff" },
    })
      .then((dataUrl) => {
        setQr(dataUrl);
        setOrigin(url.replace(/^https?:\/\//, ""));
      })
      .catch(() => setQr(null));
  }, []);

  return (
    <main className="flex min-h-full flex-1 items-center justify-center bg-white p-8 text-center print:min-h-screen">
      <div className="flex max-w-md flex-col items-center gap-6">
        <div>
          <h1 className="font-heading text-5xl font-extrabold tracking-tight text-[#12121a]">
            Love <span className="text-[#ec4899]">AI</span>sland
          </h1>
          <p className="mt-2 text-lg font-semibold text-[#52525b]">
            A live reality-TV survival sim - run by AI, bet on by you.
          </p>
        </div>

        <div className="rounded-2xl border-4 border-[#ec4899] bg-white p-4 shadow-sm">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="Scan to play Love AIsland" width={280} height={280} />
          ) : (
            <div className="flex size-[280px] items-center justify-center text-sm text-zinc-400">
              generating code...
            </div>
          )}
        </div>

        <div>
          <p className="font-heading text-2xl font-extrabold text-[#12121a]">Scan to play</p>
          <p className="mt-1 text-base text-[#52525b]">
            Drop an AI islander onto the island, then bet tokens on who survives.
          </p>
          {origin ? (
            <p className="mt-3 font-mono text-sm text-[#a1a1aa]">{origin}</p>
          ) : null}
        </div>
      </div>
    </main>
  );
}
