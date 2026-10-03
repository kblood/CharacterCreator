// SPDX-License-Identifier: GPL-3.0-or-later
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { startServer } from './server.mjs';
const srv = await startServer(8124);
const exe = [process.env.CHROME,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(existsSync);
for (const [hl, args] of [[true, []], [true, ['--enable-unsafe-webgpu']], ['new', ['--enable-unsafe-webgpu','--use-angle=d3d11']], [true, ['--enable-unsafe-webgpu','--use-webgpu-adapter=swiftshader']], [true, ['--enable-unsafe-webgpu','--enable-features=WebGPU','--ignore-gpu-blocklist']]]) {
  const b = await puppeteer.launch({ executablePath: exe, headless: hl, args: ['--no-sandbox', ...args] });
  const p = await b.newPage(); await p.goto('http://localhost:8124/experiments/cloth/server.mjs');
  const r = await p.evaluate(async () => { if (!navigator.gpu) return 'no navigator.gpu (secure=' + isSecureContext + ')'; try { const a = await navigator.gpu.requestAdapter(); if (!a) return 'adapter null'; const i = a.info || {}; return 'adapter ok ' + JSON.stringify({vendor:i.vendor, arch:i.architecture, desc:i.description, fallback: a.isFallbackAdapter ?? i.isFallbackAdapter}); } catch(e){ return 'err '+e.message; } });
  console.log(JSON.stringify(args), '->', r);
  await b.close();
}
srv.close();
