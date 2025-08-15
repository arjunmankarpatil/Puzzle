/*
Web Camera App — React (single-file)

Features included in this file (client-side):
- Requests a 4K (3840x2160) camera stream (if the device/browser supports it)
- Uses ImageCapture.takePhoto() when available for best-quality capture
- Fallback capture from video -> canvas at 4K
- Exports:
  1) 4K PNG (regular sRGB-like capture)
  2) "Log" encoded PNG (pixel values transformed with a simple log curve to simulate log gamma)
  3) "Raw-ish" upload: sends raw RGBA bytes + metadata to a server endpoint (/upload-raw) where you can convert to DNG/other true raw formats server-side.

Limitations & notes (also included as comments in the code):
- Browsers do NOT generally expose true sensor RAW (DNG) directly. Some experimental APIs / camera hardware may support RAW via the Image Capture API with specific capabilities — support is limited.
- Producing a true camera RAW (DNG) generally requires access to sensor Bayer data and camera metadata. The client app provides a "raw-like" RGBA dump which you can convert server-side into DNG using native libraries (libraw, Adobe DNG SDK, rawpy/LibRaw) with additional metadata.
- This app demonstrates practical, cross-browser-compatible approach and a server stub to accept raw uploads.

Server-side notes (not executed here):
- Provided below is an express.js stub which saves the posted raw bytes to disk. Use native tooling (libraw, Adobe DNG SDK, or a Python script using rawpy) on the server to convert the saved file to DNG/TIFF.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Usage:
- Drop this React file into a React project (Tailwind optional)
- Run the server stub (node server.js) to receive raw uploads
- Open the page on HTTPS (getUserMedia requires secure context)

*/

import React, { useRef, useState, useEffect } from "react";

export default function WebRawLogCamera() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [useImageCapture, setUseImageCapture] = useState(false);
  const imageCaptureRef = useRef(null);
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [stream]);

  async function startCamera() {
    setStatus("requesting camera...");
    try {
      const constraints = {
        video: {
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          frameRate: { ideal: 30 },
          facingMode: "environment",
        },
        audio: false,
      };
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      setStream(s);
      if (videoRef.current) videoRef.current.srcObject = s;

      // try ImageCapture
      const track = s.getVideoTracks()[0];
      if (window.ImageCapture && track) {
        try {
          const ic = new ImageCapture(track);
          imageCaptureRef.current = ic;
          setUseImageCapture(true);
          setStatus("camera ready (4K preferred). ImageCapture available.");
        } catch (err) {
          setUseImageCapture(false);
          setStatus("camera ready (4K preferred). ImageCapture not available.");
        }
      } else {
        setUseImageCapture(false);
        setStatus("camera ready (4K preferred). ImageCapture not supported.");
      }
    } catch (err) {
      console.error(err);
      setStatus("camera error: " + (err.message || err));
    }
  }

  async function captureRegularPNG() {
    setIsCapturing(true);
    setStatus("capturing regular PNG...");
    try {
      if (useImageCapture && imageCaptureRef.current) {
        // takePhoto tends to be higher quality on supporting devices
        const blob = await imageCaptureRef.current.takePhoto();
        downloadBlob(blob, `capture_${Date.now()}.png`);
      } else {
        // fallback to canvas draw
        await drawVideoToCanvasAt4k();
        const blob = await new Promise((res) => canvasRef.current.toBlob(res, "image/png"));
        downloadBlob(blob, `capture_${Date.now()}.png`);
      }
      setStatus("regular PNG saved");
    } catch (err) {
      console.error(err);
      setStatus("capture failed: " + err.message);
    } finally {
      setIsCapturing(false);
    }
  }

  async function captureLogPNG() {
    setIsCapturing(true);
    setStatus("capturing log-encoded PNG...");
    try {
      await drawVideoToCanvasAt4k();
      // apply log transform to canvas pixels
      const ctx = canvasRef.current.getContext("2d");
      const w = canvasRef.current.width;
      const h = canvasRef.current.height;
      const imageData = ctx.getImageData(0, 0, w, h);
      applySimpleLogCurve(imageData.data);
      ctx.putImageData(imageData, 0, 0);
      const blob = await new Promise((res) => canvasRef.current.toBlob(res, "image/png"));
      downloadBlob(blob, `capture_log_${Date.now()}.png`);
      setStatus("log PNG saved");
    } catch (err) {
      console.error(err);
      setStatus("log capture failed: " + err.message);
    } finally {
      setIsCapturing(false);
    }
  }

  async function captureRawUpload() {
    setIsCapturing(true);
    setStatus("capturing raw bytes and uploading...");
    try {
      await drawVideoToCanvasAt4k();
      const ctx = canvasRef.current.getContext("2d");
      const w = canvasRef.current.width;
      const h = canvasRef.current.height;
      const imageData = ctx.getImageData(0, 0, w, h);
      // We'll send the raw RGBA bytes (8-bit per channel) plus simple metadata.
      const payload = {
        width: w,
        height: h,
        format: "RGBA8",
        timestamp: Date.now(),
        // optional: simple camera info when available
      };

      // pack metadata JSON + raw bytes as multipart/form-data
      const form = new FormData();
      form.append("meta", new Blob([JSON.stringify(payload)], { type: "application/json" }));
      // raw bytes
      const rawBuffer = imageData.data.buffer; // ArrayBuffer
      const rawBlob = new Blob([rawBuffer], { type: "application/octet-stream" });
      form.append("raw", rawBlob, `capture_${Date.now()}.rgba`);

      const res = await fetch("/upload-raw", {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(`upload failed: ${res.status}`);
      const j = await res.json();
      setStatus("upload complete: " + (j.message || "ok"));
    } catch (err) {
      console.error(err);
      setStatus("raw upload failed: " + err.message);
    } finally {
      setIsCapturing(false);
    }
  }

  async function drawVideoToCanvasAt4k() {
    if (!videoRef.current) throw new Error("video missing");
    const video = videoRef.current;
    const canvas = canvasRef.current;
    // Ensure canvas is 4k
    const w = 3840;
    const h = 2160;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    // draw image
    // drawImage will scale video to canvas resolution
    ctx.drawImage(video, 0, 0, w, h);
    // wait a tick to ensure drawn
    await new Promise((r) => setTimeout(r, 50));
  }

  function applySimpleLogCurve(data) {
    // data is a Uint8ClampedArray of RGBA
    // We'll apply a simple log mapping per channel (R, G, B), leave A untouched.
    // formula: out = 255 * log10(1 + k * (in/255)) / log10(1 + k)
    // choose k = 9 for a moderate curve resembling a basic log film curve.
    const k = 9.0;
    const denom = Math.log10(1 + k);
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; ++c) {
        const v = data[i + c] / 255; // 0..1
        const lv = Math.log10(1 + k * v) / denom; // 0..1
        data[i + c] = Math.round(lv * 255);
      }
      // keep alpha as-is
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-3">Web 4K Camera — RAW-ish + Log Export</h1>
      <p className="mb-2">Status: {status}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{ width: "100%", background: "black" }}
          />
          <div className="mt-2 space-x-2">
            <button onClick={startCamera} className="px-3 py-1 rounded bg-blue-600 text-white">Start Camera (4K preferred)</button>
            <button onClick={() => { stream && stream.getTracks().forEach(t=>t.stop()); setStream(null); setStatus('camera stopped'); }} className="px-3 py-1 rounded bg-gray-600 text-white">Stop</button>
          </div>
        </div>
        <div>
          <canvas ref={canvasRef} style={{ width: "100%", background: "#111" }} />
          <div className="mt-2 space-x-2">
            <button onClick={captureRegularPNG} disabled={isCapturing || !stream} className="px-3 py-1 rounded bg-green-600 text-white">Download 4K PNG</button>
            <button onClick={captureLogPNG} disabled={isCapturing || !stream} className="px-3 py-1 rounded bg-yellow-500 text-black">Download Log PNG</button>
            <button onClick={captureRawUpload} disabled={isCapturing || !stream} className="px-3 py-1 rounded bg-red-600 text-white">Upload Raw RGBA</button>
          </div>
        </div>
      </div>

      <section className="mt-6 text-sm text-gray-700">
        <h2 className="font-semibold">Notes & tips</h2>
        <ul className="list-disc ml-6">
          <li>Run on HTTPS — getUserMedia requires secure context.</li>
          <li>Many mobile devices and webcams will not actually provide full 4K even if you request it — the browser and camera decide the best matching resolution.</li>
          <li>True RAW (DNG) capture is not universally available from browsers. The "Upload Raw RGBA" option sends the uncompressed RGBA pixels which you can convert server-side to DNG/TIFF using native libraries and proper camera metadata.</li>
          <li>If you need 10/12/14-bit per channel rep (true log/linear professional pipeline), you must capture on a device that outputs higher bit depth and use native/SDK tools; browsers only expose 8-bit canvas pixels today in most environments.</li>
        </ul>
      </section>

      <section className="mt-6 text-xs text-gray-600">
        <h3 className="font-medium">Server stub (save as server.js) — accepts multipart/form-data (meta + raw)</h3>
        <pre style={{whiteSpace: 'pre-wrap', background:'#0b1220', color:'#a8dadc', padding:10, borderRadius:6, fontSize:12}}>
{`// server.js (Node/Express)
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const upload = multer({ dest: 'uploads/' });
const app = express();

app.post('/upload-raw', upload.fields([{ name: 'meta' }, { name: 'raw' }]), (req, res) => {
  try {
    const metaFile = req.files['meta'][0];
    const rawFile = req.files['raw'][0];
    // meta contents
    const meta = JSON.parse(fs.readFileSync(metaFile.path, 'utf8'));
    // rawFile.path contains the raw bytes - save or pass to native converter
    const outPath = path.join('uploads', 'raw_saved_' + Date.now() + '.rgba');
    fs.renameSync(rawFile.path, outPath);
    // Now convert: you will need to run a native tool here (libraw, Adobe DNG SDK, or a Python script) to process RGBA -> DNG/TIFF using appropriate metadata.
    res.json({ ok: true, message: 'saved', meta });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.listen(3000, () => console.log('server listening on 3000'));
`}
        </pre>

        <h4 className="mt-2">Server conversion guidance</h4>
        <p>
          To make a real DNG you need to map raw sensor/Bayer data to the DNG format and embed camera metadata (make/model/blacklevels/whitebalance coefficients). The client RGBA dump loses the original Bayer pattern and camera sensor transforms. For professional RAW workflows you need SDK access or to capture directly from camera APIs that provide sensor data. If you only need a "log" edit-ready file, converting RGBA -> 16-bit TIFF with embedded EXIF and a linear color profile is a practical approach.
        </p>
      </section>
    </div>
  );
}
