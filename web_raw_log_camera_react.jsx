/*
Web-raw-log-camera-react

This React single-file component is a fully client-side camera UI that:
- Requests a 4K (3840×2160) camera stream (when the device/browser supports it).
- Captures a regular PNG (4K), a simple "log-encoded" PNG, and uploads raw RGBA bytes to a separate backend.

Important: server-side code (Node/Express) must run on a separate process/server. This file intentionally DOES NOT contain any Node `require(...)` calls. Instead, a server stub is provided as a template (with a placeholder) that you can download and run on your machine.

Why this rewrite: the previous document included server-side Node code directly in the client bundle which caused the bundler to attempt to resolve Node modules (fs, multer) and fail. The server code must be run separately — this file now only contains client logic and a safe, downloadable server stub.
*/

import React, { useRef, useState, useEffect } from 'react';

// ---------- Server stub template (safe placeholder) ----------
// The placeholder __REQ__ will be replaced with the literal `require` when you download
// the server stub (so the client bundle never contains `require(...)` text at build time).
const serverStubTemplate = `// server.js (Node/Express) - save & run on your server
// Install: npm install express multer
const express = __REQ__('express');
const multer = __REQ__('multer');
const fs = __REQ__('fs');
const path = __REQ__('path');

const upload = multer();
const app = express();

app.post('/upload-raw', upload.single('raw'), (req, res) => {
  try {
    const meta = req.body && req.body.meta ? JSON.parse(req.body.meta) : {};
    const outDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
    const filename = path.join(outDir, 'raw_saved_' + Date.now() + '.rgba');
    fs.writeFileSync(filename, req.file.buffer);
    res.json({ ok: true, saved: filename, meta });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.listen(3000, () => console.log('Server listening on http://localhost:3000'));
`;

// ---------- Helper utilities ----------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function canvasToBlob(canvas, type = 'image/png') {
  return await new Promise((res) => canvas.toBlob(res, type));
}

function applySimpleLogCurveToImageData(imageData) {
  // Apply a conservative log-like transform to the RGBA Uint8ClampedArray in place
  const data = imageData.data;
  const k = 9.0;
  const denom = Math.log10(1 + k);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; ++c) {
      const v = data[i + c] / 255; // 0..1
      const lv = Math.log10(1 + k * v) / denom; // 0..1
      data[i + c] = Math.round(lv * 255);
    }
    // alpha stays the same
  }
}

// ---------- Main component ----------
export default function WebRawLogCamera() {
  const videoRef = useRef(null);
  const offscreenCanvasRef = useRef(null);
  const [status, setStatus] = useState('idle');
  const [isCapturing, setIsCapturing] = useState(false);
  const [photoURL, setPhotoURL] = useState(null);
  const [diag, setDiag] = useState([]);

  useEffect(() => {
    // cleanup on unmount
    return () => {
      if (videoRef.current && videoRef.current.srcObject) {
        videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
        videoRef.current.srcObject = null;
      }
    };
  }, []);

  async function startCamera() {
    setStatus('requesting camera...');
    try {
      const constraints = {
        video: {
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          frameRate: { ideal: 30 },
          facingMode: 'environment',
        },
        audio: false,
      };
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      if (!videoRef.current) throw new Error('video element missing');
      videoRef.current.srcObject = s;
      // try to play (some browsers require this to settle autoplay / resolution)
      try {
        await videoRef.current.play();
      } catch (err) {
        // ignore autoplay errors; stream is attached and will work when the user interacts
      }
      setStatus('camera started (4K requested)');
    } catch (err) {
      console.error(err);
      setStatus('camera error: ' + (err.message || err));
    }
  }

  function stopCamera() {
    if (videoRef.current && videoRef.current.srcObject) {
      videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
      videoRef.current.srcObject = null;
      setStatus('camera stopped');
    }
  }

  async function drawVideoToCanvasAt4k() {
    if (!videoRef.current) throw new Error('video missing');
    const w = 3840;
    const h = 2160;
    let canvas = offscreenCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement('canvas');
      offscreenCanvasRef.current = canvas;
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // If video isn't ready yet this may draw a black frame — calling code should ensure the stream is active
    ctx.drawImage(videoRef.current, 0, 0, w, h);
    // small wait to ensure drawing completes on some devices
    await new Promise((r) => setTimeout(r, 50));
    return canvas;
  }

  async function download4kPNG() {
    setIsCapturing(true);
    setStatus('capturing 4K PNG...');
    try {
      const canvas = await drawVideoToCanvasAt4k();
      const blob = await canvasToBlob(canvas, 'image/png');
      downloadBlob(blob, `capture_${Date.now()}.png`);
      setStatus('4K PNG downloaded');
    } catch (err) {
      console.error(err);
      setStatus('capture failed: ' + (err.message || err));
    } finally {
      setIsCapturing(false);
    }
  }

  async function downloadLogPNG() {
    setIsCapturing(true);
    setStatus('capturing log PNG...');
    try {
      const canvas = await drawVideoToCanvasAt4k();
      const ctx = canvas.getContext('2d');
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      applySimpleLogCurveToImageData(imageData);
      ctx.putImageData(imageData, 0, 0);
      const blob = await canvasToBlob(canvas, 'image/png');
      downloadBlob(blob, `capture_log_${Date.now()}.png`);
      setStatus('log PNG downloaded');
    } catch (err) {
      console.error(err);
      setStatus('log capture failed: ' + (err.message || err));
    } finally {
      setIsCapturing(false);
    }
  }

  async function uploadRawRGBA() {
    setIsCapturing(true);
    setStatus('capturing raw bytes...');
    try {
      const canvas = await drawVideoToCanvasAt4k();
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      const imageData = ctx.getImageData(0, 0, w, h);

      const payload = { width: w, height: h, format: 'RGBA8', timestamp: Date.now() };
      const form = new FormData();
      form.append('meta', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
      // imageData.data.buffer is an ArrayBuffer
      const rawBlob = new Blob([imageData.data.buffer], { type: 'application/octet-stream' });
      form.append('raw', rawBlob, `capture_${Date.now()}.rgba`);

      // IMPORTANT: you must run the server stub separately and point this URL to it.
      const uploadUrl = window.location.origin.replace(/:\d+$/, ':3000') + '/upload-raw';
      const res = await fetch(uploadUrl, { method: 'POST', body: form });
      if (!res.ok) throw new Error('upload failed: ' + res.status);
      const json = await res.json();
      setStatus('upload complete: ' + (json.message || json.saved || 'ok'));
    } catch (err) {
      console.error(err);
      setStatus('raw upload failed: ' + (err.message || err));
    } finally {
      setIsCapturing(false);
    }
  }

  function downloadServerStub() {
    // Replace placeholder with actual `require` text at runtime.
    const code = serverStubTemplate.replace(/__REQ__/g, 'require');
    const blob = new Blob([code], { type: 'text/javascript' });
    downloadBlob(blob, 'server.js');
  }

  // Simple diagnostics (acts as lightweight tests)
  function runDiagnostics() {
    const results = [];
    results.push({ name: 'navigator.mediaDevices.getUserMedia', ok: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) });
    results.push({ name: 'ImageCapture API', ok: !!window.ImageCapture });
    results.push({ name: 'Offscreen canvas available', ok: typeof OffscreenCanvas !== 'undefined' });
    results.push({ name: 'Browser 4K capability (unknown)', ok: 'check camera stream resolution after start' });
    setDiag(results);
    setStatus('diagnostics run');
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 16, fontFamily: 'system-ui, Arial' }}>
      <h1 style={{ fontSize: 20, marginBottom: 6 }}>Web 4K Camera — RAW-ish + Log Export</h1>
      <div style={{ marginBottom: 8 }}>Status: <strong>{status}</strong></div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{ width: '100%', background: '#000' }}
          />

          <div style={{ marginTop: 8 }}>
            <button onClick={startCamera} disabled={isCapturing} style={{ marginRight: 8 }}>Start Camera (4K preferred)</button>
            <button onClick={stopCamera} style={{ marginRight: 8 }}>Stop</button>
            <button onClick={runDiagnostics}>Run Diagnostics</button>
          </div>
        </div>

        <div>
          <div style={{ marginBottom: 8 }}>
            <button onClick={download4kPNG} disabled={isCapturing} style={{ marginRight: 8 }}>Download 4K PNG</button>
            <button onClick={downloadLogPNG} disabled={isCapturing} style={{ marginRight: 8 }}>Download Log PNG</button>
            <button onClick={uploadRawRGBA} disabled={isCapturing} style={{ marginRight: 8 }}>Upload Raw RGBA</button>
          </div>

          <div style={{ marginTop: 12 }}>
            <strong>Captured preview</strong>
            {photoURL ? (
              <div style={{ marginTop: 8 }}>
                <img src={photoURL} alt="preview" style={{ width: '100%' }} />
              </div>
            ) : (
              <div style={{ marginTop: 8, color: '#666' }}>No preview available (use Download 4K PNG to save a capture)</div>
            )}
          </div>

          <div style={{ marginTop: 12 }}>
            <button onClick={downloadServerStub}>Download Server Stub (server.js)</button>
            <div style={{ marginTop: 6, fontSize: 12, color: '#444' }}>
              The downloaded server.js contains a working Express + multer example. Run it on your machine/server (node server.js) and POST to <code>http://localhost:3000/upload-raw</code> from this client.
            </div>
          </div>
        </div>
      </div>

      <section style={{ marginTop: 20, fontSize: 13 }}>
        <h3>Diagnostics / lightweight tests</h3>
        <ul>
          {diag.map((d, i) => (
            <li key={i}>
              {d.name}: <strong style={{ color: d.ok === true ? 'green' : d.ok === false ? 'red' : 'gray' }}>{String(d.ok)}</strong>
            </li>
          ))}
        </ul>
      </section>

      <section style={{ marginTop: 18, fontSize: 12, color: '#333' }}>
        <h4>Notes</h4>
        <ul>
          <li>This component runs entirely in the browser. It does not and cannot use Node built-ins like <code>fs</code> — put backend code on a separate server.</li>
          <li>Browser canvases are usually 8-bit per channel. For 10/12/14-bit capture and true RAW/DNG output you must capture sensor data server-side using native camera SDKs or camera-provided APIs.</li>
          <li>Devices may ignore the requested 4K constraints — always inspect the actual stream/tracks to see what resolution the browser provided.</li>
        </ul>
      </section>
    </div>
  );
}
